import { sql } from "../db.ts";
import { assertRuntimeControl, type RuntimeControlSnapshot } from "../operations/lane-controls.ts";
import { lockNewsProcessingPermissions } from "../providers/news-fallback.ts";
import { lockNewsModelMaterials } from "@amp/backend/content/materials";

/** Store one actual provider batch atomically; partial writes would change its paid recovery key. */
export async function storeEmbeddingBatch(
  kind: "fact" | "article" | "story",
  model: string,
  rows: { id: string; textHash: string; vector: number[] }[],
  control: RuntimeControlSnapshot,
  materials: Array<{ id: string; revision: number }>,
) {
  await sql.begin(async (tx) => {
    await assertRuntimeControl(tx, control);
    await lockNewsProcessingPermissions(
      materials.map((item) => item.id),
      tx,
    );
    const current = await lockNewsModelMaterials(
      materials.map((item) => item.id),
      tx,
    );
    if (current.length !== materials.length || current.some((row) => !materials.some((item) => item.id === row.id && item.revision === row.revision)))
      throw new Error("向量写回前材料版本已变化");
    for (const row of rows)
      await tx`INSERT INTO embeddings(kind,ref_id,model,text_hash,vector) VALUES(${kind},${row.id},${model},${row.textHash},${row.vector})
    ON CONFLICT(kind,ref_id,model) DO UPDATE SET text_hash=EXCLUDED.text_hash,vector=EXCLUDED.vector,created_at=now()`;
  });
}
