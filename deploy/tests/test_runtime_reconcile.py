"""Behavioral recovery tests; run with Python 3 on Linux/WSL (bash + flock)."""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ENTRYPOINT = Path(__file__).resolve().parents[1] / "scripts/reconcile-runtime.sh"
PROJECT = "tofan-cloud"
SERVICES = ("cloud-postgres", "cloud-redis")
FAKE_DOCKER = r'''
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import time

path = Path(os.environ["FAKE_DOCKER_STATE"])
state = json.loads(path.read_text())
args = sys.argv[1:]
state["calls"].append(args)
def save():
    path.write_text(json.dumps(state))
save()
if state.get("hang") and state["hang"] == args[:len(state["hang"])]:
    time.sleep(10)
if state.get("failure") and state["failure"] == args[:len(state["failure"])]:
    print("FAKE_PRIVATE_DOCKER_SECRET", file=sys.stderr)
    sys.exit(42)
if state.get("malformed") and state["malformed"] == args[:len(state["malformed"])]:
    print("not-json-or-tar")
    sys.exit(0)
if args[:1] == ["inspect"] and len(args) == 2:
    obj = state["containers"].get(args[1])
    if obj is None:
        sys.exit(1)
    replacement = state.get("replace_on_reinspect")
    if replacement == args[1] and sum(c == args for c in state["calls"]) > 1:
        obj["Id"] = "unexpected-replacement-id"
        save()
    if obj["State"]["Running"] and obj["State"]["Health"]["Status"] == "starting":
        remaining = state.get("health_after", {}).get(args[1])
        if remaining is not None:
            if remaining <= 0:
                obj["State"]["Health"]["Status"] = "healthy"
            else:
                state["health_after"][args[1]] -= 1
        save()
    print(json.dumps([obj]))
elif args[:2] == ["volume", "inspect"] and len(args) == 3:
    obj = state["volumes"].get(args[2])
    if obj is None:
        sys.exit(1)
    print(json.dumps([obj]))
elif args[:1] == ["cp"] and len(args) == 3 and args[2] == "-":
    identity, source = args[1].split(":", 1)
    if identity != state["containers"]["tofan-cloud-postgres"]["Id"]:
        sys.exit(1)
    relative = source.removeprefix("/var/lib/postgresql/data/")
    content = state["pg_files"].get(relative)
    if content is None:
        sys.exit(1)
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        item = tarfile.TarInfo(relative.rsplit("/", 1)[-1])
        item.size = len(content.encode())
        if state.get("archive_directory"):
            item.type = tarfile.DIRTYPE
            item.size = 0
        archive.addfile(item, io.BytesIO(content.encode()))
    sys.stdout.buffer.write(buffer.getvalue())
elif args[:2] == ["update", "--restart=always"] and len(args) == 3:
    matches = [c for c in state["containers"].values() if c["Id"] == args[2]]
    if len(matches) != 1:
        sys.exit(1)
    matches[0]["HostConfig"]["RestartPolicy"]["Name"] = "always"
    save()
elif args[:1] == ["start"] and len(args) == 2:
    matches = [c for c in state["containers"].values() if c["Id"] == args[1]]
    if len(matches) != 1:
        sys.exit(1)
    matches[0]["State"]["Running"] = True
    name = matches[0]["Name"][1:]
    matches[0]["State"]["Health"]["Status"] = (
        "starting" if name in state.get("health_after", {}) else "healthy"
    )
    save()
else:
    print("Forbidden/unexpected Docker command: " + repr(args), file=sys.stderr)
    sys.exit(97)
'''


def fixture(directory):
    state = {"calls": [], "containers": {}, "volumes": {},
             "pg_files": {"PG_VERSION": "17\n", "global/pg_control": "existing-control-data"},
             "data": {"postgres": "durable-database-marker", "redis": "durable-redis-marker"}}
    for service in SERVICES:
        name = PROJECT + "-" + service.removeprefix("cloud-")
        volume = PROJECT + "_" + service + "-data"
        mountpoint = "/var/lib/docker/volumes/" + volume + "/_data"
        state["containers"][name] = {
            "Id": service + "-existing-id", "Name": "/" + name,
            "Config": {"Labels": {
                "com.docker.compose.project": PROJECT,
                "com.docker.compose.service": service,
                "com.docker.compose.project.working_dir": str(directory),
                "com.docker.compose.oneoff": "False"},
                "Env": [], "Healthcheck": {"Test": ["CMD", "fixture-health"]}},
            "HostConfig": {"RestartPolicy": {"Name": "always", "MaximumRetryCount": 0}},
            "Mounts": [{"Type": "volume", "Name": volume, "Source": mountpoint,
                        "Destination": "/var/lib/postgresql/data" if service == "cloud-postgres" else "/data",
                        "RW": True}],
            "State": {"Running": True, "Paused": False, "Dead": False,
                      "RemovalInProgress": False, "Health": {"Status": "healthy"}}}
        state["volumes"][volume] = {
            "Name": volume, "Mountpoint": mountpoint, "Driver": "local", "Options": None,
            "Labels": {"com.docker.compose.project": PROJECT,
                       "com.docker.compose.volume": service + "-data"}}
    return state


@unittest.skipUnless(os.name == "posix" and shutil.which("bash") and shutil.which("flock"),
                     "Requires Linux/WSL bash, flock and /proc file descriptors")
class RuntimeReconcileTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="runtime-reconcile-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.directory = self.root / "deployment"
        self.directory.mkdir()
        self.state_path = self.root / "state.json"
        executable = self.root / "docker"
        executable.write_text("#!" + sys.executable + "\n" + FAKE_DOCKER)
        executable.chmod(0o755)
        self.environment = dict(os.environ, PATH=str(self.root) + os.pathsep + os.environ["PATH"],
                                COMPOSE_DIR=str(self.directory), FAKE_DOCKER_STATE=str(self.state_path),
                                RECONCILE_TIMEOUT_SECONDS="10", RECONCILE_LOCK_TIMEOUT_SECONDS="0.1")
        self.seed()

    def seed(self):
        self.state = fixture(self.directory)
        self.save()

    def save(self):
        self.state_path.write_text(json.dumps(self.state))

    def load(self):
        self.state = json.loads(self.state_path.read_text())
        return self.state

    def run_reconciler(self, *flags, success=True, inherited=False, environment=None):
        self.save()
        command = ["bash", str(ENTRYPOINT), *flags]
        if inherited:
            command = ["bash", "-c", 'exec 9>"$COMPOSE_DIR/.deployment.lock"; flock 9; exec bash "$@"',
                       "fixture", str(ENTRYPOINT), *flags]
        result = subprocess.run(command, env=environment or self.environment,
                                capture_output=True, text=True, timeout=20)
        self.load()
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        self.assertNotIn("FAKE_PRIVATE_DOCKER_SECRET", result.stdout + result.stderr)
        return result

    def mutations(self):
        return [call for call in self.state["calls"] if call[0] not in ("inspect", "volume", "cp")]

    def assert_preserved(self, original):
        self.assertEqual(self.state["data"], original["data"])
        self.assertEqual(self.state["pg_files"], original["pg_files"])
        self.assertEqual(self.state["volumes"], original["volumes"])
        for name, container in original["containers"].items():
            for field in ("Id", "Name", "Config", "Mounts"):
                self.assertEqual(self.state["containers"][name][field], container[field])

    def stop_and_drift(self):
        for container in self.state["containers"].values():
            container["State"]["Running"] = False
            container["State"]["Health"]["Status"] = "starting"
            container["HostConfig"]["RestartPolicy"]["Name"] = "on-failure"

    def test_healthy_check_is_strictly_read_only(self):
        original = copy.deepcopy(self.state)
        self.run_reconciler("--check", "--require-active")
        self.assertEqual(self.mutations(), [])
        self.assert_preserved(original)

    def test_running_policy_drift_updates_existing_ids_without_start(self):
        for container in self.state["containers"].values():
            container["HostConfig"]["RestartPolicy"]["Name"] = "on-failure"
        original = copy.deepcopy(self.state)
        self.run_reconciler()
        self.assertEqual(self.mutations(), [["update", "--restart=always", c["Id"]]
                                           for c in original["containers"].values()])
        self.assert_preserved(original)

    def test_stopped_dependencies_recover_with_same_data_and_identities(self):
        self.stop_and_drift()
        self.state["health_after"] = {name: 1 for name in self.state["containers"]}
        original = copy.deepcopy(self.state)
        self.run_reconciler("--require-active")
        self.assert_preserved(original)
        self.assertEqual(len(self.mutations()), 4)
        first_mutation = next(i for i, c in enumerate(self.state["calls"]) if c[0] == "update")
        preceding = self.state["calls"][:first_mutation]
        for name in self.state["containers"]:
            self.assertIn(["inspect", name], preceding)
        for name in self.state["volumes"]:
            self.assertIn(["volume", "inspect", name], preceding)
        self.assertEqual(sum(c[0] == "cp" for c in preceding), 2)
        self.run_reconciler("--check")

    def test_simulated_daemon_restart_recovers_old_policy_and_then_auto_starts(self):
        # A clean daemon shutdown does not retry on-failure containers. Simulate
        # that persisted state, then verify always semantics on a second restart.
        self.stop_and_drift()
        original = copy.deepcopy(self.state)
        self.run_reconciler()
        self.assert_preserved(original)
        for container in self.state["containers"].values():
            container["State"]["Running"] = container["HostConfig"]["RestartPolicy"]["Name"] == "always"
        self.state["calls"] = []
        self.run_reconciler("--check")
        self.assertEqual(self.mutations(), [])

    def test_stopped_dependencies_with_always_only_start(self):
        for container in self.state["containers"].values():
            container["State"]["Running"] = False
        self.run_reconciler()
        self.assertEqual(self.mutations(), [["start", c["Id"]] for c in self.state["containers"].values()])

    def test_container_replaced_during_polling_is_rejected(self):
        self.stop_and_drift()
        self.state["replace_on_reinspect"] = "tofan-cloud-redis"
        self.run_reconciler(success=False)
        self.assertNotIn(["start", "unexpected-replacement-id"], self.mutations())
        self.assertEqual([c[0] for c in self.mutations()], ["update", "start", "update", "start"])

    def test_strict_check_rejects_drift_stopped_and_unhealthy_without_changes(self):
        for defect in ("policy", "stopped", "starting", "unhealthy"):
            with self.subTest(defect=defect):
                self.seed()
                container = self.state["containers"]["tofan-cloud-redis"]
                if defect == "policy":
                    container["HostConfig"]["RestartPolicy"]["Name"] = "on-failure"
                elif defect == "stopped":
                    container["State"]["Running"] = False
                else:
                    container["State"]["Health"]["Status"] = defect
                self.run_reconciler("--check", success=False)
                self.assertEqual(self.mutations(), [])

    def test_maintenance_never_contacts_docker_and_strict_modes_fail(self):
        (self.directory / ".maintenance").touch()
        for flags, success in (((), True), (("--check",), False), (("--require-active",), False)):
            with self.subTest(flags=flags):
                self.run_reconciler(*flags, success=success)
                self.assertEqual(self.state["calls"], [])

    def test_contended_deployment_lock_prevents_all_docker_calls(self):
        import fcntl
        with (self.directory / ".deployment.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.run_reconciler(success=False)
        self.assertEqual(self.state["calls"], [])

    def test_real_inherited_fd9_lock_is_accepted(self):
        self.run_reconciler("--lock-held", "--check", inherited=True)
        self.assertTrue(self.state["calls"])
        self.assertEqual(self.mutations(), [])

    def test_missing_inherited_lock_is_rejected_before_docker(self):
        self.run_reconciler("--lock-held", success=False)
        self.assertEqual(self.state["calls"], [])

    def test_absent_container_or_volume_is_never_created(self):
        for kind, key in (("containers", "tofan-cloud-postgres"), ("containers", "tofan-cloud-redis"),
                          ("volumes", "tofan-cloud_cloud-postgres-data"),
                          ("volumes", "tofan-cloud_cloud-redis-data")):
            with self.subTest(kind=kind, key=key):
                self.seed()
                self.stop_and_drift()
                del self.state[kind][key]
                self.run_reconciler(success=False)
                self.assertEqual(self.mutations(), [])

    def test_wrong_ownership_or_mounts_refuse_before_either_service_changes(self):
        defects = ("project", "service", "directory", "name", "oneoff", "bind", "wrong-volume", "readonly",
                   "source", "volume-project", "volume-label", "volume-driver", "volume-options",
                   "nested", "pgdata", "healthcheck", "paused", "dead", "removing")
        for defect in defects:
            with self.subTest(defect=defect):
                self.seed()
                self.stop_and_drift()
                # Redis is validated second: its refusal must protect PostgreSQL too.
                container = self.state["containers"]["tofan-cloud-redis"]
                mount = container["Mounts"][0]
                volume = self.state["volumes"][mount["Name"]]
                labels = container["Config"]["Labels"]
                if defect in ("project", "service"):
                    labels["com.docker.compose." + defect] = "foreign"
                elif defect == "directory":
                    labels["com.docker.compose.project.working_dir"] = "/foreign"
                elif defect == "name":
                    container["Name"] = "/replacement"
                elif defect == "oneoff":
                    labels["com.docker.compose.oneoff"] = "True"
                elif defect == "bind":
                    mount["Type"] = "bind"
                elif defect == "wrong-volume":
                    mount["Name"] = "replacement-volume"
                elif defect == "readonly":
                    mount["RW"] = False
                elif defect == "source":
                    mount["Source"] = "/foreign"
                elif defect in ("volume-project", "volume-label"):
                    volume["Labels"]["com.docker.compose." + ("project" if defect == "volume-project" else "volume")] = "foreign"
                elif defect == "volume-driver":
                    volume["Driver"] = "nfs"
                elif defect == "volume-options":
                    volume["Options"] = {"device": "/foreign", "type": "none", "o": "bind"}
                elif defect == "nested":
                    container["Mounts"].append({"Destination": "/data/nested", "Type": "bind"})
                elif defect == "pgdata":
                    self.state["containers"]["tofan-cloud-postgres"]["Config"]["Env"] = ["PGDATA=/empty"]
                elif defect == "healthcheck":
                    container["Config"]["Healthcheck"] = {"Test": ["NONE"]}
                else:
                    container["State"][{"paused": "Paused", "dead": "Dead", "removing": "RemovalInProgress"}[defect]] = True
                original = copy.deepcopy(self.state)
                self.run_reconciler(success=False)
                self.assertEqual(self.mutations(), [])
                self.assert_preserved(original)

    def test_empty_uninitialized_or_wrong_postgres_data_is_never_started(self):
        for defect in ("absent-version", "empty-version", "wrong-version", "absent-control", "empty-control", "directory"):
            with self.subTest(defect=defect):
                self.seed()
                self.stop_and_drift()
                if defect == "absent-version":
                    del self.state["pg_files"]["PG_VERSION"]
                elif defect == "empty-version":
                    self.state["pg_files"]["PG_VERSION"] = ""
                elif defect == "wrong-version":
                    self.state["pg_files"]["PG_VERSION"] = "16\n"
                elif defect == "absent-control":
                    del self.state["pg_files"]["global/pg_control"]
                elif defect == "empty-control":
                    self.state["pg_files"]["global/pg_control"] = ""
                else:
                    self.state["archive_directory"] = True
                self.run_reconciler(success=False)
                self.assertEqual(self.mutations(), [])

    def test_docker_failures_fail_closed_without_leaking_stderr(self):
        cases = (["inspect"], ["volume", "inspect"], ["cp"], ["update"], ["start"])
        for command in cases:
            with self.subTest(command=command):
                self.seed()
                self.stop_and_drift()
                self.state["failure"] = command
                original = copy.deepcopy(self.state)
                self.run_reconciler(success=False)
                self.assert_preserved(original)
                if command[0] in ("inspect", "volume", "cp"):
                    self.assertEqual(self.mutations(), [])
                elif command[0] == "update":
                    self.assertEqual(self.mutations(), [["update", "--restart=always", "cloud-postgres-existing-id"]])
                else:
                    self.assertEqual([c[0] for c in self.mutations()], ["update", "start"])

    def test_invalid_docker_json_or_archive_fails_without_mutation(self):
        for command in (["inspect"], ["volume", "inspect"], ["cp"]):
            with self.subTest(command=command):
                self.seed()
                self.stop_and_drift()
                self.state["malformed"] = command
                self.run_reconciler(success=False)
                self.assertEqual(self.mutations(), [])

    def test_unhealthy_service_fails_with_bounded_deadline(self):
        self.state["containers"]["tofan-cloud-redis"]["State"]["Health"]["Status"] = "unhealthy"
        self.environment["RECONCILE_TIMEOUT_SECONDS"] = "1.5"
        self.run_reconciler(success=False)
        self.assertEqual(self.mutations(), [])

    def test_started_service_that_never_becomes_healthy_fails(self):
        self.stop_and_drift()
        self.state["health_after"] = {name: 100 for name in self.state["containers"]}
        self.environment["RECONCILE_TIMEOUT_SECONDS"] = "1.5"
        self.run_reconciler(success=False)
        self.assertTrue(self.mutations())
        self.assertFalse(all(c["State"]["Health"]["Status"] == "healthy"
                             for c in self.state["containers"].values()))

    def test_hung_docker_command_is_terminated_at_deadline(self):
        self.state["hang"] = ["inspect"]
        self.environment["RECONCILE_TIMEOUT_SECONDS"] = "0.2"
        self.run_reconciler(success=False)
        self.assertEqual(self.mutations(), [])


if __name__ == "__main__":
    unittest.main()
