import { beijingDate } from "@amp/contracts/time";
import { dbOf } from "../db.ts";
const sql = dbOf("ai-gateway");
export const usageOperationalSnapshot = () =>
  sql.begin(async (db) => {
    await db`SET LOCAL statement_timeout='2s'`;
    const start = new Date(`${beijingDate(Date.now()).slice(0, 7)}-01T00:00:00+08:00`);
    return db`SELECT service,status,currency,cost_basis,count(*)::int AS calls,sum(cost)::text AS recorded_amount,count(cost)::int AS priced_calls FROM receipt_attempts WHERE origin='live' AND started_at>=${start} GROUP BY service,status,currency,cost_basis ORDER BY service,status,currency,cost_basis LIMIT 501`;
  });
export const evaluationsOperationalSnapshot = () =>
  sql.begin(async (db) => {
    await db`SET LOCAL statement_timeout='2s'`;
    const rows = await db<
      { id: string; sample_size: number; models: string[]; created_at: Date }[]
    >`SELECT id,sample_size,models,created_at FROM selectbench_runs ORDER BY created_at DESC,id LIMIT 101`;
    return rows.map(({ models, ...row }) => ({ ...row, model_count: models.length }));
  });
