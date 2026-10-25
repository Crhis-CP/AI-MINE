import { sql, type Db } from "../db.ts";

export async function activeEditorialNewsSources(ids: string[], db: Db) {
  if (!ids.length) return [];
  return db<{ id: string }[]>`SELECT id FROM sources WHERE id=ANY(${ids}::text[])
    AND enabled AND archived_at IS NULL AND lane='news' AND participation_mode='editorial'`;
}

export const sourcesOperationalSnapshot = () =>
  sql.begin(async (db) => {
    await db`SET LOCAL statement_timeout='2s'`;
    return db`SELECT id AS source_id,lane,kind,enabled,health,last_ok_at,last_fetch_at,next_fetch_at FROM sources ORDER BY id LIMIT 501`;
  });
