import { z } from "zod";
import { prefilterUser } from "@amp/backend/editorial/writing";
import { dbOf, type Db } from "../db.ts";
import { requireOwner, type AdminPrincipal } from "./auth.ts";
import { SelectionRunEvidence } from "@amp/contracts/http/private";
import { sha256, stableJson } from "../lib/ids.ts";
import { selectionDatasetManifest } from "./selectbench-samples.ts";
import { selectionStandardSnapshot, currentSelectionModel, selectionModelIdentity, type ModelIdentityPort } from "./selectbench-runtime.ts";
import { SelectionConflict } from "./selectbench-state.ts";
const sql = dbOf("ai-gateway");
export type SelectionEvaluationMetadata = {
  datasetId: string;
  datasetVersion: string;
  synthetic: boolean;
  modelConfigurations: Record<string, string | null>;
  modelConfigurationAfter: Record<string, string | null>;
  cases: Record<string, Array<{ caseId: string; inputHash: string; sampleRevision: number; labelRevision: number; receiptIds: number[] }>>;
};
type Metadata = SelectionEvaluationMetadata & ReturnType<typeof selectionStandardSnapshot> & { origin: "trusted_runner" };
/** Called only by the existing local evaluator, never the HTTP report-upload path. */
export async function recordSelectionEvaluation(runId: string, value: SelectionEvaluationMetadata) {
  const hash = z.string().regex(/^[a-f0-9]{64}$/),
    input = z
      .strictObject({
        datasetId: z.string().min(1),
        datasetVersion: hash,
        synthetic: z.boolean(),
        modelConfigurations: z.record(z.string(), hash.nullable()),
        modelConfigurationAfter: z.record(z.string(), hash.nullable()),
        cases: z.record(
          z.string(),
          z.array(
            z.strictObject({
              caseId: z.string().min(1),
              inputHash: hash,
              sampleRevision: z.number().int().positive(),
              labelRevision: z.number().int().positive(),
              receiptIds: z.array(z.number().int().positive().safe()),
            }),
          ),
        ),
      })
      .parse(value);
  const { text: _text, prefilterText: _prefilter, ...versions } = selectionStandardSnapshot();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO ai.selection_run_evidence(run_id,metadata) VALUES(${runId},${tx.json({ ...versions, ...input, origin: "trusted_runner" } as never)})`;
    const configurations = Object.fromEntries(
      Object.entries(input.modelConfigurations).filter(([key, hash]) => hash && hash === input.modelConfigurationAfter[key]),
    );
    await tx`UPDATE selectbench_runs SET summary=summary||${tx.json({ model_configurations: configurations })} WHERE id=${runId}`;
  });
}
async function rowsFor(runId: string, model: string, db: Db) {
  return db<
    { case_id: string; gold: string; decision: string | null; score: number | null; relevance: string | null; error: string | null }[]
  >`SELECT case_id,gold,decision,score,relevance,error FROM selectbench_results WHERE run_id=${runId} AND model=${model} ORDER BY case_id`;
}
export async function confirmedRunDetails(runId: string, model: string, db: Db) {
  const rows = await rowsFor(runId, model, db);
  let tp = 0,
    tn = 0,
    fp = 0,
    fn = 0;
  for (const r of rows) {
    if (r.gold === "either") continue;
    if (r.gold === "select") {
      if (r.decision === "select") tp++;
      else fn++;
    } else if (r.decision === "reject") tn++;
    else fp++;
  }
  return {
    sampleCount: rows.length,
    accuracy: tp + tn + fp + fn ? (tp + tn) / (tp + tn + fp + fn) : null,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    mistakes: fp + fn,
  };
}
export async function selectionRunEvidence(
  runId: string,
  principal: AdminPrincipal,
  db?: Db,
  modelPort?: ModelIdentityPort,
): Promise<ReturnType<typeof SelectionRunEvidence.parse>> {
  if (!db) return sql.begin((tx) => selectionRunEvidence(runId, principal, tx, modelPort));
  await requireOwner(principal, db);
  return loadSelectionRunEvidence(runId, db, modelPort);
}
export async function loadSelectionRunEvidence(runId: string, db: Db, modelPort?: ModelIdentityPort, requireCurrentMaterials = true) {
  const [run] = await db`SELECT id,split,sample_size,models FROM selectbench_runs WHERE id=${runId}`;
  if (!run) throw new SelectionConflict("校准运行不存在");
  const [stored] = await db<{ metadata: Metadata }[]>`SELECT metadata FROM ai.selection_run_evidence WHERE run_id=${runId}`;
  const meta = stored?.metadata,
    current = selectionStandardSnapshot(),
    model = await currentSelectionModel(db, modelPort),
    missing: string[] = [];
  let dataset: Awaited<ReturnType<typeof selectionDatasetManifest>> | null = null;
  if (meta) {
    try {
      dataset = await selectionDatasetManifest(meta.datasetId, db);
    } catch {
      missing.push("样本集证据不可用");
    }
  } else missing.push("旧报告或上传报告缺少可信评测输入与配置证据");
  if (run.split !== "holdout") missing.push("不是留出集运行");
  if (meta?.synthetic || dataset?.synthetic) missing.push("合成样本不能作为真实校准确认");
  if (
    meta &&
    (meta.standardVersion !== current.standardVersion ||
      meta.contentHash !== current.contentHash ||
      meta.prefilterVersion !== current.prefilterVersion ||
      meta.thresholdVersion !== current.thresholdVersion)
  )
    missing.push("标准、预筛或门槛版本与当前版本不同");
  if (dataset) {
    if (
      dataset.cases.length < 100 ||
      dataset.cases.length > 200 ||
      !dataset.cases.some((c) => c.split === "development") ||
      !dataset.cases.some((c) => c.split === "holdout")
    )
      missing.push("样本集须为100–200条，并分别保留开发集与留出集");
    if (dataset.version !== meta!.datasetVersion) missing.push("样本或Owner标注版本已变化");
    if (dataset.cases.some((c) => (requireCurrentMaterials && !c.current) || !c.label)) missing.push("原材料有变化或尚未全部由Owner标注");
  }
  const models = [];
  for (const key of run.models as string[]) {
    const issues = [...missing],
      hash = meta?.modelConfigurations[key] ?? null;
    if (!hash || hash !== meta?.modelConfigurationAfter[key]) issues.push("缺少一致的实际模型配置身份");
    const actualHash = key === model.model && model.state === "known" ? model.configurationHash : await selectionModelIdentity(key, db);
    if (!actualHash || hash !== actualHash) issues.push("与该评分模型的当前配置不匹配");
    const rows = await rowsFor(runId, key, db),
      expected = dataset?.cases.filter((c) => c.split === "holdout") ?? [],
      manifest = meta?.cases[key] ?? [];
    if (rows.length !== Number(run.sample_size) || rows.length !== expected.length || !rows.length || manifest.length !== rows.length)
      issues.push("逐条结果与完整留出集数量不一致");
    for (const row of rows) {
      const sample = expected.find((c) => c.case_id === row.case_id),
        proof = manifest.find((c) => c.caseId === row.case_id);
      if (
        !sample?.label ||
        !proof ||
        proof.inputHash !== sample.input_hash ||
        proof.sampleRevision !== sample.sample_revision ||
        proof.labelRevision !== sample.label.revision ||
        row.gold !== sample.label.decision
      ) {
        issues.push("样本、标注与运行绑定不一致");
        break;
      }
      if (row.error || !row.decision) {
        issues.push("留出集中仍有失败结果");
        break;
      }
      const ids = [...new Set(proof.receiptIds)];
      if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
        issues.push("缺少完成回执");
        break;
      }
      const receipts = await db<
        { id: string; status: string; purpose: string; request: Record<string, unknown> }[]
      >`SELECT id,status,purpose,request FROM receipts WHERE id=ANY(${ids}::bigint[])`;
      const scores = receipts.filter(
        (r) =>
          r.status === "completed" &&
          r.purpose === "score_article" &&
          r.request.promptVersion === meta!.standardVersion &&
          r.request.userHash === proof.inputHash &&
          r.request.configuration_hash === hash,
      );
      const blocked =
        row.score === null &&
        row.decision === "reject" &&
        row.relevance === "block" &&
        receipts.some(
          (r) =>
            r.status === "completed" &&
            r.purpose === "prefilter_article" &&
            r.request.promptVersion === meta!.prefilterVersion &&
            r.request.userHash ===
              sha256(
                prefilterUser({
                  ...sample.hidden_input,
                  publishedAt: sample.hidden_input.publishedAt ? new Date(String(sample.hidden_input.publishedAt)) : null,
                  discoveredAt: sample.hidden_input.discoveredAt ? new Date(String(sample.hidden_input.discoveredAt)) : null,
                }),
              ),
        );
      if (!blocked && scores.length !== 2) {
        issues.push("评分缺少同一输入、标准与模型配置的两次独立完成回执");
        break;
      }
    }
    const distinct = [...new Set(issues)],
      evidenceHash = sha256(stableJson([runId, key, meta ?? null, dataset?.version ?? null, rows]));
    models.push({ model: key, evidenceHash, confirmable: !distinct.length, missing: distinct });
  }
  return SelectionRunEvidence.parse({
    runId,
    standardVersion: meta?.standardVersion ?? null,
    prefilterVersion: meta?.prefilterVersion ?? null,
    thresholdVersion: meta?.thresholdVersion ?? null,
    modelConfigurations: meta?.modelConfigurations ?? {},
    datasetId: meta?.datasetId ?? null,
    datasetVersion: meta?.datasetVersion ?? null,
    synthetic: meta?.synthetic ?? false,
    origin: meta ? "trusted_runner" : "legacy_or_upload",
    missing: [...new Set(missing)],
    models,
  });
}

/** Worker read port. This is historical, version-bound Owner evidence; it does not grant permission for new sources or change a route. */
export type ApprovedSelectionCalibration = {
  recordId: string;
  runId: string;
  datasetId: string;
  datasetVersion: string;
  standardVersion: string;
  prefilterVersion: string;
  thresholdVersion: string;
  modelKey: string;
  configurationHash: string;
  sampleCount: number;
  metrics: { accuracy: number | null; precision: number | null; recall: number | null; mistakes: number };
  ownerConfirmedAt: string;
  sourceIds: string[];
};
export async function readApprovedSelectionCalibration(
  input: { modelKey: string; configurationHash: string; runId?: string },
  db?: Db,
  modelPort?: ModelIdentityPort,
): Promise<ApprovedSelectionCalibration | null> {
  if (!db) return sql.begin((tx) => readApprovedSelectionCalibration(input, tx, modelPort));
  const current = selectionStandardSnapshot();
  const [standard] =
    await db`SELECT payload FROM ai.selection_records WHERE kind='standard_review' AND payload->>'standardVersion'=${current.standardVersion} AND payload->>'contentHash'=${current.contentHash} AND payload->>'synthetic'='false' ORDER BY created_at DESC,id DESC LIMIT 1`;
  if (standard?.payload.status !== "approved") return null;
  const rows =
    await db`SELECT payload FROM ai.selection_records WHERE kind='holdout' AND payload->>'model'=${input.modelKey} AND payload->>'modelConfigurationHash'=${input.configurationHash} AND payload->>'synthetic'='false' AND (${input.runId ?? null}::text IS NULL OR payload->>'runId'=${input.runId ?? null}) ORDER BY created_at DESC,id DESC`;
  for (const row of rows) {
    const record = row.payload;
    if (
      record.standardVersion !== current.standardVersion ||
      record.contentHash !== current.contentHash ||
      record.prefilterVersion !== current.prefilterVersion ||
      record.thresholdVersion !== current.thresholdVersion
    )
      continue;
    const evidence = await loadSelectionRunEvidence(record.runId, db, modelPort, false),
      model = evidence.models.find((m) => m.model === input.modelKey);
    if (!model?.confirmable) continue;
    const dataset = await selectionDatasetManifest(evidence.datasetId!, db);
    return {
      recordId: record.id,
      runId: record.runId,
      datasetId: evidence.datasetId!,
      datasetVersion: evidence.datasetVersion!,
      standardVersion: record.standardVersion,
      prefilterVersion: record.prefilterVersion,
      thresholdVersion: record.thresholdVersion,
      modelKey: input.modelKey,
      configurationHash: input.configurationHash,
      sampleCount: record.sampleCount,
      metrics: { accuracy: record.accuracy, precision: record.precision, recall: record.recall, mistakes: record.mistakes },
      ownerConfirmedAt: record.at,
      sourceIds: [...new Set(dataset.cases.flatMap((c) => (c.hidden_input.sourceId ? [c.hidden_input.sourceId] : [])))],
    };
  }
  return null;
}
