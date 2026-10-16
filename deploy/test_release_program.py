"""Exercise the exact program archive command using synthetic local directories."""
import io
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("production-release.sh").read_text()
COMMAND = re.search(r'docker exec "amp-\$role-1" sh -c \'\n(.*?)\n  \' > "\$RELEASE_BACKUP/\$role-program.tar.gz"', SCRIPT, re.S).group(1)


class ProgramArchiveTests(unittest.TestCase):
    def archive(self, extensions):
        with tempfile.TemporaryDirectory(prefix="program archive ") as temporary:
            root = Path(temporary)
            for name in ["apps", "packages", "industry", "scripts", "assets", "reference", "database", "deploy", "node_modules", *extensions]:
                (root / name).mkdir()
                (root / name / "synthetic.txt").write_text(name)
            for name in ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]:
                (root / name).write_text("synthetic")
            (root / ".env").write_text("synthetic private fixture")
            command = COMMAND.replace('"/app/$extra"', '"$FIXTURE_ROOT/$extra"').replace('-C /app', '-C "$FIXTURE_ROOT"')
            result = subprocess.run(["sh", "-c", command], env={"PATH": os.defpath, "FIXTURE_ROOT": str(root)}, check=True, capture_output=True)
            with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:gz") as archive:
                names = archive.getnames()
                self.assertNotIn(".env", names)
                self.assertIn("apps/synthetic.txt", names)
                for name in extensions:
                    self.assertEqual(archive.extractfile(f"{name}/synthetic.txt").read().decode(), name)
                return names

    def test_previous_release_without_extensions_is_still_archived(self):
        names = self.archive([])
        self.assertNotIn("site", names)
        self.assertNotIn("modules", names)

    def test_site_and_extension_code_are_kept_with_the_program(self):
        self.archive(["site", "modules"])


if __name__ == "__main__":
    unittest.main()
