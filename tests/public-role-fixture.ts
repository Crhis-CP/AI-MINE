import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { provisionRoles } from "../scripts/db-roles.ts";
import { roleFixture } from "./role-db-fixture.ts";
import { apiProcess } from "./api-process.ts";

export const INDEX_KEY = "1234567890abcdef1234567890abcdef";
export const STORY = "11111111-1111-4111-8111-111111111111";
export const ALIAS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const RATE_SECRET = "pr9-synthetic-public-rate-limit";
export const SITE_URL = "https://public-fixture.example.test";
export async function publicRoleFixture(t: TestContext) {
  const f = await roleFixture(t);
  await provisionRoles(f.admin, { prefix: f.prefix, publicConnections: 2, apply: true });
  const sessions = await f.login();
  await Promise.all(Object.values(sessions).map((sql) => sql.end()));
  await f.admin.begin(async (tx) => tx.unsafe(readFileSync(new URL("./fixtures/public-role-data.sql", import.meta.url), "utf8")));
  const reports = await f.admin`SELECT kind,key FROM reports ORDER BY kind,key DESC`;
  const keys = Object.fromEntries(["daily", "weekly", "monthly"].map((kind) => [kind, reports.filter((r) => r.kind === kind).map((r) => r.key as string)]));
  return { ...f, keys };
}
export type PublicFixture = Awaited<ReturnType<typeof publicRoleFixture>>;

/** The app gets only its real public/feedback identities; fixture administration stays in the parent. */
export async function publicServer(t: TestContext, f: PublicFixture) {
  const code = `
    import {assertProcessEnvironment,assertPublicApiCredentials} from '@amp/config';
    assertProcessEnvironment('public-api',process.env);assertPublicApiCredentials(process.env);
    const {initializeDb,closeDb}=await import('@amp/backend/db');
    const {buildApp}=await import('./apps/api/src/app.ts');
    const {normalizeRouteTree}=await import('./scripts/baseline/routes.ts');
    await initializeDb('public-api');const app=await buildApp('public-api');
    await app.listen({host:'127.0.0.1',port:Number(process.env.API_PORT)});
    const routes=normalizeRouteTree(app.printRoutes({commonPrefix:false}),{'':'/api/public/*','/api/v1':'/api/v1/*'}).filter(x=>x.startsWith('GET '));
    console.log('PR9_ROUTES='+JSON.stringify(routes));console.log('PR9_READY');
    process.on('SIGTERM',async()=>{await app.close();await closeDb();process.exit(0)});
  `;
  const child = await apiProcess(
    t,
    {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      API_ROLE: "public-api",
      DATABASE_POOL_MAX: "1",
      DATABASE_URL_PUBLIC_READ: f.urlFor("public_read"),
      DATABASE_URL_FEEDBACK_WRITE: f.urlFor("feedback_write"),
      MODEL_CALLS_ENABLED: "false",
      COLLECT_ENABLED: "false",
      FEISHU_CONTENT_PUSH_ENABLED: "false",
      INDEXNOW_SUBMIT_ENABLED: "false",
      INDEXNOW_KEY: INDEX_KEY,
      PUBLIC_RATE_LIMIT_SECRET: RATE_SECRET,
      SITE_URL,
      AMP_DATA_DIR: f.dir,
      LOG_LEVEL: "silent",
    },
    ["--input-type=module", "-e", code],
  );
  try {
    for (let n = 0; n < 150 && !child.output().includes("PR9_READY"); n++) await delay(20);
    assert.ok(child.output().includes("PR9_READY"), child.output());
  } catch (error) {
    await child.stop();
    throw error;
  }
  const routes = JSON.parse(
    child
      .output()
      .split("\n")
      .find((line) => line.startsWith("PR9_ROUTES="))!
      .slice("PR9_ROUTES=".length),
  ) as string[];
  const request = (url: string, options: RequestInit = {}) =>
    fetch(child.url + url, {
      ...options,
      redirect: "manual",
      signal: options.signal ?? AbortSignal.timeout(10_000),
      headers: { host: "public-fixture.example.test", ...options.headers },
    });
  return { ...child, routes, request };
}

export async function roleConnections(f: PublicFixture) {
  const rows = await f.admin`SELECT usename, count(*)::int AS n FROM pg_stat_activity WHERE datname=${f.database} GROUP BY usename`;
  return {
    public_read: rows.find((r) => r.usename === f.roles.public_read)?.n ?? 0,
    feedback_write: rows.find((r) => r.usename === f.roles.feedback_write)?.n ?? 0,
  };
}
