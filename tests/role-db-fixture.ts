import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { createDatabaseAccess, type Database, type DatabaseRole } from "@amp/config";
import { quote, roleNames } from "../scripts/db-roles/grants.ts";

/** Only fresh *_test databases and a collision-checked random role prefix; no test root is injected. */
export async function roleFixture(t: TestContext) {
  const base = new URL(process.env.DATABASE_URL ?? "postgres://unset/unset");
  assert.match(base.pathname, /_(test|ci)$/);
  const access = createDatabaseAccess("test", { DATABASE_URL: base.toString(), DATABASE_POOL_MAX: "1" }, () => {});
  const control = access.dbFor("worker");
  const prefix = `rg_${randomBytes(6).toString("hex")}`,
    roles = roleNames(prefix),
    database = `${prefix}_test`;
  let ownPrefix = false;
  const databases: string[] = [],
    clients: ReturnType<typeof createDatabaseAccess>[] = [];
  const dir = mkdtempSync(path.join(tmpdir(), "amp-role-test-"));
  t.after(async () => {
    const failures: unknown[] = [];
    const cleanup = async (fn: () => unknown) => {
      try {
        await fn();
      } catch (error) {
        failures.push(error);
      }
    };
    for (const client of clients) await cleanup(() => client.close());
    for (const name of databases.reverse()) await cleanup(() => control.unsafe(`DROP DATABASE ${quote(name)} WITH (FORCE)`));
    for (const role of ownPrefix ? Object.values(roles) : []) await cleanup(() => control.unsafe(`DROP ROLE IF EXISTS ${quote(role)}`));
    await cleanup(() => access.close());
    rmSync(dir, { recursive: true, force: true });
    if (failures.length) throw new AggregateError(failures, "Isolated role fixture cleanup failed");
  });
  assert.equal((await control`SELECT count(*)::int AS n FROM pg_roles WHERE rolname=ANY(${Object.values(roles)}::text[])`)[0].n, 0);
  ownPrefix = true;
  const createDatabase = async (name: string) => {
    await control.unsafe(`CREATE DATABASE ${quote(name)}`);
    databases.push(name);
  };
  await createDatabase(database);
  const address = new URL(base);
  address.pathname = `/${database}`;
  const password = randomBytes(20).toString("hex"); // Synthetic, test-only issuance; production provisioning never sets passwords.
  const urlFor = (role?: DatabaseRole, name = database) => {
    const url = new URL(address);
    url.pathname = `/${name}`;
    if (role) {
      url.username = roles[role];
      url.password = password;
    }
    return url.toString();
  };
  const open = (url: string) => {
    const client = createDatabaseAccess("test", { DATABASE_URL: url, DATABASE_POOL_MAX: "1" }, () => {});
    clients.push(client);
    return client.dbFor("worker");
  };
  const admin = open(urlFor());
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: "test",
    DATABASE_POOL_MAX: "1",
    MODEL_CALLS_ENABLED: "false",
    COLLECT_ENABLED: "false",
    FEISHU_CONTENT_PUSH_ENABLED: "false",
    INDEXNOW_SUBMIT_ENABLED: "false",
    AMP_CREDENTIALS_DIR: "/nonexistent-test-credentials",
    LOG_LEVEL: "error",
  };
  const run = async (command: string, args: string[], extra: Record<string, string> = {}) => {
    try {
      return await promisify(execFile)(command, args, { env: { ...env, ...extra }, timeout: 45_000, maxBuffer: 8 * 1024 * 1024 });
    } catch (error) {
      const e = error as { code?: unknown; stderr?: string };
      throw new Error(`Isolated ${path.basename(command)} failed (${e.code}): ${(e.stderr ?? "").replace(/\/\/[^@\s]+@/g, "//[redacted]@").slice(0, 1000)}`);
    }
  };
  await run(process.execPath, ["scripts/migrate.ts"], { DATABASE_URL: urlFor() });
  const login = async () => {
    const sessions = {} as Record<DatabaseRole, Database>;
    for (const [role, name] of Object.entries(roles)) {
      await admin.unsafe(`ALTER ROLE ${quote(name)} PASSWORD '${password}'`);
      const sql = open(urlFor(role as DatabaseRole));
      const [who] = await sql`SELECT session_user AS session, current_user AS current`;
      assert.deepEqual({ ...who }, { session: name, current: name });
      sessions[role as DatabaseRole] = sql;
    }
    return sessions;
  };
  return { prefix, roles, database, admin, control, dir, env, run, urlFor, open, login, createDatabase };
}
export async function denied(sql: Database, statement: string) {
  await assert.rejects(sql.unsafe(statement), (error: { code?: string }) => error.code === "42501");
}
