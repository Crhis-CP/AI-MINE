"""Small synthetic Docker archives exercise byte binding without models or Docker."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import release_artifact as artifact

SHA, TREE = "a" * 40, "b" * 40
LAYER = b"synthetic layer content"
CONFIG = json.dumps({"rootfs": {"diff_ids": ["sha256:" + hashlib.sha256(LAYER).hexdigest()]}}).encode()
IMAGE = {"Id": "sha256:" + hashlib.sha256(CONFIG).hexdigest(), "Os": "linux", "Architecture": "amd64", "RootFS": {"Layers": json.loads(CONFIG)["rootfs"]["diff_ids"]}}


def receipt():
    return {"receipt_version": 1, "command": "make verify", "scope": "full", "exit_status": 0, "failed_stage": None,
            "git": {"sha": SHA, "tree": TREE, "tracked_and_untracked_clean_at_start": True, "tracked_and_untracked_clean_at_end": True,
                    "lockfile_sha256": hashlib.sha256(b"synthetic lock").hexdigest()},
            "stages": [{"name": "compose-smoke", "status": "pass"}], "secret_scan": {"fixture": True}, "audit": {"fixture": True},
            "log_digest": "sha256:" + hashlib.sha256(b"synthetic log").hexdigest(),
            "local_rehearsal": {"accepted": True, "boundToInput": True, "source": SHA, "normalImage": IMAGE["Id"]}}


def saved_image(path, compressed=False, damaged=False):
    layer = b"changed layer" if damaged else LAYER
    encoded = gzip.compress(layer) if compressed else layer
    with tarfile.open(path, "w") as saved:
        for name, data in {"config.json": CONFIG, "layer.tar": encoded,
                           "manifest.json": json.dumps([{"Config": "config.json", "Layers": ["layer.tar"]}]).encode()}.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            saved.addfile(entry, io.BytesIO(data))
    return len(encoded)


class ReleaseArtifactTests(unittest.TestCase):
    def test_failed_partial_or_different_receipts_are_rejected(self):
        artifact.validate_receipt(receipt(), SHA, TREE, IMAGE["Id"])
        changes = [("scope", "focused"), ("exit_status", 1), ("stages", [{"name": "compose-smoke", "status": "skipped"}]),
                   ("git", {**receipt()["git"], "tree": "e" * 40}), ("git", {**receipt()["git"], "tracked_and_untracked_clean_at_end": False}),
                   ("local_rehearsal", {**receipt()["local_rehearsal"], "accepted": False}), ("audit", None)]
        for key, value in changes:
            with self.subTest(key=key), self.assertRaises(ValueError):
                artifact.validate_receipt({**receipt(), key: value}, SHA, TREE)
        with self.assertRaises(ValueError):
            artifact.validate_receipt(receipt(), SHA, TREE, "sha256:" + "f" * 64)

    def test_layer_measurement_checks_actual_saved_content(self):
        with tempfile.TemporaryDirectory() as work:
            path = Path(work) / "image.tar"
            for compressed in (False, True):
                encoded = saved_image(path, compressed)
                sizes = artifact.archive_layers(path, IMAGE)
                self.assertEqual(sizes, {"tar_bytes": path.stat().st_size, "layer_blob_bytes": encoded, "layer_tar_bytes": len(LAYER),
                                         "config_id": IMAGE["Id"], "rootfs_layers": IMAGE["RootFS"]["Layers"]})
            saved_image(path, damaged=True)
            with self.assertRaisesRegex(ValueError, "layer content"):
                artifact.archive_layers(path, IMAGE)

    def test_containerd_config_alias_is_bound_to_the_exported_canonical_config(self):
        with tempfile.TemporaryDirectory() as work:
            directory, saved = Path(work), Path(work) / "saved.tar"
            saved_image(saved)
            metadata = {"image": {"id": IMAGE["Id"], "config_id": IMAGE["Id"], "rootfs_layers": IMAGE["RootFS"]["Layers"], "os": "linux", "architecture": "amd64"}}
            manifest = directory / "release-manifest.json"
            manifest.write_text(json.dumps(metadata))
            manifest_hash = artifact.file_info(manifest)["sha256"]
            canonical = "sha256:" + "e" * 64
            process = SimpleNamespace(stdout=io.BytesIO(saved.read_bytes()), poll=lambda: 0, wait=lambda **_: 0, kill=lambda: None)
            with patch.object(artifact, "image_info", return_value={**IMAGE, "Id": canonical}), patch.object(artifact.subprocess, "Popen", return_value=process) as save:
                self.assertEqual(artifact.loaded_image(directory, manifest_hash), canonical)
                self.assertEqual(save.call_args.args[0][-1], canonical)
            # Identical layers with changed execution configuration must still be rejected.
            changed = json.dumps({**json.loads(CONFIG), "config": {"Cmd": ["different"]}}).encode()
            with patch.object(artifact, "image_info", return_value={**IMAGE, "Id": canonical}), patch.object(artifact, "exported_config", return_value=changed):
                with self.assertRaisesRegex(ValueError, "config mismatch"):
                    artifact.loaded_image(directory, manifest_hash)

    def test_export_reuses_verified_image_and_rejects_changed_bundle(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            receipts = root / ".verify/receipts"
            receipts.mkdir(parents=True)
            (receipts / "fixture.json").write_text(json.dumps(receipt()))
            (root / "package-lock.json").write_bytes(b"synthetic lock")
            logs = root / ".verify/logs/fixture"
            logs.mkdir(parents=True)
            (logs / "01-compose-smoke.log").write_bytes(b"synthetic log")
            calls = []

            def command(args):
                calls.append(args)
                if "rev-parse" in args:
                    return TREE if args[-1] == "HEAD^{tree}" else SHA
                if "archive" in args:
                    Path(args[args.index("-o") + 1]).write_bytes(gzip.compress(b"synthetic source archive"))
                elif "inspect" in args:
                    return json.dumps([IMAGE])
                elif "save" in args:
                    self.assertEqual(args[-1], IMAGE["Id"])
                    saved_image(Path(args[args.index("--output") + 1]))
                else:
                    self.assertIn("status", args)
                return ""

            directory = root / ".verify/release"
            with patch.object(artifact, "ROOT", root), patch.object(artifact, "command", command):
                result = artifact.pack(directory, SHA)
            self.assertFalse(any("build" in call or "pull" in call or "tag" in call for call in calls))
            self.assertEqual(set(path.name for path in directory.iterdir()), {*artifact.FILES.values(), "release-manifest.json"})
            manifest = artifact.verify_bundle(directory, SHA, TREE, result["manifest_sha256"])
            self.assertEqual(manifest["image"]["id"], IMAGE["Id"])
            for sha, tree, digest in [("e" * 40, TREE, result["manifest_sha256"]), (SHA, TREE, "f" * 64)]:
                with self.assertRaises(ValueError):
                    artifact.verify_bundle(directory, sha, tree, digest)
            (directory / "image.tar.gz").write_bytes(b"replacement bytes")
            with self.assertRaisesRegex(ValueError, "Artifact bytes changed"):
                artifact.verify_bundle(directory, SHA, TREE, result["manifest_sha256"])


if __name__ == "__main__":
    unittest.main()
