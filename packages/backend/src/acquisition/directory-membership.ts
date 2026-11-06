import { sql } from "../db.ts";

/**
 * Only completed applied heads decide current catalogue membership. No permissions, config or source bytes are read.
 * One statement answers every reference, so a public list of N documents costs one read, not N.
 */
export async function currentDirectoryMaterialMembership(refs: { sourceId: string; materialId: string }[]) {
  const result = new Map<string, boolean>();
  if (!refs.length) return result;
  const rows = await sql<{ source_id: string; material_id: string; current: boolean }[]>`SELECT ref.source_id,ref.material_id,
      NOT EXISTS(SELECT 1 FROM acquisition.directory_heads h WHERE h.source_id=ref.source_id)
      OR EXISTS(SELECT 1 FROM acquisition.directory_heads h JOIN acquisition.directory_records r ON r.scan_id=h.scan_id
        JOIN acquisition.directory_bindings b ON b.scan_id=r.scan_id AND b.record_id=r.record_id
        WHERE h.source_id=ref.source_id AND r.role='current' AND b.material_id=ref.material_id) AS current
    FROM unnest(${refs.map((ref) => ref.sourceId)}::text[],${refs.map((ref) => ref.materialId)}::text[]) AS ref(source_id,material_id)`;
  for (const row of rows) result.set(`${row.source_id}:${row.material_id}`, row.current === true);
  return result;
}
