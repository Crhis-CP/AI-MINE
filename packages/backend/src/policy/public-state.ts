import { dbOf, type Db } from "../db.ts";
const sql = dbOf("policy");
/** Minimal read-only head check. Processing/collection pauses never decide the visibility of existing publications. */
export async function currentPolicyHeads(expressionIds: string[]) {
  if (!expressionIds.length) return new Map<string, string | null>();
  const rows = await sql<
    { id: string; current_revision_id: string | null }[]
  >`SELECT id,current_revision_id FROM policy.expressions WHERE id IN ${sql(expressionIds)}`;
  return new Map(rows.map((row) => [row.id, row.current_revision_id]));
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
