import type postgres from "postgres";
import type { Database } from "./process-config.ts";
import { sql } from "./db-connections.ts";
import { closeProcessDb } from "./db-bootstrap.ts";

export { sql, identitySql, feedbackSql } from "./db-connections.ts";
export { initializeDb, operationsReadDatabase, databaseLifetimeSignal } from "./db-bootstrap.ts";

export type Sql = Database;
export type Tx = postgres.TransactionSql;
export type Db = Sql | Tx;

/**
 * Runs queries with plans made for their actual values. A cached generic plan cannot tell a
 * two-character search term (no usable trigram) from a longer one and would scan the whole trigram
 * index, so every search goes through here.
 */
export function withCustomPlans<T>(fn: (db: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
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

// Pure startup validation and connection factories; importing these does not read credentials or open pools.
export * from "./process-config.ts";
