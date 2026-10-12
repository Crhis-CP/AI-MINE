import { currentDirectoryMaterialMembership } from "@amp/backend/sources/collect";
import { dbOf, type Db } from "../db.ts";
const sql = dbOf("policy");
/** Minimal read-only head check. Processing/collection pauses never decide the visibility of existing publications. */
export async function currentPolicyHeads(expressionIds: string[]) {
  if (!expressionIds.length) return new Map<string, string | null>();
  const rows = await sql<
    { id: string; current_revision_id: string | null }[]
  >`SELECT id,current_revision_id FROM policy.expressions WHERE id IN ${sql(expressionIds)}`;
  const refs = await sql<{ expression_id: string; source_id: string; material_id: string; is_current: boolean }[]>`
    SELECT expression_id,source_id,material_id,is_current FROM policy.material_discoveries WHERE expression_id IN ${sql(expressionIds)}`;
  const members = await currentDirectoryMaterialMembership(refs.map((r) => ({ sourceId: r.source_id, materialId: r.material_id })));
  return new Map(
    rows.map((row) => {
      const linked = refs.filter((r) => r.expression_id === row.id);
      return [row.id, !linked.length || linked.some((r) => r.is_current && members.get(`${r.source_id}:${r.material_id}`)) ? row.current_revision_id : null];
    }),
  );
}

/** Private identity metadata for publication writers; public_read has no access to these extra columns. */
export async function policyPublicationIdentity(expressionId: string) {
  const [row] = await sql<
    { instrument_id: string; version_id: string; version_key: string; kind: "original" | "official_translation" }[]
  >`SELECT v.instrument_id,e.version_id,v.version_key,e.kind
 FROM policy.expressions e JOIN policy.versions v ON v.id=e.version_id WHERE e.id=${expressionId}`;
  return row ?? null;
}

/** Worker CAS locks the same current head updated by acquisition. */
export async function lockPolicyPublicationHead(expressionId: string, revisionId: string, db: Db) {
  const [row] = await db`SELECT current_revision_id FROM policy.expressions WHERE id=${expressionId} FOR SHARE`;
  return row?.current_revision_id === revisionId;
}
