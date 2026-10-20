#!/usr/bin/env python3
"""Read-only AI-MINE reconciliation; write local review drafts, never apply or enable.

Requires Python 3.10+ and Node 22.6+ (the target repository uses Node 24).
Without --runtime-json every conclusion is catalogue-only. A provided inventory
MUST use the complete envelope shown by runtime_inventory_example(); incomplete
inventories are rejected before writes. Native identity functions are read from
--repo without importing its admin module or its database connections.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

SNAPSHOT_SCHEMA = "aimine.runtime-sources.v1"
LANES = {"news", "policy"}


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path: Path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def config_hash(source):
    if not source.get("kind") or not isinstance(source.get("config"), dict):
        return None
    payload = json.dumps([source["kind"], source["config"]], ensure_ascii=False,
                         sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def raw_endpoint(source):
    c = source.get("config") or {}
    # Native sourceIdentity uses nullish coalescing, not truthiness.
    return next((c[k] for k in ("feedUrl", "url", "listUrl", "endpoint")
                 if c.get(k) is not None), "")


def unwrap(url):
    text = str(url or "").strip()
    if text.startswith("https://r.jina.ai/"):
        text = text[len("https://r.jina.ai/"):]
        if not text.startswith(("http://", "https://")):
            text = "https://" + text
    return text


def canonical(url):
    """Conservative review comparison; NEVER the backend duplicate identity."""
    raw = unwrap(url)
    if not raw:
        return ""
    try:
        p = urlsplit(raw)
        if p.scheme.lower() not in ("http", "https") or not p.hostname:
            return ""
        host = p.hostname.lower().removeprefix("www.")
        if ":" in host:
            host = "[" + host + "]"
        if p.port and p.port not in (80, 443):
            host += f":{p.port}"
    except ValueError:
        return ""
    query = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True)
             if not k.lower().startswith("utm_") and k.lower() not in ("gclid", "fbclid", "msclkid")]
    return urlunsplit(("https", host, p.path.rstrip("/") or "/", urlencode(sorted(query)), p.fragment))


def endpoint(source):
    return canonical(raw_endpoint(source))


def publisher_scope(url):
    """Publisher hints only; never sufficient to reuse, pause or archive a source."""
    u = urlsplit(canonical(url))
    host, path = u.hostname or "", u.path
    if not host:
        return ""
    if host == "gob.pe":
        m = re.match(r"/institucion/([^/]+)", path)
        if m:
            return host + "/institucion/" + m.group(1)
        m = re.match(r"/(minem|ingemmet|ipen|mincetur)(?:/|$)", path)
        return host + "/institucion/" + m.group(1) if m else host + path
    if host == "argentina.gob.ar":
        if re.match(r"/(?:economia/)?mineria(?:/|$)", path):
            return host + "/mineria"
        if path.startswith("/economia/agencia-nacional-de-puertos-y-navegacion"):
            return host + "/anpyn"
        head = next((s for s in path.split("/") if s), "")
        return host + path if head in ("noticias", "normativa") else host + "/" + head
    if host == "gov.sr":
        return host + path + ("?" + u.query if u.query else "")
    if host in ("worldbank.org", "blogs.worldbank.org", "osce.org"):
        return host + "/" + next((s for s in path.split("/") if s), "")
    return host


# Isolate only the two pure functions and their regex. In particular, DO NOT
# import admin/sources.ts: its imports include database clients and side effects.
NATIVE_IDENTITY_BRIDGE = r'''
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { createHash } from "node:crypto";
const repo = process.argv[1];
const urlSource = readFileSync(join(repo, "packages/backend/src/lib/url.ts"), "utf8");
const adminSource = readFileSync(join(repo, "packages/backend/src/admin/sources.ts"), "utf8");
function extract(text, name) {
  const pattern = new RegExp("^export function " + name + "\\([^]*?^\\}", "m");
  const match = text.match(pattern);
  if (!match) throw new Error("Cannot isolate native pure function: " + name);
  return match[0].replace(/^export /, "");
}
const tracking = urlSource.match(/^const TRACKING_PARAMS\s*=\s*[^]*?;/m)?.[0];
if (!tracking) throw new Error("Native URL tracking pattern not found");
const code = [tracking, extract(urlSource, "normalizeUrl"), extract(adminSource, "sourceIdentity")].join("\n");
const javascript = stripTypeScriptTypes(code);
const { normalizeUrl, sourceIdentity } = new Function(javascript + "\nreturn { normalizeUrl, sourceIdentity }; ")();
const input = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify({
  identities: input.configs.map(c => sourceIdentity(c ?? {})),
  normalized_urls: (input.urls ?? []).map(u => normalizeUrl(u)),
  implementation_sha256: createHash("sha256").update(code).digest("hex"),
  node_version: process.version,
  method: "extracted native normalizeUrl/sourceIdentity; no repository module imports"
}));
'''


def native_identities(repo, configs, urls=None, node="node"):
    try:
        result = subprocess.run(
            [node, "--no-warnings", "--input-type=module", "-e", NATIVE_IDENTITY_BRIDGE, str(repo)],
            input=json.dumps({"configs": configs, "urls": urls or []}),
            text=True, capture_output=True, check=True, timeout=30)
        output = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        detail = getattr(exc, "stderr", None) or str(exc)
        raise ValueError("Cannot run native identity helpers; need Node 22.6+ and the target repository: "
                         + detail[:1500]) from exc
    if len(output.get("identities", [])) != len(configs):
        raise ValueError("Native identity helper returned an unexpected result")
    return output


def _nonnegative_int(value):
    return type(value) is int and value >= 0


def _timestamp(value, label):
    if not isinstance(value, str):
        raise ValueError(label + " must be an ISO-8601 timestamp with an explicit timezone")
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(label + " is not an ISO-8601 timestamp") from exc
    if "T" not in value or stamp.utcoffset() is None:
        raise ValueError(label + " needs a time and explicit timezone")
    return stamp


def runtime_inventory_example():
    """Schema illustration, NOT an assertion that any real environment is empty."""
    return {
        "schema_version": SNAPSHOT_SCHEMA,
        "snapshot_at": "2026-10-19T00:00:00Z",
        "environment": "REPLACE_WITH_TARGET_ENVIRONMENT",
        "complete": True,
        "coverage": {
            "lanes": ["news", "policy"], "includes_archived": True,
            "includes_unarchived": True, "total_rows": 0,
            "by_lane": {"news": 0, "policy": 0},
            "by_archive_state": {"archived": 0, "unarchived": 0},
        },
        "pagination": {"all_pages_fetched": True, "expected_pages": 1,
                       "fetched_pages": 1, "next_cursor": None},
        "sources": [],
    }


def runtime_rows(data):
    """Validate the complete envelope and every row; never infer completeness."""
    if not isinstance(data, dict) or data.get("schema_version") != SNAPSHOT_SCHEMA:
        raise ValueError("Runtime inventory needs schema_version=" + SNAPSHOT_SCHEMA
                         + "; a list, summary or partial API page is not a complete snapshot")
    _timestamp(data.get("snapshot_at"), "snapshot_at")
    if not isinstance(data.get("environment"), str) or not data["environment"].strip():
        raise ValueError("Runtime inventory needs an explicit target environment")
    if data.get("complete") is not True:
        raise ValueError("Runtime inventory must explicitly attest complete=true")
    coverage, pages, rows = data.get("coverage"), data.get("pagination"), data.get("sources")
    if not isinstance(coverage, dict) or not isinstance(pages, dict) or not isinstance(rows, list):
        raise ValueError("Runtime inventory needs coverage, pagination and sources")
    if (coverage.get("lanes") not in (["news", "policy"], ["policy", "news"])
            or coverage.get("includes_archived") is not True
            or coverage.get("includes_unarchived") is not True):
        raise ValueError("Runtime inventory must cover both lanes and archived/unarchived records")
    if (pages.get("all_pages_fetched") is not True
            or not _nonnegative_int(pages.get("expected_pages"))
            or not _nonnegative_int(pages.get("fetched_pages"))
            or pages["expected_pages"] < 1
            or pages["expected_pages"] != pages["fetched_pages"]
            or "next_cursor" not in pages or pages["next_cursor"] is not None):
        raise ValueError("Runtime inventory pagination is incomplete; attest all pages, equal page counts and null next_cursor")
    seen, lane_counts, archive_counts = set(), Counter(), Counter()
    for row in rows:
        if (not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]
                or not isinstance(row.get("kind"), str) or not row["kind"]
                or not isinstance(row.get("config"), dict)):
            raise ValueError("Every runtime row needs id, kind and the full config; public summaries are insufficient")
        if row["id"] in seen:
            raise ValueError("Duplicate ID in runtime inventory: " + row["id"])
        if row.get("lane") not in LANES or type(row.get("enabled")) is not bool:
            raise ValueError("Every runtime row needs explicit lane and boolean enabled")
        owner = row.get("owner_entity_id")
        if "owner_entity_id" not in row or (owner is not None and (
                not isinstance(owner, str) or not owner.strip() or len(owner) > 120)):
            raise ValueError("Every runtime row needs explicit owner_entity_id (null or a nonempty string up to 120 characters)")
        if "archived_at" not in row:
            raise ValueError("Every runtime row needs explicit archived_at (timestamp or null)")
        if row["archived_at"] is not None:
            _timestamp(row["archived_at"], "archived_at for " + row["id"])
        seen.add(row["id"])
        lane_counts[row["lane"]] += 1
        archive_counts["archived" if row["archived_at"] is not None else "unarchived"] += 1
    expected_lanes = {k: lane_counts[k] for k in sorted(LANES)}
    expected_states = {k: archive_counts[k] for k in ("archived", "unarchived")}
    if (not _nonnegative_int(coverage.get("total_rows")) or coverage["total_rows"] != len(rows)
            or coverage.get("by_lane") != expected_lanes
            or coverage.get("by_archive_state") != expected_states
            or any(not _nonnegative_int(v) for v in coverage.get("by_lane", {}).values())
            or any(not _nonnegative_int(v) for v in coverage.get("by_archive_state", {}).values())):
        raise ValueError("Runtime inventory totals must match all rows, both lanes and both archive states")
    return [{**row, "_provenance": "runtime_snapshot"} for row in rows]


def native_policy_rows(data):
    """Retain collect=null identity; inferred seed IDs are not observed live IDs."""
    out = []
    for row in data.get("sources", []):
        collect = row.get("collect") or {}
        out.append({
            **collect, "id": "policy-" + row["id"].lower(), "lane": "policy",
            "name": row.get("authority", {}).get("zh", "") + " · " + row.get("name", {}).get("zh", ""),
            "kind": collect.get("kind"), "config": collect.get("config"),
            "catalogue_id": row["id"], "catalogue_status": row.get("status"),
            "collect_configured": bool(collect.get("kind") and isinstance(collect.get("config"), dict)),
            "listed_url": row.get("listed_url"), "entry": row.get("entry"),
            "website": row.get("website"), "hold": row.get("hold"),
            "_provenance": "policy_catalogue",
        })
    return out


def catalogue_rows(news, policy):
    return [{**row, "lane": row.get("lane", "news"), "_provenance": "news_catalogue"}
            for row in news["sources"]] + native_policy_rows(policy)


def source_urls(row):
    return [u for u in (raw_endpoint(row), row.get("listed_url"), row.get("entry"),
                       row.get("website")) if u]


def same_native(candidate, row):
    return (candidate.get("kind") == row.get("kind") and bool(candidate.get("_native_identity"))
            and candidate["_native_identity"] == row.get("_native_identity"))


def relation(candidate, meta, row):
    if candidate["id"] == row["id"]:
        return "same_id"
    if same_native(candidate, row):
        return "native_identity"
    catalogue_ids = set(meta.get("existing_policy_catalogue_ids", []))
    if row.get("catalogue_id") in catalogue_ids:
        return "declared_policy_catalogue"
    declared = set(meta.get("existing_source_ids", []) + meta.get("possible_existing_runtime_source_ids", []))
    if row["id"] in declared:
        return "declared_source_reference"
    wanted = endpoint(candidate)
    if wanted and any(canonical(u) == wanted for u in source_urls(row)):
        return "same_semantic_entry_review"
    if row["lane"] != candidate["lane"]:
        return None
    aliases = source_urls(candidate) + [meta.get("homepage")] + meta.get("identity_alias_urls", [])
    scopes = {publisher_scope(u) for u in aliases if u} - {""}
    return "publisher_review" if any(publisher_scope(u) in scopes for u in source_urls(row)) else None


def summarize(row, why=None):
    runtime = row.get("_provenance") == "runtime_snapshot"
    return {"id": row["id"], "name": row.get("name"), "kind": row.get("kind"),
            "lane": row["lane"], "entry": endpoint(row),
            "native_identity": row.get("_native_identity"), "config_hash": config_hash(row),
            "relation": why, "provenance": row.get("_provenance"),
            "catalogue_id": row.get("catalogue_id"),
            "runtime_id_if_seeded": row["id"] if row.get("_provenance") == "policy_catalogue" else None,
            "collect_configured": row.get("collect_configured", bool(config_hash(row))),
            "catalogue_urls": source_urls(row) if not runtime else [],
            "catalogue_status": row.get("catalogue_status"), "hold": row.get("hold"),
            "owner_entity_id": row.get("owner_entity_id"), "runtime_observed": runtime,
            "enabled": row.get("enabled") if runtime else None,
            "archived_at": row.get("archived_at") if runtime else None}


def choose_target(rows, candidate):
    """Only rows chosen by identity may contribute paused/archived protection."""
    return sorted(rows, key=lambda r: (config_hash(r) != config_hash(candidate),
                                      r["id"] != candidate["id"], r["id"]))[0]


def reconcile(candidate, meta, catalogues, runtime, package_rows, runtime_complete):
    cm = [(r, relation(candidate, meta, r)) for r in catalogues]
    rm = [(r, relation(candidate, meta, r)) for r in runtime]
    cm, rm = [(r, rel) for r, rel in cm if rel], [(r, rel) for r, rel in rm if rel]
    # The live row may have moved to a different host or adapter without a
    # matching registry declaration. Its catalogue ID still exists: do not
    # declare it absent or propose a second creation using that occupied ID.
    referenced_ids = {r["id"] for r, rel in cm if rel != "publisher_review"}
    related_runtime_ids = {r["id"] for r, _ in rm}
    rm += [(r, "catalogue_id_runtime_reference") for r in runtime
           if r["id"] in referenced_ids and r["id"] not in related_runtime_ids]
    direct = [r for r, rel in rm if rel in ("same_id", "native_identity")
              and r["lane"] == candidate["lane"]]
    active = [r for r in direct if r["archived_at"] is None and r["enabled"]]
    paused = [r for r in direct if r["archived_at"] is None and not r["enabled"]]
    archived = [r for r in direct if r["archived_at"] is not None]
    id_collisions = [r for r, rel in cm + rm if rel == "same_id" and r["lane"] != candidate["lane"]]
    cross_runtime = [r for r in runtime if r["archived_at"] is None
                     and r["lane"] != candidate["lane"] and same_native(candidate, r)]
    cross_catalogue = [r for r in catalogues if r["lane"] != candidate["lane"] and same_native(candidate, r)]
    package_matches = [r for r in package_rows if r["id"] != candidate["id"] and same_native(candidate, r)]
    known_catalogue = [r for r, rel in cm if r["lane"] == candidate["lane"] and rel in (
        "same_id", "native_identity", "same_semantic_entry_review", "declared_policy_catalogue")]
    selected, suggested_id = None, None

    # State never masks ID/lane collisions. Native creation excludes archived
    # duplicates but checks the same kind/identity across BOTH lanes.
    if id_collisions:
        action, basis = "blocked_id_lane_collision", "same_id_other_lane"
    elif cross_runtime:
        action, basis = "blocked_native_identity_cross_lane", "runtime_native_identity_other_lane"
    elif any(r["lane"] != candidate["lane"] for r in package_matches):
        action, basis = "blocked_package_native_identity_cross_lane", "package_native_identity_other_lane"
    elif package_matches:
        action, basis = "review_package_duplicate", "package_native_identity"
    elif active:
        selected = choose_target(active, candidate)
        basis = "runtime_identity"
        action = "reuse_existing" if config_hash(selected) == config_hash(candidate) else "review_existing_configuration"
    elif paused:
        selected, action, basis = choose_target(paused, candidate), "preserve_pause", "runtime_identity"
    elif archived:
        selected, action, basis = choose_target(archived, candidate), "preserve_archive", "runtime_identity"
    elif candidate["lane"] == "policy":
        action, basis = "policy_catalogue_only", "known_catalogue" if cm else "policy_candidate"
    elif cross_catalogue:
        action, basis = "review_catalogue_native_identity_cross_lane", "catalogue_native_identity_other_lane"
    elif rm:
        action, basis = "review_optimization_or_supplement", "related_runtime_sources"
    elif known_catalogue:
        selected = choose_target(known_catalogue, candidate)
        basis = "known_catalogue"
        if runtime_complete:
            action = "catalogue_source_absent_from_runtime"
            suggested_id = selected["id"]
        else:
            action = "catalogue_known_runtime_unchecked"
    elif cm:
        action, basis = "review_optimization_or_supplement", "related_catalogue_sources"
    elif not meta.get("ready_for_preview", False):
        action, basis = "hold_for_adapter_or_validation", "new_candidate"
    elif not runtime_complete:
        action, basis = "new_catalogue_candidate_runtime_unchecked", "new_catalogue_candidate"
    else:
        action, basis = "new_ready_for_preview", "absent_from_complete_snapshot_and_catalogue"
        suggested_id = candidate["id"]

    # Policy material remains a catalogue/review deliverable. No policy intake.
    if candidate["lane"] == "policy" and action in ("reuse_existing", "review_existing_configuration"):
        action = "policy_catalogue_only"
    return {
        "source_key": meta["id"], "candidate_id": candidate["id"], "lane": candidate["lane"],
        "review_level": "runtime_snapshot" if runtime_complete else "catalogue_only",
        "basis": basis, "action": action, "ready_for_preview": bool(meta.get("ready_for_preview")),
        "existing_source_ids": meta.get("existing_source_ids", []),
        "existing_policy_catalogue_ids": meta.get("existing_policy_catalogue_ids", []),
        "possible_existing_runtime_source_ids": meta.get("possible_existing_runtime_source_ids", []),
        "candidate_entry": endpoint(candidate), "native_identity": candidate.get("_native_identity"),
        "target_config_hash": config_hash(candidate), "matches": [summarize(r, rel) for r, rel in cm + rm],
        "selected_target": summarize(selected) if selected else None,
        "suggested_creation_id": suggested_id,
        "runtime_presence": "observed_identity" if direct else (
            "absent_same_lane_identity_at_snapshot" if runtime_complete else "not_checked"),
        "runtime_uniqueness_checked": runtime_complete,
        "package_matches": [summarize(r, "native_identity") for r in package_matches],
        "related_source_states_are_not_inherited": True,
        "preserved_runtime_states": [{"id": r["id"], "enabled": r["enabled"],
                                      "archived_at": r["archived_at"]} for r, _ in rm],
        "activation_proposed": False,
        "next_step": (
            "Review a disabled creation draft under suggested_creation_id; recheck the target environment before intake."
            if suggested_id else
            "Review the recorded matches and validation status; this file authorizes no creation, update or activation."),
    }


def reconcile_all(repo, original_news, policy_data, metadata_data, candidates_data,
                  snapshot=None, node="node"):
    catalogues = catalogue_rows(original_news, policy_data)
    runtime = runtime_rows(snapshot) if snapshot is not None else []
    metadata_list, supplied = metadata_data["sources"], candidates_data["sources"]
    by_native_id, research_ids = {}, set()
    for meta in metadata_list:
        if meta["id"] in research_ids:
            raise ValueError("Duplicate registry research ID: " + meta["id"])
        research_ids.add(meta["id"])
        native_id = meta.get("native_source_id")
        if native_id:
            if native_id in by_native_id:
                raise ValueError("Duplicate native_source_id in registry: " + native_id)
            by_native_id[native_id] = meta
    candidates, seen = [], set()
    for row in supplied:
        if row.get("id") in seen:
            raise ValueError("Duplicate candidate ID: " + row["id"])
        if (row.get("id") not in by_native_id or row.get("lane") not in LANES
                or not config_hash(row)):
            raise ValueError("Every native candidate needs id, lane, kind/config and matching registry.native_source_id")
        meta = by_native_id[row["id"]]
        expected = "sa5-" + re.sub(r"[^a-z0-9]+", "-", meta["id"].lower()).strip("-")
        if row["id"] != expected:
            raise ValueError("Native candidate ID must be " + expected)
        if row.get("enabled") is not None and row["enabled"] is not False:
            raise ValueError("Candidate must not request enabled=true")
        candidates.append({**row, "_provenance": "package_candidate"})
        seen.add(row["id"])
    rows = catalogues + runtime + candidates
    native = native_identities(repo, [r.get("config") or {} for r in rows], node=node)
    for row, identity in zip(rows, native["identities"]):
        row["_native_identity"] = identity
    decisions = [reconcile(c, by_native_id[c["id"]], catalogues, runtime, candidates, snapshot is not None)
                 for c in candidates]
    additions = [dict(supplied[i]) for i, d in enumerate(decisions) if d["action"] in (
        "new_ready_for_preview", "new_catalogue_candidate_runtime_unchecked")]
    # Registry-only endpoints may have no native adapter at all. Still expose
    # their explicit references to collect=null policy directory records.
    unconfigured_references = []
    for row in catalogues:
        if row.get("_provenance") != "policy_catalogue" or row["collect_configured"]:
            continue
        linked = [m["id"] for m in metadata_list
                  if row["catalogue_id"] in m.get("existing_policy_catalogue_ids", [])]
        if linked:
            unconfigured_references.append({
                "source_keys": linked, "catalogue": summarize(row, "declared_policy_catalogue"),
                "named_runtime_matches": [summarize(r, "inferred_seed_id_reference")
                                          for r in runtime if r["id"] == row["id"]],
                "identity_verified": False,
            })
    result = {
        "schema_version": "aimine.source-reconciliation.v2", "repository": str(repo),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "runtime_inventory_supplied": snapshot is not None,
        "review_level": "runtime_snapshot" if snapshot is not None else "catalogue_only",
        "runtime_snapshot": {k: snapshot[k] for k in ("schema_version", "snapshot_at", "environment", "coverage", "pagination")}
        if snapshot is not None else None,
        "native_identity": {k: v for k, v in native.items() if k not in ("identities", "normalized_urls")},
        "counts": dict(Counter(d["action"] for d in decisions)), "decisions": decisions,
        "unconfigured_policy_catalogue_references": unconfigured_references,
        "draft_only": True,
        "limitations": [
            "Snapshot completeness is an exporter assertion checked for consistency, not a live database observation by this tool.",
            "Absence and uniqueness apply only at snapshot_at; refresh the target inventory before source intake.",
            "Publisher and catalogue references are review hints, not proof of runtime identity or running state.",
            "Proposal files are not source-intake manifests; use the target environment's audited intake workflow.",
        ],
        "effects": "Only local review drafts were written; no repository, database, source state, deployment or network service was changed.",
    }
    return result, additions


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--package", type=Path, default=Path(__file__).resolve().parents[1])
    ap.add_argument("--runtime-json", type=Path, help="Complete snapshot envelope; partial exports are rejected")
    ap.add_argument("--node", default="node", help="Node 22.6+ executable for native identity functions")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    repo, package, out = args.repo.resolve(), args.package.resolve(), args.out.resolve()
    if out == repo or repo in out.parents:
        ap.error("--out must be outside the repository; this command only creates review files")
    inputs = [repo / "industry/sources.json", repo / "industry/policy-sources.json",
              package / "config/registry.json", package / "config/native.sources.json"]
    if args.runtime_json:
        inputs.append(args.runtime_json.resolve())
    names = ["news.catalogue.proposed.json", "new.sources.proposed.json", "reconciliation.json"]
    for name in names:
        dest = out / name
        if dest.is_symlink() or dest.resolve() in {p.resolve() for p in inputs}:
            ap.error("Output must not overwrite an input or follow a file symlink: " + str(dest))
        if repo == dest.resolve() or repo in dest.resolve().parents:
            ap.error("Output must not point into the repository")
    try:
        news, policy, metadata, candidates = [read(p) for p in inputs[:4]]
        snapshot = read(args.runtime_json) if args.runtime_json else None
        result, additions = reconcile_all(repo, news, policy, metadata, candidates, snapshot, args.node)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        ap.error(str(exc))
    out.mkdir(parents=True, exist_ok=True)
    write(out / names[0], {**news, "sources": news["sources"] + additions})
    write(out / names[1], {"draft_only": True, "review_level": result["review_level"],
                          "activation_proposed": False, "sources": additions})
    write(out / names[2], result)
    print(json.dumps({"output": str(out), "counts": result["counts"],
                      "review_level": result["review_level"], "draft_only": True}, ensure_ascii=False))


if __name__ == "__main__":
    main()
