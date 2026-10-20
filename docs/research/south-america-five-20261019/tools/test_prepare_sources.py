#!/usr/bin/env python3
"""Focused offline reconciliation regressions.

Run: python tools/test_prepare_sources.py --repo /path/to/AI-MINE -v
Only local fixtures and the target repository's pure identity functions are used.
"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("prepare_sources.py")
spec = importlib.util.spec_from_file_location("prepare_sources", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
REPO = Path(__file__).resolve().parents[1] / "repository-src"


def source(source_id, url, lane="news", kind="rss", **extra):
    return {"id": source_id, "name": source_id, "lane": lane, "kind": kind,
            "config": {"feedUrl" if kind == "rss" else "url": url}, "owner_entity_id": None, **extra}


def meta(candidate, **extra):
    return {"id": candidate["id"].removeprefix("sa5-"), "native_source_id": candidate["id"],
            "ready_for_preview": True, "existing_source_ids": [],
            "existing_policy_catalogue_ids": [], "possible_existing_runtime_source_ids": [],
            **extra}


def snapshot(rows):
    data = module.runtime_inventory_example()
    data["environment"] = "test-fixture-only"
    data["sources"] = copy.deepcopy(rows)
    data["coverage"]["total_rows"] = len(rows)
    data["coverage"]["by_lane"] = {k: sum(r["lane"] == k for r in rows) for k in ("news", "policy")}
    data["coverage"]["by_archive_state"] = {
        "archived": sum(r.get("archived_at") is not None for r in rows),
        "unarchived": sum(r.get("archived_at") is None for r in rows),
    }
    return data


class ReconciliationTests(unittest.TestCase):
    def run_case(self, candidate, *, news=None, policy=None, live=None, metadata=None,
                 additional=None, extra_metadata=None):
        candidates = [candidate] + (additional or [])
        result, additions = module.reconcile_all(
            REPO, {"sources": news or []}, {"sources": policy or []},
            {"sources": [metadata or meta(candidate)] + [meta(c) for c in candidates[1:]]
             + (extra_metadata or [])}, {"sources": candidates}, live)
        return result["decisions"][0], result, additions

    def test_native_identity_matches_target_semantics(self):
        urls = [
            " http://www.Example.org:80/feed/?ref=x&source=y&b=2&a=1#part ",
            "https://example.org/feed/",
            "https://example.org/feed/?page=2&language=es&source=filter#chapter",
            "https://example.org/feed?b=2&a=second&a=first&utm_source=x&msclkid=kept",
            "https://mp.weixin.qq.com/s?chksm=x&sn=s&idx=1&mid=2&__biz=b&extra=ignored",
            "ftp://example.org/file",
        ]
        output = module.native_identities(REPO, [
            {"feedUrl": urls[0]}, {"listUrl": urls[1]}, {"endpoint": urls[2]},
            {"feedUrl": "", "url": urls[1]},
            {"feedUrl": "https://r.jina.ai/https://www.example.org/feed/#frag"},
            {"feedUrl": "https://r.jina.ai/example.org/feed/"},
        ], urls)
        self.assertEqual(output["normalized_urls"], [
            "https://example.org/feed/?a=1&b=2", "https://example.org/feed",
            "https://example.org/feed/?language=es&page=2",
            "https://example.org/feed?a=second&a=first&b=2&msclkid=kept",
            "https://mp.weixin.qq.com/s?__biz=b&mid=2&idx=1&sn=s", None,
        ])
        self.assertEqual(output["identities"], [
            output["normalized_urls"][0], output["normalized_urls"][1], output["normalized_urls"][2],
            None, "https://example.org/feed", "https://r.jina.ai/example.org/feed/",
        ])
        self.assertNotEqual(module.canonical(urls[0]), output["identities"][0])
        self.assertRegex(output["implementation_sha256"], r"^[a-f0-9]{64}$")

    def test_native_extraction_does_not_evaluate_admin_module(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            for relative in ("packages/backend/src/lib/url.ts", "packages/backend/src/admin/sources.ts"):
                target = repo / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('throw new Error("module must never execute");\n' + (REPO / relative).read_text())
            value = module.native_identities(repo, [{"feedUrl": "https://example.org/feed/"}])
            self.assertEqual(value["identities"], ["https://example.org/feed"])

    def test_related_paused_or_archived_channel_does_not_transfer_state(self):
        candidate = source("sa5-pe-snmpe-members", "https://www.snmpe.org.pe/members.feed?type=rss")
        for enabled, archived_at in ((False, None), (False, "2026-10-01T00:00:00Z")):
            with self.subTest(archived_at=archived_at):
                old = source("old-snmpe-press", "https://www.snmpe.org.pe/press.feed?type=rss",
                             enabled=enabled, archived_at=archived_at)
                decision, _, additions = self.run_case(
                    candidate, live=snapshot([old]), metadata=meta(candidate, existing_source_ids=[old["id"]]))
                self.assertEqual(decision["action"], "review_optimization_or_supplement")
                self.assertIsNone(decision["selected_target"])
                self.assertEqual(decision["preserved_runtime_states"][0]["archived_at"], archived_at)
                self.assertEqual(additions, [])

    def test_active_replacement_wins_over_archived_and_paused_duplicates(self):
        candidate = source("sa5-pe-press", "https://example.org/feed/")
        rows = [source("archived-original", "https://example.org/feed/", enabled=False,
                       archived_at="2026-10-01T00:00:00Z"),
                source("paused-copy", "https://example.org/feed/", enabled=False, archived_at=None),
                source("active-replacement", "https://example.org/feed/", enabled=True, archived_at=None)]
        decision, _, additions = self.run_case(candidate, live=snapshot(rows))
        self.assertEqual(decision["action"], "reuse_existing")
        self.assertEqual(decision["selected_target"]["id"], "active-replacement")
        self.assertEqual(len(decision["preserved_runtime_states"]), 3)
        self.assertFalse(decision["activation_proposed"])
        self.assertEqual(additions, [])

    def test_pause_archive_and_id_lane_collision_protect_only_direct_identity(self):
        candidate = source("sa5-pe-press", "https://example.org/new-feed/")
        for enabled, archived_at, action in ((False, None, "preserve_pause"),
                                            (False, "2026-10-01T00:00:00Z", "preserve_archive")):
            old = source(candidate["id"], "https://example.org/old-feed/", enabled=enabled, archived_at=archived_at)
            with self.subTest(action=action):
                decision, _, _ = self.run_case(candidate, live=snapshot([old]))
                self.assertEqual(decision["action"], action)
                old["lane"] = "policy"
                decision, _, _ = self.run_case(candidate, live=snapshot([old]))
                self.assertEqual(decision["action"], "blocked_id_lane_collision")

    def test_complete_inventory_required_and_counts_checked(self):
        row = source("existing", "https://example.org/feed/", enabled=False, archived_at=None)
        base = snapshot([row])
        cases = [[], {"page": 1, "total": 220, "sources": [row]}]
        for section, key, value in [
            (None, "schema_version", "old"), (None, "snapshot_at", "2026-10-19"),
            (None, "snapshot_at", "2026-10-19T01:00:00"), (None, "environment", ""),
            (None, "complete", False), ("coverage", "lanes", ["news"]),
            ("coverage", "includes_archived", False), ("coverage", "includes_unarchived", False),
            ("coverage", "total_rows", 220), ("coverage", "by_lane", {"news": 0, "policy": 1}),
            ("coverage", "by_archive_state", {"archived": 1, "unarchived": 0}),
            ("pagination", "all_pages_fetched", False), ("pagination", "expected_pages", 3),
            ("pagination", "next_cursor", "page2"),
        ]:
            bad = copy.deepcopy(base)
            (bad[section] if section else bad)[key] = value
            cases.append(bad)
        for missing in ("config", "lane", "enabled", "archived_at", "owner_entity_id"):
            bad = copy.deepcopy(base)
            bad["sources"][0].pop(missing)
            cases.append(bad)
        duplicate = snapshot([row, row])
        cases.append(duplicate)
        for i, bad in enumerate(cases):
            with self.subTest(case=i), self.assertRaises(ValueError):
                module.runtime_rows(bad)
        self.assertEqual(len(module.runtime_rows(base)), 1)
        self.assertEqual(module.runtime_rows(snapshot([])), [])

    def test_runtime_owner_must_be_explicit_null_or_nonempty_limited_string(self):
        row = source("existing", "https://example.org/feed/", enabled=False, archived_at=None)
        for value in ("", "   ", True, 42, "x" * 121):
            with self.subTest(owner_entity_id=value), self.assertRaisesRegex(ValueError, "owner_entity_id"):
                module.runtime_rows(snapshot([{**row, "owner_entity_id": value}]))
        for value in (None, "publisher-example", "x" * 120):
            self.assertEqual(module.runtime_rows(snapshot([{**row, "owner_entity_id": value}]))[0]["owner_entity_id"], value)

    def test_catalogue_absence_is_not_runtime_reuse_or_new_directory_entry(self):
        candidate = source("sa5-pe-dipromin", "https://www.dipromin.com/feed/")
        existing = source("exp-20261014-dipromin", "https://www.dipromin.com/feed/")
        decision, _, additions = self.run_case(candidate, news=[existing], live=snapshot([]))
        self.assertEqual(decision["action"], "catalogue_source_absent_from_runtime")
        self.assertEqual(decision["suggested_creation_id"], existing["id"])
        self.assertFalse(decision["selected_target"]["runtime_observed"])
        self.assertIsNone(decision["selected_target"]["enabled"])
        self.assertEqual(additions, [])

    def test_no_inventory_is_explicitly_catalogue_only(self):
        candidate = source("sa5-pe-new", "https://example.org/feed/")
        decision, result, additions = self.run_case(candidate)
        self.assertEqual(decision["action"], "new_catalogue_candidate_runtime_unchecked")
        self.assertEqual(result["review_level"], "catalogue_only")
        self.assertFalse(decision["runtime_uniqueness_checked"])
        self.assertEqual(additions, [candidate])
        existing = source("catalogue-existing", "https://example.org/feed/")
        decision, _, additions = self.run_case(candidate, news=[existing])
        self.assertEqual(decision["action"], "catalogue_known_runtime_unchecked")
        self.assertEqual(additions, [])

    def test_declared_publisher_id_cannot_merge_distinct_catalogue_channels(self):
        candidate = source("sa5-pe-members", "https://example.org/members/feed/")
        existing = source("old-press", "https://example.org/press/feed/")
        decision, _, additions = self.run_case(candidate, news=[existing], live=snapshot([]),
                                              metadata=meta(candidate, existing_source_ids=[existing["id"]]))
        self.assertEqual(decision["action"], "review_optimization_or_supplement")
        self.assertIsNone(decision["suggested_creation_id"])
        self.assertEqual(additions, [])

    def test_live_catalogue_id_with_different_entry_is_not_called_absent(self):
        candidate = source("sa5-pe-new", "https://example.org/new/feed/")
        existing = source("old-id", "https://example.org/new/feed/")
        running = source("old-id", "https://different-publisher.example/old/feed/", enabled=False, archived_at=None)
        decision, _, _ = self.run_case(candidate, news=[existing], live=snapshot([running]))
        self.assertEqual(decision["action"], "review_optimization_or_supplement")
        self.assertIsNone(decision["suggested_creation_id"])
        self.assertTrue(any(m["relation"] == "catalogue_id_runtime_reference" for m in decision["matches"]))

    def test_unconfigured_policy_catalogues_keep_identity_and_registry_only_references(self):
        candidate = source("sa5-pe-minem-rules", "https://www.gob.pe/institucion/minem/normas-legales",
                           lane="policy", kind="web_list")
        policy = [{"id": "PE-002", "authority": {"zh": "能源矿业部"}, "name": {"zh": "规范"},
                   "collect": None, "status": "blocked", "entry": candidate["config"]["url"]},
                  {"id": "CO-002", "authority": {"zh": "国家印刷局"}, "name": {"zh": "官方公报"},
                   "collect": None, "status": "dynamic", "website": "https://www.imprenta.gov.co/"}]
        decision, result, _ = self.run_case(
            candidate, policy=policy, metadata=meta(candidate, existing_policy_catalogue_ids=["PE-002"]),
            extra_metadata=[{"id": "co-diario-oficial", "existing_policy_catalogue_ids": ["CO-002"]}])
        self.assertEqual(decision["action"], "policy_catalogue_only")
        match = decision["matches"][0]
        self.assertEqual(match["catalogue_id"], "PE-002")
        self.assertEqual(match["runtime_id_if_seeded"], "policy-pe-002")
        self.assertFalse(match["runtime_observed"])
        self.assertFalse(match["collect_configured"])
        self.assertIsNone(match["config_hash"])
        self.assertIn(candidate["config"]["url"], match["catalogue_urls"])
        self.assertEqual({r["catalogue"]["catalogue_id"] for r in result["unconfigured_policy_catalogue_references"]},
                         {"PE-002", "CO-002"})

    def test_shared_government_host_preserves_institution_boundary(self):
        candidate = source("sa5-pe-minem", "https://www.gob.pe/institucion/minem/noticias", kind="web_list")
        other = source("ipen", "https://www.gob.pe/institucion/ipen/noticias", kind="web_list",
                       enabled=False, archived_at=None)
        decision, _, additions = self.run_case(candidate, live=snapshot([other]),
                                              metadata=meta(candidate, homepage="https://www.gob.pe/minem"))
        self.assertEqual(decision["action"], "new_ready_for_preview")
        self.assertEqual(decision["matches"], [])
        self.assertEqual(additions, [candidate])

    def test_cross_lane_native_duplicate_blocks_even_when_review_urls_differ(self):
        candidate = source("sa5-pe-press", "https://example.org/feed/?source=news#one")
        other = source("policy-existing", "https://example.org/feed/?ref=law#two", lane="policy",
                       enabled=False, archived_at=None)
        self.assertNotEqual(module.endpoint(candidate), module.endpoint(other))
        decision, _, additions = self.run_case(candidate, live=snapshot([other]))
        self.assertEqual(decision["action"], "blocked_native_identity_cross_lane")
        self.assertEqual(additions, [])
        other["archived_at"] = "2026-10-01T00:00:00Z"
        decision, _, _ = self.run_case(candidate, live=snapshot([other]))
        self.assertEqual(decision["action"], "review_optimization_or_supplement")
        self.assertNotEqual(decision["action"], "preserve_archive")

    def test_kind_is_part_of_native_duplicate_identity(self):
        candidate = source("sa5-pe-press", "https://example.org/feed/", kind="web_list")
        other = source("rss-copy", "https://example.org/feed/", lane="policy", enabled=False, archived_at=None)
        decision, _, _ = self.run_case(candidate, live=snapshot([other]))
        self.assertEqual(decision["action"], "review_optimization_or_supplement")
        self.assertNotEqual(decision["action"], "blocked_native_identity_cross_lane")

    def test_package_duplicates_are_checked_before_proposals_in_both_lanes(self):
        candidate = source("sa5-pe-a", "https://example.org/feed/?ref=a")
        other = source("sa5-pe-b", "https://example.org/feed/?ref=b")
        for lane, expected in (("news", "review_package_duplicate"),
                               ("policy", "blocked_package_native_identity_cross_lane")):
            other["lane"] = lane
            with self.subTest(lane=lane):
                _, result, additions = self.run_case(candidate, live=snapshot([]), additional=[other])
                self.assertEqual({d["action"] for d in result["decisions"]}, {expected})
                self.assertEqual(additions, [])

    def test_candidate_identity_and_enabled_validation(self):
        candidate = source("sa5-pe-valid", "https://example.org/feed/")
        with self.assertRaisesRegex(ValueError, "enabled=true"):
            self.run_case({**candidate, "enabled": True})
        with self.assertRaisesRegex(ValueError, "Native candidate ID"):
            self.run_case(candidate, metadata=meta(candidate, id="different-research-id"))

    def test_cli_only_writes_local_drafts_and_refuses_incomplete_snapshot_before_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, package, output = root / "repo", root / "package", root / "review"
            for relative in ("packages/backend/src/lib/url.ts", "packages/backend/src/admin/sources.ts"):
                target = repo / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(REPO / relative, target)
            (repo / "industry").mkdir()
            (package / "config").mkdir(parents=True)
            old = source("untouched", "https://old.example/feed/")
            candidate = source("sa5-pe-new", "https://new.example/feed/")
            files = {
                repo / "industry/sources.json": {"note": "preserve this", "sources": [old]},
                repo / "industry/policy-sources.json": {"sources": []},
                package / "config/registry.json": {"sources": [meta(candidate)]},
                package / "config/native.sources.json": {"sources": [candidate]},
            }
            for path, data in files.items():
                module.write(path, data)
            original = {p: p.read_bytes() for p in files}
            command = [sys.executable, str(SCRIPT), "--repo", str(repo), "--package", str(package), "--out", str(output)]
            done = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual({p: p.read_bytes() for p in files}, original)
            proposed = module.read(output / "news.catalogue.proposed.json")
            self.assertEqual(proposed, {"note": "preserve this", "sources": [old, candidate]})
            self.assertEqual(module.read(output / "new.sources.proposed.json")["review_level"], "catalogue_only")
            self.assertFalse(module.read(output / "new.sources.proposed.json")["activation_proposed"])
            refused = subprocess.run(command[:-1] + [str(repo / "not-allowed")], capture_output=True, text=True)
            self.assertNotEqual(refused.returncode, 0)
            self.assertFalse((repo / "not-allowed").exists())
            partial = root / "partial.json"
            module.write(partial, {"page": 1, "sources": []})
            failed_output = root / "failed-review"
            refused = subprocess.run(command[:-1] + [str(failed_output), "--runtime-json", str(partial)],
                                     capture_output=True, text=True)
            self.assertNotEqual(refused.returncode, 0)
            self.assertFalse(failed_output.exists())
            self.assertEqual({p: p.read_bytes() for p in files}, original)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--repo", type=Path, default=REPO)
    options, unittest_args = parser.parse_known_args()
    REPO = options.repo.resolve()
    unittest.main(argv=[sys.argv[0], *unittest_args])
