import { dbOf, type Tx } from "../db.ts";
import { audit } from "../admin/auth.ts";
import { requireRuntimeRunning, RuntimeControlPaused } from "../operations/lane-controls.ts";

const sql = dbOf("ai-gateway");
const NOTE = "自动放行：结果未知超过 30 分钟，未核对是否计费";
const PURPOSES = ["prefilter_article", "score_article", "understand_article", "summarize_article", "structure_article"];
type Released = { id: number; subject: string | null; purpose: string; attempts: number; error: string | null };

/** Incident scope: one recovery for news analysis, retaining every uncertain attempt and charge. */
export async function recoverUnknownNewsOnce(now: number, resume: (row: Released, db: Tx) => Promise<boolean>) {
  const cutoff = new Date(now - 30 * 60_000);
  const candidates = await sql<Pick<Released, "id" | "purpose" | "subject">[]>`SELECT r.id,r.purpose,r.subject FROM receipts r
    WHERE r.status='unknown' AND r.updated_at<${cutoff} AND r.purpose=ANY(${PURPOSES}::text[])
      AND coalesce(r.request->>'lane','news')='news'
      AND r.subject ~ '^article:[a-zA-Z0-9_-]+@[1-9][0-9]*$'
      AND NOT EXISTS (SELECT 1 FROM receipt_attempts a JOIN receipts prior ON prior.id=a.receipt_id
        WHERE prior.subject=r.subject AND prior.purpose=r.purpose AND coalesce(prior.request->>'lane','news')='news'
          AND a.error LIKE ${`${NOTE}%`})
    ORDER BY r.id LIMIT 200`;
  let released = 0;
  let requeued = 0;
  for (const candidate of candidates) {
    const result = await sql.begin(async (tx) => {
      // The model identity may change the receipt key; the recovery allowance belongs to the material stage.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`news-receipt:${candidate.purpose}:${candidate.subject}`}))`;
      const [row] = await tx<Released[]>`SELECT id,subject,purpose,attempts,error FROM receipts
        WHERE id=${candidate.id} AND status='unknown' AND updated_at<${cutoff} FOR UPDATE`;
      if (!row) return null;
      // Match paidRequest's receipt-before-control lock order; a pause preserves the opportunity.
      try {
        await requireRuntimeRunning("news", ["processing"], tx);
      } catch (error) {
        if (error instanceof RuntimeControlPaused) return null;
        throw error;
      }
      const [prior] = await tx`SELECT 1 FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id
        WHERE r.subject=${row.subject} AND r.purpose=${row.purpose} AND coalesce(r.request->>'lane','news')='news'
          AND a.error LIKE ${`${NOTE}%`} LIMIT 1`;
      if (prior) return null;
      const note = `${NOTE}；原错误：${row.error ?? "未记录"}`;
      const marked = await tx`UPDATE receipt_attempts SET error=${note}
        WHERE receipt_id=${row.id} AND attempt=${row.attempts} AND status='unknown'`;
      if (!marked.count) return null;
      await tx`UPDATE receipts SET status='failed',error=${note},updated_at=now() WHERE id=${row.id}`;
      const queued = await resume(row, tx);
      await audit(
        "ops.recover",
        "receipt.release",
        `receipt:${row.id}`,
        NOTE,
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
