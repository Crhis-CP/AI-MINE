// One automatic retry after an unknown outcome; uncertainty remains in the cost ledger.
import { dbOf, type Db } from "../db.ts";
import { audit } from "../admin/auth.ts";
import { runtimeControlSnapshot } from "../operations/lane-controls.ts";

const sql = dbOf("ai-gateway");
export const UNKNOWN_AUTO_RELEASE_NOTE = "自动放行：结果未知超过 30 分钟，未核对是否计费";
type Released = { id: number; subject: string | null; purpose: string; request: unknown };

/** Private gateway helper: claiming, audit and requeue commit atomically. */
export async function recoverUnknownOnce(now: number, resume: (row: Released, db: Db) => Promise<boolean>) {
  const cutoff = new Date(now - 30 * 60_000);
  const candidates = await sql<{ id: number }[]>`SELECT r.id FROM receipts r
    WHERE r.status='unknown' AND r.updated_at<${cutoff}
      AND NOT EXISTS (SELECT 1 FROM receipt_attempts a WHERE a.receipt_id=r.id AND a.error LIKE ${`${UNKNOWN_AUTO_RELEASE_NOTE}%`})
    ORDER BY r.id LIMIT 200`;
  let released = 0;
  let requeued = 0;
  for (const candidate of candidates) {
    const result = await sql.begin(async (tx) => {
      const [row] = await tx<Released[]>`SELECT id,subject,purpose,request FROM receipts
        WHERE id=${candidate.id} AND status='unknown' AND updated_at<${cutoff} FOR UPDATE`;
      if (!row) return null;
      const lane = row.request && typeof row.request === "object" && "lane" in row.request ? row.request.lane : null;
      // An intentional pause must retain the one recovery opportunity until that lane can actually continue.
      if ((lane === "news" || lane === "policy") && (await runtimeControlSnapshot(lane, ["processing"], tx)).paused) return null;
      const [prior] = await tx`SELECT 1 FROM receipt_attempts WHERE receipt_id=${row.id} AND error LIKE ${`${UNKNOWN_AUTO_RELEASE_NOTE}%`} LIMIT 1`;
      if (prior) return null;
      // Mark the original attempt, retaining unknown status, unknown cost and its reserved exposure.
      const marked = await tx`UPDATE receipt_attempts SET error=${UNKNOWN_AUTO_RELEASE_NOTE}
        WHERE receipt_id=${row.id} AND attempt=(SELECT attempts FROM receipts WHERE id=${row.id}) AND status='unknown'`;
      if (!marked.count) return null;
      await tx`UPDATE receipts SET status='failed',error=${UNKNOWN_AUTO_RELEASE_NOTE},updated_at=now() WHERE id=${row.id}`;
      const queued = await resume(row, tx);
      await audit(
        "ops.recover",
        "receipt.release",
        `receipt:${row.id}`,
        UNKNOWN_AUTO_RELEASE_NOTE,
        { status: "unknown" },
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
