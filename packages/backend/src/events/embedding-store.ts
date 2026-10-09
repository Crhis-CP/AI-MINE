import { dbOf } from "../db.ts";
import { assertRuntimeControl, type RuntimeControlSnapshot } from "../operations/lane-controls.ts";
const sql = dbOf("events");
/** Store one actual provider batch atomically; partial writes would change its paid recovery key. */
export async function storeEmbeddingBatch(
  kind: "fact" | "article" | "story",
  model: string,
  rows: { id: string; textHash: string; vector: number[] }[],
  control: RuntimeControlSnapshot,
) {
  await sql.begin(async (tx) => {
    await assertRuntimeControl(tx, control);
    for (const row of rows)
      await tx`INSERT INTO embeddings(kind,ref_id,model,text_hash,vector) VALUES(${kind},${row.id},${model},${row.textHash},${row.vector})
    ON CONFLICT(kind,ref_id,model) DO UPDATE SET text_hash=EXCLUDED.text_hash,vector=EXCLUDED.vector,created_at=now()`;
  });
}
