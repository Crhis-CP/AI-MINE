// One automatic retry after an unknown outcome; uncertainty remains in the cost ledger.
import { sql, type Db } from "../db.ts";
import { audit } from "../admin/auth.ts";
import { requireRuntimeRunning, RuntimeControlPaused, runtimeControlSnapshot } from "../operations/lane-controls.ts";

export const UNKNOWN_AUTO_RELEASE_NOTE = "自动放行：结果未知超过 30 分钟，未核对是否计费";
type Released = {
  id: number;
  service: string;
  model: string | null;
  subject: string | null;
  purpose: string;
  request: unknown;
  attempts: number;
  error: string | null;
};

/** Private gateway helper: claiming, audit and requeue commit atomically. */
export async function recoverUnknownOnce(now: number, resume: (row: Released, db: Db) => Promise<boolean>) {
  const cutoff = new Date(now - 30 * 60_000);
  const [newsProcessing, newsCollection, policyProcessing, policyCollection] = await Promise.all([
    runtimeControlSnapshot("news", ["processing"]),
    runtimeControlSnapshot("news", ["collection"]),
    runtimeControlSnapshot("policy", ["processing"]),
    runtimeControlSnapshot("policy", ["collection"]),
  ]);
  const candidates = await sql<{ id: number }[]>`SELECT r.id FROM receipts r
    WHERE r.status='unknown' AND r.updated_at<${cutoff}
      AND CASE WHEN r.request->>'lane'='policy'
        THEN CASE WHEN r.model IS NULL AND r.service IN ('jina','dajiala') THEN ${!policyCollection.paused} ELSE ${!policyProcessing.paused} END
        ELSE CASE WHEN r.model IS NULL AND r.service IN ('jina','dajiala') THEN ${!newsCollection.paused} ELSE ${!newsProcessing.paused} END END
      AND EXISTS(SELECT 1 FROM receipt_attempts current WHERE current.receipt_id=r.id AND current.attempt=r.attempts AND current.status='unknown')
      AND NOT EXISTS (SELECT 1 FROM ai.model_fallback_resolutions f WHERE f.primary_receipt_id=r.id AND f.backup_receipt_id IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM receipt_attempts current WHERE current.receipt_id=r.id AND current.attempt=r.attempts AND current.failure_kind='provider_refused')
      AND NOT EXISTS (SELECT 1 FROM receipt_attempts a WHERE a.receipt_id=r.id
        AND a.error LIKE ${`${UNKNOWN_AUTO_RELEASE_NOTE}%`})
    ORDER BY r.id LIMIT 200`;
  let released = 0;
  let requeued = 0;
  for (const candidate of candidates) {
    const result = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`receipt-recovery:${candidate.id}`}))`;
      const [row] = await tx<Released[]>`SELECT id,service,model,subject,purpose,request,attempts,error FROM receipts
        WHERE id=${candidate.id} AND status='unknown' AND updated_at<${cutoff} FOR UPDATE`;
      if (!row) return null;
      const [held] =
        await tx`SELECT 1 WHERE EXISTS (SELECT 1 FROM ai.model_fallback_resolutions f WHERE f.primary_receipt_id=${row.id} AND f.backup_receipt_id IS NOT NULL)
        OR EXISTS (SELECT 1 FROM receipt_attempts a WHERE a.receipt_id=${row.id} AND a.attempt=${row.attempts} AND a.failure_kind='provider_refused')`;
      if (held) return null;
      const lane = row.request && typeof row.request === "object" && "lane" in row.request && row.request.lane === "policy" ? "policy" : "news";
      // An intentional pause must retain the one recovery opportunity until that lane can actually continue.
      if (lane === "news" || lane === "policy") {
        try {
          await requireRuntimeRunning(lane, [!row.model && ["jina", "dajiala"].includes(row.service) ? "collection" : "processing"], tx);
        } catch (error) {
          if (error instanceof RuntimeControlPaused) return null;
          throw error;
        }
      }
      const [prior] = await tx`SELECT 1 FROM receipt_attempts a WHERE a.receipt_id=${row.id}
        AND a.error LIKE ${`${UNKNOWN_AUTO_RELEASE_NOTE}%`} LIMIT 1`;
      if (prior) return null;
      const note = `${UNKNOWN_AUTO_RELEASE_NOTE}；原错误：${row.error ?? "未记录"}`;
      // Mark the original attempt, retaining unknown status, unknown cost and its reserved exposure.
      const marked = await tx`UPDATE receipt_attempts SET error=${note}
        WHERE receipt_id=${row.id} AND attempt=(SELECT attempts FROM receipts WHERE id=${row.id}) AND status='unknown'`;
      if (!marked.count) return null;
      await tx`UPDATE receipts SET status='failed',error=${note},updated_at=now() WHERE id=${row.id}`;
      const queued = await resume(row, tx);
      await audit(
        "ops.recover",
        "receipt.release",
        `receipt:${row.id}`,
        UNKNOWN_AUTO_RELEASE_NOTE,
        { status: "unknown", attempts: row.attempts, error: row.error },
        { status: "failed", billed: null, automatic: true, requeued: queued },
        undefined,
        tx,
      );
      return queued;
    });
    if (result !== null) {
      released++;
      if (result) requeued++;
    }
  }
  return { released, requeued };
}
