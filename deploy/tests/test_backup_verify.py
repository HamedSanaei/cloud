import hashlib
import importlib.util
import io
import tarfile
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "backup_verify", Path(__file__).parents[1] / "scripts/backup-verify.py"
)
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class RecoveryBoundaries(unittest.TestCase):
    def test_recovery_targets_can_never_name_the_live_database(self):
        for name in (
            "cloud",
            "postgres",
            "restore_verify_",
            'restore_verify_";DROP DATABASE cloud;--',
        ):
            with self.assertRaises(ValueError):
                recovery.recovery_database(name)
        name = "restore_verify_" + "a" * 24
        self.assertEqual(recovery.recovery_database(name), name)

    def test_configuration_and_effective_runtime_round_trip_without_plaintext_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "deploy.env"
            path.write_text("TEST_FIXTURE=not-a-secret\n")
            # arcname on Windows is not a POSIX deployment path; extra members
            # exercise the same checksum verifier without filesystem extraction.
            archive, hashes = recovery.config_archive(
                [], {"runtime/inspect.json": path.read_bytes()}
            )
            recovery.verify_config_restore(archive, hashes)
            hashes["runtime/inspect.json"] = hashlib.sha256(b"tampered").hexdigest()
            with self.assertRaises(ValueError):
                recovery.verify_config_restore(archive, hashes)

    def test_missing_configuration_is_not_silently_omitted(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(ValueError):
                recovery.config_archive([Path(temporary) / "missing"])

    def test_unsafe_archive_members_are_rejected(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            member = tarfile.TarInfo("../outside")
            archive.addfile(member, io.BytesIO())
        with self.assertRaises(ValueError):
            recovery.verify_config_restore(buffer.getvalue(), {})


if __name__ == "__main__":
    unittest.main()
