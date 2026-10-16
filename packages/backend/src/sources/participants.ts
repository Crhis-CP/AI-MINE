import { sql, type Db } from "../db.ts";
import { entityIdentity } from "../editorial/vocabulary.ts";

export interface SourceParticipant {
  id: string;
  owner_entity_id?: string | null;
  lane?: string;
  participation_mode?: string;
}
/** Explicit source ownership groups multiple entry points; an unknown owner is never guessed from a headline. */
export function participantIdentity(source: SourceParticipant): string {
  const owner = source.owner_entity_id?.normalize("NFKC").trim();
  return owner ? `owner:${entityIdentity(owner) ?? owner.toLowerCase().replace(/\s+/g, " ")}` : `source:${source.id}`;
}
export async function sourceParticipants(ids: string[], db: Db = sql) {
  if (!ids.length) return [];
  return db<
    (SourceParticipant & { name: string; tier: string; created_at: Date })[]
  >`SELECT id,name,tier,created_at,owner_entity_id,lane,participation_mode FROM sources WHERE id=ANY(${ids}::text[])`;
}

/** Safe source projection for public participation checks; never reads owners, tiers, configuration or keys. */
export async function publicParticipationSources(ids: string[]) {
  if (!ids.length) return [];
  return sql<
    { id: string; lane: string; participation_mode: string; enabled: boolean; kind: string; last_ok_at: Date | null; interval_minutes: number }[]
  >`SELECT id,lane,participation_mode,enabled,kind,last_ok_at,interval_minutes FROM sources WHERE id=ANY(${ids}::text[])`;
}
