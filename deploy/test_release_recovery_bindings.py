import copy
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

from recovery_bindings import RecoveryBindings, RecoveryBindingError


def image(character):
    return "sha256:" + character * 64


class RecoveryBindingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.directory = "release-" + "a" * 12
        self.snapshot = self.root / self.directory
        self.snapshot.mkdir()
        (self.snapshot / "previous-image.txt").write_text(image("1") + "\n")
        self.database = self.snapshot / "database.dump"
        self.database.write_bytes(b"SYNTHETIC database dump bytes")
        self.programs = {}
        for role in ("api", "web", "worker"):
            self.programs[role] = self.archive(role)
        self.evidence_path = self.snapshot / "restore-evidence.json"
        self.recipe = {"kind": "image_plus_program_overlays", "original_image": image("1"),
                       "runtime_image": image("2"), "recovery_directory": self.directory,
                       "database": self.describe(self.database), "program_overlays": self.programs}
        self.evidence = {"schema_version": 1, "kind": "isolated_program_overlay_restore",
                         **{key: self.recipe[key] for key in ("original_image", "runtime_image", "recovery_directory")},
                         "inputs": {"database": copy.deepcopy(self.recipe["database"]), "program_overlays": copy.deepcopy(self.programs)},
                         "isolation": {"network": "none"}, "checks": {"database_restore": True,
                         "database_read": True, "authentication": True, "services_started": list(self.programs)},
                         "result": "passed", "completed_at": "2020-01-01T00:00:00Z"}
        self.save()
        self.resolver = Mock(return_value=image("2"))

    def describe(self, path):
        data = path.read_bytes()
        return {"path": path.relative_to(self.root).as_posix(), "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}

    def archive(self, role):
        target = self.snapshot / f"{role}-program.tar.gz"
        data = f"synthetic {role} application".encode()
        with tarfile.open(target, "w:gz") as archive:
            member = tarfile.TarInfo("app/package.json")
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
        return self.describe(target)

    def save(self):
        self.evidence_path.write_text(json.dumps(self.evidence))
        self.recipe["restore_evidence"] = self.describe(self.evidence_path)
        (self.root / "recovery-bindings.json").write_text(json.dumps({"schema_version": 1, "bindings": [self.recipe]}))

    def resolve(self):
        return RecoveryBindings(self.root, self.resolver).resolve(image("1"), self.directory)

    def second_snapshot(self, runtime=None):
        directory = "release-" + "b" * 12
        snapshot = self.root / directory
        snapshot.mkdir()
        (snapshot / "previous-image.txt").write_text(image("1"))
        (snapshot / "database.dump").write_bytes(b"SYNTHETIC different database")
        programs = {}
        for role, descriptor in self.programs.items():
            archive = snapshot / f"{role}-program.tar.gz"
            archive.write_bytes((self.root / descriptor["path"]).read_bytes())
            programs[role] = self.describe(archive)
        recipe = {**self.recipe, "recovery_directory": directory, "runtime_image": runtime or image("2"),
                  "database": self.describe(snapshot / "database.dump"), "program_overlays": programs}
        evidence = copy.deepcopy(self.evidence)
        evidence.update(recovery_directory=directory, runtime_image=recipe["runtime_image"],
                        inputs={"database": recipe["database"], "program_overlays": programs})
        receipt = snapshot / "restore-evidence.json"
        receipt.write_text(json.dumps(evidence))
        recipe["restore_evidence"] = self.describe(receipt)
        (self.root / "recovery-bindings.json").write_text(json.dumps({"schema_version": 1, "bindings": [self.recipe, recipe]}))
        return directory

    def test_one_proved_snapshot_does_not_authorize_another_predecessor_directory(self):
        verifier = RecoveryBindings(self.root, self.resolver)
        verifier.resolve(image("1"), self.directory)
        other = self.root / ("release-" + "b" * 12)
        other.mkdir(); (other / "previous-image.txt").write_text(image("1"))
        (other / "database.dump").write_bytes(b"SYNTHETIC unproved database")
        with self.assertRaisesRegex(RecoveryBindingError, "Missing explicit"):
            verifier.resolve(image("1"), other.name)

    def test_same_original_snapshots_are_independent_and_candidate_checks_every_recipe(self):
        other = self.second_snapshot()
        verifier = RecoveryBindings(self.root, self.resolver)
        with patch.object(verifier, "_hash", wraps=verifier._hash) as digest:
            for directory in (self.directory, other):
                self.assertEqual(verifier.resolve(image("1"), directory), image("2"))
            self.assertEqual(verifier.resolve_candidate(image("1")), image("2"))
            self.assertEqual(digest.call_count, 8, "each database and role set is hashed and cached separately")
        (self.root / other / "database.dump").write_bytes(b"SYNTHETIC changed database")
        self.assertEqual(verifier.resolve(image("1"), self.directory), image("2"))
        with self.assertRaises(RecoveryBindingError): verifier.resolve(image("1"), other)
        with self.assertRaises(RecoveryBindingError): verifier.resolve_candidate(image("1"))

    def test_candidate_requires_a_recipe_and_one_canonical_runtime(self):
        verifier = RecoveryBindings(self.root, self.resolver)
        with self.assertRaises(RecoveryBindingError): verifier.resolve_candidate(image("9"))
        self.second_snapshot(image("3"))
        self.resolver.side_effect = lambda immutable: immutable
        with self.assertRaisesRegex(RecoveryBindingError, "runtimes disagree"):
            verifier.resolve_candidate(image("1"))

    def test_valid_recipe_and_cache_are_limited_to_this_instance(self):
        verifier = RecoveryBindings(self.root, self.resolver)
        with patch.object(verifier, "_hash", wraps=verifier._hash) as digest:
            self.assertEqual(verifier.resolve(image("1"), self.directory), image("2"))
            self.assertEqual(verifier.resolve(image("1"), self.directory), image("2"))
            self.assertEqual(digest.call_count, 4)
        self.assertEqual(self.resolver.call_count, 2, "Docker availability is checked even on a content-cache hit")
        fresh = RecoveryBindings(self.root, self.resolver)
        with patch.object(fresh, "_hash", wraps=fresh._hash) as digest:
            self.assertEqual(fresh.resolve(image("1"), self.directory), image("2"))
            self.assertEqual(digest.call_count, 4)

    def test_legacy_four_roles_are_supported_without_inventing_unified_api(self):
        del self.programs["api"]
        for role in ("public-api", "private-api"):
            self.programs[role] = self.archive(role)
        self.evidence["inputs"]["program_overlays"] = copy.deepcopy(self.programs)
        self.evidence["checks"]["services_started"] = list(self.programs)
        self.save()
        self.assertEqual(self.resolve(), image("2"))

    def test_missing_registry_missing_binding_and_duplicate_binding_fail_closed(self):
        registry = self.root / "recovery-bindings.json"
        for value in [None, {"schema_version": 1, "bindings": []},
                      {"schema_version": 1, "bindings": [self.recipe, self.recipe]}]:
            with self.subTest(value=value):
                if value is None:
                    registry.unlink()
                    RecoveryBindings(self.root, self.resolver)  # Unused fallback remains lazy.
                else:
                    registry.write_text(json.dumps(value))
                with self.assertRaises(RecoveryBindingError): self.resolve()

    def test_incomplete_roles_wrong_snapshot_and_predecessor_mismatch_are_rejected(self):
        original = copy.deepcopy(self.recipe)
        for mutate in [lambda: self.recipe["program_overlays"].pop("worker"),
                       lambda: self.recipe.update(recovery_directory="release-20261020"),
                       lambda: self.recipe["database"].update(path="release-" + "b" * 12 + "/database.dump"),
                       lambda: (self.snapshot / "previous-image.txt").write_text(image("9"))]:
            self.recipe = copy.deepcopy(original)
            mutate(); self.save()
            with self.assertRaises(RecoveryBindingError): self.resolve()

    def test_changed_bytes_invalidate_cache_even_when_size_and_mtime_match(self):
        import os
        verifier = RecoveryBindings(self.root, self.resolver)
        verifier.resolve(image("1"), self.directory)
        before = self.database.stat()
        self.database.write_bytes(b"X" * before.st_size)
        os.utime(self.database, ns=(before.st_atime_ns, before.st_mtime_ns))
        with self.assertRaisesRegex(RecoveryBindingError, "hash"): verifier.resolve(image("1"), self.directory)

    def test_cached_predecessor_and_inputs_changed_during_resolution_fail_closed(self):
        verifier = RecoveryBindings(self.root, self.resolver)
        verifier.resolve(image("1"), self.directory)
        (self.snapshot / "previous-image.txt").write_text(image("9"))
        with self.assertRaisesRegex(RecoveryBindingError, "predecessor"): verifier.resolve(image("1"), self.directory)
        (self.snapshot / "previous-image.txt").write_text(image("1"))
        def changed(_image):
            self.database.write_bytes(b"X" * self.database.stat().st_size)
            return image("2")
        self.resolver.side_effect = changed
        with self.assertRaisesRegex(RecoveryBindingError, "changed during validation"): verifier.resolve(image("1"), self.directory)

    def test_symlinked_files_directory_and_root_are_rejected(self):
        original = self.database.read_bytes()
        other = self.root / "other.dump"; other.write_bytes(original)
        self.database.unlink(); self.database.symlink_to(other)
        with self.assertRaises(RecoveryBindingError): self.resolve()
        self.database.unlink(); self.database.write_bytes(original)
        relocated = self.root / "real-directory"; self.snapshot.rename(relocated); self.snapshot.symlink_to(relocated, target_is_directory=True)
        with self.assertRaises(RecoveryBindingError): self.resolve()
        alias = self.root / "root-link"; alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(RecoveryBindingError): RecoveryBindings(alias, self.resolver).resolve(image("1"), self.directory)

    def test_absolute_parent_and_cross_snapshot_evidence_paths_are_rejected(self):
        original = copy.deepcopy(self.recipe)
        for value in [str(self.evidence_path), "../restore-evidence.json", self.directory + "/../restore-evidence.json"]:
            self.recipe = copy.deepcopy(original)
            self.recipe["restore_evidence"]["path"] = value
            (self.root / "recovery-bindings.json").write_text(json.dumps({"schema_version": 1, "bindings": [self.recipe]}))
            with self.assertRaises(RecoveryBindingError): self.resolve()
        outside = self.root / "restore-evidence.json"; outside.write_bytes(self.evidence_path.read_bytes())
        self.recipe["restore_evidence"] = self.describe(outside)
        (self.root / "recovery-bindings.json").write_text(json.dumps({"schema_version": 1, "bindings": [self.recipe]}))
        with self.assertRaises(RecoveryBindingError): self.resolve()

    def test_failed_unbound_or_nonisolated_restore_evidence_is_rejected(self):
        original = copy.deepcopy(self.evidence)
        for mutate in [lambda: self.evidence.update(kind="generic_success"),
                       lambda: self.evidence.update(schema_version=2),
                       lambda: self.evidence.update(original_image=image("9")),
                       lambda: self.evidence.update(runtime_image=image("9")),
                       lambda: self.evidence.update(recovery_directory="release-" + "b" * 12),
                       lambda: self.evidence["inputs"]["database"].update(sha256="0" * 64),
                       lambda: self.evidence["isolation"].update(network="bridge"),
                       lambda: self.evidence["checks"].update(authentication=False),
                       lambda: self.evidence["checks"].update(authentication=1),
                       lambda: self.evidence["checks"].update(database_restore=False),
                       lambda: self.evidence["checks"].update(database_read=False),
                       lambda: self.evidence["checks"].update(services_started=["api", "web"]),
                       lambda: self.evidence.update(result="pending"),
                       lambda: self.evidence.update(completed_at=None),
                       lambda: self.evidence.update(completed_at="not-a-date")]:
            self.evidence = copy.deepcopy(original)
            mutate(); self.save()
            with self.assertRaises(RecoveryBindingError): self.resolve()

    def test_changed_receipt_missing_archive_and_missing_runtime_fail_closed(self):
        self.evidence_path.write_text("{}")
        with self.assertRaises(RecoveryBindingError): self.resolve()
        self.save()
        self.resolver.side_effect = RuntimeError("synthetic Docker image missing")
        with self.assertRaisesRegex(RecoveryBindingError, "runtime image"): self.resolve()
        self.resolver.side_effect = None; self.resolver.return_value = "mutable-tag:latest"
        with self.assertRaises(RecoveryBindingError): self.resolve()
        (self.snapshot / "worker-program.tar.gz").unlink()
        with self.assertRaises(RecoveryBindingError): self.resolve()


if __name__ == "__main__":
    unittest.main()
