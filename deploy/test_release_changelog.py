import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest

spec = importlib.util.spec_from_file_location("release_changelog", Path(__file__).with_name("release_changelog.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RegistrationTests(unittest.TestCase):
    def test_pending_survives_failure_and_retries_original_date(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / ".ops").mkdir()
            sha = "a" * 40
            module.save_pending(root, sha, "2026-10-13T19:00:00Z")
            module.save_pending(root, sha, "2026-10-14T19:00:00Z")
            target = Path(root) / ".ops/changelog-pending.json"
            self.assertFalse(module.retry_pending(root, "b" * 12))
            self.assertFalse(module.retry_pending(root, sha[:12], lambda *a, **k: types.SimpleNamespace(returncode=1)))
            self.assertTrue(target.exists())
            with self.assertRaises(RuntimeError):
                module.save_pending(root, "b" * 40, "2026-10-14T19:00:00Z")
            calls = []
            def succeed(args, **kwargs):
                calls.append(args)
                return types.SimpleNamespace(returncode=0)
            self.assertTrue(module.retry_pending(root, sha[:12], succeed))
            self.assertEqual(calls[0][-1], "2026-10-13T19:00:00Z")
            self.assertFalse(target.exists())
            self.assertTrue(module.retry_pending(root, sha[:12], succeed))
            self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
