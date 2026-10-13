import argparse
import importlib.util
import json
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

    def test_protects_running_rollback_latest_other_and_stopped(self):
        containers, images = fixture()
        containers.append({"name": "/amp-setup-1", "image": ident(7), "running": False})
        result = m.plan(containers, images, [], [ident(2), ident(3)], NOW)
        self.assertEqual({x["id"] for x in result["candidates"]}, {ident(5), ident(6)})
        images[ident(5)]["tags"].append("other-project:hold")
        self.assertNotIn(ident(5), {x["id"] for x in m.plan(containers, images, [], [ident(2)], NOW)["candidates"]})

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
        for kind in ["missing", "mixed", "stopped", "recent", "no-rollback", "lost-rollback"]:
            with self.subTest(kind=kind):
                containers, images = fixture()
                seeds = [ident(2)]
                if kind == "missing": containers.pop(0)
                if kind == "mixed": containers[0]["image"] = ident(7)
                if kind == "stopped": containers[0]["running"] = False
                if kind == "recent": containers[0]["started"] = m.dt.datetime.fromtimestamp(NOW - 10, m.dt.timezone.utc).isoformat()
                if kind == "no-rollback": seeds = []
                if kind == "lost-rollback": del images[ident(2)]
                with self.assertRaises(RuntimeError): m.plan(containers, images, [], seeds, NOW)

    def run_execute(self, apply, automatic=False, drift=False):
        containers, images = fixture()
        # Exactly one delete candidate, to make command-boundary assertions unambiguous.
        del images[ident(6)], images[ident(7)]
        calls = []
        def docker(*args):
            calls.append(args)
            if args[:2] == ("image", "inspect"): return ident(6) if drift else ident(5)
            return "Total reclaimed space: 1GB"
        with tempfile.TemporaryDirectory() as directory:
            args = argparse.Namespace(apply=apply, automatic=automatic, seed=[ident(2), ident(3)], state_dir=directory)
            if automatic:
                Path(directory, "state.json").write_text(json.dumps({"history": [ident(1), ident(2), ident(3)], "cleaned_at": NOW - 1}))
            with patch.object(m, "inventory", return_value=(containers, images)), patch.object(m, "health", return_value="release"), patch.object(m.time, "time", return_value=NOW), patch.object(m, "docker", side_effect=docker):
                if drift:
                    with self.assertRaises(RuntimeError): m.execute(args)
                else: m.execute(args)
            state = list(Path(directory).iterdir())
            if not apply and not automatic: self.assertEqual(state, [])
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


if __name__ == "__main__":
    unittest.main()
