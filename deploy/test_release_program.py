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
    def test_failed_dependency_install_preserves_previous_maintenance_entry(self):
        lines = [line for line in SCRIPT.splitlines() if line.startswith("install -m") and "/usr/local/lib/aimine-maintenance/" in line]
        with tempfile.TemporaryDirectory(prefix="maintenance install ") as temporary:
            root = Path(temporary)
            stage, target = root / "stage", root / "maintenance"
            (stage / "deploy").mkdir(parents=True)
            target.mkdir()
            previous = b"print('previous maintenance entry remains usable')\n"
            entry = target / "release-retention.py"
            entry.write_bytes(previous)
            for name in ("release-retention.py", "release_changelog.py"):
                (stage / "deploy" / name).write_bytes(Path(__file__).with_name(name).read_bytes())
            command = "set -e\n" + "\n".join(lines).replace("/usr/local/lib/aimine-maintenance", '"$MAINTENANCE_TARGET"')
            env = {"PATH": os.defpath, "RELEASE_STAGE": str(stage), "MAINTENANCE_TARGET": str(target), "PYTHONPATH": str(target)}
            failed = subprocess.run(["bash", "-c", command], env=env, capture_output=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual(entry.read_bytes(), previous)
            subprocess.run(["python3", "-B", str(entry)], env=env, check=True, capture_output=True)
            name = "recovery_bindings.py"
            (stage / "deploy" / name).write_bytes(Path(__file__).with_name(name).read_bytes())
            subprocess.run(["bash", "-c", command], env=env, check=True, capture_output=True)
            subprocess.run(["python3", "-B", "-c", "import runpy,sys; runpy.run_path(sys.argv[1], run_name='verification')", str(entry)],
                           env=env, check=True, capture_output=True)

    def test_only_new_byte_identical_archives_share_storage_and_keep_role_paths(self):
        reuse = re.search(r"reuse_identical_program\(\) \{\n.*?\n\}", SCRIPT, re.S).group(0)
        with tempfile.TemporaryDirectory(prefix="program reuse ") as temporary:
            root = Path(temporary)
            first, duplicate, different = [root / name for name in ("api.tar.gz", "web.tar.gz", "worker.tar.gz")]
            first.write_bytes(b"same program archive")
            duplicate.write_bytes(first.read_bytes())
            different.write_bytes(b"unique role overlay")
            original_inode = first.stat().st_ino
            command = 'set -e\n' + reuse + '\nreuse_identical_program "$1" "$1"\nreuse_identical_program "$1" "$2"\nreuse_identical_program "$1" "$3"'
            subprocess.run(["bash", "-c", command, "reuse", str(first), str(duplicate), str(different)], check=True)
            self.assertEqual(first.stat().st_ino, original_inode)
            self.assertEqual(duplicate.stat().st_ino, original_inode)
            self.assertEqual(duplicate.read_bytes(), b"same program archive")
            self.assertNotEqual(different.stat().st_ino, original_inode)
            self.assertEqual(different.read_bytes(), b"unique role overlay")

    def archive(self, extensions, lockfiles=("pnpm-lock.yaml", "pnpm-workspace.yaml")):
        with tempfile.TemporaryDirectory(prefix="program archive ") as temporary:
            root = Path(temporary)
            for name in ["apps", "packages", "industry", "scripts", "assets", "reference", "database", "deploy", "node_modules", *extensions]:
                (root / name).mkdir()
                (root / name / "synthetic.txt").write_text(name)
            for name in ["package.json", *lockfiles]:
                (root / name).write_text("synthetic")
            (root / ".env").write_text("synthetic private fixture")
            command = COMMAND.replace('"/app/$extra"', '"$FIXTURE_ROOT/$extra"').replace('-C /app', '-C "$FIXTURE_ROOT"')
            result = subprocess.run(["sh", "-c", command], env={"PATH": os.defpath, "FIXTURE_ROOT": str(root)}, check=True, capture_output=True)
            with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:gz") as archive:
                names = archive.getnames()
                self.assertNotIn(".env", names)
                for name in lockfiles:
                    self.assertIn(name, names)
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

    def test_npm_release_keeps_lock_and_install_configuration(self):
        self.archive(["site", "modules"], ("package-lock.json", ".npmrc"))


if __name__ == "__main__":
    unittest.main()
