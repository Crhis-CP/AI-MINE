import { dbOf, type Db } from "../db.ts";
const sql = dbOf("events");
export async function representativeFactSubjects(ids: number[], db: Db = sql) {
  if (!ids.length) return [];
  return db<{ id: number; subject: string | null }[]>`SELECT id,subject FROM facts WHERE id=ANY(${ids}::bigint[])`;
}
