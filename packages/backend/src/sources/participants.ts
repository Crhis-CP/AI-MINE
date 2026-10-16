import { dbOf, type Db } from "../db.ts";
import { entityIdentity } from "../editorial/vocabulary.ts";
const sql = dbOf("sources");
export interface SourceParticipant {
  id: string;
  owner_entity_id?: string | null;
}
/** Explicit source ownership groups multiple entry points; an unknown owner is never guessed from a headline. */
export function participantIdentity(source: SourceParticipant): string {
  const owner = source.owner_entity_id?.normalize("NFKC").trim();
  return owner ? `owner:${entityIdentity(owner) ?? owner.toLowerCase().replace(/\s+/g, " ")}` : `source:${source.id}`;
}
export async function sourceParticipants(ids: string[], db: Db = sql) {
  if (!ids.length) return [];
  return db<SourceParticipant[]>`SELECT id,owner_entity_id FROM sources WHERE id=ANY(${ids}::text[])`;
}
