import argparse
import importlib.util
import hashlib
import json
import re
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("retention", Path(__file__).with_name("release-retention.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = 1791810000


def ident(i):
    return "sha256:" + str(i) * 64


def fixture():
    names = [*m.APP_NAMES, "/amp-db-1", "/amp-caddy-1"]
    containers = [{"name": name, "image": ident(1 if name in m.APP_NAMES else 9), "running": True, "started": "2026-10-10T00:00:00Z"} for name in names]
    images = {ident(i): {"id": ident(i), "created": "2026-10-09T00:00:00Z", "tags": [f"amp-release:release{i}"]} for i in range(1, 10)}
    images[ident(4)]["tags"] = ["amp-app:latest"]
    images[ident(8)]["tags"] = ["unrelated:keep"]
    return containers, images


class RetentionTests(unittest.TestCase):
    def backup(self, root, suffix, previous, candidate, persistent=False):
        directory = root / ("release-" + f"{suffix:012x}")
        directory.mkdir()
        payloads = {name: (name + str(suffix)).encode() for name in
                    ["database.dump", "host-program.tar.gz", "api-program.tar.gz", "web-program.tar.gz", "worker-program.tar.gz"]}
        if persistent:
            payloads["persistent-files.tar.gz"] = b"SYNTHETIC uploads and site files"
            (directory / "persistent-files-list.txt").write_text("uploads/fixture\n")
        for name, data in payloads.items(): (directory / name).write_bytes(data)
        hashes = {name: hashlib.sha256(data).hexdigest() for name, data in payloads.items()}
        (directory / "backup-sha256.txt").write_text("".join(f"{value}  {directory / name}\n" for name, value in hashes.items()))
        (directory / "environment").write_text("SYNTHETIC SECRET DO NOT COPY")
        (directory / "database-restore-list.txt").write_text("SYNTHETIC readable dump inventory")
        (directory / "previous-image.txt").write_text(previous)
        (directory / "candidate-image.txt").write_text(candidate)
        (directory / "previous-health.json").write_text(json.dumps({"ok": True, "db": "ok", "release": "a" * 12}))
        (directory / "health.json").write_text(json.dumps({"ok": True, "db": "ok", "release": f"{suffix:012x}"}))
        if persistent:
            (directory / "recovery-point.json").write_text(json.dumps({"version": 1, "previous_image": previous,
                "previous_release": "a" * 12, "attempted_release": f"{suffix:012x}" + "b" * 28,
                "files": [{"file": name, "sha256": hashes[name], "bytes": len(data)} for name, data in payloads.items()]}))
        return directory

    def test_backup_window_uses_predecessor_not_candidate_or_mtime_and_keeps_persistent_proof(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(m, "docker", side_effect=lambda *args: args[-1]):
            root, ops = Path(temporary) / "backups", Path(temporary) / "ops"
            root.mkdir(); ops.mkdir()
            first = self.backup(root, 10, ident(2), ident(1), persistent=True)
            second = self.backup(root, 11, ident(3), ident(2))
            old = self.backup(root, 12, ident(5), ident(3), persistent=True)
            current = self.backup(root, 13, ident(1), ident(6))
            # Directory freshness and its candidate identity cannot turn this expired predecessor into a required point.
            m.os.utime(old, (NOW + 999, NOW + 999))
            window = m.recovery_window(root, [ident(1), ident(2), ident(3)])
            self.assertEqual({p["directory"] for p in window["keep"]}, {first.name, second.name})
            self.assertEqual([p["directory"] for p in window["remove"]], [old.name, current.name])
            removed = m.remove_expired_recovery(root, window, ops / "result.json")
            self.assertEqual(removed, [old.name, current.name]); self.assertFalse(old.exists()); self.assertFalse(current.exists())
            self.assertTrue((first / "persistent-files.tar.gz").exists()); self.assertTrue(second.exists())
            evidence = (ops / "result.json").read_text()
            self.assertIn("persistent-files.tar.gz", evidence)
            self.assertNotIn("SYNTHETIC SECRET", evidence)

    def test_repeated_success_keeps_newest_complete_database_for_each_rollback(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(m, "docker", side_effect=lambda *args: args[-1]):
            root, ops = Path(temporary) / "backups", Path(temporary) / "ops"
            root.mkdir(); ops.mkdir()
            older = self.backup(root, 30, ident(2), ident(1), persistent=True)
            newer = self.backup(root, 10, ident(2), ident(1), persistent=True)
            second = self.backup(root, 20, ident(3), ident(2))
            for directory, at in [(older, "2026-10-12T00:00:00Z"), (newer, "2026-10-13T00:00:00Z")]:
                path = directory / "recovery-point.json"
                point = json.loads(path.read_text()); point["at"] = at; path.write_text(json.dumps(point))
            m.os.utime(older, (NOW + 999, NOW + 999))
            window = m.recovery_window(root, [ident(1), ident(2), ident(3)])
            self.assertEqual({p["directory"] for p in window["keep"]}, {newer.name, second.name})
            self.assertEqual([p["directory"] for p in window["remove"]], [older.name])
            before = (newer / "database.dump").read_bytes()
            m.remove_expired_recovery(root, window, ops / "result.json")
            self.assertEqual((newer / "database.dump").read_bytes(), before)
            self.assertEqual(len(list(root.iterdir())), 2)

    def test_missing_second_recovery_point_aborts_before_any_deletion(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "backups"; root.mkdir()
            self.backup(root, 10, ident(2), ident(1))
            old = self.backup(root, 12, ident(5), ident(3))
            args = argparse.Namespace(apply=True, automatic=False, seed=[ident(2), ident(3)], state_dir=temporary, backup_dir=str(root))
            with patch.object(m, "inventory", return_value=fixture()), patch.object(m, "health", return_value="a" * 12), patch.object(m.time, "time", return_value=NOW), patch.object(m, "quality_blockers", return_value=[]), patch.object(m, "retry_pending"), patch.object(m, "docker", side_effect=lambda *args: args[-1]) as docker:
                with self.assertRaisesRegex(ValueError, "Necessary rollback"): m.execute(args)
            self.assertTrue(old.exists())
            self.assertTrue(all(call.args[:2] == ("image", "inspect") for call in docker.call_args_list))
            self.assertEqual(json.loads((Path(temporary) / "state.json").read_text())["history"], [ident(1)])

    def test_hash_symlink_failed_and_unmapped_points_are_kept_explicitly(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(m, "docker", side_effect=lambda *args: args[-1]):
            root = Path(temporary)
            self.backup(root, 10, ident(2), ident(1)); self.backup(root, 11, ident(3), ident(2))
            for suffix, failure in [(12, "hash"), (13, "symlink"), (14, "failed"), (15, "persistent")]:
                item = self.backup(root, suffix, ident(5), ident(6), persistent=failure == "persistent")
                if failure == "hash": (item / "database.dump").write_bytes(b"changed")
                if failure == "symlink":
                    (item / "web-program.tar.gz").unlink(); (item / "web-program.tar.gz").symlink_to(root / "outside")
                if failure == "failed": (item / "health.json").write_text('{"ok":false}')
                if failure == "persistent": (item / "persistent-files.tar.gz").unlink()
            (root / "program-retention-legacy").mkdir()
            window = m.recovery_window(root, [ident(1), ident(2), ident(3)])
            self.assertEqual(window["remove"], [])
            self.assertEqual(len(window["retained_uncertain"]), 5)

    def test_changed_retained_input_or_late_inventory_blocks_the_whole_delete_plan(self):
        for change in ["required-dump", "late-directory"]:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary, patch.object(m, "docker", side_effect=lambda *args: args[-1]):
                root = Path(temporary)
                first = self.backup(root, 10, ident(2), ident(1)); self.backup(root, 11, ident(3), ident(2))
                old = self.backup(root, 12, ident(5), ident(3))
                window = m.recovery_window(root, [ident(1), ident(2), ident(3)])
                if change == "required-dump": (first / "database.dump").write_bytes(b"changed")
                else: (root / "release-unexpected").mkdir()
                with self.assertRaises(RuntimeError): m.remove_expired_recovery(root, window, root / "never-written.json")
                self.assertTrue(old.exists()); self.assertFalse((root / "never-written.json").exists())

    def test_old_latest_tag_has_no_special_exemption_but_current_latest_remains_protected(self):
        containers, images = fixture()
        result = m.plan(containers, images, [], [ident(2), ident(3)], NOW)
        self.assertIn(ident(4), {x["id"] for x in result["candidates"]})
        images[ident(1)]["tags"].append("amp-app:latest")
        self.assertNotIn(ident(1), {x["id"] for x in m.plan(containers, images, [], [ident(2), ident(3)], NOW)["candidates"]})

    def test_missing_image_requires_a_verified_overlay_recipe_and_protects_its_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            release = root / "release-123456789abc"
            release.mkdir()
            original = release / "previous-image.txt"
            original.write_text(ident(5))
            missing = m.subprocess.CalledProcessError(1, ["docker", "image", "inspect"])
            with patch.object(m, "docker", side_effect=missing), patch.object(m, "RecoveryBindings") as factory:
                factory.return_value.resolve.return_value = ident(6)
                references, blocked = m.backup_references(root)
                self.assertEqual(references, {"release-123456789abc/previous-image.txt": ident(6)})
                self.assertEqual(blocked, [])
                factory.return_value.resolve.assert_called_once_with(ident(5), "release-123456789abc")
                self.assertEqual(original.read_text(), ident(5))
                containers, images = fixture()
                result = m.plan(containers, images, [], [ident(2), ident(3)], NOW, backup_images=references.values())
                self.assertNotIn(ident(6), {item["id"] for item in result["candidates"]})
                factory.return_value.resolve.side_effect = ValueError("Unproved recovery")
                self.assertTrue(m.backup_references(root)[1])
                second = root / "release-23456789abcd"
                second.mkdir()
                (second / "previous-image.txt").write_text(ident(5))
                def resolve(image, snapshot):
                    if snapshot == release.name:
                        return ident(6)
                    raise ValueError("This snapshot has no restore proof")
                factory.return_value.resolve.side_effect = resolve
                references, blocked = m.backup_references(root)
                self.assertEqual(references["release-123456789abc/previous-image.txt"], ident(6))
                self.assertTrue(any(second.name in message for message in blocked))

    def test_container_config_digest_resolves_to_manifest_digest(self):
        container = {"image": ident(1), "name": "/amp-web-1"}
        image = {"id": ident(4), "tags": ["amp-app:latest"]}
        def docker(*args):
            if args[0] == "ps": return "container-id"
            if args[0] == "inspect": return json.dumps(container)
            if args[:2] == ("image", "ls"): return ident(4)
            if args[3] == "{{.Id}}": return ident(4)
            return json.dumps(image)
        with patch.object(m, "docker", side_effect=docker):
            containers, images = m.inventory()
        self.assertEqual(containers[0]["image"], ident(4))
        self.assertIn(containers[0]["image"], images)

    def test_protects_running_rollback_other_and_stopped(self):
        containers, images = fixture()
        containers.append({"name": "/amp-setup-1", "image": ident(7), "running": False})
        result = m.plan(containers, images, [], [ident(2), ident(3)], NOW)
        self.assertEqual({x["id"] for x in result["candidates"]}, {ident(4), ident(5), ident(6)})
        images[ident(5)]["tags"].append("other-project:hold")
        self.assertNotIn(ident(5), {x["id"] for x in m.plan(containers, images, [], [ident(2), ident(3)], NOW)["candidates"]})

    def test_untagged_cleanup_requires_recorded_ownership_and_preserves_backup_references(self):
        containers, images = fixture()
        managed = m.provenance(images, {})
        for index in [5, 6, 8]: images[ident(index)]["tags"] = []
        result = m.plan(containers, images, [], [ident(2), ident(3)], NOW, managed, [ident(6)])
        self.assertIn(ident(5), {x["id"] for x in result["candidates"]})
        self.assertNotIn(ident(6), {x["id"] for x in result["candidates"]})
        self.assertNotIn(ident(8), {x["id"] for x in result["candidates"]})
        self.assertEqual(m.provenance(images, managed)[ident(5)], ["amp-release:release5"])
        images[ident(5)]["tags"] = ["unrelated:keep"]
        self.assertNotIn(ident(5), {x["id"] for x in m.plan(containers, images, [], [ident(2), ident(3)], NOW, managed)["candidates"]})

    def test_backup_predecessor_alias_resolves_and_unmapped_snapshot_blocks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            release = root / "release-target"
            release.mkdir()
            (release / "previous-image.txt").write_text(ident(5))
            with patch.object(m, "docker", return_value=ident(6)):
                references, blocked = m.backup_references(root)
                self.assertEqual(references, {"release-target/previous-image.txt": ident(6)})
                self.assertEqual(blocked, [])
                (release / "candidate-image.txt").symlink_to(root / "missing")
                self.assertTrue(m.backup_references(root)[1])
                snapshot = root / "program-retention-old"
                snapshot.mkdir()
                self.assertTrue(m.backup_references(root)[1])
                (release / "previous-image.txt").write_text("not an image ID")
                self.assertEqual(m.backup_references(root)[0], {})
                overlays = [{"container": name[1:], "archive": name[1:] + "-program.tar.gz", "sha256": "a" * 64, "bytes": 1} for name in m.APP_NAMES]
                for item in overlays: (snapshot / item["archive"]).write_bytes(b"x")
                (snapshot / "current-image.oci.tar").write_bytes(b"x")
                (snapshot / "manifest.json").write_text(json.dumps({"current_image": ident(7), "runtime_manifest": ident(8), "program_overlays": overlays}))
                references = m.program_references(snapshot)
                self.assertEqual(set(references.values()), {ident(7), ident(8)})
                self.assertEqual(len(references), 6)
                (snapshot / overlays[0]["archive"]).unlink()
                with self.assertRaises(ValueError): m.program_references(snapshot)

    def test_quality_record_requires_accepted_exact_release_and_timestamp(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "quality.json"
            self.assertTrue(m.quality_blockers("a" * 12, path))
            for status, sha, at, blocked in [("pending", "a" * 40, "2026-10-10T00:00:00Z", True),
                    ("accepted", "b" * 40, "2026-10-10T00:00:00Z", True), ("accepted", "a" * 40, "invalid", True),
                    ("accepted", "a" * 40, "2026-10-10T00:00:00Z", False)]:
                path.write_text(json.dumps({"status": status, "sha": sha, "at": at}))
                self.assertEqual(bool(m.quality_blockers("a" * 12, path)), blocked)

    def test_rotates_only_after_new_current_and_protects_recent_staging(self):
        containers, images = fixture()
        for item in containers:
            if item["name"] in m.APP_NAMES:
                item["image"] = ident(6)
        images[ident(5)]["created"] = "2026-10-12T11:00:00Z"
        result = m.plan(containers, images, [ident(1), ident(2), ident(3)], [], NOW)
        self.assertEqual(result["history"], [ident(6), ident(1), ident(2)])
        self.assertNotIn(ident(5), {x["id"] for x in result["candidates"]})

    def test_unhealthy_mixed_recent_and_missing_rollback_fail_closed(self):
        for kind in ["missing", "mixed", "stopped", "recent", "no-rollback", "one-rollback", "lost-rollback"]:
            with self.subTest(kind=kind):
                containers, images = fixture()
                seeds = [ident(2), ident(3)]
                if kind == "missing": containers.pop(0)
                if kind == "mixed": containers[0]["image"] = ident(7)
                if kind == "stopped": containers[0]["running"] = False
                if kind == "recent": containers[0]["started"] = m.dt.datetime.fromtimestamp(NOW - 10, m.dt.timezone.utc).isoformat()
                if kind == "no-rollback": seeds = []
                if kind == "one-rollback": seeds = [ident(2)]
                if kind == "lost-rollback": del images[ident(2)]
                with self.assertRaises(RuntimeError): m.plan(containers, images, [], seeds, NOW)

    def test_unified_api_accepts_stopped_legacy_containers_but_preserves_their_images(self):
        containers, images = fixture()
        for item in containers:
            if item["name"] in {"/amp-public-api-1", "/amp-private-api-1"}:
                item["running"] = False
                item["image"] = ident(7)
        containers.append({"name": "/amp-api-1", "image": ident(1), "running": True, "started": "2026-10-10T00:00:00Z"})
        result = m.plan(containers, images, [], [ident(2), ident(3)], NOW)
        self.assertEqual(result["history"], [ident(1), ident(2), ident(3)])
        self.assertNotIn(ident(7), {x["id"] for x in result["candidates"]})
        for item in containers:
            if item["name"] == "/amp-private-api-1": item["running"] = True
        with self.assertRaises(RuntimeError): m.plan(containers, images, [], [ident(2), ident(3)], NOW)

    def test_unified_api_missing_recent_or_mixed_services_fail_closed(self):
        for kind in ["missing", "mixed", "recent"]:
            with self.subTest(kind=kind):
                containers, images = fixture()
                containers = [x for x in containers if x["name"] not in {"/amp-public-api-1", "/amp-private-api-1"}]
                if kind != "missing":
                    containers.append({"name": "/amp-api-1", "image": ident(7 if kind == "mixed" else 1), "running": True,
                                       "started": m.dt.datetime.fromtimestamp(NOW - 10, m.dt.timezone.utc).isoformat()})
                with self.assertRaises(RuntimeError): m.plan(containers, images, [], [ident(2), ident(3)], NOW)

    def run_execute(self, apply, automatic=False, drift=False, dangling=False, quality_pending=False):
        containers, images = fixture()
        # Exactly one delete candidate, to make command-boundary assertions unambiguous.
        del images[ident(4)], images[ident(6)], images[ident(7)]
        calls = []
        managed = m.provenance(images, {})
        if dangling: images[ident(5)]["tags"] = []
        def docker(*args):
            calls.append(args)
            if args[:2] == ("image", "inspect"): return ident(6) if drift else ident(5)
            if args[:2] == ("image", "rm"):
                if args[-1] == ident(5): del images[ident(5)]
                else: images[ident(5)]["tags"].remove(args[-1])
            return "Total reclaimed space: 1GB"
        with tempfile.TemporaryDirectory() as directory:
            args = argparse.Namespace(apply=apply, automatic=automatic, seed=[ident(2), ident(3)], state_dir=directory, backup_dir=directory + "/backups")
            if automatic or dangling:
                Path(directory, "state.json").write_text(json.dumps({"history": [ident(1), ident(2), ident(3)], "managed_images": managed, "cleaned_at": NOW - 1}))
            with patch.object(m, "inventory", return_value=(containers, images)), patch.object(m, "health", return_value="a" * 12), patch.object(m.time, "time", return_value=NOW), patch.object(m, "docker", side_effect=docker), patch.object(m, "backup_references", return_value=({}, [])), patch.object(m, "quality_blockers", return_value=["pending"] if quality_pending else []), patch.object(m, "recovery_window", return_value={"keep": [], "remove": [], "retained_uncertain": []}) as window, patch.object(m, "recheck_recovery_window"), patch.object(m, "remove_expired_recovery", return_value=[]):
                if drift:
                    with self.assertRaises(RuntimeError): m.execute(args)
                else: m.execute(args)
            state = list(Path(directory).iterdir())
            if not apply and not automatic: self.assertEqual(state, [])
            if apply and not drift and not quality_pending:
                self.assertEqual(json.loads(Path(directory, "state.json").read_text())["managed_images"], managed)
            if quality_pending:
                if apply: self.assertEqual(json.loads(Path(directory, "state.json").read_text())["history"], [ident(1)])
                else: self.assertEqual(state, [])
            if quality_pending or automatic: window.assert_not_called()
        return calls

    def test_dry_run_and_unchanged_automatic_do_not_mutate(self):
        self.assertEqual(self.run_execute(False), [])
        self.assertEqual(self.run_execute(True, automatic=True), [])

    def test_apply_only_removes_exact_old_tag_and_cache(self):
        calls = self.run_execute(True)
        self.assertIn(("image", "rm", "--no-prune", "amp-release:release5"), calls)
        self.assertIn(("builder", "prune", "--all", "--force", "--filter", "until=24h", "--keep-storage", "2GB"), calls)
        self.assertTrue(all(x[0] in {"image", "builder"} for x in calls))
        self.assertTrue(all("--force" not in x for x in calls if x[:2] == ("image", "rm")))

    def test_retagged_candidate_aborts_before_removal(self):
        self.assertFalse(any(x[:2] == ("image", "rm") for x in self.run_execute(True, drift=True)))

    def test_owned_dangling_image_is_removed_by_exact_id_without_force_or_parent_prune(self):
        calls = self.run_execute(True, dangling=True)
        self.assertIn(("image", "rm", "--no-prune", ident(5)), calls)
        self.assertFalse(any("--force" in x for x in calls if x[:2] == ("image", "rm")))

    def test_pending_quality_never_reclaims_images_or_cache(self):
        self.assertEqual(self.run_execute(True, quality_pending=True), [])
        self.assertEqual(self.run_execute(False, quality_pending=True), [])

    def test_formal_predecessor_observation_handles_rapid_releases_and_rejects_failed_candidates(self):
        script = Path(__file__).with_name("production-release.sh").read_text()
        observation = re.search(r"python3 -B - .*? <<'PYOBSERVE'\n(.*?)\nPYOBSERVE", script, re.S)
        self.assertIsNotNone(observation)
        start = script.index("<<'PYOBSERVE'")
        self.assertLess(script.index('flock -w 5 9'), start)
        self.assertLess(script.index('== "$RELEASE_OLD_IMAGE" ]]'), start)
        self.assertLess(start, script.index('phase import_verified_image'))
        containers, images = fixture()
        for container in containers:
            container["started"] = m.dt.datetime.fromtimestamp(NOW - 1, m.dt.timezone.utc).isoformat()
            if container["name"] in m.APP_NAMES: container["image"] = ident(6)
        with tempfile.TemporaryDirectory() as temporary:
            state_path = Path(temporary) / "state.json"
            state_path.write_text(json.dumps({"history": [ident(1), ident(2), ident(3)], "cleaned_at": NOW - 1}))
            code = observation.group(1).replace('/var/lib/aimine-maintenance/state.json', str(state_path))
            tools = str(Path(__file__).resolve().parent)
            with patch.object(m, "inventory", return_value=(containers, images)), patch.object(m, "health", return_value="a" * 12) as health, \
                    patch.object(m.time, "time", return_value=NOW), patch("runpy.run_path", return_value=m.__dict__), \
                    patch.object(sys, "path", sys.path.copy()), patch.object(sys, "argv", ["-", tools, ident(6), "a" * 12]):
                exec(compile(code, "formal-observe-previous", "exec"), {})
                self.assertEqual(json.loads(state_path.read_text())["history"], [ident(6), ident(1), ident(2)])
                # A second actual release is observed before the timer/ten-minute cleanup interval.
                for container in containers:
                    if container["name"] in m.APP_NAMES: container["image"] = ident(7)
                sys.argv[2] = ident(7)
                exec(compile(code, "formal-observe-previous", "exec"), {})
                self.assertEqual(json.loads(state_path.read_text())["history"], [ident(7), ident(6), ident(1)])
                before = state_path.read_bytes()
                sys.argv[2] = ident(8)  # Staged/failed candidate exists, but it is not running.
                with self.assertRaisesRegex(RuntimeError, "predecessor changed"):
                    exec(compile(code, "formal-observe-previous", "exec"), {})
                self.assertEqual(state_path.read_bytes(), before)
                sys.argv[2] = ident(7)
                health.side_effect = RuntimeError("synthetic unhealthy response")
                with self.assertRaisesRegex(RuntimeError, "unhealthy"):
                    exec(compile(code, "formal-observe-previous", "exec"), {})
                self.assertEqual(state_path.read_bytes(), before)
                with self.assertRaises(RuntimeError): m.plan(containers, images, [ident(7), ident(6), ident(1)], [], NOW)

    def test_observation_dry_run_and_symlink_state_do_not_write(self):
        containers, images = fixture()
        with tempfile.TemporaryDirectory() as temporary, patch.object(m, "inventory", return_value=(containers, images)), \
                patch.object(m, "health", return_value="a" * 12), patch.object(m.time, "time", return_value=NOW):
            root = Path(temporary)
            missing = root / "absent" / "state.json"
            m.observe_current(missing, apply=False)
            self.assertFalse(missing.parent.exists())
            target = root / "original.json"; target.write_text('{"history":[]}')
            linked = root / "state.json"; linked.symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, "regular file"): m.observe_current(linked, apply=True)
            self.assertEqual(target.read_text(), '{"history":[]}')

    def test_pending_running_release_is_kept_in_the_next_accepted_recovery_window(self):
        containers, images = fixture()
        for container in containers:
            if container["name"] in m.APP_NAMES: container["image"] = ident(6)
        # This test exercises real backup selection/removal, not image/cache reclamation.
        for image in images.values(): image["created"] = m.dt.datetime.fromtimestamp(NOW, m.dt.timezone.utc).isoformat()
        pending, calls = True, []
        def docker(*args):
            calls.append(args)
            return args[-1] if args[:2] == ("image", "inspect") else ""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_path = root / "state.json"
            state_path.write_text(json.dumps({"history": [ident(1), ident(2), ident(3)], "cleaned_at": NOW - 1}))
            args = argparse.Namespace(apply=True, automatic=True, seed=[], state_dir=temporary, backup_dir=str(root / "backups"))
            ops = root / "ops"; ops.mkdir()
            with patch.object(m, "inventory", return_value=(containers, images)), patch.object(m, "health", return_value="a" * 12), \
                    patch.object(m.time, "time", return_value=NOW), patch.object(m, "docker", side_effect=docker), \
                    patch.object(m, "quality_blockers", side_effect=lambda _: ["pending"] if pending else []), \
                    patch.object(m, "retry_pending"), patch.object(m, "OPS", ops):
                m.execute(args)
                observed = json.loads(state_path.read_text())
                self.assertEqual(observed["history"], [ident(6), ident(1), ident(2)])
                self.assertEqual(observed["cleaned_at"], 0)
                self.assertEqual(calls, [], "pending only records the healthy observation")
                self.assertFalse(Path(args.backup_dir).exists(), "pending must not require or scan backups")
                backups = Path(args.backup_dir); backups.mkdir()
                ece = self.backup(backups, 70, ident(6), ident(7))
                prior = self.backup(backups, 60, ident(1), ident(6))
                expired = self.backup(backups, 10, ident(2), ident(1))
                original = (ece / "database.dump").read_bytes()
                for container in containers:
                    if container["name"] in m.APP_NAMES: container["image"] = ident(7)
                pending = False
                m.execute(args)
                self.assertEqual(json.loads(state_path.read_text())["history"], [ident(7), ident(6), ident(1)])
                self.assertEqual({p.name for p in backups.iterdir()}, {ece.name, prior.name})
                self.assertEqual((ece / "database.dump").read_bytes(), original)
                self.assertFalse(expired.exists())


if __name__ == "__main__":
    unittest.main()
