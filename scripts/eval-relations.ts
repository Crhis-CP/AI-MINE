import { prepareEvaluationInput, currentEvaluationDerivedInput, loadAnalyzeInput } from "@amp/backend/editorial/analyze";
import { prepareNewsFallback } from "../packages/backend/src/providers/news-fallback.ts";
import { shutdownSignal } from "@amp/backend/jobs/queue";
import { newsRelationJurisdictions } from "@amp/backend/publication/publish";
import { stableJson } from "@amp/backend/lib/ids";
// Evaluates the production pairwise event-relation judge on a user-supplied gold set.
// Usage: node --env-file=.env scripts/eval-relations.ts --gold .data/relation-gold.jsonl
//        [--models default,deepseek-flash] [--split development] [--n 200] [--thresholds 0.75,0.8]
// The same pair prompt/schema as production is used; receipts make identical re-runs reusable.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "@amp/backend/config";
import { closeDb, sql, initializeDb } from "@amp/backend/db";
import { modelFor } from "@amp/backend/editorial/models";
import { PAIR_SYSTEM, PairSchema, RELATE_PROMPT_VERSION, pairUser } from "@amp/backend/events/relate";
import { MODELS, ModelOutputError, chatJson } from "@amp/backend/providers/llm";
import { completeReceipt } from "@amp/backend/providers/receipts";
import {
  parseRelationGoldJsonl,
  relationMetrics,
  safeReportNamePart,
  sampleRelationGold,
  storyTieMetrics,
  toReportView,
  type RelationPrediction,
  type RelationGoldRow,
} from "./eval-relations-core.ts";

async function authorizedPair(row: RelationGoldRow) {
  const a = await prepareEvaluationInput(row.a.analysisInput, row.a.inputFingerprint);
  const b = await prepareEvaluationInput(row.b.analysisInput, row.b.inputFingerprint);
  const read = async () => ({
    a: await loadAnalyzeInput(a.input.id),
    b: await loadAnalyzeInput(b.input.id),
    da: await currentEvaluationDerivedInput(a.input.id, a.input.revision),
    db: await currentEvaluationDerivedInput(b.input.id, b.input.revision),
  });
  const initial = await read();
  const contexts = await newsRelationJurisdictions([a.input, b.input]);
  const reports = [row.a, row.b].map((report, i) => {
    const input = i === 0 ? a.input : b.input,
      derived = i === 0 ? initial.da : initial.db;
    if (
      ![input.title, derived?.title_zh].includes(report.title) ||
      report.source !== input.source.name ||
      report.firstParty !== input.source.firstParty ||
      ![null, input.excerpt, derived?.summary_zh].includes(report.summary) ||
      (report.publishedAt ? new Date(report.publishedAt).toISOString() : null) !== (input.publishedAt?.toISOString() ?? null)
    )
      throw new Error("关系gold中的标题、导读或来源元数据不再匹配当前已绑定材料，请重新导出");
    const fact = (derived?.output?.fact ?? {}) as Record<string, unknown>;
    const frame = { subject: fact.subject ?? null, action: fact.action ?? null, object: fact.object ?? null, occurredAt: fact.occurredAt ?? null };
    if (report.frame && stableJson(report.frame) !== stableJson(frame)) throw new Error("关系gold事实框架没有当前修订的已存依据");
    return {
      ...toReportView(report),
      articleId: input.id,
      revision: input.revision,
      originalText: input.title + "\n" + (input.bodyText ?? input.excerpt ?? ""),
      jurisdiction: contexts.find((c) => c.id === input.id)?.jurisdiction ?? null,
    };
  });
  const articles = [...new Map([a.input, b.input].map((input) => [input.id, input])).values()];
  const permit = await prepareNewsFallback({ root: shutdownSignal.signal, expected: initial, current: read, articles });
  if (!permit) throw new Error("关系评测缺少当前材料许可");
  const user = pairUser(reports[0]!, reports[1]!);
  return { user, fallbackPermit: permit({ system: PAIR_SYSTEM, user }) };
}

await initializeDb("worker");

const { values } = parseArgs({
  options: {
    gold: { type: "string", default: ".data/relation-gold.jsonl" },
    models: { type: "string" },
    n: { type: "string", default: "200" },
    split: { type: "string", default: "all" },
    concurrency: { type: "string", default: "6" },
    seed: { type: "string", default: "7" },
    thresholds: { type: "string", default: "0.75,0.8" },
  },
});

async function pmap<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await fn(items[index]!);
      }
    }),
  );
  return out;
}

function positiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

async function usageFor(receiptIds: number[]) {
  const ids = [...new Set(receiptIds)];
  if (!ids.length) return { tokensIn: 0, tokensOut: 0, avgLatencyMs: 0 };
  const [usage] = await sql<{ tin: number; tout: number; latency: number }[]>`
    SELECT
      sum(coalesce((usage->>'prompt_tokens')::int, (usage->>'input_tokens')::int, 0)) AS tin,
      sum(coalesce((usage->>'completion_tokens')::int, (usage->>'output_tokens')::int, 0)) AS tout,
      avg(latency_ms) AS latency
    FROM receipt_attempts WHERE receipt_id IN ${sql(ids)}`;
  return {
    tokensIn: Number(usage?.tin ?? 0),
    tokensOut: Number(usage?.tout ?? 0),
    avgLatencyMs: Math.round(Number(usage?.latency ?? 0)),
  };
}

async function main() {
  const n = positiveInt(values.n!, "n");
  const concurrency = positiveInt(values.concurrency!, "concurrency");
  const seed = Number(values.seed);
  if (!Number.isInteger(seed)) throw new Error("--seed must be an integer");
  const thresholds = values.thresholds!.split(",").map((value) => Number(value.trim()));
  if (!thresholds.length || thresholds.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error("--thresholds must be comma-separated numbers between 0 and 1");
  }

  const rows = parseRelationGoldJsonl(readFileSync(path.resolve(REPO_ROOT, values.gold!), "utf8"));
  const sample = sampleRelationGold(rows, { split: values.split, n, seed });
  if (!sample.length) throw new Error(`no cases for split ${values.split}`);

  const models = values.models
    ? values.models
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean)
    : [await modelFor("groupReview")];
  if (!models.length) throw new Error("--models did not name any models");
  for (const model of models) if (!MODELS[model]) throw new Error(`unknown model ${model}`);

  const report: Record<string, unknown> = {};
  for (const model of models) {
    const started = Date.now();
    // Distinct gold cases can render identical prompts. Share their result, including failures,
    // so a cold run scores the same cases as a cached run and never retries a pair within one run.
    const requests = new Map<string, ReturnType<typeof chatJson<typeof PairSchema>>>();
    const results = await pmap(sample, concurrency, async (row) => {
      try {
        const { user, fallbackPermit } = await authorizedPair(row);
        let request = requests.get(user);
        const shared = request !== undefined;
        if (!request) {
          request = (async () => {
            const res = await chatJson({
              model,
              purpose: "eval_relation_pair",
              subject: `relation-gold:${row.caseId}`,
              promptVersion: RELATE_PROMPT_VERSION,
              system: PAIR_SYSTEM,
              user,
              fallbackPermit,
              sourceIds: [...fallbackPermit.sourceIds],
              usagePurpose: "evaluation",
              lane: "news",
              schema: PairSchema,
              temperature: 0,
              maxTokens: 400,
            });
            await completeReceipt(sql, res.receiptId);
            return res;
          })();
          requests.set(user, request);
        }
        const res = await request;
        return { row, out: res.data, receiptId: res.receiptId, reused: shared || res.reused, error: null as string | null };
      } catch (error) {
        const receiptId = error instanceof ModelOutputError ? error.receiptId : null;
        return { row, out: null, receiptId, reused: false, error: String(error).slice(0, 300) };
      }
    });

    const predictions: RelationPrediction[] = results.flatMap((result) =>
      result.out
        ? [
            {
              caseId: result.row.caseId,
              gold: result.row.gold.relation,
              relation: result.out.relation,
              confidence: result.out.confidence,
              stratum: result.row.samplingContext?.samplingStratum ?? null,
            },
          ]
        : [],
    );
    const metrics = relationMetrics(predictions, sample.length);
    const usage = await usageFor(results.flatMap((result) => (result.receiptId === null ? [] : [result.receiptId])));
    const summary = {
      model,
      n: sample.length,
      evaluated: metrics.evaluated,
      errors: metrics.errors,
      accuracy: metrics.accuracy,
      macroF1: metrics.macroF1,
      reused: results.filter((result) => result.reused).length,
      ...usage,
      wallSeconds: Math.round((Date.now() - started) / 1000),
    };
    const storyThresholds = thresholds.map((threshold) => storyTieMetrics(predictions, threshold));
    console.log(JSON.stringify(summary));
    console.log(storyThresholds.map((metric) => `  story t=${metric.threshold} P=${metric.precision} R=${metric.recall} F1=${metric.f1}`).join("\n"));

    report[model] = {
      summary,
      confusionMatrix: metrics.confusionMatrix,
      perClass: metrics.perClass,
      storyThresholds,
      cases: results.map((result) => ({
        caseId: result.row.caseId,
        stratum: result.row.samplingContext?.samplingStratum ?? null,
        gold: result.row.gold.relation,
        decision: result.out?.relation ?? null,
        confidence: result.out?.confidence ?? null,
        a: result.out?.a ?? null,
        b: result.out?.b ?? null,
        difference: result.out?.difference ?? null,
        receiptId: result.receiptId,
        reused: result.reused,
        error: result.error,
      })),
    };
  }

  const outDir = path.join(REPO_ROOT, ".data/eval");
  mkdirSync(outDir, { recursive: true });
  const splitName = safeReportNamePart(values.split!);
  const file = path.join(outDir, `relations-${splitName}-${sample.length}-${Date.now()}.json`);
  const meta = {
    split: values.split,
    n: sample.length,
    seed,
    thresholds,
    promptVersion: RELATE_PROMPT_VERSION,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify({ meta, models: report }, null, 2));
  console.log(`report: ${file}`);
}

try {
  await main();
} finally {
  await closeDb();
}
