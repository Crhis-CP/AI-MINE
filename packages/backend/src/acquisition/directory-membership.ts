import { dbOf } from "../db.ts";
const sql = dbOf("acquisition");
/** Only completed applied heads decide current catalogue membership. No permissions, config or source bytes are read. */
export async function currentDirectoryMaterialMembership(refs: { sourceId: string; materialId: string }[]) {
  const result = new Map<string, boolean>();
  for (const ref of refs) {
    const [row] = await sql<{ current: boolean }[]>`SELECT
      NOT EXISTS(SELECT 1 FROM acquisition.directory_heads h WHERE h.source_id=${ref.sourceId})
      OR EXISTS(SELECT 1 FROM acquisition.directory_heads h JOIN acquisition.directory_records r ON r.scan_id=h.scan_id
        JOIN acquisition.directory_bindings b ON b.scan_id=r.scan_id AND b.record_id=r.record_id
        WHERE h.source_id=${ref.sourceId} AND r.role='current' AND b.material_id=${ref.materialId}) AS current`;
    result.set(`${ref.sourceId}:${ref.materialId}`, row?.current === true);
  }
  return result;
}
