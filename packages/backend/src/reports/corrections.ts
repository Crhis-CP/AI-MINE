import type { PgBoss } from "pg-boss";
import { sql, type Db } from "../db.ts";
import { stableJson } from "../lib/ids.ts";
import { ensureQueue, recordRun } from "../jobs/queue.ts";
import { enqueueJob as enqueue, work } from "../jobs/module-queues.ts";
import { currentReportPublications, lockReportPublications } from "@amp/backend/publication/publish";
import { readCurrentSourcePolicy, lockCurrentSourcePolicies } from "@amp/backend/admin/sources";
import { isReportWithdrawn } from "@amp/backend/publication/reports";
import { completeReceipt } from "../providers/receipts.ts";
import { requireRuntimeRunning, assertRuntimeControl } from "../operations/lane-controls.ts";
import { reportMemberIds, type StoredReportContent } from "./references.ts";
import { generateReportCorrection } from "./correction-compose.ts";

export const REPORT_CORRECTION_QUEUE = "reports.correct";
export async function ensureReportCorrectionQueue() {
  await ensureQueue(REPORT_CORRECTION_QUEUE, { policy: "exclusive", retryLimit: 0, expireInSeconds: 900 });
}
export type CorrectionReason = "manual_correction" | "withdrawal" | "restoration";
const publicReason: Record<CorrectionReason, string> = {
  manual_correction: "引用报道已更正，本期内容随之更新。",
  withdrawal: "部分引用已撤回，本期仅保留仍可公开的内容。",
  restoration: "引用报道的公开状态已恢复，本期内容已重新核对。",
};
type Report = {
  id: number;
  kind: "daily" | "weekly" | "monthly";
  key: string;
  revision: number;
  content: StoredReportContent;
  generated_at: Date;
  window_start: Date;
  window_end: Date;
};
const corrections = (content: StoredReportContent) =>
  Array.isArray(content.corrections) ? (content.corrections as Array<{ revision: number; reason: string; at: string }>) : [];

/** Same transaction as the editorial change: immediately invalidates old synthesis and durably queues repair. */
export async function invalidateReportCorrections(db: Db, itemIds: string[], reason: CorrectionReason) {
  if (!itemIds.length) return 0;
  const rows = await db<Report[]>`SELECT id,kind,key,revision,content,generated_at,window_start,window_end FROM reports ORDER BY id FOR UPDATE`;
  let changed = 0;
  for (const report of rows) {
    if (!reportMemberIds(report.content).some((id) => itemIds.includes(id))) continue;
    const revision = report.revision + 1;
    const content = {
      ...report.content,
      sourceMemberIds: reportMemberIds(report.content),
      ...(report.kind === "daily"
        ? {
            sourceStructure: report.content.sourceStructure ?? {
              sections: report.content.sections ?? [],
              flashes: report.content.flashes ?? [],
              ...(typeof report.content.leadItemId === "string" ? { leadItemId: report.content.leadItemId } : {}),
              ...(Array.isArray(report.content.highlights)
                ? { highlights: report.content.highlights.filter((id): id is string => typeof id === "string") }
                : {}),
            },
          }
        : {}),
      correctionPending: true,
      generationStatus: "pending",
      corrections: [...corrections(report.content), { revision, reason: publicReason[reason], at: new Date().toISOString() }],
    };
    await db`INSERT INTO report_revisions(report_id,revision,content,generated_at,reason) VALUES(${report.id},${report.revision},${db.json(report.content as never)},${report.generated_at},${publicReason[reason]}) ON CONFLICT DO NOTHING`;
    await db`UPDATE reports SET revision=${revision},content=${db.json(content)},updated_at=now() WHERE id=${report.id}`;
    await db`INSERT INTO reports.correction_jobs(report_id,requested_revision,state,reason_code) VALUES(${report.id},${revision},'pending',${reason})
      ON CONFLICT(report_id) DO UPDATE SET requested_revision=EXCLUDED.requested_revision,state='pending',reason_code=EXCLUDED.reason_code,last_error=NULL,updated_at=now()`;
    await ensureReportCorrectionQueue();
    await enqueue(REPORT_CORRECTION_QUEUE, { reportId: String(report.id), lane: "news" }, { singletonKey: `${report.id}:${revision}` }, db);
    changed++;
  }
  return changed;
}

export async function correctNewsReport(reportId: string) {
  const [report] = await sql<Report[]>`SELECT id,kind,key,revision,content,generated_at,window_start,window_end FROM reports WHERE id=${reportId}`;
  const [job] = await sql<
    { requested_revision: number; state: string; reason_code: CorrectionReason }[]
  >`SELECT requested_revision,state,reason_code FROM reports.correction_jobs WHERE report_id=${reportId}`;
  if (!report || !job || job.state === "done" || !report.content.correctionPending) return { status: "current" as const };
  if (await isReportWithdrawn("news", report.kind, report.key)) return { status: "withdrawn" as const };
  const ids = reportMemberIds(report.content);
  const entries = await currentReportPublications(ids);
  const expected = stableJson(entries);
  try {
    const control = await requireRuntimeRunning("news", report.kind === "daily" ? ["publication"] : ["publication", "processing"]);
    const permissions = await Promise.all(
      [...new Set(entries.map((e) => e.sourceId))].sort().map(async (sourceId) => {
        const policy = await readCurrentSourcePolicy(sourceId);
        if (!policy) throw new Error("Report source permission missing");
        return { sourceId, permissionVersion: policy.permission_version };
      }),
    );
    await sql`UPDATE reports.correction_jobs SET state='running',updated_at=now() WHERE report_id=${report.id} AND requested_revision=${report.revision}`;
    const generated = await generateReportCorrection(report, entries);
    const generatedModel = generated.model;
    const saved = await sql.begin(async (tx) => {
      await assertRuntimeControl(tx, control);
      await lockCurrentSourcePolicies(tx, permissions);
      await tx`SELECT pg_advisory_xact_lock(hashtext('report_candidates'))`;
      await lockReportPublications(ids, tx);
      const current = await currentReportPublications(ids, tx);
      const [latest] = await tx<{ revision: number }[]>`SELECT revision FROM reports WHERE id=${report.id} FOR UPDATE`;
      if (latest?.revision !== report.revision || stableJson(current) !== expected) return false;
      const revision = report.revision + 1;
      const content = {
        ...generated.content,
        corrections: [...corrections(report.content), { revision, reason: "已依据当前公开报道完成本期更正。", at: new Date().toISOString() }],
      };
      await tx`INSERT INTO report_revisions(report_id,revision,content,generated_at,reason) VALUES(${report.id},${report.revision},${tx.json(report.content as never)},${report.generated_at},'更正后的报告已生成') ON CONFLICT DO NOTHING`;
      await tx`UPDATE reports SET content=${tx.json(content as never)},revision=${revision},model=${generatedModel},origin=${generatedModel ? "model" : "rule"},generated_at=now(),updated_at=now() WHERE id=${report.id}`;
      await tx`UPDATE reports.correction_jobs SET state='done',last_error=NULL,updated_at=now() WHERE report_id=${report.id} AND requested_revision=${report.revision}`;
      if (generated.receiptId) await completeReceipt(tx, generated.receiptId);
      return true;
    });
    return { status: saved ? ("corrected" as const) : ("stale" as const) };
  } catch (error) {
    await sql.begin(async (tx) => {
      const updated = await tx`UPDATE reports.correction_jobs SET state='blocked',last_error=${error instanceof Error ? error.name : "Error"},updated_at=now()
        WHERE report_id=${report.id} AND requested_revision=${report.revision}`;
      if (updated.count)
        await tx`UPDATE reports SET content=jsonb_set(content,'{generationStatus}','"failed"'::jsonb),updated_at=now() WHERE id=${report.id} AND revision=${report.revision}`;
    });
    throw error;
  }
}

/** Retry the same durable repair after a control pause or receipt reconciliation; the gateway still refuses unknown bills. */
export async function enqueuePendingReportCorrections(limit = 20) {
  await ensureReportCorrectionQueue();
  const rows = await sql<{ report_id: number; requested_revision: number }[]>`SELECT report_id,requested_revision FROM reports.correction_jobs
    WHERE state IN ('pending','blocked','running') AND updated_at<now()-interval '5 minutes' ORDER BY updated_at LIMIT ${limit}`;
  for (const row of rows)
    await enqueue(REPORT_CORRECTION_QUEUE, { reportId: String(row.report_id), lane: "news" }, { singletonKey: `${row.report_id}:${row.requested_revision}` });
  return { queued: rows.length };
}

export async function registerReportCorrectionJobs(boss: PgBoss) {
  await ensureReportCorrectionQueue();
  await work(
    boss,
    REPORT_CORRECTION_QUEUE,
    { localConcurrency: 1, pollingIntervalSeconds: 2 },
    async () => "news",
    async (data) => {
      if (typeof data.reportId !== "string" || !/^[1-9]\d*$/.test(data.reportId)) throw new Error("Invalid report correction task");
      return recordRun(REPORT_CORRECTION_QUEUE, () => correctNewsReport(data.reportId));
    },
  );
}
