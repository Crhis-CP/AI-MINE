import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Policy } from "@amp/contracts/http/public";
import { normalizeSourceTime } from "@amp/contracts/time-assertion";
import { completePolicy, policyBackfill } from "../packages/backend/src/publication/policies-project.ts";
import { checkCandidate, candidateClaims, type Candidate } from "../packages/backend/src/policy/interpretation-schema.ts";
import { buildPolicyFulltextPlan } from "../packages/backend/src/policy/processing-plan.ts";
import type { FulltextRun } from "../packages/backend/src/policy/fulltext-store.ts";
const base = Policy.parse(JSON.parse(readFileSync("tests/fixtures/policy-public/complete.json", "utf8")));
const source = "Published 2026-01-01. Substantive amendment 2026-02-01. Planned publication 2027-01-01.";
const plan = buildPolicyFulltextPlan(
  {
    revisionId: "revision",
    state: "extracted",
    gaps: [],
    resources: [
      { url: "https://official.invalid/law", sha256: "1".repeat(64), state: "extracted", gaps: [], nodes: [{ id: "node", ordinal: 0, text: source }] },
    ],
  },
  { sourceId: "source", expressionId: "expression", language: "en", identityHash: "2".repeat(64), recipeVersion: "synthetic" },
);
if (plan.status !== "planned") throw new Error("fixture plan");
const time = (raw: string, meaning: "published" | "updated") =>
  normalizeSourceTime(
    { meaning, raw, local_date: raw, local_time: null, utc: null, timezone: null, basis: "source literal", condition_text: null },
    { instantBasis: null, timezoneEvidence: null },
  );
const unknown = { value: "unknown" as const, basis: null, evidence_ids: [] };
const candidate: Candidate = {
  id: "3".repeat(64),
  input_hash: "4".repeat(64),
  input_ids: ["root"],
  document_title: "Original",
  title_zh: "矿业法规",
  instrument_number: "1",
  relevance: "relevant",
  relevance_evidence_ids: ["e"],
  legal_state: {
    nature: { value: "regulation", basis: "source", evidence_ids: ["e"] },
    legislative_stage: { value: "published", basis: "source", evidence_ids: ["e"] },
    publication: { value: "published", basis: "source", evidence_ids: ["e"], time: time("2026-01-01", "published") },
    enforcement: { ...unknown, arrangements: [] },
    applicability: [],
    deadlines: [],
    repeal: unknown,
  },
  publication_events: [
    { time: { ...time("2026-01-01", "published"), event_kind: "original_publication", occurrence: "occurred" }, evidence_ids: ["e"] },
    { time: { ...time("2026-02-01", "updated"), event_kind: "substantive_change", occurrence: "occurred" }, evidence_ids: ["e"] },
    { time: { ...time("2027-01-01", "published"), event_kind: "original_publication", occurrence: "planned" }, evidence_ids: ["e"] },
  ],
  main_points: base.main_points.map((p) => ({ ...p, evidence_ids: ["e"] })),
  impacts: base.impacts.map((i) => ({ ...i, evidence_ids: ["e"], deadline: null })),
  relationships: [],
  dynamic_zh: "合成日期事件",
  gaps: [],
  comparisons: [],
  evidence: [{ id: "e", part_id: plan.parts[0]!.partId, quote: source }],
};
test("publication event dates require literal evidence, retain planned events and sort on the latest occurred substantive change", () => {
  assert.doesNotThrow(() => checkCandidate(candidate, plan, { title: "Original", number: "1", jurisdiction: "AR", sequence: 1 }, []));
  assert.equal(candidateClaims(candidate).filter((c) => c.path.startsWith("publication_events")).length, 3);
  const run = { plan, snapshot: { sourceId: "source" } } as FulltextRun;
  const projected = completePolicy(base, candidate, run, { e: "public-evidence" });
  assert.equal(projected.success, true, projected.success ? undefined : JSON.stringify(projected.error.issues));
  if (!projected.success) return;
  assert.equal(projected.data.dates.length, 3);
  assert.equal(projected.data.sort_kind, "substantive_change");
  assert.equal(projected.data.sort_time!.local_date, "2026-02-01");
  assert.equal(projected.data.published_time.local_date, "2026-01-01");
  const invented = structuredClone(candidate);
  invented.publication_events![1]!.time.raw = "2026-03-01";
  assert.throws(() => checkCandidate(invented, plan, { title: "Original", number: "1", jurisdiction: "AR", sequence: 1 }, []), /date_has_no_source_literal/);
});
test("backfill compares the source calendar and never guesses an unknown timezone", () => {
  const day = { ...time("2026-01-01", "published"), timezone: "Asia/Shanghai" };
  assert.equal(policyBackfill(day, "2026-01-01T17:00:00Z"), true);
  assert.equal(policyBackfill(day, "2026-01-01T10:00:00Z"), false);
  assert.equal(policyBackfill({ ...day, timezone: null }, "2026-01-02T17:00:00Z"), false);
});
