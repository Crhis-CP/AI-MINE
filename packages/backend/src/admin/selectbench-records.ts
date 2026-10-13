import { randomUUID } from "node:crypto";
import { z } from "zod";
import { dbOf, type Db } from "../db.ts";
import { requireOwner, audit, type AdminPrincipal } from "./auth.ts";
import { SelectionStandardReview, SelectionSubmission, SelectionRecord, SelectionStandards, SelectionHoldoutConfirm } from "@amp/contracts/http/private";
import { selectionCommand, SelectionConflict, toolState } from "./selectbench-state.ts";
import { selectionStandardSnapshot, currentSelectionModel, type ModelIdentityPort } from "./selectbench-runtime.ts";
import { selectionRunEvidence, loadSelectionRunEvidence, confirmedRunDetails } from "./selectbench-evidence.ts";
const sql = dbOf("ai-gateway");
export async function submitSelectionStandard(value: unknown) {
  const input = z.strictObject({ materialReference: z.string().trim().min(1), changeNote: z.string(), synthetic: z.boolean().default(false) }).parse(value),
    current = selectionStandardSnapshot(),
    id = randomUUID();
  const [row] =
    await sql`INSERT INTO ai.selection_submissions(id,standard_version,content_hash,prefilter_version,threshold_version,material_reference,change_note,synthetic)
 VALUES(${id},${current.standardVersion},${current.contentHash},${current.prefilterVersion},${current.thresholdVersion},${input.materialReference},${input.changeNote},${input.synthetic}) RETURNING submitted_at`;
  return { id, submittedAt: row!.submitted_at.toISOString() };
}
async function submissionFor(id: string | undefined, db: Db) {
  const snapshot = selectionStandardSnapshot();
  const [row] = id
    ? await db`SELECT * FROM ai.selection_submissions WHERE id=${id}`
    : await db`SELECT * FROM ai.selection_submissions WHERE standard_version=${snapshot.standardVersion} AND content_hash=${snapshot.contentHash} ORDER BY submitted_at DESC,id DESC LIMIT 1`;
  return row
    ? SelectionSubmission.parse({
        id: row.id,
        standardVersion: row.standard_version,
        contentHash: row.content_hash,
        prefilterVersion: row.prefilter_version,
        thresholdVersion: row.threshold_version,
        submittedAt: row.submitted_at.toISOString(),
        materialReference: row.material_reference,
        changeNote: row.change_note,
        synthetic: row.synthetic,
      })
    : null;
}
export async function appendSelectionRecord(payload: Record<string, unknown>, principal: AdminPrincipal, db: Db) {
  const fields = {
    submissionId: null,
    runId: null,
    model: null,
    modelConfigurationHash: null,
    sampleCount: null,
    accuracy: null,
    precision: null,
    recall: null,
    mistakes: null,
    ...payload,
    id: randomUUID(),
    actor: `account:${principal.userId}`,
    at: new Date().toISOString(),
  };
  const record = SelectionRecord.parse(Object.fromEntries(Object.keys(SelectionRecord.shape).map((key) => [key, fields[key as keyof typeof fields]])));
  await db`INSERT INTO ai.selection_records(id,kind,payload) VALUES(${record.id},${record.kind},${db.json(record)})`;
  await audit(record.actor, `selection.${record.kind}`, record.id, record.note, null, record, undefined, db);
  return record;
}
export async function reviewSelectionStandard(value: unknown, principal: AdminPrincipal) {
  const input = SelectionStandardReview.parse(value);
  return selectionCommand(principal, "standard-review", input, async (tx) => {
    const submission = await submissionFor(input.submissionId, tx),
      current = selectionStandardSnapshot();
    if (
      !submission ||
      submission.standardVersion !== input.standardVersion ||
      submission.contentHash !== input.contentHash ||
      input.standardVersion !== current.standardVersion ||
      input.contentHash !== current.contentHash ||
      submission.prefilterVersion !== current.prefilterVersion
    )
      throw new SelectionConflict("提交材料或当前评分标准版本已变化，请重新阅读对应版本");
    return appendSelectionRecord(
      { ...submission, submissionId: submission.id, kind: "standard_review", status: input.decision, note: input.note, id: randomUUID() },
      principal,
      tx,
    );
  });
}
export async function confirmSelectionHoldout(value: unknown, principal: AdminPrincipal, modelPort?: ModelIdentityPort) {
  const input = SelectionHoldoutConfirm.parse(value);
  return selectionCommand(principal, "holdout", input, async (tx) => {
    const evidence = await selectionRunEvidence(input.runId, principal, tx, modelPort),
      model = evidence.models.find((m) => m.model === input.model);
    if (!model?.confirmable || model.evidenceHash !== input.evidenceHash) throw new SelectionConflict("留出集证据尚不齐全或已变化，请刷新后核对");
    const current = selectionStandardSnapshot(),
      detail = await confirmedRunDetails(input.runId, input.model, tx);
    const approved =
      await tx`SELECT payload FROM ai.selection_records WHERE kind='standard_review' AND payload->>'standardVersion'=${current.standardVersion} AND payload->>'contentHash'=${current.contentHash} ORDER BY created_at DESC,id DESC LIMIT 1`;
    if (approved[0]?.payload.status !== "approved" || approved[0]?.payload.synthetic)
      throw new SelectionConflict("须先取得同一评分标准版本的真实Owner通过记录");
    return appendSelectionRecord(
      {
        ...current,
        kind: "holdout",
        status: "confirmed",
        runId: input.runId,
        model: input.model,
        modelConfigurationHash: evidence.modelConfigurations[input.model] ?? null,
        note: input.note,
        synthetic: evidence.synthetic,
        ...detail,
      },
      principal,
      tx,
    );
  });
}
export async function selectionStandards(principal: AdminPrincipal, modelPort?: ModelIdentityPort) {
  return sql.begin(async (tx) => {
    await requireOwner(principal, tx);
    const current = { ...selectionStandardSnapshot(), model: await currentSelectionModel(tx, modelPort) },
      tool = await toolState(tx),
      submission = await submissionFor(undefined, tx);
    const rows = await tx`SELECT payload FROM ai.selection_records ORDER BY created_at DESC,id DESC LIMIT 100`;
    const records = rows.map((r) => SelectionRecord.parse(r.payload)),
      review = records.find((r) => r.kind === "standard_review" && r.standardVersion === current.standardVersion && r.contentHash === current.contentHash);
    const ownerStandardReview = !!review && !review.synthetic && review.status === "approved";
    const holdout = records.find(
      (r) =>
        r.kind === "holdout" &&
        !r.synthetic &&
        r.standardVersion === current.standardVersion &&
        r.contentHash === current.contentHash &&
        r.thresholdVersion === current.thresholdVersion &&
        r.prefilterVersion === current.prefilterVersion &&
        r.model === current.model.model &&
        r.modelConfigurationHash === current.model.configurationHash,
    );
    let ownerHoldout = false;
    if (holdout?.runId) {
      const evidence = await loadSelectionRunEvidence(holdout.runId, tx, modelPort, false);
      ownerHoldout = !!evidence.models.find((m) => m.model === holdout.model)?.confirmable;
    }
    const versionsMatch = ownerStandardReview && ownerHoldout && current.configuredForCurrent && current.model.state === "known";
    const missing = [
      ...(!ownerStandardReview ? ["缺少当前评分标准版本的Owner通过记录"] : []),
      ...(!ownerHoldout ? ["缺少与当前版本、样本和模型匹配的Owner留出集确认"] : []),
      ...(!current.configuredForCurrent ? ["受控生效配置未指向当前评分标准"] : []),
      ...(current.model.state !== "known" ? ["当前评分模型配置身份尚不可核实"] : []),
    ];
    const runs = await tx<
      {
        id: string;
        label: string;
        split: string | null;
        sample_size: number;
        models: string[];
        summary: Record<string, Record<string, number>>;
        created_at: Date;
        metadata: Record<string, unknown> | null;
      }[]
    >`SELECT r.id,r.label,r.split,r.sample_size,r.models,r.summary,r.created_at,e.metadata FROM selectbench_runs r LEFT JOIN ai.selection_run_evidence e ON e.run_id=r.id ORDER BY r.created_at DESC,r.id LIMIT 20`;
    const metric = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : null);
    const calibrations = runs.flatMap((run) =>
      run.models.map((model) => {
        const m = run.metadata as {
            standardVersion?: string;
            prefilterVersion?: string;
            thresholdVersion?: string;
            modelConfigurations?: Record<string, string | null>;
            datasetVersion?: string;
            synthetic?: boolean;
          } | null,
          s = run.summary[model] ?? {},
          confirmed = records.find((r) => r.kind === "holdout" && r.runId === run.id && r.model === model);
        return {
          runId: run.id,
          label: run.label,
          split: run.split,
          sampleCount: run.sample_size >= 0 ? run.sample_size : null,
          model,
          standardVersion: m?.standardVersion ?? null,
          prefilterVersion: m?.prefilterVersion ?? null,
          thresholdVersion: m?.thresholdVersion ?? null,
          modelConfigurationHash: m?.modelConfigurations?.[model] ?? null,
          datasetVersion: m?.datasetVersion ?? null,
          accuracy: metric(s.accuracy),
          precision: metric(s.precision),
          recall: metric(s.recall),
          mistakes: Number.isInteger(s.fp) && Number.isInteger(s.fn) && s.fp! >= 0 && s.fn! >= 0 ? s.fp! + s.fn! : null,
          ranAt: run.created_at.toISOString(),
          ownerConfirmedAt: confirmed?.at ?? null,
          synthetic: m?.synthetic ?? false,
          origin: m ? "trusted_runner" : "legacy_or_upload",
        };
      }),
    );
    return SelectionStandards.parse({
      tool,
      current,
      submission,
      reviewStatus: review?.status === "confirmed" ? "draft" : (review?.status ?? (submission ? "submitted" : "draft")),
      records,
      calibrations,
      checks: { ownerStandardReview, ownerHoldout, versionsMatch, ready: versionsMatch },
      missing,
    });
  });
}
