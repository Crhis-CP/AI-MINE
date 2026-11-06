// 法规线成本设计: translation memory, change-only interpretation, deterministic verification and grouping, scans kept
// manual, and paid work only off-peak. A local stub provider counts every request; no real model is reachable.
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb, initializeDb, sql } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { stopBoss } from "@amp/backend/jobs/queue";
import { recordPolicyOriginal } from "../modules/policy/backend/domain/originals.ts";
import { runPolicyFulltext } from "../modules/policy/backend/domain/fulltext-runtime.ts";
import { runPolicyInterpretation } from "../modules/policy/backend/domain/interpretation-runtime.ts";
import { advancePolicyMaterial, readPolicyWorkflow, type PolicyAutomationPorts } from "../modules/policy/backend/domain/automation.ts";
import { capturePolicyMaterial } from "../modules/policy/backend/domain/capture.ts";
import { publishPolicyPublication } from "../modules/policy/backend/publication/policies-publish.ts";
import { ensurePolicyQueues, policyQueues } from "../modules/policy/backend/jobs.ts";
import { deterministicDecisions, policyUnits } from "../modules/policy/backend/domain/interpretation-units.ts";
import { buildPolicyFulltextPlan, type PolicyFulltextPlan } from "../modules/policy/backend/domain/processing-plan.ts";
import { CandidateReply } from "../modules/policy/backend/domain/interpretation-schema.ts";
import { sha256 } from "../packages/backend/src/lib/ids.ts";
import { answer, interpretReply } from "./policy-automation-provider.ts";
import { fixture as automationFixture } from "./policy-automation-fixture.ts";
import { grantDateFixture } from "./source-date-fixture.ts";

const root = await initializeDb("test");
type Payload = ReturnType<typeof JSON.parse>;
const requests: Payload[] = [];
let reply = (input: Payload) => answer(input);
const provider = await stub(async (_hit, req) => {
  const input = JSON.parse(JSON.parse(req.body).messages.at(-1).content);
  requests.push(input);
  return {
    id: `synthetic-${requests.length}`,
    model: "reported-test-model",
    choices: [{ message: { content: JSON.stringify(reply(input)) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 50, completion_tokens: 20 },
  };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "synthetic-test-only", LLM_MODEL: "cost-design-model" });
config.modelCallsEnabled = true;
await installUsageFixtureForModel("default", sql);
beforeEach(() => {
  reply = (input) => answer(input);
});
after(async () => {
  await stopBoss();
  await provider.close();
  await closeDb();
});
const profile = { bodySelector: "article", attachmentSelector: null, maxBytes: 2_000_000, maxResources: 8, maxPages: 40, maxTextBytes: 2_000_000 };
const phase = (r: Payload) => r.phase ?? "fulltext";
const since = (from: number) => requests.slice(from).map(phase);

async function policyDocument(paragraphs: (id: string) => string[], language = "en") {
  const sourceId = `cost-${tag()}`,
    url = `https://source.invalid/${sourceId}`;
  await sql`INSERT INTO sources(id,name,kind,lane,enabled) VALUES(${sourceId},${sourceId},'external','policy',false)`;
  await grantDateFixture(sourceId, [url]);
  const value = {
    sourceId,
    permissionVersion: 1,
    identity: { jurisdiction: "AR", authority: sourceId, documentType: "regulation", documentNumber: "fixture-7", officialUrl: url },
    versionKey: "official-1",
    language,
    kind: "original",
    officialTitle: "Synthetic Royalty Regulation",
    expectedHead: null as string | null,
    catalogueClosed: true,
    resources: [{ url, mediaType: "text/html; charset=utf-8", attachment: false, required: true, state: "acquired", reason: null, body: Buffer.from("") }],
  };
  let head: string | null = null;
  const revise = async (lines: string[], outside = "") => {
    const record = await recordPolicyOriginal({
      ...value,
      expectedHead: head,
      resources: [{ ...value.resources[0]!, body: Buffer.from(`${outside}<article>${lines.map((line) => `<p>${line}</p>`).join("")}</article>`) }],
    });
    head = record.revisionId;
    return record;
  };
  const first = await revise(paragraphs(sourceId));
  return { sourceId, expressionId: first.expressionId, revise };
}
async function processRevision(expressionId: string) {
  const fulltext = await runPolicyFulltext(expressionId, profile, { root, maxRequests: 100 });
  assert.equal(fulltext.status, "program_validated");
  assert.ok("runId" in fulltext);
  const interpretation = await runPolicyInterpretation(fulltext.runId, { root, maxRequests: 100 });
  return { fulltext, interpretation };
}

test("translation memory and change-only interpretation: an amendment pays for its changed provision only; an unchanged revision costs nothing", async () => {
  const lines = (rate: number, id: string) => [
    "Article 1 Scope",
    `This Regulation applies to every holder of a mining lease registered in ${id}.`,
    "Article 2 Royalty",
    `A holder must pay royalty at ${rate} per cent of the value of the mineral recovered in ${id}.`,
    "Article 3 Reports",
    `A holder must file a quarterly production report with the registry of ${id}.`,
  ];
  const doc = await policyDocument((id) => lines(5, id));
  let before = requests.length;
  const v1 = await processRevision(doc.expressionId);
  assert.equal(v1.interpretation.status, "semantic_verified");
  assert.deepEqual(since(before), ["fulltext", "interpret"], "first version: one translation batch, one interpret call, verified by code");
  const firstInterpret = requests.at(-1)!;
  assert.deepEqual(
    firstInterpret.provisions.map((p: Payload) => p.label),
    ["Article 1", "Article 2", "Article 3"],
    "parts are grouped into provisions by their article numbers in code",
  );

  // Amendment: Article 2 changes from 5 to 7 per cent.
  await doc.revise(lines(7, doc.sourceId));
  before = requests.length;
  const v2 = await processRevision(doc.expressionId);
  assert.equal(v2.interpretation.status, "semantic_verified");
  assert.deepEqual(since(before), ["fulltext", "interpret"]);
  const [translation, interpret] = requests.slice(before);
  assert.deepEqual(
    translation.parts.map((p: Payload) => p.source),
    [`<p>A holder must pay royalty at 7 per cent of the value of the mineral recovered in ${doc.sourceId}.</p>`],
    "only the modified paragraph is translated; the other five come from translation memory",
  );
  assert.equal(interpret.mode, "amendment");
  assert.deepEqual(
    interpret.provisions.map((p: Payload) => [p.label, p.change]),
    [["Article 2", "modified"]],
    "the interpret input holds only the changed provision",
  );
  assert.match(interpret.provisions[0].before, /5 per cent/);
  assert.ok(interpret.so_far.legal_state && interpret.document.title === "Synthetic Royalty Regulation");
  assert.ok("candidate" in v2.interpretation && v2.interpretation.candidate);
  const points = v2.interpretation.candidate.main_points.map((p) => p.clause_ref);
  assert.deepEqual(points.sort(), ["Article 1", "Article 2", "Article 3"], "unchanged provisions' main points are carried forward");
  assert.equal(v2.interpretation.changes.carriedMainPoints, 2);

  // A new revision whose provisions are all unchanged (only bytes outside the body differ): zero model calls.
  await doc.revise(lines(7, doc.sourceId), "<!-- republished page chrome -->");
  before = requests.length;
  const v3 = await processRevision(doc.expressionId);
  assert.equal(v3.interpretation.status, "semantic_verified");
  assert.deepEqual(since(before), [], "unchanged recrawl: no translation, interpretation or verification call");
  assert.ok("candidate" in v3.interpretation && v3.interpretation.candidate?.main_points.length === 3);
  assert.equal(v3.interpretation.modelEvidenceComplete, true, "carried output keeps the physical evidence of the receipts behind it");

  // Another document repeating one paragraph verbatim reuses that translation as well.
  const shared = `A holder must file a quarterly production report with the registry of ${doc.sourceId}.`;
  const other = await policyDocument(() => [shared, `Annex rules of ${doc.sourceId} for lithium.`]);
  before = requests.length;
  assert.equal((await runPolicyFulltext(other.expressionId, profile, { root, maxRequests: 100 })).status, "program_validated");
  assert.deepEqual(
    requests.slice(before).flatMap((r) => r.parts.map((p: Payload) => p.source)),
    [`<p>Annex rules of ${doc.sourceId} for lithium.</p>`],
  );
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE purpose='policy_group'`)[0]!.n, 0, "no policy_group call");
});

test("a Chinese original is its own reading text: fulltext costs no call", async () => {
  const doc = await policyDocument((id) => [`第一条 为了规范${id}矿业权管理，制定本办法。`, "第二条 本办法自公布之日起施行。"], "zh");
  const before = requests.length;
  const fulltext = await runPolicyFulltext(doc.expressionId, profile, { root, maxRequests: 100 });
  assert.equal(fulltext.status, "program_validated");
  assert.equal(requests.length, before);
  assert.ok("runId" in fulltext);
  const interpretation = await runPolicyInterpretation(fulltext.runId, { root, maxRequests: 100 });
  assert.equal(interpretation.status, "semantic_verified");
  assert.deepEqual(since(before), ["interpret"]);
  assert.equal(interpretation.modelEvidenceComplete, true);
});

test("deterministic verification: quotes, clause references and numbers are decided by code; only the rest goes to the model", () => {
  const source = ["Article 1 Royalty", "A holder must pay royalty at 5 per cent.", "Article 2 Reports", "A holder must file a report."];
  const built = buildPolicyFulltextPlan(
    {
      revisionId: sha256("revision"),
      state: "extracted",
      gaps: [],
      resources: [
        {
          url: "https://source.invalid/a",
          sha256: sha256(source.join("")),
          state: "extracted",
          gaps: [],
          nodes: source.map((text, ordinal) => ({ id: `n${ordinal}`, ordinal, text })),
        },
      ],
    },
    { sourceId: "source", expressionId: "expression", language: "en", identityHash: sha256("identity"), recipeVersion: "test" },
  );
  const plan = built as PolicyFulltextPlan;
  const units = policyUnits(plan);
  assert.deepEqual(
    units.units.map((u) => [u.label, u.partIds.length]),
    [
      ["Article 1", 2],
      ["Article 2", 2],
    ],
  );
  const delta = interpretReply({
    mode: "first_version",
    provisions: [{ label: "Article 1", change: "added", parts: [{ ref: plan.parts[1]!.partId, text: source[1] }] }],
  });
  const candidate = CandidateReply.parse({
    ...delta,
    id: sha256("c"),
    input_hash: sha256("i"),
    input_ids: [sha256("r")],
    document_title: "T",
    instrument_number: null,
    comparisons: [],
  });
  const verdicts = (c: typeof candidate) => deterministicDecisions(c, plan, units).decisions.map((d) => [d.path, d.verdict]);
  assert.deepEqual(
    verdicts(candidate).filter(([, verdict]) => verdict !== "passes"),
    [],
  );
  const numbers = structuredClone(candidate);
  numbers.main_points[0]!.text = "费率为5%";
  assert.ok(
    verdicts(numbers).every(([, verdict]) => verdict === "passes"),
    "5 appears in the cited quote",
  );
  numbers.main_points[0]!.text = "费率为6%";
  assert.deepEqual(
    verdicts(numbers).find(([path]) => path === "main_points.0"),
    ["main_points.0", "undecided"],
  );
  const clause = structuredClone(candidate);
  clause.main_points[0]!.clause_ref = "Article 9";
  assert.deepEqual(
    verdicts(clause).find(([path]) => path === "main_points.0"),
    ["main_points.0", "fails"],
  );
  const excluded = { ...structuredClone(candidate), relevance: "excluded" as const };
  assert.deepEqual(
    verdicts(excluded).find(([path]) => path === "relevance"),
    ["relevance", "undecided"],
  );
});

test("paid stages wait for the provider's off-peak window; archive is unaffected and scans stay manual", async () => {
  await ensurePolicyQueues();
  const material = `peak-${tag()}`;
  await sql`INSERT INTO policy.material_workflows(source_id,material_id,material_revision,stage,status,next_check_at)
    VALUES('peak-source',${material},1,'fulltext','pending',now())`;
  let fulltextCalls = 0;
  const ports: PolicyAutomationPorts = {
    publish: publishPolicyPublication,
    fulltext: async () => {
      fulltextCalls++;
      throw new Error("must not run in peak");
    },
  };
  const job = { lane: "policy" as const, sourceId: "peak-source", materialId: material };
  // Thursday 07:30 UTC is peak (06:00–10:00); the job is re-queued for 10:00 and buys nothing.
  const peak = policyQueues(ports, { now: () => new Date("2026-11-05T07:30:00Z") }).find((q) => q.name === "policy.fulltext")!;
  const deferred = (await peak.run([job])) as Payload;
  assert.deepEqual([deferred.status, deferred.reason, deferred.retryAt], ["deferred", "provider_peak", "2026-11-05T10:00:00.000Z"]);
  assert.equal(fulltextCalls, 0);
  const [queued] = await sql`SELECT start_after FROM pgboss.job WHERE name='policy.fulltext' AND data->>'materialId'=${material} AND state='created'`;
  assert.equal(new Date(queued!.start_after).toISOString(), "2026-11-05T10:00:00.000Z");
  assert.equal((await readPolicyWorkflow("peak-source", material))!.next_check_at.toISOString(), "2026-11-05T10:00:00.000Z");
  // The acquire queue never waits for off-peak.
  const acquire = policyQueues(ports, { now: () => new Date("2026-11-05T07:30:00Z") }).find((q) => q.name === "policy.acquire")!;
  assert.notEqual(((await acquire.run([job])) as Payload).status, "deferred");
  // Off-peak (Saturday), the same job runs its stage.
  await sql`UPDATE policy.material_workflows SET stage='fulltext' WHERE material_id=${material}`;
  const offPeak = policyQueues(ports, { now: () => new Date("2026-11-07T07:30:00Z") }).find((q) => q.name === "policy.fulltext")!;
  assert.notEqual(((await offPeak.run([job])) as Payload).status, "deferred");
  await sql`DELETE FROM policy.material_workflows WHERE material_id=${material}`;

  // A scan (fulltext incomplete without a text layer) is marked needs_manual; vision never runs unless enabled.
  delete process.env.POLICY_VISION_ENABLED;
  const f = await automationFixture(),
    scan = { lane: "policy" as const, sourceId: f.sourceId, materialId: f.materialId };
  let visionCalls = 0;
  const scanPorts: PolicyAutomationPorts = {
    publish: publishPolicyPublication,
    capture: (sourceId, materialId) => capturePolicyMaterial(sourceId, materialId, f.get),
    fulltext: async () => ({ status: "incomplete", revisionId: "synthetic", gaps: ["no_text_layer"], requests: [] }),
    vision: async () => {
      visionCalls++;
      return { status: "extracted" };
    },
  };
  await sql`INSERT INTO policy.material_workflows(source_id,material_id,material_revision) VALUES(${f.sourceId},${f.materialId},1) ON CONFLICT DO NOTHING`;
  for (const stage of ["acquire", "fulltext", "vision"] as const) await advancePolicyMaterial(scan, stage, scanPorts, { root, collectionEnabled: true });
  const row = (await readPolicyWorkflow(f.sourceId, f.materialId))!;
  assert.deepEqual([row.stage, row.status], ["acquire", "needs_manual"]);
  assert.equal(visionCalls, 0);
});
