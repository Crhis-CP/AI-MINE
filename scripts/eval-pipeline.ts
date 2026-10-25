// Internal fixed-case evaluation: production model steps, no publication writes or rule activation.
import { z } from "zod";
import { closeSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeSync } from "node:fs";
import { parseArgs } from "node:util";
import { closeDb, initializeDb } from "@amp/backend/db";
import { selectionDatasetManifest } from "@amp/backend/admin/selectbench";
import { currentModelConfiguration } from "@amp/backend/admin/models";
import {
  ANALYZE_PROMPT_VERSION,
  SELECTION_PROMPT_VERSION,
  scoringConfirmed,
  evaluationInputFingerprint,
  normalizeAnalysis,
  prepareEvaluationInput,
  runAnalysis,
  waitsForPage,
} from "@amp/backend/editorial/analyze";
import { runtimeControlSnapshot } from "@amp/backend/operations/lane-controls";
import { SELECTION } from "@amp/industry/selection";
import { sha256, stableJson } from "@amp/backend/lib/ids";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const Case = z.object({
  caseId: z.string().min(1),
  materialId: z.string().min(1),
  revision: z.number().int().positive(),
  inputHash: hash,
  url: z.string(),
  title: z.string(),
  reference: z.object({ decision: z.enum(["select", "reject", "either"]), revision: z.number().int().positive(), actor: z.string() }).nullable(),
  decision: z.enum(["select", "reject"]).nullable(),
  score: z.number().nullable(),
  jurisdictions: z.array(z.string()).nullable(),
  titleZh: z.string().nullable(),
  reason: z.string().nullable(),
  prefilterReason: z.string().nullable(),
  geographyReason: z.string().nullable(),
  models: z.array(z.string()),
  receiptIds: z.array(z.number().int().positive().safe()),
  stepReceiptsComplete: z.boolean(),
  reused: z.boolean().nullable(),
  error: z.string().nullable(),
});
const Routes = z.record(
  z.string(),
  z.object({ key: z.string(), service: z.string().nullable(), requestedModel: z.string().nullable(), configuration: hash.nullable() }),
);
const Report = z.object({
  format: z.literal("article-analysis-evaluation-v1"),
  datasetId: z.string(),
  datasetVersion: hash,
  inputManifest: hash,
  ruleHash: hash,
  promptVersion: z.string(),
  release: z.string(),
  synthetic: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  expectedCases: z.number().int().positive(),
  executionComplete: z.boolean(),
  configurationSnapshotsMatch: z.boolean(),
  modelStart: Routes,
  modelEnd: Routes.nullable(),
  stopReason: z.string().nullable(),
  cases: z.array(Case),
});
export type PipelineReport = z.infer<typeof Report>;
type CaseResult = z.infer<typeof Case>;

function quality(cases: CaseResult[]) {
  const rows = cases.filter((c) => !c.error && c.decision && c.reference && c.reference.decision !== "either");
  return {
    referencedCases: rows.length,
    falseNegatives: rows.length ? rows.filter((c) => c.reference!.decision === "select" && c.decision === "reject").length : null,
    falsePositives: rows.length ? rows.filter((c) => c.reference!.decision === "reject" && c.decision === "select").length : null,
  };
}
function sameCases(before: PipelineReport, after: PipelineReport) {
  const identities = (report: PipelineReport) =>
    report.cases.map((c) => [c.caseId, c.materialId, c.revision, c.inputHash, c.reference]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  if (
    !before.executionComplete ||
    before.cases.length !== before.expectedCases ||
    after.expectedCases !== before.expectedCases ||
    after.cases.length !== after.expectedCases ||
    new Set(before.cases.map((c) => c.caseId)).size !== before.cases.length ||
    before.synthetic !== after.synthetic ||
    before.datasetId !== after.datasetId ||
    before.datasetVersion !== after.datasetVersion ||
    before.inputManifest !== after.inputManifest ||
    before.ruleHash !== after.ruleHash ||
    stableJson(identities(before)) !== stableJson(identities(after))
  )
    throw new Error("评测基线的样本、输入或规则不一致");
}
export function comparePipelineReports(beforeValue: unknown, afterValue: unknown) {
  const before = Report.parse(beforeValue),
    after = Report.parse(afterValue);
  sameCases(before, after);
  if (!after.executionComplete || !stableConfigurations(before) || !stableConfigurations(after)) throw new Error("评测未执行完毕或模型配置未确认稳定");
  const old = new Map(before.cases.map((c) => [c.caseId, c]));
  const changes: Array<{
    caseId: string;
    url: string;
    addedCandidate: boolean;
    removedCandidate: boolean;
    jurisdictionsBefore: string[] | null;
    jurisdictionsAfter: string[] | null;
  }> = [];
  const incomparable: string[] = [];
  for (const current of after.cases) {
    const previous = old.get(current.caseId)!;
    if (previous.error || current.error || previous.decision === null || current.decision === null) {
      incomparable.push(current.caseId);
      continue;
    }
    const jurisdictionsChanged =
      previous.jurisdictions !== null && current.jurisdictions !== null && stableJson(previous.jurisdictions) !== stableJson(current.jurisdictions);
    if (previous.decision !== current.decision || jurisdictionsChanged)
      changes.push({
        caseId: current.caseId,
        url: current.url,
        addedCandidate: previous.decision === "reject" && current.decision === "select",
        removedCandidate: previous.decision === "select" && current.decision === "reject",
        jurisdictionsBefore: previous.jurisdictions,
        jurisdictionsAfter: current.jurisdictions,
      });
  }
  return { changes, incomparable, before: quality(before.cases), after: quality(after.cases) };
}
const STEPS = ["prefilter", "score", "structure", "understand", "summarize", "wording"] as const;
function stableConfigurations(report: PipelineReport) {
  return !!report.modelEnd && STEPS.every((step) => !!report.modelStart[step]?.configuration) && stableJson(report.modelStart) === stableJson(report.modelEnd);
}
async function modelRoutes() {
  return Object.fromEntries(
    await Promise.all(
      STEPS.map(async (step) => {
        const model = await currentModelConfiguration(step);
        return [step, { key: model.key, service: model.service, requestedModel: model.requestedModel, configuration: model.configuration_hash }];
      }),
    ),
  );
}

export async function evaluatePipeline(options: { dataset: string; output: string; baseline?: string }) {
  const dataset = await selectionDatasetManifest(options.dataset);
  if (!dataset.cases.length || dataset.cases.length > 200 || dataset.cases.some((c) => !c.current))
    throw new Error("样本为空、超出已有样本库范围或原材料已变化");
  const identities = dataset.cases.map((c) => ({
    caseId: c.case_id,
    materialId: c.material_id,
    revision: c.material_revision,
    inputHash: evaluationInputFingerprint(c.hidden_input),
  }));
  const emptyCases: CaseResult[] = dataset.cases.map((c, i) => ({
    ...identities[i]!,
    url: c.hidden_input.url,
    title: c.hidden_input.title,
    reference: c.label ? { decision: c.label.decision, revision: c.label.revision, actor: c.label.actor } : null,
    decision: null,
    score: null,
    jurisdictions: null,
    titleZh: null,
    reason: null,
    prefilterReason: null,
    geographyReason: null,
    models: [],
    receiptIds: [],
    stepReceiptsComplete: false,
    reused: null,
    error: "not_run",
  }));
  const initial: PipelineReport = {
    format: "article-analysis-evaluation-v1",
    datasetId: dataset.id,
    datasetVersion: dataset.version,
    inputManifest: sha256(stableJson(identities)),
    ruleHash: sha256(stableJson([SELECTION, SELECTION_PROMPT_VERSION, scoringConfirmed()])),
    promptVersion: ANALYZE_PROMPT_VERSION,
    release: process.env.AMP_RELEASE ?? "dev",
    synthetic: dataset.synthetic,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    expectedCases: emptyCases.length,
    executionComplete: false,
    configurationSnapshotsMatch: false,
    modelStart: {},
    modelEnd: null,
    stopReason: null,
    cases: emptyCases,
  };
  const baseline = options.baseline ? Report.parse(JSON.parse(readFileSync(options.baseline, "utf8"))) : null;
  if (baseline) {
    sameCases(baseline, initial);
    if (!stableConfigurations(baseline)) throw new Error("基线模型配置未确认稳定");
  }
  const controls = await runtimeControlSnapshot("news", ["processing"]);
  if (controls.paused) throw new Error("处理已暂停，评测没有开始");
  initial.modelStart = await modelRoutes();
  // Reserve the destination before paid work; an old report (including the baseline) cannot be overwritten.
  const fd = openSync(options.output, "wx", 0o600);
  const report = initial;
  const save = (comparison: ReturnType<typeof comparePipelineReports> | null = null) => {
    const text = JSON.stringify({ ...report, quality: quality(report.cases), comparison }, null, 2);
    ftruncateSync(fd, 0);
    if (writeSync(fd, text, 0, "utf8") !== Buffer.byteLength(text)) throw new Error("评测报告未完整写入，停止后续请求");
    fsyncSync(fd);
  };
  try {
    save();
    for (let i = 0; i < dataset.cases.length; i++) {
      const currentControl = await runtimeControlSnapshot("news", ["processing"]);
      if (currentControl.paused || currentControl.version !== controls.version) {
        report.stopReason = "processing_control_changed";
        break;
      }
      const sample = dataset.cases[i]!,
        row = report.cases[i]!;
      let phase = "input";
      try {
        const { input, fallbackInput } = await prepareEvaluationInput(sample.hidden_input, row.inputHash);
        if (waitsForPage(input)) {
          row.error = "waiting_body";
          row.stepReceiptsComplete = true;
          row.reused = true;
          save();
          continue;
        }
        phase = "models";
        const run = await runAnalysis(input, { fallbackInput, usagePurpose: "evaluation", runtimeControl: controls });
        row.receiptIds = [
          ...new Set([
            ...(run.prefilter ? [run.prefilter.receiptId] : []),
            ...(run.scores?.receiptIds ?? []),
            ...(run.writing?.receiptIds ?? []),
            ...(run.structure ? [run.structure.receiptId] : []),
          ]),
        ];
        row.stepReceiptsComplete = true;
        // A changed/revoked material keeps billing evidence, but its model payload never enters the report.
        phase = "recheck";
        await prepareEvaluationInput(sample.hidden_input, row.inputHash);
        const out = normalizeAnalysis(run);
        row.decision = out.relevance === "block" ? "reject" : out.score === null ? null : out.selected ? "select" : "reject";
        row.score = out.score;
        row.jurisdictions = out.geography && out.geography.state !== "unknown" ? [...out.geography.codes].sort() : null;
        row.titleZh = out.titleZh || null;
        row.reason = out.reasonZh;
        row.prefilterReason = run.prefilter?.reason ?? null;
        row.geographyReason = out.geography?.reason ?? null;
        row.models = [
          ...new Set(
            [run.prefilter?.model, run.scores?.model, ...(run.scores?.models ?? []), run.writing?.model, run.structure?.model].filter((m): m is string => !!m),
          ),
        ];
        row.reused = (run.prefilter?.reused ?? true) && (run.scores?.reused ?? true) && (run.writing?.reused ?? true) && (run.structure?.reused ?? true);
        row.error = row.decision === null ? (run.prefilter === null ? "waiting_material" : "unscored") : null;
      } catch (error) {
        row.error = `${phase}:${error instanceof Error ? error.name : "Error"}`;
        if (
          error &&
          typeof error === "object" &&
          "receiptId" in error &&
          typeof error.receiptId === "number" &&
          Number.isSafeInteger(error.receiptId) &&
          Number(error.receiptId) > 0
        )
          row.receiptIds = [...new Set([...row.receiptIds, Number(error.receiptId)])];
      }
      save();
    }
    report.executionComplete = report.cases.every((c) => c.error !== "not_run");
    report.modelEnd = await modelRoutes();
    report.configurationSnapshotsMatch = stableConfigurations(report);
    report.finishedAt = new Date().toISOString();
    save();
    const comparison = baseline && report.executionComplete && report.configurationSnapshotsMatch ? comparePipelineReports(baseline, report) : null;
    save(comparison);
    return { ...report, comparison };
  } finally {
    closeSync(fd);
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { dataset: { type: "string" }, output: { type: "string" }, baseline: { type: "string" } } });
  if (!values.dataset || !values.output) throw new Error("需要 --dataset 和新的 --output 文件；--baseline 可选");
  await initializeDb("worker");
  try {
    const report = await evaluatePipeline({ dataset: values.dataset, output: values.output, baseline: values.baseline });
    console.log(
      JSON.stringify({
        report: values.output,
        cases: report.cases.length,
        complete: report.executionComplete,
        errors: report.cases.filter((c) => c.error).length,
      }),
    );
    if (!report.executionComplete || !report.configurationSnapshotsMatch || report.cases.some((c) => c.error)) process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
