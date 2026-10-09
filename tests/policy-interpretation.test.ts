import { stub, gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { dbOf, closeDb, initializeDb } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { recordPolicyOriginal } from "../packages/backend/src/policy/originals.ts";
import { runPolicyFulltext, setPolicyProcessingPaused } from "@amp/backend/policy/fulltext";
import { runPolicyInterpretation, loadPolicyInterpretation } from "@amp/backend/policy/interpretation";
import { checkCandidate, CandidateReply, checkVerification, aggregateVerification } from "../packages/backend/src/policy/interpretation-schema.ts";
import { buildPolicyFulltextPlan, type PolicyFulltextPlan } from "../packages/backend/src/policy/processing-plan.ts";
import { normalizeSourceTime } from "@amp/contracts/time-assertion";
import { sha256 } from "../packages/backend/src/lib/ids.ts";
import { grantDateFixture } from "./source-date-fixture.ts";

const sql = dbOf("policy"),
  root = await initializeDb("test");
type Payload = ReturnType<typeof JSON.parse>;
const requests: Payload[] = [],
  groupReplies: Payload[] = [];
let mode = "pass",
  usage: { prompt_tokens: number; completion_tokens: number } | null = { prompt_tokens: 50, completion_tokens: 20 };
let beforeResponse = async (_input: Payload) => {};
const visible = (value: string) => value.replace(/<[^>]+>/g, "");
function candidate(input: Payload) {
  const quote = input.root.quotes[0],
    known = (value: string) => ({ value, basis: "原文", evidence_ids: ["e1"] });
  const unknown = { value: "unknown", basis: null, evidence_ids: [] };
  return {
    id: input.id,
    input_hash: input.input_hash,
    input_ids: [input.root.id],
    document_title: input.identity.title,
    title_zh: "合成矿业规章",
    instrument_number: input.identity.number,
    relevance: "relevant",
    relevance_evidence_ids: ["e1"],
    legal_state: {
      nature: known("regulation"),
      legislative_stage: known("published"),
      publication: { ...known("published"), time: null },
      enforcement: { ...unknown, arrangements: [] },
      applicability: [],
      deadlines: [],
      repeal: unknown,
    },
    main_points: [{ text: "矿业阈值规定", clause_ref: quote.node_path ?? "原文", evidence_ids: ["e1"] }],
    impacts: [
      {
        id: "impact1",
        theme: "safety_environment",
        region: "AR",
        legal_actor: "矿权人",
        affected_actor: "矿权人",
        activity: "矿业生产",
        condition: "符合原文条件",
        effect_mode: "direct",
        impact: "适用阈值规定",
        deadline: null,
        exceptions: "保留原文例外",
        evidence_ids: ["e1"],
      },
    ],
    relationships: [],
    dynamic_zh: input.previous_candidate ? "仅在原文条件下适用阈值规定。" : "矿业活动适用阈值规定。",
    gaps: [],
    comparisons: [],
    evidence: [{ id: "e1", part_id: quote.part_id, quote: quote.quote }],
  };
}
function answer(input: Payload): Payload {
  if (!input.phase)
    return {
      parts: input.parts.map((part: Payload) => ({
        partId: part.partId,
        sourceHash: part.sourceHash,
        classification: "facts",
        facts: [{ statement: "适用量和例外", role: "scope", quote: visible(part.source) }],
        zh: part.source
          .replaceAll("Published Regulation: Mining threshold at", "已公布的规章：矿业阈值为")
          .replaceAll("Exception: mining above", "例外：矿业量超过")
          .replaceAll("is prohibited.", "被禁止。"),
      })),
    };
  const bound = { id: input.id, input_hash: input.input_hash };
  if (input.phase === "group") {
    const result = {
      ...bound,
      input_ids: input.parts.map((part: Payload) => part.partId),
      consistent: true,
      roles: input.parts.map((part: Payload) => ({ part_id: part.partId, roles: ["scope"] })),
      summary: "本组全部矿业阈值及文末例外。",
      quotes: input.parts.slice(0, 2).map((part: Payload) => ({ part_id: part.partId, quote: visible(part.source).slice(0, 200) })),
    };
    groupReplies.push(result);
    return result;
  }
  if (input.phase === "merge")
    return {
      ...bound,
      input_ids: input.children.map((child: Payload) => child.id),
      summary: "全部子组的矿业阈值、条件与例外。",
      quotes: input.children.flatMap((child: Payload) => child.quotes).slice(0, 2),
    };
  if (input.phase === "candidate") return candidate(input);
  return {
    ...bound,
    group_id: input.group_id,
    candidate_hash: input.candidate_hash,
    publication_authorized: false,
    judgments: input.claims.map((claim: Payload) => ({
      claim_id: claim.id,
      verdict: claim.requiresSupport ? "supports" : "not_applicable",
      quotes: claim.requiresSupport ? [{ part_id: input.parts[0].partId, quote: visible(input.parts[0].source).slice(0, 200) }] : [],
      reason: "合成provider判断",
    })),
  };
}
const provider = await stub(async (_hit, req) => {
  const body = JSON.parse(req.body),
    input = JSON.parse(body.messages.at(-1).content);
  requests.push(input);
  await beforeResponse(input);
  const output = answer(input);
  if (mode === "bad_group" && input.phase === "group") output.input_ids = [];
  if (mode === "bad_merge" && input.phase === "merge") output.quotes = [groupReplies.at(-1)!.quotes[0]];
  if (mode === "bad_candidate" && input.phase === "candidate") output.evidence = [{ id: "e1", ...groupReplies.at(-1)!.quotes[0] }];
  if (mode === "missing_judgment" && input.phase === "verify") output.judgments.pop();
  if (mode === "public_auth" && input.phase === "verify") output.publication_authorized = true;
  if (mode === "foreign_verify" && input.phase === "verify") output.judgments[0].quotes = [groupReplies.at(-1)!.quotes[0]];
  if (input.phase === "verify") {
    const dynamic = input.claims.find((claim: Payload) => claim.path === "dynamic_zh"),
      item = output.judgments.find((j: Payload) => j.claim_id === dynamic.id);
    if (mode === "veto_tail" && input.parts.some((part: Payload) => part.source.includes("Exception:"))) item.verdict = "vetoes";
    if (mode === "limit_once" && !dynamic.value.includes("仅在")) item.verdict = "limits";
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
beforeEach(() => {
  mode = "pass";
  usage = { prompt_tokens: 50, completion_tokens: 20 };
  beforeResponse = async () => {};
  groupReplies.length = 0;
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
          `<article>${Array.from({ length: count }, (_, i) => `<p>${i === count - 1 && count > 1 ? "Exception: mining above 50 kg is prohibited." : `Published Regulation: Mining threshold at ${i + 10} kg.`}</p>`).join("")}</article>`,
        ),
      },
    ],
  };
  const original = await recordPolicyOriginal(value),
    fulltext = await runPolicyFulltext(original.expressionId, profile, { root, maxRequests: 100 });
  assert.equal(fulltext.status, "program_validated");
  assert.ok("runId" in fulltext);
  return { sourceId, original, runId: fulltext.runId, value };
}

test("complete bounded chain resumes durable stages, verifies every conclusion against every group, and never grants publication", async () => {
  const f = await fixture(85),
    before = requests.length;
  const partial = await runPolicyInterpretation(f.runId, { root, maxRequests: 2 });
  assert.equal(partial.status, "partial");
  assert.equal(requests.length - before, 2);
  const complete = await runPolicyInterpretation(f.runId, { root, maxRequests: 100 });
  assert.equal(complete.status, "semantic_verified");
  assert.equal(complete.publication_authorized, false);
  assert.ok("candidate" in complete && complete.candidate);
  const calls = requests.slice(before),
    merges = calls.filter((r) => r.phase === "merge"),
    groups = calls.filter((r) => r.phase === "group");
  assert.ok(groups.length > 6);
  assert.ok(merges.every((r) => r.children.length >= 2 && r.children.length <= 6));
  const verifications = calls.filter((r) => r.phase === "verify");
  assert.equal(verifications.length, groups.length);
  assert.ok(verifications.every((r) => r.claims.length === verifications[0].claims.length));
  const after = requests.length,
    loaded = await loadPolicyInterpretation(f.runId);
  assert.equal(loaded!.semantic_verified, true);
  assert.equal(loaded!.contentHash, complete.contentHash);
  assert.equal(requests.length, after);
  assert.ok(loaded!.modelEvidence.length > groups.length);
  assert.deepEqual(loaded!.models, ["reported-test-model"]);
  assert.equal(loaded!.modelEvidenceComplete, true);
  assert.ok(loaded!.modelEvidence.every((m) => m.requestedModel === "unchanged-stage-model"));
});

test("a late exception veto overrides earlier support; limitations require rewriting and a new full matrix", async () => {
  const f = await fixture(13);
  mode = "veto_tail";
  const vetoed = await runPolicyInterpretation(f.runId, { root, maxRequests: 100 });
  assert.equal(vetoed.status, "semantic_failed");
  assert.equal(vetoed.semantic_verified, false);
  assert.ok("verification" in vetoed && vetoed.verification[0]!.decisions.some((d) => d.verdict === "vetoes"));
  mode = "pass";
  const next = await fixture();
  mode = "limit_once";
  const fixed = await runPolicyInterpretation(next.runId, { root, maxRequests: 100 });
  assert.equal(fixed.status, "semantic_verified");
  assert.ok("verification" in fixed && fixed.verification.length === 2);
  assert.notEqual(fixed.verification[0]!.candidateHash, fixed.verification[1]!.candidateHash);
  assert.equal(fixed.publication_authorized, false);
});

test("actual group/child/root inputs bound citations; missing judgments and malformed JSON cannot be retried by rerunning", async () => {
  for (const failure of ["bad_group", "bad_merge", "bad_candidate", "missing_judgment", "foreign_verify", "bad_json", "public_auth"]) {
    mode = "pass";
    groupReplies.length = 0;
    const f = await fixture(failure === "bad_merge" ? 85 : 13);
    mode = failure;
    const bad = await runPolicyInterpretation(f.runId, { root, maxRequests: 100 });
    assert.equal(bad.status, "invalid_output", failure);
    const at = requests.length;
    assert.equal((await runPolicyInterpretation(f.runId, { root, maxRequests: 100 })).status, "invalid_output");
    assert.equal(requests.length, at, "rejected immutable input is not purchased again");
  }
});

test("unknown usage stops the source and missing provider model identity remains missing evidence", async () => {
  const f = await fixture();
  usage = null;
  assert.equal((await runPolicyInterpretation(f.runId, { root, maxRequests: 100 })).status, "blocked_unknown");
  const at = requests.length;
  assert.equal((await runPolicyInterpretation(f.runId, { root, maxRequests: 100 })).status, "blocked_unknown");
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
    if (input.phase === "group") {
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
  assert.equal(requests.slice(before).filter((r) => r.phase === "group").length, 1);
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
  const c = CandidateReply.parse(
    candidate({
      id: sha256("c"),
      input_hash: sha256("input"),
      identity,
      root: { id: sha256("root"), quotes: [{ part_id: part.partId, quote: source, node_path: part.nodePath }] },
    }),
  );
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
