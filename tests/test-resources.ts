import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { Database } from "@amp/config";

/** The parent reserves a random namespace; direct single-file tests keep their existing names. */
export const resourcePrefix = (fallback: string) =>
  process.env.AMP_TEST_RESOURCE_PREFIX ? `${process.env.AMP_TEST_RESOURCE_PREFIX}_${randomBytes(4).toString("hex")}` : fallback;

export function recordResources(kind: "database" | "role", names: string[]) {
  const journal = process.env.AMP_TEST_RESOURCE_JOURNAL;
  if (!journal) return;
  for (const name of names) {
    assert.ok(name.startsWith(`${process.env.AMP_TEST_RESOURCE_PREFIX}_`) && /^[a-z][a-z0-9_]{0,62}$/.test(name), "Unowned test resource");
    appendFileSync(journal, `${JSON.stringify({ kind, name })}\n`);
  }
}

/** Register before CREATE so an interrupted creation is still cleaned, after excluding pre-existing databases. */
export async function createTestDatabase(sql: Database, name: string) {
  assert.match(name, /_test$/);
  assert.equal((await sql`SELECT count(*)::int AS n FROM pg_database WHERE datname=${name}`)[0].n, 0);
  recordResources("database", [name]);
  await sql`CREATE DATABASE ${sql(name)}`;
}
