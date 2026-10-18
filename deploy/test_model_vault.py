import base64
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("vault", Path(__file__).with_name("ensure_model_vault.py"))
vault = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vault)


class VaultSetup(unittest.TestCase):
    def test_first_setup_survives_program_rollback_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as folder:
            live, backup = Path(folder) / "live", Path(folder) / "backup"
            live.write_text("APP_IMAGE=new\nOTHER=preserved\n")
            backup.write_text("APP_IMAGE=old\nOTHER=preserved\n")
            self.assertEqual(vault.ensure_vault(live, backup, 0), "ready")
            key = vault.read_key(live.read_text())
            self.assertEqual(len(base64.b64decode(key)), 32)
            self.assertEqual(vault.read_key(backup.read_text()), key)
            self.assertIn("APP_IMAGE=old", backup.read_text())
            self.assertIn("OTHER=preserved", live.read_text())
            self.assertEqual(live.stat().st_mode & 0o777, 0o600)
            before = live.read_bytes(), backup.read_bytes()
            vault.ensure_vault(live, backup, 4)
            self.assertEqual(before, (live.read_bytes(), backup.read_bytes()))

    def test_missing_existing_key_or_conflicting_key_never_overwrites(self):
        for first, second, count in [
            ("OTHER=one\n", "OTHER=two\n", 1),
            ("MODEL_REGISTRY_ENCRYPTION_KEY=malformed\n", "OTHER=two\n", 0),
            ("MODEL_REGISTRY_ENCRYPTION_KEY=" + base64.b64encode(b"a" * 32).decode(), "MODEL_REGISTRY_ENCRYPTION_KEY=" + base64.b64encode(b"b" * 32).decode(), 1),
        ]:
            with self.subTest(count=count), tempfile.TemporaryDirectory() as folder:
                live, backup = Path(folder) / "live", Path(folder) / "backup"
                live.write_text(first)
                backup.write_text(second)
                with self.assertRaises(ValueError):
                    vault.ensure_vault(live, backup, count)
                self.assertEqual(live.read_text(), first)
                self.assertEqual(backup.read_text(), second)

    def test_existing_key_is_preserved_and_added_to_rollback(self):
        with tempfile.TemporaryDirectory() as folder:
            live, backup = Path(folder) / "live", Path(folder) / "backup"
            value = base64.b64encode(b"c" * 32).decode()
            live.write_text('MODEL_REGISTRY_ENCRYPTION_KEY="' + value + '" # existing key\n')
            backup.write_text("APP_IMAGE=old\n")
            vault.ensure_vault(live, backup, 2)
            self.assertEqual(vault.read_key(backup.read_text()), value)
            self.assertEqual(vault.read_key(live.read_text()), value)


if __name__ == "__main__":
    unittest.main()
