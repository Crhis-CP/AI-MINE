import type { z } from "zod";
import type { OpsRows } from "@amp/contracts/ops-mcp";
import { readUsageProtection } from "./usage-protection.ts";
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

export const protectionOperationalSnapshot = () =>
  sql.begin(async (db) => {
    await db`SET LOCAL statement_timeout='2s'`;
    const overview = await readUsageProtection(db);
    const values = (input: Record<string, string>) =>
      Object.fromEntries(Object.entries(input).filter(([key, value]) => /^[a-z_]+$/.test(key) && /^\d+(?:\.\d+)?$/.test(value)));
    const rows: z.infer<typeof OpsRows.protection> = overview.indicators.map((value) => ({
      kind: "indicator",
      state: value.level,
      lane: value.scope?.lane ?? null,
      trigger: value.trigger,
      capability: value.scope?.capability ?? null,
      source_id: value.scope?.source_id ?? null,
      current: values(value.current),
      threshold: values(value.threshold),
    }));
    rows.push(
      ...overview.breakers.map((value) => ({
        kind: "breaker" as const,
        state: value.state,
        lane: value.scope.lane,
        trigger: value.trigger,
        capability: value.scope.capability,
        source_id: value.scope.source_id,
        current: values(value.current),
        threshold: values(value.threshold),
      })),
    );
    if (overview.missing.length)
      rows.push({ kind: "coverage", state: "needs_configuration", lane: null, trigger: null, capability: null, source_id: null, current: {}, threshold: {} });
    return rows;
  });
