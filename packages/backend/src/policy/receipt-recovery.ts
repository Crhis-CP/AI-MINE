import { z } from "zod";
import { dbOf, type Db } from "../db.ts";

const sql = dbOf("policy");
const Request = z.object({
  lane: z.literal("policy"),
  manifest: z.object({
    materials: z.array(z.object({ source_id: z.string().min(1), material_id: z.string().min(1), revision: z.number().int().positive() })),
  }),
});

/** Called only inside an approved receipt release transaction; the normal worker rechecks all controls. */
export async function resumePolicyAfterReceipt(request: unknown, db: Db = sql): Promise<boolean> {
  const parsed = Request.safeParse(request);
  if (!parsed.success) return false;
  let resumed = false;
  for (const material of parsed.data.manifest.materials) {
    const changed = await db`UPDATE policy.material_workflows SET stage='acquire',status='pending',
      reason='请求恢复后重新核对原件与处理权限',next_check_at=now(),updated_at=now()
      WHERE source_id=${material.source_id} AND material_id=${material.material_id} AND material_revision=${material.revision}
        AND status IN ('blocked_unknown','waiting_receipt') RETURNING material_id`;
    resumed ||= changed.length > 0;
  }
  return resumed;
}
