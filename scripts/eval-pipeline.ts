import {
  PipelineReportSchema as Report,
  quality,
  sameCases,
  comparePipelineReports,
  stableConfigurations,
  writePipelineCheckpoint,
  STEPS,
  type PipelineReport,
  type CaseResult,
} from "./eval-pipeline-core.ts";
// Internal fixed-case evaluation: production model steps, no publication writes or rule activation.
import { closeSync, openSync, readFileSync } from "node:fs";
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
  closeSync(openSync(options.output, "wx", 0o600));
  const report = initial;
  const save = (comparison: ReturnType<typeof comparePipelineReports> | null = null) => {
    const text = JSON.stringify({ ...report, quality: quality(report.cases), comparison }, null, 2);
    writePipelineCheckpoint(options.output, text);
  };
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
      phase = "models";
      const run = waitsForPage(input) ? null : await runAnalysis(input, { fallbackInput, usagePurpose: "evaluation", runtimeControl: controls });
      if (!run) {
        row.error = "waiting_body";
        row.stepReceiptsComplete = true;
        row.reused = true;
      } else {
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
      }
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
