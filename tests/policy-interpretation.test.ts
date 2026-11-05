import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { policyModelQualification } from "../modules/policy/backend/domain/model-evidence.ts";
import { stub, gate, tag } from "./setup.ts";
import { answer, interpretReply, verifyReply } from "./policy-automation-provider.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb, initializeDb } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { recordPolicyOriginal } from "../modules/policy/backend/domain/originals.ts";
import { runPolicyFulltext } from "../modules/policy/backend/domain/fulltext-runtime.ts";
import { setPolicyProcessingPaused } from "../modules/policy/backend/domain/fulltext-store.ts";
import { runPolicyInterpretation, loadPolicyInterpretation } from "../modules/policy/backend/domain/interpretation-runtime.ts";
import { checkCandidate, CandidateReply, checkVerification, aggregateVerification } from "../modules/policy/backend/domain/interpretation-schema.ts";
import { buildPolicyFulltextPlan, type PolicyFulltextPlan } from "../modules/policy/backend/domain/processing-plan.ts";
import { normalizeSourceTime } from "@amp/contracts/time-assertion";
import { sha256 } from "../packages/backend/src/lib/ids.ts";
import { grantDateFixture } from "./source-date-fixture.ts";

const root = await initializeDb("test");
type Payload = ReturnType<typeof JSON.parse>;
const requests: Payload[] = [];
let mode = "pass",
  usage: { prompt_tokens: number; completion_tokens: number } | null = { prompt_tokens: 50, completion_tokens: 20 };
let beforeResponse = async (_input: Payload) => {};
const provider = await stub(async (_hit, req) => {
  const body = JSON.parse(req.body),
    input = JSON.parse(body.messages.at(-1).content);
  requests.push(input);
  await beforeResponse(input);
  const output = answer(input);
  if (input.phase === "interpret") {
    if (["excluded_pass", "excluded_veto"].includes(mode)) output.relevance = "excluded";
    // A number the cited quote does not contain: code cannot decide it, the model verifier must.
    if (["number_veto", "number_pass", "missing_judgment"].includes(mode)) output.main_points.push({ ...output.main_points[0], text: "上限提高到99吨" });
    if (mode === "bad_ref") output.evidence[0].part_id = "p99999";
    if (mode === "bad_quote") output.evidence[0].quote = "Invented text";
  }
  if (input.phase === "verify") {
    const verdict = (claim: Payload) =>
      (mode === "excluded_veto" && claim.path === "relevance") || (mode === "number_veto" && String(claim.value?.text).includes("99")) ? "vetoes" : "supports";
    Object.assign(output, verifyReply(input, verdict));
    if (mode === "missing_judgment") output.judgments.pop();
  }
  return {
    id: `synthetic-${requests.length}`,
    ...(mode === "no_model" ? {} : { model: "reported-test-model" }),
    choices: [{ message: { content: mode === "bad_json" && input.phase ? "not-json" : JSON.stringify(output) }, finish_reason: "stop" }],
    usage,
  };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "synthetic-test-only", LLM_MODEL: "unchanged-stage-model" });
config.modelCallsEnabled = true;
await installUsageFixtureForModel("default", sql);
beforeEach(() => {
  mode = "pass";
  usage = { prompt_tokens: 50, completion_tokens: 20 };
  beforeResponse = async () => {};
});
after(async () => {
  await provider.close();
  await closeDb();
});
const profile = { bodySelector: "article", attachmentSelector: null, maxBytes: 2_000_000, maxResources: 8, maxPages: 40, maxTextBytes: 2_000_000 };
async function fixture(count = 1) {
  const sourceId = `interpret-${tag()}`,
    url = `https://source.invalid/${sourceId}`;
  await sql`INSERT INTO sources(id,name,kind,lane,enabled) VALUES(${sourceId},${sourceId},'external','policy',false)`;
  await grantDateFixture(sourceId, [url]);
  const value = {
    sourceId,
    permissionVersion: 1,
    identity: { jurisdiction: "AR", authority: sourceId, documentType: "regulation", documentNumber: "fixture-1", officialUrl: url },
    versionKey: "official-1",
    language: "en",
    kind: "original",
    officialTitle: "Synthetic Mining Regulation",
    expectedHead: null,
    catalogueClosed: true,
    resources: [
      {
        url,
        mediaType: "text/html; charset=utf-8",
        attachment: false,
        required: true,
        state: "acquired",
        reason: null,
        body: Buffer.from(
          `<article>${Array.from({ length: count }, (_, i) => `<p>${i === count - 1 && count > 1 ? `Exception: mining above 50 kg is prohibited in ${sourceId}.` : `Published Regulation ${sourceId}: Mining threshold at ${i + 10} kg.`}</p>`).join("")}</article>`,
        ),
      },
    ],
  };
  const original = await recordPolicyOriginal(value),
    fulltext = await runPolicyFulltext(original.expressionId, profile, { root, maxRequests: 1000 });
  assert.equal(fulltext.status, "program_validated");
  assert.ok("runId" in fulltext);
  return { sourceId, original, runId: fulltext.runId, value };
}
const phases = (from: number) => requests.slice(from).map((r) => r.phase ?? "fulltext");

test("a first version is interpreted whole but chunk-bounded, verified by code, replayed without sends, and never grants publication", async () => {
  const f = await fixture(300),
    before = requests.length;
  const partial = await runPolicyInterpretation(f.runId, { root, maxRequests: 1 });
  assert.equal(partial.status, "partial");
  assert.equal(requests.length - before, 1);
  const complete = await runPolicyInterpretation(f.runId, { root, maxRequests: 100 });
  assert.equal(complete.status, "semantic_verified");
  assert.equal(complete.publication_authorized, false);
  assert.ok("candidate" in complete && complete.candidate);
  const calls = requests.slice(before);
  // About 22 kB of provision text: a few bounded chunks, one interpret call each; no group, merge or verify call.
  assert.ok(calls.length >= 2 && phases(before).every((phase) => phase === "interpret"));
  assert.deepEqual(
    calls.map((c) => c.chunk),
    calls.map((_, i) => ({ index: i + 1, count: calls.length })),
  );
  assert.equal(calls[0].so_far, null);
  assert.ok(calls[1].so_far.legal_state, "the second chunk continues from the first one's document fields");
  assert.ok(calls.every((c) => Buffer.byteLength(JSON.stringify(c.provisions)) < 20_000));
  assert.ok(complete.decisions.every((d) => d.verdict === "passes"));
  assert.ok(complete.candidate.main_points.length <= 16 && complete.candidate.main_points.length > 1);
  const after = requests.length,
    loaded = await loadPolicyInterpretation(f.runId);
  assert.equal(loaded!.semantic_verified, true);
  assert.equal(loaded!.contentHash, complete.contentHash);
  assert.equal(requests.length, after);
  assert.deepEqual(loaded!.models, policyModelQualification(loaded!.modelEvidence).models);
  assert.ok(loaded!.models.length > 0 && loaded!.models.every((key) => /^pmodel1:[a-f0-9]{64}$/u.test(key)));
  assert.equal(loaded!.modelEvidenceComplete, true);
  assert.ok(loaded!.modelEvidence.every((m) => m.requestedModel === "unchanged-stage-model"));
  const physical = loaded!.modelEvidence.at(-1)!;
  await sql`UPDATE receipts SET request=request||${sql.json({ configuration_hash: sha256("logical request is not proof") })} WHERE id=${physical.receiptId}`;
  await sql`DELETE FROM ai.model_attempt_snapshots WHERE attempt_id=${physical.attemptId}::bigint`;
  const missing = await loadPolicyInterpretation(f.runId);
  assert.equal(missing?.semantic_verified, true);
  assert.equal(missing?.modelEvidenceComplete, false);
  assert.equal(requests.length, after, "missing physical evidence does not trigger a paid retry");
});

test("only claims code cannot decide reach the model verifier; a vetoed item is dropped without a rewrite call", async () => {
  const f = await fixture(3),
    before = requests.length;
  mode = "number_veto";
  const vetoed = await runPolicyInterpretation(f.runId, { root, maxRequests: 100 });
  assert.equal(vetoed.status, "semantic_verified");
  assert.deepEqual(phases(before), ["interpret", "verify"]);
  assert.deepEqual(
    requests.at(-1)!.claims.map((c: Payload) => c.value.text),
    ["上限提高到99吨"],
    "only the undecidable claim is sent",
  );
  assert.ok("candidate" in vetoed && vetoed.candidate && !vetoed.candidate.main_points.some((p) => p.text.includes("99")));
  mode = "pass";
  const next = await fixture(3),
    at = requests.length;
  mode = "number_pass";
  const kept = await runPolicyInterpretation(next.runId, { root, maxRequests: 100 });
  assert.equal(kept.status, "semantic_verified");
  assert.ok("candidate" in kept && kept.candidate?.main_points.some((p) => p.text.includes("99")));
  assert.deepEqual(phases(at), ["interpret", "verify"]);
});

test("excluded relevance is always checked by the model verifier before it may hide a policy", async () => {
  for (const [choice, expected] of [
    ["excluded_veto", "semantic_failed"],
    ["excluded_pass", "excluded"],
  ]) {
    mode = "pass";
    const f = await fixture(5),
      before = requests.length;
    mode = choice!;
    const result = await runPolicyInterpretation(f.runId, { root, maxRequests: 100 });
    assert.equal(result.status, expected);
    assert.deepEqual(phases(before), ["interpret", "verify"]);
    assert.equal(result.semantic_verified, expected === "excluded");
  }
});

test("replies outside the actual input and malformed answers cannot be retried by rerunning", async () => {
  for (const failure of ["bad_ref", "bad_quote", "missing_judgment", "bad_json"]) {
    mode = "pass";
    const f = await fixture(3);
    mode = failure;
    const bad = await runPolicyInterpretation(f.runId, { root, maxRequests: 100 });
    assert.equal(bad.status, "invalid_output", failure);
    const at = requests.length;
    assert.equal((await runPolicyInterpretation(f.runId, { root, maxRequests: 100 })).status, "invalid_output");
    assert.equal(requests.length, at, "rejected immutable input is not purchased again");
  }
});

test("missing usage does not erase valid proof; missing provider identity remains missing evidence", async () => {
  const f = await fixture();
  usage = null;
  assert.equal((await runPolicyInterpretation(f.runId, { root, maxRequests: 100 })).status, "semantic_verified");
  const at = requests.length;
  assert.equal((await runPolicyInterpretation(f.runId, { root, maxRequests: 100 })).status, "semantic_verified");
  assert.equal(requests.length, at);
  usage = { prompt_tokens: 50, completion_tokens: 20 };
  const next = await fixture();
  mode = "no_model";
  const output = await runPolicyInterpretation(next.runId, { root, maxRequests: 100 });
  assert.equal(output.status, "semantic_verified");
  assert.ok("modelEvidenceComplete" in output && !output.modelEvidenceComplete);
  assert.ok(output.modelEvidence.some((item) => item.reportedModel === null));
  assert.equal(output.publication_authorized, false);
});

test("a pause during a real local request keeps its receipt and resumes it without a second paid send", async () => {
  const f = await fixture(),
    started = gate(),
    finish = gate(),
    before = requests.length;
  beforeResponse = async (input) => {
    if (input.phase === "interpret") {
      started.open();
      await finish.promise;
    }
  };
  const pending = runPolicyInterpretation(f.runId, { root, maxRequests: 10 });
  await started.promise;
  await setPolicyProcessingPaused(f.original.expressionId, { expectedVersion: 1, paused: true, reason: "synthetic pause", actor: "test" });
  finish.open();
  assert.equal((await pending).status, "stale");
  beforeResponse = async () => {};
  await setPolicyProcessingPaused(f.original.expressionId, { expectedVersion: 2, paused: false, reason: "synthetic resume", actor: "test" });
  const resumed = await runPolicyFulltext(f.original.expressionId, profile, { root, maxRequests: 10 });
  assert.equal(resumed.status, "program_validated");
  assert.ok("runId" in resumed && typeof resumed.runId === "string");
  const result = await runPolicyInterpretation(resumed.runId, { root, maxRequests: 10 });
  assert.equal(result.status, "semantic_verified");
  assert.equal(requests.slice(before).filter((r) => r.phase === "interpret").length, 1);
});

test("literal date components, source title, evidence references and law targets cannot be invented", () => {
  const source = "Published Regulation. Effective 2026-10-01. It refers to Act-B at https://source.invalid/b.";
  const built = buildPolicyFulltextPlan(
    {
      revisionId: sha256("r"),
      state: "extracted",
      gaps: [],
      resources: [{ url: "https://source.invalid/a", sha256: sha256(source), state: "extracted", gaps: [], nodes: [{ id: "node", ordinal: 0, text: source }] }],
    },
    { sourceId: "source", expressionId: "expression", language: "en", identityHash: sha256("identity"), recipeVersion: "test" },
  );
  assert.equal(built.status, "planned");
  const plan = built as PolicyFulltextPlan,
    part = plan.parts[0]!;
  const identity = { title: "Synthetic Mining Regulation", number: "fixture-1", jurisdiction: "AR", sequence: 1 };
  const reply = interpretReply({ mode: "first_version", provisions: [{ label: null, change: "added", parts: [{ ref: part.partId, text: source }] }] });
  const c = CandidateReply.parse({
    ...reply,
    id: sha256("c"),
    input_hash: sha256("input"),
    input_ids: [sha256("root")],
    document_title: identity.title,
    instrument_number: identity.number,
    comparisons: [],
  });
  const date = normalizeSourceTime(
    { meaning: "effective", raw: "2026-10-01", local_date: "2026-10-01", local_time: null, timezone: null, utc: null, basis: "原文", condition_text: null },
    { instantBasis: null, timezoneEvidence: null },
  );
  c.legal_state.enforcement.arrangements = [{ text: "明确日期", time: date, occurrence: "planned", scope: null, condition: null, evidence_ids: ["e1"] }];
  assert.doesNotThrow(() => checkCandidate(c, plan, identity, []));
  const corrupted = structuredClone(c);
  corrupted.impacts[0]!.impact += "\uFFFD";
  assert.throws(() => checkCandidate(corrupted, plan, identity, []), /candidate_character_integrity/);
  const wrong = structuredClone(c);
  wrong.legal_state.enforcement.arrangements[0]!.time!.local_date = "2027-10-01";
  assert.throws(() => checkCandidate(wrong, plan, identity, []), /date_components_unproved/);
  assert.throws(() => checkCandidate({ ...c, document_title: "Invented" }, plan, identity, []), /official_identity_changed/);
  c.relationships = [{ relation: "repeals", target_policy_id: "lawB", target_citation: "Act-B", evidence_ids: ["e1"] }];
  assert.throws(() => checkCandidate(c, plan, identity, []), /relationship_target_unproved/);
  assert.throws(
    () => checkCandidate(c, plan, identity, [{ id: "lawB", citation: "Act-B", url: "https://source.invalid/b", jurisdiction: "BR", qualified: true }]),
    /relationship_target_unproved/,
  );
  assert.doesNotThrow(() =>
    checkCandidate(c, plan, identity, [{ id: "lawB", citation: "Act-B", url: "https://source.invalid/b", jurisdiction: "AR", qualified: true }]),
  );
  const claims = [{ id: "claim", path: "impact", value: "rule", requiresSupport: true }];
  assert.equal(
    aggregateVerification(claims, [{ judgments: [{ claim_id: "claim", verdict: "not_applicable", quotes: [], reason: "none" }] } as never])[0]!.verdict,
    "unsupported",
  );
  assert.throws(
    () =>
      checkVerification(
        { id: sha256("v"), input_hash: sha256("i"), group_id: sha256("g"), candidate_hash: sha256("c"), judgments: [], publication_authorized: false },
        { id: sha256("v"), inputHash: sha256("i"), groupId: sha256("g"), candidateHash: sha256("c"), claims, parts: [part] },
      ),
    /coverage_mismatch/,
  );
});
