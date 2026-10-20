"""Release admission uses distinct stages and preserves failed evidence."""
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
import release_capacity as capacity

MIB = 1024 ** 2
MANIFEST = {"source": {"sha": "a" * 40, "tree": "b" * 40, "tar_bytes": 50 * MIB},
            "image": {"bytes": 200 * MIB, "tar_bytes": 400 * MIB, "layer_blob_bytes": 390 * MIB, "layer_tar_bytes": 390 * MIB}}
PREVIOUS = {"dump_bytes": 200 * MIB, "program_named_bytes": 50 * MIB}
FILESYSTEM = {"path": "/synthetic", "device": "1", "available_bytes": 8 * capacity.GIB, "inodes_total": 100000, "inodes_available": 90000}
OBSERVED = {"root": FILESYSTEM, "backup": FILESYSTEM, "memory_available_bytes": 2 * capacity.GIB}


class CapacityTests(unittest.TestCase):
    def test_stages_take_max_and_loaded_gzip_is_not_budgeted_twice(self):
        result = capacity.evaluate(MANIFEST, PREVIOUS, OBSERVED, "before_import")
        self.assertTrue(result["passed"])
        self.assertEqual(len(result["filesystems"]), 1)
        self.assertEqual(result["filesystems"][0]["estimated_peak_additional_bytes"], max(value["1"] for value in result["stage_estimates"].values()))
        changed = copy.deepcopy(MANIFEST)
        changed["image"]["bytes"] *= 100
        self.assertEqual(capacity.evaluate(changed, PREVIOUS, OBSERVED, "before_import"), result)
        constrained = {**OBSERVED, "root": {**FILESYSTEM, "available_bytes": 2 * capacity.GIB}, "backup": {**FILESYSTEM, "available_bytes": 2 * capacity.GIB}}
        self.assertFalse(capacity.evaluate(MANIFEST, PREVIOUS, constrained, "before_import")["passed"])
        later = capacity.evaluate(MANIFEST, PREVIOUS, constrained, "before_backup")
        self.assertTrue(later["passed"])
        self.assertEqual(later["filesystems"][0]["estimated_peak_additional_bytes"], 300 * MIB)
        separated = capacity.evaluate(MANIFEST, PREVIOUS, {**OBSERVED, "backup": {**FILESYSTEM, "device": "2"}}, "before_backup")
        self.assertEqual({row["device"]: row["estimated_peak_additional_bytes"] for row in separated["filesystems"]}, {"1": 50 * MIB, "2": 250 * MIB})
        for change in [{"memory_available_bytes": capacity.GIB - 1}, {"root": {**FILESYSTEM, "inodes_available": 0}}]:
            self.assertFalse(capacity.evaluate(MANIFEST, PREVIOUS, {**OBSERVED, **change}, "before_import")["passed"])

    def test_missing_backup_blocks_release_and_failed_record_is_preserved(self):
        with tempfile.TemporaryDirectory() as work:
            root, record = Path(work), Path(work) / "evidence.json"
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps(MANIFEST))
            with patch.object(capacity, "filesystem", return_value=FILESYSTEM), patch.object(capacity, "memory_available", return_value=2 * capacity.GIB):
                result = capacity.preflight(root, root, manifest, record, "before_import")
                self.assertFalse(result["passed"])
                self.assertIn("No completed release backup", result["error"])
                before = record.read_bytes()
                with self.assertRaises(FileExistsError):
                    capacity.preflight(root, root, manifest, record, "before_import")
                self.assertEqual(record.read_bytes(), before)
            for name, stamp in [("release-" + "c" * 12, 1), ("release-" + "d" * 12 + "-20261020T000000000000000", 2)]:
                point = root / name
                point.mkdir()
                for filename in ("database.dump", "backup-sha256.txt", "api-program.tar.gz"):
                    (point / filename).write_bytes(b"synthetic completed size sample")
                os.utime(point / "database.dump", (stamp, stamp))
            self.assertEqual(capacity.latest_backup(root)["path"], str(point))

    def test_monitor_writes_actual_samples_and_exits_on_term(self):
        with tempfile.TemporaryDirectory() as work:
            output = Path(work) / "observed.jsonl"
            # Use the PID visible through procfs even on executors with a separate PID namespace.
            parent = Path("/proc/self/stat").read_text().split(" ", 1)[0]
            process = subprocess.Popen(["python3", "-B", str(Path(capacity.__file__)), "monitor", "--root", work, "--output", str(output), "--parent", parent])
            try:
                for _ in range(50):
                    if output.exists() and output.stat().st_size:
                        break
                    time.sleep(0.02)
                process.terminate()
                self.assertEqual(process.wait(timeout=3), 0)
                row = json.loads(output.read_text().splitlines()[0])
                self.assertGreater(row["filesystem"]["available_bytes"], 0)
                self.assertGreater(row["memory_available_bytes"], 0)
                self.assertIn("+00:00", row["at"])
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()


if __name__ == "__main__":
    unittest.main()
