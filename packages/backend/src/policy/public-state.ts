import { dbOf } from "../db.ts";
const sql = dbOf("policy");
/** Minimal read-only head check. Processing/collection pauses never decide the visibility of existing publications. */
export async function currentPolicyHeads(expressionIds: string[]) {
  if (!expressionIds.length) return new Map<string, string | null>();
  const rows = await sql<
    { id: string; current_revision_id: string | null }[]
  >`SELECT id,current_revision_id FROM policy.expressions WHERE id IN ${sql(expressionIds)}`;
  return new Map(rows.map((row) => [row.id, row.current_revision_id]));
}
