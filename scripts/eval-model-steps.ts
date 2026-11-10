// Model comparison by step (TASK-0601): replays one analysis step, or the full-text translation, of real items with
// another model and compares the answer with what DeepSeek stored for the same material revision and with the Owner's
// labels. Read-only toward the site: no analysis, translation, checkpoint, route or setting is written. Model calls go
// through the receipts as usage purpose "evaluation" (subjects “evaluation:…”), so their spend stays separate.
//   node scripts/eval-model-steps.ts draw [--seed 20261109] [--out <dir>/samples.json]
//   node scripts/eval-model-steps.ts run --step prefilter|score|structure|translate --model <key> --token-cap <n> [--sample f] [--limit 5] [--concurrency 1] [--out f]
//   node scripts/eval-model-steps.ts sheet --results <dir|file> [--candidate <key>] [--paragraphs 10] [--out sheet.md] [--key sheet-key.json]
//   node scripts/eval-model-steps.ts import --results <dir> [--summary-only]
// The token cap counts this model's earlier result files in the same folder, so one cap covers one free quota.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { REPO_ROOT } from "@amp/backend/config";
import { closeDb, initializeDb, sql } from "@amp/backend/db";
import { importSelectBenchRun } from "@amp/backend/admin/selectbench";
import { readCurrentBody } from "@amp/backend/content/materials";
import {
  analysisVersionOf,
  draftTierThreshold,
  evaluationInputFingerprint,
  loadAnalyzeInput,
  prepareEvaluationInput,
  runSelectionPrefilter,
  runSelectionScores,
  runSelectionStructure,
  toPublicApiCategory,
} from "@amp/backend/editorial/analyze";
import { promptText } from "@amp/backend/editorial/prompts";
import { TRANSLATE_PROMPT_VERSION } from "@amp/backend/editorial/translate";
import { shutdownSignal } from "@amp/backend/jobs/queue";
import { runtimeControlSnapshot } from "@amp/backend/operations/lane-controls";
import { chatJson, MODELS } from "@amp/backend/providers/llm";
import { meetsThreshold, SELECTION } from "@amp/industry/selection";
import { prepareNewsFallback } from "../packages/backend/src/providers/news-fallback.ts";
import { readStoredTranslation, translationCheckpoints } from "../packages/backend/src/editorial/translation-store.ts";
import { shield, TRANSLATION_MANIFEST_FORMAT, translationLeaves, translationSourceManifest } from "../packages/backend/src/editorial/translation-readiness.ts";
import {
  addUsage,
  blindSheet,
  CALL_ESTIMATE,
  draw,
  emptyUsage,
  parseDomainNames,
  pickSheet,
  renderReport,
  STEPS,
  summarize,
  TokenBudget,
  usageOf,
  usageTokens,
  type Baseline,
  type CaseResult,
  type Candidate,
  type Gold,
  type ResultFile,
  type SampleCase,
  type SegmentResult,
  type Step,
  type Usage,
} from "./eval-model-steps-core.ts";

const DIR = path.join(REPO_ROOT, "docs/acceptance/model-bakeoff-20261109");
const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    seed: { type: "string", default: "20261109" },
    out: { type: "string" },
    step: { type: "string" },
    model: { type: "string" },
    sample: { type: "string" },
    "token-cap": { type: "string" },
    limit: { type: "string" },
    concurrency: { type: "string", default: "1" },
    results: { type: "string" },
    candidate: { type: "string" },
    paragraphs: { type: "string", default: "10" },
    key: { type: "string" },
    "summary-only": { type: "boolean", default: false },
  },
});
const names = parseDomainNames(
  ["rules-domain-names.md", "rules-domain-names-extra.md"].map((f) => readFileSync(path.join(REPO_ROOT, "industry/prompts", f), "utf8")).join("\n"),
);
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
/** Never overwrite an earlier sample, result or sheet; the folder is created when missing. */
function reserve(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  closeSync(openSync(file, "wx", 0o600));
}
function save(file: string, value: unknown) {
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
const resultFiles = (target: string, extra: string[] = []): ResultFile[] =>
  [target, ...extra]
    .filter((p) => existsSync(p))
    .flatMap((p) => (statSync(p).isDirectory() ? readdirSync(p).map((f) => path.join(p, f)) : [p]))
    .filter((f) => f.endsWith(".json"))
    .map((f) => json(f))
    .filter((r) => r?.format === "model-bakeoff-result-v1");

// ---- draw ----------------------------------------------------------------------------------------------------------

interface Row {
  id: string;
  revision: number;
  title: string;
  language: string | null;
  tier: string;
  relevance: string | null;
  selected: boolean | null;
  category: string | null;
  subjects: string[];
  score: string | null;
  prompt_version: string | null;
  output: StoredOutput | null;
}
/** The fields of analyses.output (analyzeArticle's detail) that the comparison reads. */
interface StoredOutput {
  prefilter?: { label?: Baseline["label"] } | null;
  scores?: number[] | null;
  threshold?: number | null;
  geography?: { codes?: string[] } | null;
  fact?: unknown;
}
const analysed = (filter: ReturnType<typeof sql>) => sql<Row[]>`
  SELECT a.id, a.revision, a.title, a.language, s.tier, x.relevance, x.selected, x.category, x.subjects, x.score, x.prompt_version, x.output
  FROM articles a JOIN sources s ON s.id = a.source_id
  JOIN LATERAL (SELECT * FROM analyses y WHERE y.article_id = a.id AND y.input_revision = a.revision ORDER BY y.id DESC LIMIT 1) x ON true
  WHERE ${filter} ORDER BY a.id LIMIT 5000`;
const recent = (days: number) => sql`a.discovered_at >= now() - make_interval(days => ${days})`;
const lang = (l: string | null) => (l ?? "unknown").split("-")[0]!;

function ownerLabels(): Map<string, Gold> {
  const dir = path.join(REPO_ROOT, "industry/selection-gold");
  const labels = json(path.join(dir, "owner-20261105-labels.json")) as Record<Gold, number[] | undefined>;
  const byNumber = new Map<number, Gold>((["select", "reject", "either"] as const).flatMap((g) => (labels[g] ?? []).map((n) => [n, g] as const)));
  return new Map(
    (json(path.join(dir, "owner-20261105-candidates.json")) as Array<{ n: number; id: string }>).flatMap((c) =>
      byNumber.has(c.n) ? [[c.id, byNumber.get(c.n)!] as const] : [],
    ),
  );
}

async function sampleCase(row: Row, stratum: string, gold: Gold | null): Promise<SampleCase | null> {
  const input = await loadAnalyzeInput(row.id);
  if (!input || input.revision !== row.revision) return null;
  const out = row.output ?? {};
  const baseline: Baseline = {
    label: out.prefilter?.label ?? (row.relevance === "block" ? "BLOCK" : row.relevance === "pass" ? "PASS" : null),
    selected: row.selected,
    firstScore: typeof out.scores?.[0] === "number" ? out.scores[0] : row.score === null ? null : Number(row.score),
    threshold: typeof out.threshold === "number" ? out.threshold : draftTierThreshold(row.tier),
    category: row.category,
    subjects: row.subjects ?? [],
    countries: out.geography?.codes ?? [],
    hasFact: "fact" in out ? out.fact !== null : null,
    promptCurrent: row.prompt_version === null ? null : row.prompt_version === analysisVersionOf(input),
  };
  return {
    articleId: row.id,
    revision: row.revision,
    title: row.title,
    fingerprint: evaluationInputFingerprint(input),
    stratum,
    language: row.language,
    gold,
    baseline,
  };
}

async function drawSamples(seed: string, out: string) {
  reserve(out);
  const gold = ownerLabels();
  const owner = await analysed(sql`a.id = ANY(${[...gold.keys()]}::text[])`);
  const key = (r: Row) => r.id;
  const goldOf = (r: Row) => gold.get(r.id) ?? null;
  const ownerSelect = owner.filter((r) => goldOf(r) === "select");
  const keptRows = [
    ...draw(ownerSelect, 30, { seed, key }).map((r) => [r, "selected-owner"] as const),
    ...draw(await analysed(sql`${recent(14)} AND x.selected AND x.relevance = 'pass'`), 30, { seed, key, exclude: new Set(ownerSelect.map(key)) }).map(
      (r) => [r, "selected-deepseek"] as const,
    ),
  ].slice(0, 30);
  const blocked = draw(await analysed(sql`${recent(14)} AND x.relevance = 'block'`), 10, { seed, key, groupOf: (r) => lang(r.language) });
  const gap = (r: Row) => {
    const t = typeof r.output?.threshold === "number" ? r.output.threshold : draftTierThreshold(r.tier);
    return r.score === null || t === null ? 1000 : Math.abs(Number(r.score) - t);
  };
  const scoreRows = [
    ...draw(ownerSelect, 40, { seed, key }),
    ...owner.filter((r) => goldOf(r) === "reject").sort((a, b) => gap(a) - gap(b) || (a.id < b.id ? -1 : 1)),
  ].slice(0, 40);
  const structureRows = draw(await analysed(sql`${recent(14)} AND x.category IS NOT NULL AND x.relevance = 'pass'`), 40, {
    seed,
    key,
    groupOf: (r) => r.category!,
  });
  const missing: string[] = [...gold.keys()].filter((id) => !owner.some((r) => r.id === id));
  const cases = async (rows: ReadonlyArray<readonly [Row, string]>) => {
    const list: SampleCase[] = [];
    for (const [row, stratum] of rows) {
      const c = await sampleCase(row, stratum, goldOf(row));
      if (c) list.push(c);
      else missing.push(row.id);
    }
    return list;
  };
  const recipe = `${TRANSLATION_MANIFEST_FORMAT}:${TRANSLATE_PROMPT_VERSION}`;
  const translated = await sql<{ id: string; revision: number; title: string; language: string; recipe: string | null; rich: boolean }[]>`
    SELECT a.id, a.revision, a.title, a.language, t.recipe,
      (a.body_html ~ '<(table|a)\\s' OR length(regexp_replace(coalesce(a.body_text, ''), '[^0-9]', '', 'g')) >= 20) AS rich
    FROM translations t JOIN articles a ON a.id = t.article_id JOIN publications p ON p.article_id = a.id
    WHERE t.lang = 'zh' AND t.origin = 'model' AND t.complete AND t.revision = a.revision AND p.selected AND ${recent(30)}
      AND split_part(a.language, '-', 1) IN ('en', 'es', 'pt')
    ORDER BY a.id LIMIT 5000`;
  const prefer = (r: (typeof translated)[number]) => (r.recipe === recipe ? 2 : 0) + (r.rich ? 1 : 0);
  const translate = [
    ...draw(
      translated.filter((r) => lang(r.language) === "en"),
      30,
      { seed, key: (r) => r.id, prefer },
    ),
    ...draw(
      translated.filter((r) => lang(r.language) !== "en"),
      10,
      { seed, key: (r) => r.id, prefer },
    ),
  ].map(
    (r): SampleCase => ({
      articleId: r.id,
      revision: r.revision,
      title: r.title,
      fingerprint: "",
      stratum: lang(r.language) === "en" ? "en" : "es-pt",
      language: r.language,
      gold: null,
      baseline: {
        label: null,
        selected: true,
        firstScore: null,
        threshold: null,
        category: null,
        subjects: [],
        countries: [],
        hasFact: null,
        promptCurrent: r.recipe === recipe,
      },
    }),
  );
  const steps: Record<Step, SampleCase[]> = {
    prefilter: await cases([...keptRows, ...blocked.map((r) => [r, `block-${lang(r.language)}`] as const)]),
    score: await cases(scoreRows.map((r) => [r, goldOf(r) === "select" ? "owner-select" : "owner-reject-near-threshold"] as const)),
    structure: await cases(structureRows.map((r) => [r, `category-${r.category}`] as const)),
    translate,
  };
  save(out, { format: "model-bakeoff-samples-v1", seed, drawnAt: new Date().toISOString(), steps, missing: [...new Set(missing)] });
  const strata = (list: SampleCase[]) => {
    const counts: Record<string, number> = {};
    for (const c of list) counts[c.stratum] = (counts[c.stratum] ?? 0) + 1;
    return counts;
  };
  console.log(JSON.stringify({ out, ...Object.fromEntries(STEPS.map((s) => [s, strata(steps[s])])), missing: new Set(missing).size }));
}

// ---- run -----------------------------------------------------------------------------------------------------------

class CapReached extends Error {}
const REFUSED = /\b(403|429)\b|quota|free ?tier|arrearage|throttl|rate.?limit/i;
/** The case was not judged because its material changed or may not be sent; it does not count as a model error. */
class Skip extends Error {}
const attemptMark = async () => Number((await sql<{ id: string }[]>`SELECT coalesce(max(id), 0)::text AS id FROM receipt_attempts`)[0]!.id);
/** What the provider billed for these receipts after the mark: reused receipts cost nothing and count nothing. */
async function usageSince(receiptIds: number[], mark: number): Promise<Usage> {
  if (!receiptIds.length) return emptyUsage();
  const rows = await sql<{ usage: Record<string, unknown> | null; latency_ms: number | null; model: string | null }[]>`
    SELECT ra.usage, ra.latency_ms, r.response->>'model' AS model FROM receipt_attempts ra JOIN receipts r ON r.id = ra.receipt_id
    WHERE ra.receipt_id IN ${sql([...new Set(receiptIds)])} AND ra.id > ${mark}`;
  return rows.reduce((total, r) => addUsage(total, usageOf(r.usage, r.latency_ms ?? 0, r.model)), emptyUsage());
}

interface Meter {
  budget: TokenBudget;
  usage: Usage;
  receiptIds: number[];
  /** Errors already seen in this run (design §6: the same error twice stops it), shared with translation segments. */
  seen: Set<string>;
  stopped: () => boolean;
}
/** A translation segment failed with an error this run has already seen. */
class RepeatedError extends Error {}
/** Records a segment failure; the second of the same kind stops the run. */
function noteSegmentError(meter: Meter, message: string) {
  if (meter.seen.has(message)) throw new RepeatedError(message);
  meter.seen.add(message);
}
/** One paid call within the cap: refused before sending when the cap could be passed, measured from its receipts after. */
async function metered<T>(meter: Meter, call: (onReceipt: (id: number) => void) => Promise<T>): Promise<T> {
  const size = meter.budget.reserve();
  if (size === null) throw new CapReached("token_cap");
  const mark = await attemptMark(),
    ids: number[] = [];
  try {
    return await call((id) => ids.push(id));
  } finally {
    const used = await usageSince(ids, mark);
    meter.budget.settle(size, usageTokens(used));
    meter.usage = addUsage(meter.usage, used);
    meter.receiptIds.push(...ids);
  }
}

const SYSTEM = promptText("translate-body");
async function translateCase(
  model: string,
  c: SampleCase,
  meter: Meter,
  runtimeControl: Awaited<ReturnType<typeof runtimeControlSnapshot>>,
  segments: SegmentResult[],
) {
  const body = await readCurrentBody(c.articleId);
  if (!body?.body_html || body.revision !== c.revision) throw new Skip("材料已有新修订");
  const source = translationSourceManifest(body.body_html);
  const stored = await readStoredTranslation(body.id);
  if (stored?.origin !== "model" || !stored.complete || stored.revision !== body.revision || stored.source_hash !== source.sourceHash || !stored.recipe)
    throw new Skip("DeepSeek 的完整译文已不对应当前材料");
  // Read-only: the stored checkpoints are read as the admin preview reads them; nothing is claimed or saved.
  const saved = await translationCheckpoints({ body: { ...body, body_html: body.body_html }, recipe: stored.recipe, source });
  const leaves = translationLeaves(
    source,
    saved.filter((s) => s.replacement).map((s) => s.index),
  );
  if (!leaves) throw new Skip("译文分段计划无效");
  const permit = await prepareNewsFallback({
    root: shutdownSignal.signal,
    expected: body,
    current: () => readCurrentBody(c.articleId),
    articles: [body],
    materialScope: "body",
  });
  if (!permit) throw new Skip("来源许可不允许把正文送外部模型");
  // Translation-only models take no system prompt and answer in plain text (site/models.ts, jsonMode false).
  const plain = MODELS[model]?.jsonMode === false;
  for (const leaf of leaves) {
    if (meter.stopped()) break;
    const part = shield(leaf.html).html;
    const user = plain ? part : JSON.stringify({ text: part, ...(leaf.reference ? { referenceOnly: leaf.reference } : {}) });
    const system = plain ? "" : SYSTEM;
    const baseline = saved.find((s) => s.index === leaf.index && s.state === "complete");
    const segment: SegmentResult = {
      index: leaf.index,
      language: body.language,
      source: leaf.html,
      candidate: null,
      baseline: baseline ? baseline.text : null,
      finishReason: null,
    };
    segments.push(segment);
    let reply: Awaited<ReturnType<typeof chatJson>>;
    try {
      reply = await metered(meter, (onReceipt) =>
        chatJson({
          model,
          purpose: "translate_body",
          usagePurpose: "evaluation",
          // Not an article scope: translation recovery reads “article:…” subjects of translate_body receipts.
          subject: `evaluation:article:${body.id}@${body.revision}#${leaf.index}`,
          usageObject: { kind: "article", id: `${body.id}@${body.revision}` },
          sourceIds: [body.source_id],
          runtimeControl,
          promptVersion: plain ? `${TRANSLATE_PROMPT_VERSION}:plain` : TRANSLATE_PROMPT_VERSION,
          system,
          user,
          fallbackPermit: permit({ system, user }),
          schema: z.unknown(),
          parse: (content) => content,
          ...(plain ? { json: false } : {}),
          temperature: 0.2,
          maxTokens: Math.min(8000, Math.ceil(part.length * 1.2) + 400),
          timeoutMs: 180_000,
          maxRejectedOutputs: 1,
        }).then(
          (r) => {
            onReceipt(r.receiptId);
            return r;
          },
          (error: unknown) => {
            const receiptId = (error as { receiptId?: unknown } | null)?.receiptId;
            if (typeof receiptId === "number") onReceipt(receiptId);
            throw error;
          },
        ),
      );
    } catch (error) {
      // One failed segment is a failed segment; a cap, a refused quota or a lost response stops the article.
      const message = String(error instanceof Error ? error.message : error).slice(0, 300);
      if (error instanceof CapReached) segments.pop(); // never sent
      if (error instanceof CapReached || REFUSED.test(message) || /unknown|未知/i.test(message)) throw error;
      segment.error = message;
      noteSegmentError(meter, message);
      continue;
    }
    segment.finishReason = reply.finishReason;
    try {
      const raw = plain ? { text: String(reply.data).trim() } : JSON.parse(String(reply.data));
      segment.candidate = typeof raw?.text === "string" ? raw.text : null;
    } catch {
      segment.error = "unparsable JSON";
      noteSegmentError(meter, segment.error);
    }
  }
}

async function judge(
  step: Step,
  model: string,
  c: SampleCase,
  meter: Meter,
  runtimeControl: Awaited<ReturnType<typeof runtimeControlSnapshot>>,
): Promise<Candidate> {
  if (step === "translate") {
    const segments: SegmentResult[] = [];
    try {
      await translateCase(model, c, meter, runtimeControl, segments);
    } catch (error) {
      if ((error instanceof CapReached || error instanceof RepeatedError) && segments.length) Object.assign(error, { partial: { segments } });
      throw error;
    }
    return { segments };
  }
  const current = await loadAnalyzeInput(c.articleId);
  if (!current || current.revision !== c.revision) throw new Skip("材料已有新修订");
  let prepared: Awaited<ReturnType<typeof prepareEvaluationInput>>;
  try {
    prepared = await prepareEvaluationInput(current, c.fingerprint);
  } catch (error) {
    throw new Skip(String(error).slice(0, 200));
  }
  const opts = { fallbackInput: prepared.fallbackInput, usagePurpose: "evaluation" as const, runtimeControl };
  const input = prepared.input;
  if (step === "prefilter") return { label: (await metered(meter, (r) => runSelectionPrefilter(input, { ...opts, prefilterModel: model }, r))).label };
  if (step === "structure") {
    const s = await metered(meter, (r) => runSelectionStructure(input, { ...opts, structureModel: model }, r));
    return { category: toPublicApiCategory(s.category), subjects: s.subjects, countries: s.geography.codes, hasFact: s.fact !== null };
  }
  const threshold = c.baseline.threshold ?? draftTierThreshold(input.source.tier);
  if (threshold === null) throw new Skip("该信源等级没有门槛");
  const scores = await metered(meter, (r) => runSelectionScores(input, { ...opts, scoreModel: model }, r, threshold));
  if (!scores || scores.refused || !scores.values.length) throw new Error("模型拒绝评分或没有给出分数");
  return { score: scores.values[0]!, selected: meetsThreshold(scores.values.slice(0, 1), threshold) };
}

async function runStep() {
  const step = values.step as Step,
    model = values.model,
    cap = Number(values["token-cap"]);
  if (!STEPS.includes(step) || !model || !values["token-cap"])
    throw new Error("usage: run --step prefilter|score|structure|translate --model <key> --token-cap <n>");
  if (!MODELS[model] && !model.startsWith("registered:")) throw new Error(`Unknown model ${model}`);
  const samplePath = values.sample ?? path.join(DIR, "samples.json");
  const sample = json(samplePath) as { format: string; steps: Record<Step, SampleCase[]> };
  if (sample.format !== "model-bakeoff-samples-v1") throw new Error("--sample is not a draw output");
  const limit = values.limit === undefined ? Infinity : Number(values.limit);
  const concurrency = Number(values.concurrency);
  if (!(limit > 0) || ![1, 2, 3, 4].includes(concurrency)) throw new Error("--limit must be positive and --concurrency 1 to 4");
  const out = values.out ?? path.join(path.dirname(samplePath), `${step}-${model.replace(/[^\w.-]+/g, "_")}-${Date.now()}.json`);
  const priorTokens = resultFiles(path.dirname(out))
    .filter((r) => r.model === model)
    .reduce((sum, r) => sum + r.cases.reduce((s, c) => s + usageTokens(c.usage), 0), 0);
  const budget = new TokenBudget(cap, priorTokens, CALL_ESTIMATE[step]);
  const controls = await runtimeControlSnapshot("news", ["processing"]);
  if (controls.paused) throw new Error("处理已暂停，评测没有开始");
  // Each item is scored once (design §2.2); production asks for the second score only near the threshold.
  if (step === "score") (SELECTION as { secondScoreMargin: number }).secondScoreMargin = -1;
  reserve(out);
  const file: ResultFile = {
    format: "model-bakeoff-result-v1",
    step,
    model,
    stopReason: null,
    tokenCap: cap,
    priorTokens,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    cases: [],
  };
  const errors = new Set<string>();
  const queue = sample.steps[step].slice(0, limit);
  const stop = (reason: string) => (file.stopReason ??= reason);
  const worker = async () => {
    for (let c = queue.shift(); c && !file.stopReason; c = queue.shift()) {
      const now = await runtimeControlSnapshot("news", ["processing"]);
      if (now.paused || now.version !== controls.version) {
        stop("processing_control_changed");
        break;
      }
      const meter: Meter = { budget, usage: emptyUsage(), receiptIds: [], seen: errors, stopped: () => file.stopReason !== null };
      const result: CaseResult = { ...c, candidate: null, error: null, receiptIds: [], usage: emptyUsage() };
      try {
        result.candidate = await judge(step, model, c, meter, controls);
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error).slice(0, 300);
        if (error instanceof RepeatedError) {
          // Completed segments are kept; no further call is made.
          stop("repeated_error");
          result.candidate = (error as RepeatedError & { partial?: Candidate }).partial ?? null;
          result.error = message;
          file.cases.push({ ...result, receiptIds: meter.receiptIds, usage: meter.usage });
          save(out, file);
          continue;
        }
        if (error instanceof CapReached) {
          stop("token_cap");
          result.candidate = (error as CapReached & { partial?: Candidate }).partial ?? null;
          if (!result.candidate && !meter.receiptIds.length) continue;
        }
        result.error = error instanceof Skip ? `skipped: ${message}` : message;
        if (!(error instanceof Skip) && !(error instanceof CapReached)) {
          // Design §6 stop rules: a refused quota or rate limit stops this model; the same error twice stops the run.
          if (REFUSED.test(message)) stop("provider_refused");
          else if (errors.has(message)) stop("repeated_error");
          errors.add(message);
        }
      }
      file.cases.push({ ...result, receiptIds: meter.receiptIds, usage: meter.usage });
      save(out, file);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  file.finishedAt = new Date().toISOString();
  file.summary = summarize(file, names);
  save(out, file);
  console.log(JSON.stringify(file.summary));
  const used = file.cases.reduce((a, c) => addUsage(a, c.usage), emptyUsage());
  console.log(
    `result: ${out}\n实测每次调用约 ${used.calls ? Math.round(usageTokens(used) / used.calls) : "—"} tokens；本模型累计 ${budget.spent}/${cap}，额度内约还能调用 ${budget.remainingCalls()} 次`,
  );
}

// ---- sheet / import ------------------------------------------------------------------------------------------------

function sheet() {
  if (!values.results) throw new Error("usage: sheet --results <dir|file> [--candidate <key>]");
  const files = resultFiles(values.results, positionals).filter((r) => r.step === "translate");
  const models = [...new Set(files.map((f) => f.model))];
  const model = values.candidate ?? (models.length === 1 ? models[0] : undefined);
  if (!model) throw new Error(`several translation results (${models.join(", ")}); name one with --candidate`);
  const cases = files.filter((f) => f.model === model).flatMap((f) => f.cases);
  const { markdown, key } = blindSheet(pickSheet(cases, names, values.seed!, Number(values.paragraphs)), model, values.seed!);
  const out = values.out ?? path.join(path.dirname(values.results), "sheet.md"),
    keyFile = values.key ?? path.join(path.dirname(values.results), "sheet-key.json");
  reserve(out);
  reserve(keyFile);
  writeFileSync(out, markdown);
  save(keyFile, key);
  console.log(`sheet: ${out} (${key.length} segments); key: ${keyFile} — keep the key until the Owner has answered`);
}

const decisionOf = (step: Step, c: Candidate | Baseline | null): string | null => {
  if (!c) return null;
  if (step === "prefilter") return c.label ?? null;
  if (step === "score") return c.selected === undefined || c.selected === null ? null : c.selected ? "select" : "reject";
  if (step === "structure") return c.category ?? null;
  return "segments" in c ? (c.segments?.every((s) => s.candidate !== null) ? "ok" : "failed") : null;
};
async function importResults() {
  const dir = values.results ?? DIR;
  const files = resultFiles(dir, positionals);
  if (!files.length) throw new Error(`no result files in ${dir}`);
  const summaries = files.map((f) => summarize(f, names));
  writeFileSync(path.join(dir, "summary.md"), renderReport(summaries));
  console.log(`summary: ${path.join(dir, "summary.md")}`);
  if (values["summary-only"]) return;
  for (const step of STEPS) {
    const group = files.filter((f) => f.step === step);
    if (!group.length) continue;
    const row = (c: CaseResult, decision: string | null, score: number | null | undefined, extra: Record<string, unknown>) => ({
      caseId: `${c.articleId}@${c.revision}`,
      title: c.title,
      stratum: c.stratum,
      gold: c.gold ?? `ds:${decisionOf(step, c.baseline) ?? "—"}`,
      decision,
      score: typeof score === "number" ? Math.round(score) : null,
      ...extra,
    });
    const models: Record<string, unknown> = Object.fromEntries(
      group.map((f, i) => [
        `${f.model}${group.filter((g) => g.model === f.model).length > 1 ? `#${i + 1}` : ""}`,
        {
          summary: summarize(f, names),
          cases: f.cases.map((c) =>
            row(c, decisionOf(step, c.candidate), c.candidate?.score, {
              category: c.candidate?.category ?? null,
              reason: c.candidate?.subjects ? `${c.candidate.subjects.join(",")} | ${c.candidate.countries?.join(",") ?? ""}` : null,
              receiptId: c.receiptIds[0] ?? null,
              error: c.error,
            }),
          ),
        },
      ]),
    );
    const all = [...new Map(group.flatMap((f) => f.cases).map((c) => [`${c.articleId}@${c.revision}`, c])).values()];
    models["deepseek(库存)"] = {
      summary: { n: all.length, note: "库里已存的 DeepSeek 结果，未重新调用" },
      cases: all.map((c) => row(c, decisionOf(step, c.baseline), c.baseline.firstScore, { category: c.baseline.category })),
    };
    const run = await importSelectBenchRun(
      { meta: { split: step, n: all.length }, models },
      `模型比选 ${step} · 与 DeepSeek 库存结果对照（非人工金标）`,
      "script:eval-model-steps",
    );
    console.log(`SelectBench ${step}: ${run.id}`);
  }
}

if (!["draw", "run", "sheet", "import"].includes(command ?? "")) throw new Error("usage: node scripts/eval-model-steps.ts draw|run|sheet|import …");
if (command === "sheet") sheet();
else {
  await initializeDb("worker");
  try {
    if (command === "draw") await drawSamples(values.seed!, values.out ?? path.join(DIR, "samples.json"));
    else if (command === "run") await runStep();
    else await importResults();
  } finally {
    await closeDb();
  }
}
