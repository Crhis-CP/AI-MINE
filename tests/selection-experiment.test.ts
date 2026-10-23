import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { sql, closeDb } from "@amp/backend/db";
import { promptText } from "@amp/backend/editorial/prompts";
import { environmentModelMetadata } from "@amp/backend/providers/llm";
import { config } from "@amp/backend/config";
import { publishArticle } from "@amp/backend/publication/publish";
import { ANALYZE_PROMPT_VERSION } from "@amp/backend/editorial/analyze";
import { stopBoss } from "@amp/backend/jobs/queue";
import { boundEvaluationFixture } from "./bound-eval-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { validateGeography } from "../packages/backend/src/editorial/geography.ts";
import { ExperimentManifest, countryPreview, metrics, attemptSummary, type ExperimentCase, type Outcome } from "../scripts/selection-experiment-data.ts";
import { runExperiment, exportCountryCandidates, assertIsolatedDatabase } from "../scripts/selection-experiment.ts";

const requests: Array<{ system: string; user: string }> = [];
const provider = await stub((_n, req) => {
  const body = JSON.parse(req.body),
    system = body.messages[0].content as string,
    user = body.messages.at(-1).content as string;
  requests.push({ system, user });
  const prefilter = system.includes("宽召回");
  const content =
    !prefilter && user.includes("BAD_RESPONSE")
      ? "not JSON"
      : JSON.stringify(prefilter ? { label: "PASS", reason: "合成涉矿材料" } : { attentionScore: system.includes("阿根廷经营视角") ? 80 : 45 });
  return { choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 6 } };
});
Object.assign(process.env, {
  LLM_BASE_URL: `${provider.url}/v1`,
  LLM_API_KEY: "synthetic",
  LLM_MODEL: "experiment-synthetic",
  SCORE_MODEL: "default",
  PREFILTER_MODEL: "default",
});
config.modelCallsEnabled = true;
await installUsageFixtureForModel("default");
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

async function sample(marker = tag(), suffix = ""): Promise<ExperimentCase> {
  const body = `矿山项目位于阿根廷，获得附条件建设批准。${marker} ${suffix}`;
  const bound = await boundEvaluationFixture({
    title: `合成矿山 ${marker} ${suffix}`,
    body,
    source: "合成政府来源",
    tier: "T1",
    kind: "rss",
    firstParty: true,
    publishedAt: "2026-10-20T12:00:00Z",
    language: "zh",
  });
  const input = bound.analysisInput;
  const geography = validateGeography(
    {
      status: "identified",
      primary: "AR",
      assignments: [{ code: "AR", role: "event_location", mention: "阿根廷", segment: "body_head", quote: "矿山项目位于阿根廷" }],
      reason: "合成引用",
    },
    { title: input.title, bodyText: body, excerpt: null, bodyStatus: "ok" },
  );
  await sql`INSERT INTO analyses(article_id,input_revision,origin,model,prompt_version,relevance,title_zh,summary_zh,selected,output)
    VALUES(${input.id},${input.revision},'model','synthetic',${ANALYZE_PROMPT_VERSION},'pass',${input.title},${body},false,${sql.json({ scores: null, geography })})`;
  await publishArticle(input.id);
  return {
    caseId: input.id,
    familyId: marker,
    occurrenceId: marker,
    split: "holdout",
    ...bound,
    labels: [
      { reviewer: "reviewer-1", global: "reject", argentina: "select", reason: "合成测试，非人工金标" },
      { reviewer: "reviewer-2", global: "reject", argentina: "select", reason: "合成测试，非人工金标" },
    ],
  };
}
const manifest = (cases: ExperimentCase[], scoreModel = "default") =>
  ExperimentManifest.parse({
    version: 1,
    datasetId: "synthetic-only",
    synthetic: true,
    bindings: {
      model: scoreModel,
      prefilterModel: "default",
      modelIdentity: environmentModelMetadata(scoreModel)!.configuration_hash!,
      prefilterIdentity: environmentModelMetadata("default")!.configuration_hash!,
      prefilterHash: createHash("sha256").update(promptText("prefilter")).digest("hex"),
      promptHashes: {
        A: createHash("sha256").update(promptText("selection-score")).digest("hex"),
        B: createHash("sha256").update(promptText("selection-score-b")).digest("hex"),
        AR: createHash("sha256").update(promptText("selection-country-ar")).digest("hex"),
      },
    },
    frozenAt: "2026-10-22T00:00:00Z",
    cases,
  });
const outcome = (row: ExperimentCase, variant: "A" | "B" | "AR", selected: boolean | null): Outcome => ({
  caseId: row.caseId,
  variant,
  selected,
  scores: selected ? [80, 80] : [],
  receipts: [],
  error: selected === null ? "synthetic failure" : null,
});

test("historical variants keep reviewed weights; the unified candidate is version-bound and experiments stay isolated", () => {
  const a = readFileSync("industry/prompts/selection-score.md", "utf8"),
    b = readFileSync("industry/prompts/selection-score-b.md", "utf8");
  assert.equal(createHash("sha256").update(a).digest("hex"), "736941dd23a1dcd1badc482d57195e9a7ac2477b73ab5937699d482973902327");
  assert.deepEqual(
    b.split("\n").filter((l) => l.startsWith("|")),
    a.split("\n").filter((l) => l.startsWith("|")),
  );
  assert.ok(b.includes("期限日期改变本身不构成实质后果"));
  assert.ok(b.includes("正式安排不等于已经启动"));
  assert.ok(!b.includes("分数受“必须压住”里解读条款的约束"));
  assert.throws(() => assertIsolatedDatabase("postgres://localhost/production"), /isolated/);
  assert.throws(() => assertIsolatedDatabase("postgres://localhost/something_eval", true), /isolated/);
  assert.throws(
    () => assertIsolatedDatabase("postgres://localhost/safe_eval", false, { DATABASE_URL_WORKER: "postgres://localhost/production" }),
    /split DATABASE_URL/,
  );
});

test("families and exact inputs cannot leak between splits; one person cannot count as two reviewers", async () => {
  const row = await sample(),
    copy = { ...row, caseId: "copy", split: "development" as const };
  assert.throws(() => manifest([row, copy]), /crosses split/);
  assert.throws(() => manifest([row, { ...copy, familyId: "different", occurrenceId: "different" }]), /identical input/);
  assert.throws(() => manifest([row, { ...row, caseId: "duplicate", occurrenceId: "different-progress" }]), /duplicate material/);
  assert.throws(() => manifest([{ ...row, labels: [row.labels[0]!, row.labels[0]!] }]), /independent reviewers/);
});

test("unselected global candidates receive independent AR scores; same fact has one shared website/group preview; replay buys nothing", async () => {
  const marker = tag(),
    a = await sample(marker),
    b = await sample(marker, "同次进展转载");
  const before = requests.length;
  const result = await runExperiment(manifest([a, b]), 14);
  assert.equal(requests.length - before, 14, "one prefilter plus six independent scores for each different input");
  for (const item of result.outcomes) assert.equal(item.selected, item.variant === "AR");
  assert.equal(result.countryPreview.length, 1);
  const preview = result.countryPreview[0]!;
  assert.equal(preview.website.caseId, preview.delivery.caseId);
  assert.deepEqual(new Set(preview.members), new Set([a.caseId, b.caseId]));
  assert.equal(result.coverage.transportCalls, 0);
  assert.equal(result.metrics.holdout!.AR!.missed, 0);
  assert.equal(result.metrics.holdout!.AR!.occurrences, 1, "reprints do not multiply quality denominators");
  const replay = await runExperiment(manifest([a, b]), 14);
  assert.equal(requests.length - before, 14);
  assert.equal(replay.newPhysicalAttempts, 0);
  assert.equal(replay.attempts.length, 14, "original cost evidence is retained on reuse");
  const exported = await exportCountryCandidates("export-test");
  assert.ok(exported.cases.some((r) => r.analysisInput.id === a.analysisInput.id));
  assert.ok(exported.cases.every((r) => r.labels.length === 0));
});

test("missing labels, changed input and insufficient declared calls stop before any model request", async () => {
  const row = await sample(),
    start = requests.length;
  await assert.rejects(runExperiment(manifest([{ ...row, labels: [] }]), 7), /independent labels/);
  await assert.rejects(runExperiment(manifest([row]), 6), /7 calls/);
  const changed = manifest([row]);
  changed.bindings!.promptHashes.B = "changed";
  await assert.rejects(runExperiment(changed, 7), /Frozen prompt/);
  const changedPrefilter = manifest([row]);
  changedPrefilter.bindings!.prefilterHash = "changed";
  await assert.rejects(runExperiment(changedPrefilter, 7), /Frozen prompt/);
  await assert.rejects(runExperiment(manifest([{ ...row, analysisInput: { ...row.analysisInput, bodyText: "edited" } }]), 7), /不一致/);
  assert.equal(requests.length, start);
});

test("failed model results remain unknown and count against important recall; unknown cost never becomes zero", async () => {
  const row = await sample(tag(), "BAD_RESPONSE"),
    result = await runExperiment(manifest([row]), 7);
  assert.ok(result.outcomes.every((o) => o.selected === null && o.error));
  assert.equal(result.metrics.holdout!.AR!.missed, 1);
  assert.equal(result.metrics.holdout!.AR!.failures, 1);
  assert.equal(result.countryPreview.length, 0);
  assert.equal(result.attempts.length, 4, "prefilter and three unusable first scores retained");
  const hits = requests.length,
    replay = await runExperiment(manifest([row]), 7);
  assert.equal(requests.length, hits, "failed-score replay does not buy replacement results");
  assert.equal(replay.attempts.length, 4, "failed-score replay retains all original costs");
  assert.deepEqual(replay.receiptGaps, []);
  const costs = attemptSummary([
    { cost: null, currency: "CNY", cost_basis: "estimated", status: "received", latency_ms: 10 },
    { cost: "0", currency: "CNY", cost_basis: "actual", status: "received", latency_ms: 20 },
    { cost: "2", currency: "USD", cost_basis: "estimated", status: "received", latency_ms: 30 },
  ]);
  assert.equal(costs.unknownCost, 1);
  assert.deepEqual(costs.totals, { "CNY:actual": 0, "USD:estimated": 2 });
  assert.equal(costs.p95Ms, 30);
});

test("separate progress survives dedupe; stale/withdrawn country candidates cannot enter preview; disagreements remain visible", async () => {
  const a = await sample(),
    b = { ...a, caseId: "progress2", occurrenceId: "progress2", analysisInput: { ...a.analysisInput, id: "progress2" } };
  const outcomes = [outcome(a, "AR", true), outcome(b, "AR", true)];
  assert.equal(countryPreview([a, b], outcomes, new Set([a.analysisInput.id, b.analysisInput.id])).length, 2);
  assert.equal(countryPreview([a, b], outcomes, new Set()).length, 0);
  const disputed = { ...a, labels: [a.labels[0]!, { ...a.labels[1]!, argentina: "reject" as const }] };
  assert.equal(metrics([disputed], [outcome(a, "AR", true)], "AR").disputed, 1);
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${a.analysisInput.id}`;
  const result = await runExperiment(manifest([a]), 7);
  assert.equal(result.countryPreview.length, 0);
});

test("CLI rejects a real run beyond the declared task budget before initializing the database", async () => {
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      ["scripts/selection-experiment.ts", "--run", "--task", "TASK-0402", "--max-calls", "7", "--output", "/unused-output.json"],
      { env: { ...process.env, DATABASE_URL: "postgres://127.0.0.1:1/isolated_test" } },
    ),
    /exceed the task card/,
  );
});

test("reasoning model token allowance does not lose prior failed attempts on replay", async () => {
  Object.assign(process.env, { DEEPSEEK_BASE_URL: `${provider.url}/v1`, DEEPSEEK_API_KEY: "synthetic", SCORE_MODEL: "deepseek-flash-think" });
  try {
    await installUsageFixtureForModel("deepseek-flash-think");
    const row = await sample(tag(), "BAD_RESPONSE"),
      data = manifest([row], "deepseek-flash-think");
    const first = await runExperiment(data, 7),
      hits = requests.length;
    const replay = await runExperiment(data, 7);
    assert.equal(first.attempts.length, 4);
    assert.equal(replay.attempts.length, 4);
    assert.equal(requests.length, hits);
    assert.deepEqual(replay.receiptGaps, []);
  } finally {
    process.env.SCORE_MODEL = "default";
  }
});
