import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
import prepare_capacity as preparation


class PreparationTests(unittest.TestCase):
    def test_config_and_manifest_aliases_protect_the_same_existing_image(self):
        manifest = "sha256:" + "b"*64
        config = "sha256:" + "a"*64
        with patch.object(preparation, "command", side_effect=lambda *args: manifest if args[-1] in {manifest, config} else ""):
            self.assertEqual(preparation.canonical_images({manifest, config}), {manifest})
            with self.assertRaisesRegex(ValueError, "unavailable"):
                preparation.canonical_images({"missing"})

    def test_only_identical_program_bytes_share_an_inode_and_all_recovery_paths_survive(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            release = root / ("release-" + "a"*12)
            release.mkdir()
            for role in ["api", "web", "worker"]:
                (release / f"{role}-program.tar.gz").write_bytes(b"synthetic immutable program"*500)
            database = release / "database.dump"
            database.write_bytes(b"synthetic immutable program"*500)
            original = database.read_bytes()
            plan = preparation.program_plan(root)
            self.assertEqual(len(plan["aliases"]), 2)
            self.assertGreater(plan["reclaimable_bytes"], 0)
            preparation.compact(plan)
            self.assertEqual(len({(release/f"{role}-program.tar.gz").stat().st_ino for role in ["api","web","worker"]}),1)
            self.assertNotEqual(database.stat().st_ino,(release/"api-program.tar.gz").stat().st_ino)
            self.assertEqual(database.read_bytes(),original)
            self.assertEqual(preparation.program_plan(root)["aliases"],[])

    def test_changed_bytes_symlinks_and_different_permissions_do_not_get_compacted(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            release=root/("release-"+"b"*12)
            release.mkdir()
            first=release/"api-program.tar.gz"; second=release/"web-program.tar.gz"
            first.write_bytes(b"first"); second.write_bytes(b"first")
            (release/"worker-program.tar.gz").symlink_to(first)
            plan=preparation.program_plan(root)
            second.write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError,"changed"):
                preparation.compact(plan)
            self.assertEqual(second.read_bytes(),b"changed")
            second.write_bytes(b"first"); second.chmod(0o400)
            self.assertEqual(preparation.program_plan(root)["aliases"],[])


if __name__ == "__main__":
    unittest.main()
