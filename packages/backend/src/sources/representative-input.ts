import { dbOf, type Db } from "../db.ts";
const sql = dbOf("sources");
/** Source identity is metadata, not a claim that every report speaks for its subject. */
export async function representativeSourceIdentities(ids: string[], db: Db = sql) {
  if (!ids.length) return [];
  return db<{ id: string; source_tier: string; publisher_role: string | null; owner_entity_id: string | null }[]>`
    SELECT id,tier AS source_tier,config->>'publisherRole' AS publisher_role,owner_entity_id
    FROM sources WHERE id=ANY(${ids}::text[])`;
}
