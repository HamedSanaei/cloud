"""Validate and recover existing tofan-cloud infrastructure; never create data."""
from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import time

PROJECT = "tofan-cloud"
SERVICES = (
    ("cloud-postgres", "tofan-cloud-postgres", "cloud-postgres-data", "/var/lib/postgresql/data"),
    ("cloud-redis", "tofan-cloud-redis", "cloud-redis-data", "/data"),
)


class RecoveryError(Exception):
    pass


class Reconciler:
    def __init__(self, directory: str, timeout: float):
        self.directory = directory
        self.deadline = time.monotonic() + timeout

    def docker(self, *args: str) -> bytes:
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise RecoveryError("Recovery deadline exceeded")
        try:
            return subprocess.run(
                ["docker", *args], check=True, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, timeout=min(30, remaining),
            ).stdout
        except (subprocess.SubprocessError, OSError):
            # Docker stderr/inspect can contain credentials. Do not print either.
            raise RecoveryError(f"Docker {args[0]} failed; inspect daemon/service privately") from None

    def inspect(self, *args: str) -> dict:
        result = json.loads(self.docker(*args))
        if not isinstance(result, list) or len(result) != 1:
            raise RecoveryError("Docker identity inspection was ambiguous")
        return result[0]

    def validate(self, service: str, name: str, volume: str, target: str) -> dict:
        container = self.inspect("inspect", name)
        labels = container.get("Config", {}).get("Labels") or {}
        # Only one known historical PostgreSQL container was created from the
        # versioned storefront release directory. Keep its existing cluster and
        # Docker volume instead of requiring a destructive container replacement.
        # Every other identity, volume and initialized-PGDATA guard still applies.
        historical_postgres_dir = str(
            Path(self.directory) / "releases" / "provider-storefront-20261016"
        )
        legacy_postgres = (
            service == "cloud-postgres"
            and labels.get("com.docker.compose.project.working_dir") == historical_postgres_dir
            and labels.get("com.docker.compose.project.config_files")
            == str(Path(historical_postgres_dir) / "docker-compose.yml")
            and (Path(historical_postgres_dir) / "docker-compose.yml").is_file()
        )
        expected = {
            "com.docker.compose.project": PROJECT,
            "com.docker.compose.service": service,
        }
        if (any(labels.get(key) != value for key, value in expected.items())
                or (labels.get("com.docker.compose.project.working_dir") != self.directory
                    and not legacy_postgres)):
            raise RecoveryError(f"{name}: Compose ownership mismatch")
        if container.get("Name") != "/" + name or not container.get("Id"):
            raise RecoveryError(f"{name}: container identity mismatch")
        if labels.get("com.docker.compose.oneoff", "false").lower() != "false":
            raise RecoveryError(f"{name}: one-off container refused")
        mounts = [m for m in container.get("Mounts", []) if m.get("Destination") == target]
        expected_volume = PROJECT + "_" + volume
        if (len(mounts) != 1 or mounts[0].get("Type") != "volume"
                or mounts[0].get("Name") != expected_volume or not mounts[0].get("RW")):
            raise RecoveryError(f"{name}: persistent volume identity mismatch")
        if any(m.get("Destination", "").startswith(target + "/") for m in container.get("Mounts", [])):
            raise RecoveryError(f"{name}: nested data mount refused")
        actual = self.inspect("volume", "inspect", expected_volume)
        volume_labels = actual.get("Labels") or {}
        if (actual.get("Name") != expected_volume
                or volume_labels.get("com.docker.compose.project") != PROJECT
                or volume_labels.get("com.docker.compose.volume") != volume
                or actual.get("Driver") != "local" or actual.get("Options")):
            raise RecoveryError(f"{name}: persistent volume ownership/driver mismatch")
        if mounts[0].get("Source") != actual.get("Mountpoint"):
            raise RecoveryError(f"{name}: persistent volume source mismatch")
        state = container.get("State", {})
        if state.get("Paused") or state.get("Dead") or state.get("RemovalInProgress"):
            raise RecoveryError(f"{name}: unsafe container state")
        if not container.get("Config", {}).get("Healthcheck", {}).get("Test") or container["Config"]["Healthcheck"]["Test"][0] == "NONE":
            raise RecoveryError(f"{name}: required healthcheck missing")
        # PGDATA elsewhere can initialize a fresh cluster even with the right mount.
        if service == "cloud-postgres":
            env = dict(item.split("=", 1) for item in container["Config"].get("Env", []) if "=" in item)
            if env.get("PGDATA", target) != target:
                raise RecoveryError(f"{name}: unexpected PGDATA; operator verification required")
            for relative in ("PG_VERSION", "global/pg_control"):
                payload = self.docker("cp", f"{container['Id']}:{target}/{relative}", "-")
                with tarfile.open(fileobj=io.BytesIO(payload), mode="r:*") as archive:
                    members = archive.getmembers()
                    if len(members) != 1 or not members[0].isfile() or members[0].size == 0:
                        raise RecoveryError(f"{name}: initialized PostgreSQL data not proven")
                    if relative == "PG_VERSION":
                        stream = archive.extractfile(members[0])
                        if stream is None or stream.read(16).strip() != b"17":
                            raise RecoveryError(f"{name}: PostgreSQL data version mismatch")
        return container

    @staticmethod
    def ready(container: dict) -> bool:
        state = container.get("State", {})
        return (state.get("Running") is True
                and state.get("Health", {}).get("Status") == "healthy"
                and container.get("HostConfig", {}).get("RestartPolicy", {}).get("Name") == "always")

    def run(self, check: bool):
        # Validate every identity/data mount BEFORE changing either service.
        containers = [self.validate(*spec) for spec in SERVICES]
        if check:
            if not all(self.ready(c) for c in containers):
                raise RecoveryError("Infrastructure must be healthy with restart=always")
        else:
            for container in containers:
                if Path(self.directory, ".maintenance").exists():
                    raise RecoveryError("Maintenance mode entered; recovery stopped")
                name, identity = container["Name"], container["Id"]
                if container.get("HostConfig", {}).get("RestartPolicy", {}).get("Name") != "always":
                    self.docker("update", "--restart=always", identity)
                    print(f"[reconcile] {name}: restart policy reconciled to always", flush=True)
                if not container.get("State", {}).get("Running"):
                    self.docker("start", identity)
                    print(f"[reconcile] {name}: existing container started", flush=True)
            while True:
                # Revalidate ownership and volume identities after starts, too.
                current = [self.validate(*spec) for spec in SERVICES]
                if any(a["Id"] != b["Id"] for a, b in zip(containers, current)):
                    raise RecoveryError("Infrastructure container changed during recovery")
                if all(self.ready(c) for c in current):
                    break
                remaining = self.deadline - time.monotonic()
                if remaining <= 0:
                    raise RecoveryError("Infrastructure health deadline exceeded")
                time.sleep(min(1, remaining))
        print("[reconcile] PostgreSQL and Redis healthy; restart=always; existing volumes verified")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--require-active", action="store_true")
    parser.add_argument("--lock-held", action="store_true")
    args = parser.parse_args()
    timeout = float(os.environ.get("RECONCILE_TIMEOUT_SECONDS", "180"))
    if not 0 < timeout <= 3600:
        raise RecoveryError("Invalid recovery timeout")
    Reconciler(os.environ.get("COMPOSE_DIR", "/opt/tofan/cloud"), timeout).run(args.check)


if __name__ == "__main__":
    try:
        main()
    except (RecoveryError, ValueError, KeyError, TypeError, tarfile.TarError) as error:
        message = str(error) if isinstance(error, RecoveryError) else "Invalid Docker metadata/data archive"
        print("[reconcile] FAILED: " + message, file=sys.stderr)
        sys.exit(1)
