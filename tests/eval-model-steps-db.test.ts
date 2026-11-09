// TASK-0601 with an isolated database and a local provider stub: the gold file binds the material, and the step
// comparison draws, calls only the model it names, stops at its token cap and writes no analysis.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { REPO_ROOT } from "@amp/backend/config";
import { closeDb, sql } from "@amp/backend/db";
import { prepareEvaluationInput, evaluationInputFingerprint } from "@amp/backend/editorial/analyze";
import { sanitizeBody } from "@amp/backend/content/sanitize";
import { upsertMaterial } from "@amp/backend/content/materials";
import { stopBoss } from "@amp/backend/jobs/queue";
import { runBodyTranslation } from "../packages/backend/src/editorial/translation-runtime.ts";
import { ensureModelSourceFixture } from "./model-source-fixture.ts";
import { boundEvaluationFixture } from "./bound-eval-fixture.ts";
import { stub, tag } from "./setup.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";

const exec = promisify(execFile);
const dir = mkdtempSync(path.join(tmpdir(), "eval-model-steps-"));
after(async () => {
  rmSync(dir, { recursive: true, force: true });
  await stopBoss();
  await closeDb();
});
// The provider stub listens on 127.0.0.1; executors' proxies must not route it.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|EGRESS_PROXY_URL)$/i.test(name)));
const node = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  exec(process.execPath, args, { cwd: REPO_ROOT, env: { ...inherited, MODEL_CALLS_ENABLED: "true", ...env }, timeout: 30_000 });

async function article(marker: string) {
  return boundEvaluationFixture({
    title: `${marker} copper mine expansion approved`,
    body: `${marker} received approval to expand its copper mine, adding 40,000 tonnes a year from 2027. `.repeat(6),
    source: `Mining source ${marker}`,
    tier: "T2",
    kind: "rss",
    firstParty: false,
    publishedAt: new Date().toISOString(),
  });
}

test("gold rows carry the bound analysis input that eval-selection requires", async () => {
  const run = tag();
  const [a, b] = [await article(`gold-a-${run}`), await article(`gold-b-${run}`)];
  const candidates = path.join(dir, "candidates.json"),
    labels = path.join(dir, "labels.json"),
    out = path.join(dir, "gold.jsonl");
  writeFileSync(
    candidates,
    JSON.stringify([
      { n: 1, id: a.analysisInput.id },
      { n: 2, id: b.analysisInput.id },
      { n: 3, id: `missing-${run}` },
    ]),
  );
  writeFileSync(labels, JSON.stringify({ select: [1], reject: [2, 3] }));
  const { stdout } = await node(["scripts/gold-from-labels.ts", "--out", out, "--labels", labels, "--candidates", candidates]);
  assert.match(stdout, /2 cases written .*not found: 3/);
  const rows = readFileSync(out, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    rows.map((r) => [r.caseId, r.gold.decision, r.analysisInput.id]),
    [
      ["owner-20261105-001", "select", a.analysisInput.id],
      ["owner-20261105-002", "reject", b.analysisInput.id],
    ],
  );
  for (const row of rows) {
    assert.equal(row.inputFingerprint, evaluationInputFingerprint(row.analysisInput));
    // eval-selection.ts passes exactly these two fields; before the fix both were missing and every case failed here.
    const { input } = await prepareEvaluationInput(row.analysisInput, row.inputFingerprint);
    assert.equal(input.revision, row.analysisInput.revision);
  }
});

test("draw samples stored judgements, and run calls only the named model, stops at the token cap and writes no analysis", async () => {
  const run = tag();
  const ids: string[] = [];
  for (const n of [1, 2, 3]) {
    const { analysisInput } = await article(`step-${n}-${run}`);
    ids.push(analysisInput.id);
    await sql`INSERT INTO analyses (article_id, input_revision, origin, model, prompt_version, relevance, category, subjects, score, selected, output)
      VALUES (${analysisInput.id}, ${analysisInput.revision}, 'model', 'deepseek-flash', 'older', 'pass', 'production', '{}', 70, true,
        ${sql.json({ prefilter: { label: "PASS", reason: "mining" }, scores: [70], threshold: 60, geography: { codes: ["CL"] }, fact: null })})`;
  }
  const samples = path.join(dir, "run", "samples.json");
  const drawn = await node(["scripts/eval-model-steps.ts", "draw", "--seed", "1", "--out", samples]);
  const summary = JSON.parse(drawn.stdout.trim().split("\n").at(-1)!);
  assert.ok(summary.prefilter["selected-deepseek"] >= 3, drawn.stdout);
  const sample = JSON.parse(readFileSync(samples, "utf8"));
  const ours = sample.steps.prefilter.filter((c: { articleId: string }) => ids.includes(c.articleId));
  assert.equal(ours.length, 3);
  assert.deepEqual(ours[0].baseline, {
    label: "PASS",
    selected: true,
    firstScore: 70,
    threshold: 60,
    category: "production",
    subjects: [],
    countries: ["CL"],
    hasFact: false,
    promptCurrent: false,
  });
  assert.ok(sample.steps.structure.some((c: { articleId: string }) => ids.includes(c.articleId)));
  // Only our three items in this run's sample, so the stub sees exactly them.
  sample.steps.prefilter = ours;
  writeFileSync(samples, JSON.stringify(sample));

  const provider = await stub(() => ({
    model: "qwen-flash",
    choices: [{ message: { content: JSON.stringify({ label: "BLOCK", reason: "not mining" }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 600 } },
  }));
  try {
    process.env.DASHSCOPE_BASE_URL = `${provider.url}/v1`;
    process.env.DASHSCOPE_API_KEY = "test-key";
    await installUsageFixtureForModel("qwen-flash");
    const before = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM analyses WHERE article_id = ANY(${ids}::text[])`;
    // 15 000 tokens: two calls fit beside the 13 800-token first estimate (1 010 + 13 800), a third does not.
    const { stdout } = await node(
      ["scripts/eval-model-steps.ts", "run", "--step", "prefilter", "--model", "qwen-flash", "--sample", samples, "--token-cap", "15000"],
      {
        DASHSCOPE_BASE_URL: `${provider.url}/v1`,
        DASHSCOPE_API_KEY: "test-key",
      },
    );
    assert.equal(provider.hits(), 2, stdout);
    const file = readdirSync(path.dirname(samples)).find((f) => f.startsWith("prefilter-qwen-flash-"))!;
    const result = JSON.parse(readFileSync(path.join(path.dirname(samples), file), "utf8"));
    assert.equal(result.stopReason, "token_cap");
    assert.equal(result.cases.length, 2);
    assert.deepEqual(
      result.cases.map((c: { candidate: { label: string } }) => c.candidate.label),
      ["BLOCK", "BLOCK"],
    );
    assert.deepEqual(result.cases[0].usage, {
      calls: 1,
      tokensIn: 1000,
      tokensOut: 10,
      cached: 600,
      reasoning: 0,
      latencyMs: result.cases[0].usage.latencyMs,
      returnedModels: ["qwen-flash"],
    });
    assert.equal(result.summary.falseReject.k, 2);
    assert.equal(result.summary.agreement.rate, 0);
    const after = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM analyses WHERE article_id = ANY(${ids}::text[])`;
    assert.equal(after[0]!.n, before[0]!.n, "no analysis is written");
    const receipts = await sql<{ subject: string; purpose: string | null }[]>`
      SELECT subject, request->>'usage_purpose' AS purpose FROM receipts WHERE id = ANY(${result.cases.flatMap((c: { receiptIds: number[] }) => c.receiptIds)}::bigint[])`;
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every((r) => r.subject.startsWith("evaluation:") && r.purpose === "evaluation"));

    // The cap covers this model's earlier results in the same folder: a second run starts with 2 020 tokens spent.
    const again = await node(
      ["scripts/eval-model-steps.ts", "run", "--step", "prefilter", "--model", "qwen-flash", "--sample", samples, "--token-cap", "15000"],
      {
        DASHSCOPE_BASE_URL: `${provider.url}/v1`,
        DASHSCOPE_API_KEY: "test-key",
      },
    );
    assert.equal(provider.hits(), 2, "the 2 020 tokens already spent leave no room for another call");
    assert.match(again.stdout, /"stopReason":"token_cap"/);

    // Import: a summary without article text, and one SelectBench run beside the stored DeepSeek decisions.
    const imported = await node(["scripts/eval-model-steps.ts", "import", "--results", path.dirname(samples)]);
    const runId = /SelectBench prefilter: (sb-\S+)/.exec(imported.stdout)?.[1];
    assert.ok(runId, imported.stdout);
    const [bench] = await sql<{ models: string[]; label: string }[]>`SELECT models, label FROM selectbench_runs WHERE id = ${runId}`;
    assert.match(bench!.label, /非人工金标/);
    assert.ok(bench!.models.includes("deepseek(库存)"));
    const rows = await sql<
      { model: string; gold: string; decision: string }[]
    >`SELECT model, gold, decision FROM selectbench_results WHERE run_id = ${runId} ORDER BY model`;
    assert.ok(rows.some((r) => r.model === "deepseek(库存)" && r.decision === "PASS" && r.gold === "ds:PASS"));
    assert.ok(rows.some((r) => r.model.startsWith("qwen-flash") && r.decision === "BLOCK"));
    const report = readFileSync(path.join(path.dirname(samples), "summary.md"), "utf8");
    assert.match(report, /## prefilter/);
    assert.doesNotMatch(report, /copper mine expansion/);
  } finally {
    await provider.close();
  }
});

// The text between tags becomes Chinese; tags, link ids, placeholders and numbers stay, like a faithful translation.
const translateText = (html: string, word: string) =>
  html.replace(/(^|>)([^<]*)/g, (_m, open: string, text: string) => open + text.replace(/[A-Za-z]+/g, word));

test("translation replay compares with the stored DeepSeek segments and writes no translation or checkpoint", async () => {
  const run = tag();
  const source = `eval-translate-${run}`;
  await sql`INSERT INTO sources(id, name, kind, site_fulltext) VALUES (${source}, 'Translation comparison fixture', 'rss', true)`;
  await ensureModelSourceFixture(source, ["https://fixture.invalid/source"]);
  const html = sanitizeBody(
    `<p>Lundin Mining output rose 12% to 300 tonnes in 2025, see <a href="https://fixture.invalid/r">the report</a> ${run}.</p><p>Second paragraph about 4 mines ${run}.</p>`,
  );
  const { articleId } = await upsertMaterial({
    sourceId: source,
    url: `https://fixture.invalid/${run}`,
    title: `Translation ${run}`,
    language: "en",
    bodyHtml: html,
    bodyText: html.replace(/<[^>]+>/g, " "),
    bodyStatus: "ok",
    via: "fetch",
  });
  const deepseek = await stub((_hit, req) => {
    const { text } = JSON.parse(JSON.parse(req.body).messages[1].content) as { text: string };
    return {
      choices: [{ message: { content: JSON.stringify({ text: translateText(text, "译") }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 40 },
    };
  });
  const requests: Array<{ messages: Array<{ role: string; content: string }>; response_format?: unknown; translation_options?: unknown }> = [];
  const bailian = await stub((_hit, req) => {
    const body = JSON.parse(req.body);
    requests.push(body);
    return {
      model: "qwen-mt-flash",
      choices: [{ message: { content: translateText(body.messages[0].content, "文") }, finish_reason: "stop" }],
      usage: { prompt_tokens: 30, completion_tokens: 30 },
    };
  });
  try {
    process.env.DEEPSEEK_BASE_URL = `${deepseek.url}/v1`;
    process.env.DEEPSEEK_API_KEY = "test-key";
    process.env.DASHSCOPE_BASE_URL = `${bailian.url}/v1`;
    process.env.DASHSCOPE_API_KEY = "test-key";
    await installUsageFixtureForModel("deepseek-flash");
    await installUsageFixtureForModel("qwen-mt-flash");
    const [{ revision }] = await sql<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${articleId}`;
    const recipe = { id: `fixture-${run}`, model: "deepseek-flash", promptVersion: `fixture-${run}`, system: "SELF_AUTHORED translation fixture" };
    assert.equal((await runBodyTranslation(articleId, recipe)).status, "translated");
    const stored = async () => ({
      translation: await sql`SELECT revision, recipe, body_html, complete, receipt_id FROM translations WHERE article_id = ${articleId}`,
      segments: await sql`SELECT segment_index, receipt_id, response_text FROM enrichment.translation_segments WHERE article_id = ${articleId} ORDER BY 1, 2`,
    });
    const before = await stored();
    assert.equal(before.segments.length, 2);

    const samples = path.join(dir, "translate", "samples.json");
    mkdirSync(path.dirname(samples), { recursive: true });
    const baseline = {
      label: null,
      selected: true,
      firstScore: null,
      threshold: null,
      category: null,
      subjects: [],
      countries: [],
      hasFact: null,
      promptCurrent: false,
    };
    const item = { articleId, revision, title: "t", fingerprint: "", stratum: "en", language: "en", gold: null, baseline };
    writeFileSync(
      samples,
      JSON.stringify({ format: "model-bakeoff-samples-v1", seed: "1", steps: { prefilter: [], score: [], structure: [], translate: [item] } }),
    );
    const { stdout } = await node(
      ["scripts/eval-model-steps.ts", "run", "--step", "translate", "--model", "qwen-mt-flash", "--sample", samples, "--token-cap", "100000"],
      {
        DASHSCOPE_BASE_URL: `${bailian.url}/v1`,
        DASHSCOPE_API_KEY: "test-key",
      },
    );
    assert.equal(requests.length, 2, stdout);
    for (const body of requests) {
      assert.deepEqual(
        body.messages.map((m: { role: string }) => m.role),
        ["user"],
        "no system prompt for a translation-only model",
      );
      assert.equal(body.response_format, undefined);
      assert.deepEqual(body.translation_options, { source_lang: "auto", target_lang: "Chinese" });
    }
    const file = readdirSync(path.dirname(samples)).find((f) => f.startsWith("translate-qwen-mt-flash-"))!;
    const result = JSON.parse(readFileSync(path.join(path.dirname(samples), file), "utf8"));
    const segments = result.cases[0].candidate.segments;
    assert.equal(segments.length, 2);
    assert.ok(segments.every((x: { candidate: string; baseline: string }) => x.candidate.includes("文") && x.baseline.includes("译")));
    assert.equal(result.summary.structureKept.rate, 1);
    assert.equal(result.summary.candidate.numbers, 0);
    assert.equal(result.summary.automaticChecksPass, true);
    assert.deepEqual(await stored(), before, "the stored translation and its checkpoints are unchanged");
    const receipts = await sql<{ subject: string; purpose: string | null }[]>`
      SELECT subject, request->>'usage_purpose' AS purpose FROM receipts WHERE id = ANY(${result.cases[0].receiptIds}::bigint[])`;
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every((r) => r.subject.startsWith(`evaluation:article:${articleId}@`) && r.purpose === "evaluation"));
  } finally {
    await deepseek.close();
    await bailian.close();
  }
});
