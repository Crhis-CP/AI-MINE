// Private, explicitly invoked evaluation. Never imported by an API, scheduler or production worker.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import path from "node:path";
import { REPO_ROOT } from "@amp/backend/config";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { sql, initializeDb, closeDb } from "@amp/backend/db";
import { loadPool } from "@amp/backend/publication/pool";
import {
  loadAnalyzeInput,
  prepareEvaluationInput,
  evaluationInputFingerprint,
  buildScoreInput,
  ScoreSchema,
  draftTierThreshold,
  type AnalyzeInputArticle,
} from "@amp/backend/editorial/analyze";
import { PREFILTER_SYSTEM, prefilterUser, missingEvidence } from "@amp/backend/editorial/writing";
import { promptText, promptVersion } from "@amp/backend/editorial/prompts";
import { modelFor } from "@amp/backend/editorial/models";
import { selectionModelIdentity } from "@amp/backend/admin/selectbench";
import { chatJson, type ChatJsonOptions } from "@amp/backend/providers/llm";
import { normalizedUppercase } from "@amp/backend/lib/text";
import { sha256, stableJson } from "@amp/backend/lib/ids";
import { ExperimentManifest, metrics, countryPreview, attemptSummary, type Experiment, type Outcome, type Variant } from "./selection-experiment-data.ts";

const prompts = { A: "selection-score", B: "selection-score-b", AR: "selection-country-ar" } as const;
const Prefilter = z.object({ label: z.preprocess(normalizedUppercase, z.enum(["PASS", "BLOCK", "UNKNOWN"])), reason: z.string().max(200).catch("") });
const restored = (input: AnalyzeInputArticle): AnalyzeInputArticle => ({
  ...input,
  publishedAt: input.publishedAt ? new Date(input.publishedAt) : null,
  discoveredAt: input.discoveredAt ? new Date(input.discoveredAt) : null,
});
export function assertIsolatedDatabase(url: string, production = process.env.NODE_ENV === "production", environment: NodeJS.ProcessEnv = process.env) {
  if (Object.keys(environment).some((key) => key.startsWith("DATABASE_URL_") && environment[key] !== undefined))
    throw new Error("Experiment refuses split DATABASE_URL_* overrides; use one isolated database");
  if (production || !/_(test|ci|eval)$/.test(new URL(url).pathname))
    throw new Error("Experiment requires an explicitly isolated *_eval, *_test or *_ci database");
}
async function argentinaCandidates() {
  const now = new Date(),
    ids = new Set<string>();
  let page = 1,
    pages = 1,
    expected: number | null = null;
  do {
    const result = await loadPool({ jurisdiction: "AR", channel: "news", category: null, tag: null, selected: false, now, page });
    expected ??= result.total;
    if (expected !== result.total) throw new Error("Candidate pool changed during export; retry snapshot");
    for (const item of result.items) ids.add(item.id);
    pages = result.pageCount;
    page++;
  } while (page <= pages);
  if (ids.size !== expected) throw new Error("Candidate pagination changed or omitted material");
  return ids;
}
export async function exportCountryCandidates(datasetId: string): Promise<Experiment> {
  const ids = await argentinaCandidates(),
    cases: Experiment["cases"] = [];
  for (const id of ids) {
    const input = await loadAnalyzeInput(id);
    if (!input) throw new Error("Candidate input unavailable");
    // Export only material whose current processing permissions can be proven; never manufacture grants.
    await prepareEvaluationInput(input);
    cases.push({
      caseId: `ar-${cases.length + 1}`,
      familyId: `unreviewed-${id}`,
      occurrenceId: `unreviewed-${id}`,
      split: "holdout",
      inputFingerprint: evaluationInputFingerprint(input),
      analysisInput: input,
      labels: [],
    });
  }
  const model = await modelFor("score"),
    prefilterModel = await modelFor("prefilter");
  const modelIdentity = await selectionModelIdentity(model),
    prefilterIdentity = await selectionModelIdentity(prefilterModel);
  return {
    version: 1,
    datasetId,
    frozenAt: new Date().toISOString(),
    synthetic: false,
    cases,
    ...(modelIdentity && prefilterIdentity
      ? {
          bindings: {
            model,
            prefilterModel,
            modelIdentity,
            prefilterIdentity,
            prefilterHash: sha256(PREFILTER_SYSTEM),
            promptHashes: { A: sha256(promptText(prompts.A)), B: sha256(promptText(prompts.B)), AR: sha256(promptText(prompts.AR)) },
          },
        }
      : {}),
  };
}
export async function runExperiment(manifest: Experiment, maxCalls: number, checkpoint?: (value: unknown) => void) {
  manifest = ExperimentManifest.parse(manifest);
  assertIsolatedDatabase(process.env.DATABASE_URL ?? "postgres://unset/unset");
  if (!Number.isInteger(maxCalls) || maxCalls < manifest.cases.length * 7)
    throw new Error("Declare at least 7 calls per case: shared prefilter and two scores for A/B/AR");
  if (manifest.cases.some((c) => c.labels.length !== 2 || c.familyId.startsWith("unreviewed-") || c.occurrenceId.startsWith("unreviewed-")))
    throw new Error("Two independent labels and reviewed event families are required before unblinding");
  const model = await modelFor("score"),
    prefilterModel = await modelFor("prefilter"),
    identity = await selectionModelIdentity(model);
  if (!identity) throw new Error("Cannot freeze model configuration");
  const prefilterIdentity = await selectionModelIdentity(prefilterModel);
  if (!prefilterIdentity) throw new Error("Cannot freeze prefilter configuration");
  const versions = Object.fromEntries(Object.entries(prompts).map(([k, p]) => [k, { version: promptVersion(p), renderedHash: sha256(promptText(p)) }]));
  if (
    !manifest.bindings ||
    manifest.bindings.model !== model ||
    manifest.bindings.prefilterModel !== prefilterModel ||
    manifest.bindings.modelIdentity !== identity ||
    manifest.bindings.prefilterIdentity !== prefilterIdentity ||
    manifest.bindings.prefilterHash !== sha256(PREFILTER_SYSTEM) ||
    (Object.keys(prompts) as Variant[]).some((v) => manifest.bindings!.promptHashes[v] !== versions[v]!.renderedHash)
  )
    throw new Error("Frozen prompt/model bindings are missing or changed; do not silently rerun a different experiment");
  const outcomes: Outcome[] = [],
    receipts = new Set<number>();
  const snapshot = sha256(stableJson(manifest));
  // Freeze all inputs before the first call so a malformed later sample cannot waste earlier requests.
  for (const row of manifest.cases) await prepareEvaluationInput(restored(row.analysisInput), row.inputFingerprint);
  const before = Number((await sql`SELECT coalesce(max(id),0) id FROM receipt_attempts`)[0]!.id);
  const rememberError = (error: unknown) => {
    const id = (error as { receiptId?: unknown })?.receiptId;
    if (typeof id === "number" && Number.isInteger(id)) receipts.add(id);
  };
  const receiptGaps: string[] = [];
  const observedCall = async <S extends z.ZodType>(options: ChatJsonOptions<S>, configurationHash: string) => {
    try {
      return await chatJson(options);
    } catch (error) {
      rememberError(error);
      // A bounded retry can fail before the gateway returns an ID. Match the exact stored request,
      // including configuration and score ordinal; never infer a receipt from the material alone.
      if (typeof (error as { receiptId?: unknown })?.receiptId !== "number") {
        const matches = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE purpose=${options.purpose}
          AND request->>'configuration_hash'=${configurationHash} AND request->>'promptVersion'=${options.promptVersion}
          AND request->>'systemHash'=${sha256(options.system)} AND request->>'userHash'=${sha256(String(options.user))}
          AND request->>'temperature'=${String(options.temperature)} AND request->>'maxTokens'=${String(Math.max(options.maxTokens ?? 1500, 512) + (options.model.endsWith("-think") ? 4000 : 0))}
          AND logical_key LIKE ${`%:${options.attemptTag ?? "0"}`}`;
        if (matches.length === 1) receipts.add(Number(matches[0]!.id));
        else if (matches.length > 1 || (error as Error)?.constructor?.name === "ReceiptPhysicalLimitError")
          receiptGaps.push(`${options.subject}:${options.promptVersion}:ambiguous_receipt`);
      }
      throw error;
    }
  };
  const guardModel = async () => {
    if ((await selectionModelIdentity(model)) !== identity || (await selectionModelIdentity(prefilterModel)) !== prefilterIdentity)
      throw new Error("Model configuration changed during experiment");
  };
  for (const row of manifest.cases) {
    let prefilter: "PASS" | "BLOCK" | "UNKNOWN";
    try {
      await guardModel();
      const { input, fallbackInput } = await prepareEvaluationInput(restored(row.analysisInput), row.inputFingerprint);
      const user = prefilterUser(input);
      const result = await observedCall(
        {
          model: prefilterModel,
          purpose: "prefilter_article",
          lane: "news",
          usagePurpose: "evaluation",
          subject: `article:${input.id}@${input.revision}`,
          sourceIds: [input.sourceId!],
          system: PREFILTER_SYSTEM,
          user,
          promptVersion: promptVersion("prefilter"),
          schema: Prefilter,
          temperature: 0,
          maxTokens: 512,
          maxPhysicalAttempts: 1,
          fallbackPermit: fallbackInput({ system: PREFILTER_SYSTEM, user }),
          beforeRequest: guardModel,
        },
        prefilterIdentity,
      );
      receipts.add(result.receiptId);
      prefilter = result.data.label === "BLOCK" && missingEvidence(input) ? "UNKNOWN" : result.data.label;
    } catch (error) {
      rememberError(error);
      for (const variant of Object.keys(prompts) as Variant[])
        outcomes.push({ caseId: row.caseId, variant, scores: [], receipts: [], selected: null, error: String(error).slice(0, 300) });
      continue;
    }
    // Alternate order by family hash, independently of labels, to avoid always measuring B later.
    const order: Variant[] = Number.parseInt(sha256(row.familyId).slice(0, 2), 16) % 2 ? ["AR", "B", "A"] : ["A", "B", "AR"];
    for (const variant of order) {
      const out: Outcome = { caseId: row.caseId, variant, scores: [], selected: null, receipts: [], error: null };
      outcomes.push(out);
      const threshold = draftTierThreshold(row.analysisInput.source.tier);
      if (prefilter === "BLOCK" || threshold === null) {
        out.selected = false;
        continue;
      }
      try {
        for (let i = 1; i <= 2; i++) {
          await guardModel();
          const { input, fallbackInput } = await prepareEvaluationInput(restored(row.analysisInput), row.inputFingerprint);
          const system = promptText(prompts[variant]),
            user = buildScoreInput(input);
          const special = model === "glm-5.3-flash-selection";
          const result = await observedCall(
            {
              model,
              purpose: "score_article",
              lane: "news",
              usagePurpose: "evaluation",
              subject: `article:${input.id}@${input.revision}`,
              sourceIds: [input.sourceId!],
              system,
              user,
              promptVersion: promptVersion(prompts[variant]),
              schema: ScoreSchema,
              temperature: special ? 1 : 0.2,
              maxTokens: special ? 65536 : 1024,
              timeoutMs: special ? 180000 : 120000,
              maxPhysicalAttempts: 1,
              attemptTag: `score-${i}`,
              fallbackPermit: fallbackInput({ system, user }),
              beforeRequest: guardModel,
            },
            identity,
          );
          receipts.add(result.receiptId);
          out.receipts.push(result.receiptId);
          out.scores.push(result.data.attentionScore);
        }
        out.selected = out.scores.reduce((a, b) => a + b, 0) >= threshold * 2;
      } catch (error) {
        rememberError(error);
        out.error = String(error).slice(0, 300);
      }
      checkpoint?.({ mode: "partial_not_approved", datasetHash: snapshot, versions, model, identity, outcomes, receiptIds: [...receipts] });
    }
  }
  const afterIdentity = await selectionModelIdentity(model),
    afterPrefilterIdentity = await selectionModelIdentity(prefilterModel);
  const ids = [...receipts];
  const attempts = ids.length
    ? await sql`SELECT id,receipt_id,status,usage,cost,currency,cost_basis,latency_ms,started_at,finished_at FROM receipt_attempts WHERE receipt_id IN ${sql(ids)} ORDER BY id`
    : [];
  const currentCandidates = await argentinaCandidates();
  for (const row of manifest.cases) {
    try {
      await prepareEvaluationInput(restored(row.analysisInput), row.inputFingerprint);
    } catch {
      currentCandidates.delete(row.analysisInput.id);
    }
  }
  const modelStable = identity === afterIdentity && prefilterIdentity === afterPrefilterIdentity;
  // Scope comes from the current evidenced country pool, never from a model score or global selection.
  return {
    mode: "exploratory_not_approved",
    datasetHash: snapshot,
    synthetic: manifest.synthetic,
    versions,
    model,
    identity,
    prefilterModel,
    prefilterIdentity,
    modelStable,
    declaredCalls: maxCalls,
    maximumPlannedCalls: manifest.cases.length * 7,
    newPhysicalAttempts: attempts.filter((a) => Number(a.id) > before).length,
    attempts,
    receiptGaps,
    costAndLatency: attemptSummary(attempts as never),
    outcomes,
    metrics: Object.fromEntries(
      ["development", "holdout"].map((split) => [
        split,
        Object.fromEntries(
          (Object.keys(prompts) as Variant[]).map((v) => [
            v,
            metrics(
              manifest.cases.filter((c) => c.split === split),
              outcomes,
              v,
            ),
          ]),
        ),
      ]),
    ),
    countryPreview: modelStable ? countryPreview(manifest.cases, outcomes, currentCandidates) : [],
    coverage: {
      sampled: manifest.cases.length,
      currentPublishedCountryCandidates: currentCandidates.size,
      unclassifiedOrUnpublished: "not_measured",
      transportCalls: 0,
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      output: { type: "string" },
      run: { type: "boolean", default: false },
      "max-calls": { type: "string", default: "0" },
      "export-country": { type: "string" },
      task: { type: "string" },
    },
  });
  if (!values.output) throw new Error("--output required");
  if (!values.run && !values["export-country"]) {
    const data = ExperimentManifest.parse(JSON.parse(readFileSync(values.manifest!, "utf8")));
    writeFileSync(
      values.output,
      JSON.stringify(
        {
          mode: "plan_only",
          cases: data.cases.length,
          maximumCalls: data.cases.length * 7,
          missingLabels: data.cases.filter((c) => c.labels.length !== 2).map((c) => c.caseId),
          transportCalls: 0,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    return;
  }
  assertIsolatedDatabase(process.env.DATABASE_URL ?? "postgres://unset/unset");
  if (values.run) {
    if (!/^TASK-[0-9]{4}$/.test(values.task ?? "")) throw new Error("--task TASK-nnnn required for live experiment");
    const text = readFileSync(path.join(REPO_ROOT, "tasks", `${values.task}.md`), "utf8");
    // Task cards use this deliberately narrow inline declaration; unsupported forms fail closed.
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] ?? "";
    const declarations = [...header.matchAll(/^budget:\s*\{\s*model_calls:\s*([0-9]+)\s*\}\s*$/gm)];
    const taskCalls = declarations.length === 1 ? Number(declarations[0]![1]) : 0;
    if (!Number.isInteger(Number(values["max-calls"])) || Number(values["max-calls"]) <= 0 || Number(values["max-calls"]) > taskCalls)
      throw new Error("Declared physical calls exceed the task card; no model request made");
  }
  await initializeDb("worker");
  try {
    const result = values["export-country"]
      ? await exportCountryCandidates(values["export-country"])
      : await runExperiment(ExperimentManifest.parse(JSON.parse(readFileSync(values.manifest!, "utf8"))), Number(values["max-calls"]), (partial) =>
          writeFileSync(values.output!, JSON.stringify(partial, null, 2), { mode: 0o600 }),
        );
    writeFileSync(values.output, JSON.stringify(result, null, 2), { mode: 0o600 });
  } finally {
    await closeDb();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
