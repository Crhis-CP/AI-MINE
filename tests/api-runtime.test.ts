import "./setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { apiChildEnvironment } from "../scripts/verify/api-harness.ts";
import { apiProcess } from "./api-process.ts";

const ENTRY_ARGS = ["--input-type=module", "-e", "import { startApi } from './apps/api/src/runtime.ts'; await startApi(process.env);"];

after(closeDb);
const marker = `api-entrypoint-${process.pid}`;
const address = new URL(process.env.DATABASE_URL!);
address.searchParams.set("application_name", marker);
const secrets = {
  PUBLIC_RATE_LIMIT_SECRET: randomBytes(24).toString("hex"),
  SESSION_SECRET: randomBytes(24).toString("hex"),
  ADMIN_PASSWORD: randomBytes(24).toString("hex"),
};
const environment = () =>
  apiChildEnvironment({
    ...process.env,
    ...secrets,
    NODE_ENV: "production",
    DATABASE_URL: address.toString(),
    SITE_URL: "http://127.0.0.1:3000",
    LOG_LEVEL: "error",
  });
const noConnections = async () => assert.equal((await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${marker}`)[0].n, 0);

test("API runtime rejects a different environment source before backend configuration can disagree", () => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "import { startApi } from './apps/api/src/runtime.ts'; await startApi({...process.env, NODE_ENV:'production'});"],
    {
      env: { ...environment(), NODE_ENV: "development", PUBLIC_RATE_LIMIT_SECRET: undefined },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /API startup requires the current process environment/);
});

test("the unified runtime rejects legacy modes and missing credentials before database access", () => {
  const unifiedEnv = environment();
  const cases: [NodeJS.ProcessEnv, string][] = [
    ...["public-api", "private-api", "", "PRIVATE_MARKER"].map((API_ROLE): [NodeJS.ProcessEnv, string] => [{ ...unifiedEnv, API_ROLE }, "API_ROLE must be"]),
    ...["PUBLIC_RATE_LIMIT_SECRET", "SESSION_SECRET"].flatMap((key) =>
      [undefined, ""].map((value) => [{ ...unifiedEnv, [key]: value }, key] as [NodeJS.ProcessEnv, string]),
    ),
    [{ ...unifiedEnv, ADMIN_PASSWORD: undefined }, "set ADMIN_PASSWORD"],
  ];
  for (const [env, expected] of cases) {
    const result = spawnSync(process.execPath, ENTRY_ARGS, {
      env: { ...env, NODE_ENV: "production", API_PORT: "0", DATABASE_URL: "postgres://postgres@127.0.0.1:1/api_entrypoint_test" },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(expected), result.stderr);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED|PRIVATE_MARKER/);
  }
});

test("the unified process serves public reads and hashes feedback without disclosing server credentials", async (t) => {
  const env = environment();
  delete env.API_ROLE;
  assert.equal(env.SESSION_SECRET, secrets.SESSION_SECRET);
  assert.equal(env.ADMIN_PASSWORD, secrets.ADMIN_PASSWORD);
  assert.equal(env.IMG_PROXY_SIGN_SECRET, undefined);
  const app = await apiProcess(t, env, ENTRY_ARGS);
  await app.ready();
  assert.equal((await fetch(`${app.url}/api/site/meta`)).status, 200);
  assert.equal((await fetch(`${app.url}/api/admin/me`)).status, 401);
  const publicBody = await (await fetch(`${app.url}/api/site/meta`)).text();
  for (const value of Object.values(secrets)) assert.ok(!publicBody.includes(value));
  const feedback = await fetch(`${app.url}/api/site/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.42", "user-agent": "Firefox", "idempotency-key": randomUUID() },
    body: JSON.stringify({ content: marker }),
  });
  assert.equal(feedback.status, 201);
  const { id } = (await feedback.json()) as { id: number };
  const expected = createHmac("sha256", secrets.PUBLIC_RATE_LIMIT_SECRET).update("203.0.113.42|Firefox").digest("base64url").slice(0, 24);
  assert.equal((await sql`SELECT source_hash FROM feedback WHERE id=${id}`)[0].source_hash, expected);
  await sql`DELETE FROM feedback.submissions WHERE feedback_id=${id}`;
  await sql`DELETE FROM feedback WHERE id=${id}`;

  assert.equal(await app.stop(), 0, app.output());
  await noConnections();
});

test("the unified production process authenticates, retains CSRF and closes its connections", async (t) => {
  const env = environment();
  assert.ok(env.PUBLIC_RATE_LIMIT_SECRET);
  assert.equal(env.IMG_PROXY_SIGN_SECRET, undefined);
  const app = await apiProcess(t, env, ENTRY_ARGS);
  await app.ready();
  assert.deepEqual(await (await fetch(`${app.url}/api/auth/options`)).json(), { password: true, feishu: false });
  assert.equal((await fetch(`${app.url}/api/site/meta`)).status, 200);
  assert.equal((await fetch(`${app.url}/api/admin/me`)).status, 401);
  const nonce = await fetch(`${app.url}/api/auth/password-nonce`);
  const login_nonce = ((await nonce.json()) as { token: string }).token;
  const login = await fetch(`${app.url}/api/auth/password`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", cookie: nonce.headers.get("set-cookie")!.split(";")[0]! },
    body: JSON.stringify({ login_name: "admin@local", login_nonce, password: secrets.ADMIN_PASSWORD, return: "/admin" }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const me = await fetch(`${app.url}/api/admin/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  const principal = (await me.json()) as { dev: boolean; csrf: string };
  assert.equal(principal.dev, false);
  const missingCsrf = await fetch(`${app.url}/api/auth/logout`, { method: "POST", redirect: "manual", headers: { cookie } });
  assert.equal(missingCsrf.status, 403);
  assert.equal((await fetch(`${app.url}/api/admin/me`, { headers: { cookie } })).status, 200);
  assert.equal((await sql`SELECT count(*)::int AS n FROM settings WHERE key=${`heartbeat.private-api:${app.port}`}`)[0].n, 1);
  assert.equal(
    (await fetch(`${app.url}/api/auth/logout`, { method: "POST", redirect: "manual", headers: { cookie, "x-csrf-token": principal.csrf } })).status,
    303,
  );
  assert.equal((await fetch(`${app.url}/api/admin/me`, { headers: { cookie } })).status, 401);
  assert.equal(await app.stop(), 0, app.output());
  await noConnections();
  await sql`DELETE FROM settings WHERE key=${`heartbeat.private-api:${app.port}`}`;
});

test("retired API modes are rejected in development too", () => {
  for (const API_ROLE of ["public-api", "private-api"]) {
    const result = spawnSync(process.execPath, ENTRY_ARGS, {
      env: { ...environment(), NODE_ENV: "development", API_ROLE, LLM_API_KEY: "PRIVATE_MARKER" },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /legacy API modes are no longer supported/);
    assert.doesNotMatch(result.stderr, /PRIVATE_MARKER|ECONNREFUSED/);
  }
});
