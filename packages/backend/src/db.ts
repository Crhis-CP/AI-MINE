import type postgres from "postgres";
import type { Database } from "@amp/config";
import { dbOf } from "./module-db.ts";
import { closeProcessDb } from "./db-bootstrap.ts";

export { dbOf, injectDb } from "./module-db.ts";
export { initializeDb, DB_MODULES } from "./db-bootstrap.ts";

export type Sql = Database;
export type Tx = postgres.TransactionSql;
export type Db = Sql | Tx;

/**
 * Runs queries with plans made for their actual values. A cached generic plan cannot tell a
 * two-character search term (no usable trigram) from a longer one and would scan the whole trigram
 * index, so every search goes through here.
 */
export function withCustomPlans<T>(fn: (db: Tx) => Promise<T>): Promise<T> {
  return dbOf("publication").begin(async (tx) => {
    await tx`SET LOCAL plan_cache_mode = force_custom_plan`;
    return fn(tx);
  }) as Promise<T>;
}

export function closeDb(): Promise<void> {
  return closeProcessDb();
}

/** First row of a query that always returns one (aggregates). */
export function one<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row");
  return row;
}
