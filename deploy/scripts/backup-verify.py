"""Encrypted two-stack recovery point; verify restores without touching live data.

Run on the deployment host before configuration changes. Nothing is printed from
configuration, databases or decrypted archives. Restores use temporary databases
in the existing PostgreSQL containers, never another runtime or Telegram poller.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


def dotenv(path: Path) -> dict[str, str]:
    result = {}
    for line in path.read_text().splitlines():
        if line and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            result[key.strip()] = value.strip().strip("\"'")
    return result


def recovery_database(name: str) -> str:
    if not re.fullmatch(r"restore_verify_[a-f0-9]{24}", name):
        raise ValueError("invalid isolated recovery database name")
    return name


def run(command: list[str], **kwargs):
    return subprocess.run(command, check=True, stderr=subprocess.PIPE, **kwargs)


class Vault:
    def __init__(self, key: str, home: str):
        if len(key) < 32:
            raise ValueError("BACKUP_ENCRYPTION_KEY is missing or too short")
        self.key, self.home = key, home

    def start(self, arguments: list[str], **kwargs):
        reader, writer = os.pipe()
        try:
            os.write(writer, (self.key + "\n").encode())
            os.close(writer)
            return subprocess.Popen(
                [
                    "gpg",
                    "--homedir",
                    self.home,
                    "--batch",
                    "--yes",
                    "--pinentry-mode",
                    "loopback",
                    "--no-symkey-cache",
                    "--passphrase-fd",
                    str(reader),
                    *arguments,
                ],
                pass_fds=(reader,),
                stderr=subprocess.PIPE,
                **kwargs,
            )
        finally:
            os.close(reader)

    def decrypt(self, path: Path):
        return self.start(["--decrypt", str(path)], stdout=subprocess.PIPE)


def config_archive(
    files: list[Path], extra: dict[str, bytes] | None = None
) -> tuple[bytes, dict[str, str]]:
    contents, hashes = io.BytesIO(), {}
    with tarfile.open(fileobj=contents, mode="w") as archive:
        for path in sorted(set(files)):
            if not path.is_file():
                raise ValueError("required recovery configuration does not exist")
            archive.add(path, arcname=str(path).lstrip("/"), recursive=False)
            hashes[str(path).lstrip("/")] = hashlib.sha256(path.read_bytes()).hexdigest()
        for name, data in (extra or {}).items():
            member = tarfile.TarInfo(name)
            member.size, member.mode = len(data), 0o600
            archive.addfile(member, io.BytesIO(data))
            hashes[name] = hashlib.sha256(data).hexdigest()
    return contents.getvalue(), hashes


def verify_config_restore(payload: bytes, expected: dict[str, str]) -> None:
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r") as archive:
        observed = {}
        for member in archive.getmembers():
            if (
                not member.isfile()
                or member.name.startswith("/")
                or ".." in Path(member.name).parts
            ):
                raise ValueError("unsafe recovery archive member")
            stream = archive.extractfile(member)
            if stream is None:
                raise ValueError("unreadable recovery configuration")
            observed[member.name] = hashlib.sha256(stream.read()).hexdigest()
        if observed != expected:
            raise ValueError("configuration restore checksum mismatch")


def backup_database(vault: Vault, directory: Path, container: str) -> dict:
    output = directory / (container + ".dump.gpg")
    dump = subprocess.Popen(
        ["docker", "exec", container, "pg_dump", "-U", "cloud", "-d", "cloud", "-Fc"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    encrypted = vault.start(
        [
            "--symmetric",
            "--cipher-algo",
            "AES256",
            "--compress-algo",
            "none",
            "--output",
            str(output),
        ],
        stdin=dump.stdout,
    )
    dump.stdout.close()
    encrypted.communicate()
    dump.communicate()
    if dump.returncode or encrypted.returncode:
        raise RuntimeError("encrypted database backup failed")
    output.chmod(0o600)
    scratch = recovery_database("restore_verify_" + uuid4().hex[:24])
    psql = [
        "docker",
        "exec",
        container,
        "psql",
        "-U",
        "cloud",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-Atc",
    ]
    run([*psql, f'CREATE DATABASE "{scratch}"'], stdout=subprocess.PIPE)
    try:
        decrypted = vault.decrypt(output)
        restore = subprocess.Popen(
            [
                "docker",
                "exec",
                "-i",
                container,
                "pg_restore",
                "-U",
                "cloud",
                "-d",
                scratch,
                "--exit-on-error",
                "--no-owner",
                "--no-privileges",
            ],
            stdin=decrypted.stdout,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        decrypted.stdout.close()
        restore.communicate()
        decrypted.communicate()
        if decrypted.returncode or restore.returncode:
            raise RuntimeError("isolated database restore failed")
        check = run(
            [
                "docker",
                "exec",
                container,
                "psql",
                "-U",
                "cloud",
                "-d",
                scratch,
                "-Atc",
                "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')",
            ],
            stdout=subprocess.PIPE,
        )
        tables = int(check.stdout)
        if tables < 1:
            raise ValueError("isolated restore has no application tables")
    finally:
        # This exact, freshly created name can never select a production DB.
        recovery_database(scratch)
        run([*psql, f'DROP DATABASE "{scratch}"'], stdout=subprocess.PIPE)
    return {
        "file": output.name,
        "bytes": output.stat().st_size,
        "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "restore": "passed",
        "tables": tables,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--website-path", type=Path, required=True)
    parser.add_argument("--platform-path", type=Path, required=True)
    parser.add_argument("--platform-config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    args.output.mkdir(parents=True, mode=0o700, exist_ok=False)
    manifest = {"createdAt": datetime.now(timezone.utc).isoformat(), "databases": []}
    env_file = args.website_path / ".env"
    files = [
        env_file,
        args.website_path / "configuration.toml",
        args.website_path / "compose.yml",
        args.platform_path / "docker-compose.yml",
        args.platform_path / "deploy.env",
        args.platform_config,
        Path.home() / ".ssh/authorized_keys",
    ]
    for directory in [args.website_path, args.platform_path]:
        files.extend(p for p in directory.glob("*.yml") if p.is_file())
    runtime, historical = {}, []
    for container in [
        "tofan-cloud",
        "tofan-cloud-api",
        "tofan-cloud-worker",
        "tofan-cloud-postgres",
        "tofan-cloud-redis",
        "cloud-platform-production-api-1",
        "cloud-platform-production-worker-1",
        "cloud-platform-production-bot-1",
        "cloud-platform-production-postgres-1",
        "cloud-platform-production-redis-1",
    ]:
        data = json.loads(run(["docker", "inspect", container], stdout=subprocess.PIPE).stdout)[0]
        runtime[container] = data
        for name in data["Config"]["Labels"]["com.docker.compose.project.config_files"].split(","):
            path = Path(name)
            if path.is_file():
                files.append(path)
            else:
                historical.append(name)  # promoted candidate paths legitimately disappear
    manifest["historicalComposePaths"] = sorted(set(historical))
    archive, hashes = config_archive(
        files, {"runtime/docker-inspect.json": json.dumps(runtime).encode()}
    )
    with tempfile.TemporaryDirectory(prefix="backup-gpg-") as home:
        vault = Vault(dotenv(env_file).get("BACKUP_ENCRYPTION_KEY", ""), home)
        config_file = args.output / "configuration.tar.gpg"
        process = vault.start(
            ["--symmetric", "--cipher-algo", "AES256", "--output", str(config_file)],
            stdin=subprocess.PIPE,
        )
        process.communicate(archive)
        if process.returncode:
            raise RuntimeError("configuration encryption failed")
        process = vault.decrypt(config_file)
        restored, _ = process.communicate()
        if process.returncode:
            raise RuntimeError("configuration decryption failed")
        verify_config_restore(restored, hashes)
        manifest["configuration"] = {
            "file": config_file.name,
            "sha256": hashlib.sha256(config_file.read_bytes()).hexdigest(),
            "restore": "passed",
            "files": len(hashes),
        }
        for container in ["tofan-cloud-postgres", "cloud-platform-production-postgres-1"]:
            manifest["databases"].append(backup_database(vault, args.output, container))
        run(["gpgconf", "--homedir", home, "--kill", "gpg-agent"], stdout=subprocess.PIPE)
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"recoveryPoint": str(args.output), **manifest}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Child stderr / configuration values are deliberately not printed.
        print("Backup/restore verification failed: " + type(error).__name__)
        raise SystemExit(1) from None
