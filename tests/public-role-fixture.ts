import { participationHash } from "../packages/backend/src/events/participation-read.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { provisionRoles } from "../scripts/db-roles.ts";
import { roleFixture } from "./role-db-fixture.ts";
import { apiProcess } from "./api-process.ts";
import { TRANSLATE_PROMPT_VERSION } from "@amp/backend/editorial/translate";
import { TRANSLATION_MANIFEST_FORMAT } from "../packages/backend/src/editorial/translation-readiness.ts";

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
  // The stored translations carry the current recipe, so a translation prompt change does not stale the fixture.
  const data = readFileSync(new URL("./fixtures/public-role-data.sql", import.meta.url), "utf8").replaceAll(
    "__TRANSLATION_RECIPE__",
    `${TRANSLATION_MANIFEST_FORMAT}:${TRANSLATE_PROMPT_VERSION}`,
  );
  await f.admin.begin(async (tx) => tx.unsafe(data));
  await f.admin`UPDATE story_signals ss SET qualified_at=now(),qualified_fact_id=p.fact_id,material_revision=a.revision,source_date_version=a.source_date_version,
    publication_revision=CASE WHEN ss.kind='editorial' THEN p.revision ELSE NULL END,source_since=now()-interval '2 years'
    FROM publications p JOIN articles a ON a.id=p.article_id WHERE ss.article_id=p.article_id`;
  const proof = await f.admin<
    { article_id: string; participant_key: string; kind: "editorial" | "signal"; observed_at: Date }[]
  >`SELECT article_id,participant_key,kind,observed_at FROM story_signals WHERE story_id=9101`;
  await f.admin`UPDATE hot_rankings SET entries=jsonb_set(entries,'{0,evidenceHash}',to_jsonb(${participationHash(proof)}::text))`;
  const reports = await f.admin`SELECT kind,key FROM reports ORDER BY kind,key DESC`;
  const keys = Object.fromEntries(["daily", "weekly", "monthly"].map((kind) => [kind, reports.filter((r) => r.kind === kind).map((r) => r.key as string)]));
  return { ...f, keys };
}
export type PublicFixture = Awaited<ReturnType<typeof publicRoleFixture>>;

/** The app gets only its real public/feedback identities; fixture administration stays in the parent. */
export async function publicServer(t: TestContext, f: PublicFixture) {
  const code = `
    import {assertProcessEnvironment,assertPublicApiCredentials} from '@amp/backend/db';
    assertProcessEnvironment('public-api',process.env);assertPublicApiCredentials(process.env);
    const {initializeDb,closeDb}=await import('@amp/backend/db');
    const {buildApp}=await import('./apps/api/src/app.ts');
    const {normalizeRouteTree}=await import('./scripts/baseline/routes.ts');
    const {installModules}=await import('@amp/backend/modules');const {SERVER_MODULES}=await import('./site/modules/server.ts');installModules(SERVER_MODULES);await initializeDb('public-api');const app=await buildApp();
    await app.listen({host:'127.0.0.1',port:Number(process.env.API_PORT)});
    const allRoutes=normalizeRouteTree(app.printRoutes({commonPrefix:false}),{'':'/api/public/*','/api/v1':'/api/v1/*'}).filter(x=>x.startsWith('GET '));
    const isProtected=x=>x==='GET /mcp-ops'||x==='GET /api/admin'||x.startsWith('GET /api/admin/')||x==='GET /api/auth'||x.startsWith('GET /api/auth/');
    const routes=allRoutes.filter(x=>!isProtected(x));
    const protectedRoutes=allRoutes.filter(isProtected);
    console.log('PR9_ROUTES='+JSON.stringify(routes));console.log('PR9_PROTECTED_ROUTES='+JSON.stringify(protectedRoutes));console.log('PR9_READY');
    process.on('SIGTERM',async()=>{await app.close();await closeDb();process.exit(0)});
  `;
  const child = await apiProcess(
    t,
    {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      API_ROLE: "api",
      PRIVATE_HOST: "private-role-fixture.example.test",
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
  const protectedRoutes = JSON.parse(
    child
      .output()
      .split("\n")
      .find((line) => line.startsWith("PR9_PROTECTED_ROUTES="))!
      .slice("PR9_PROTECTED_ROUTES=".length),
  ) as string[];
  const request = (url: string, options: RequestInit = {}) =>
    fetch(child.url + url, {
      ...options,
      redirect: "manual",
      signal: options.signal ?? AbortSignal.timeout(10_000),
      headers: { host: "public-fixture.example.test", ...options.headers },
    });
  return { ...child, routes, protectedRoutes, request };
}

export async function roleConnections(f: PublicFixture) {
  const rows = await f.admin`SELECT usename, count(*)::int AS n FROM pg_stat_activity WHERE datname=${f.database} GROUP BY usename`;
  return {
    public_read: rows.find((r) => r.usename === f.roles.public_read)?.n ?? 0,
    feedback_write: rows.find((r) => r.usename === f.roles.feedback_write)?.n ?? 0,
  };
}
