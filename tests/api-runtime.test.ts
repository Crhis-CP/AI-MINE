import "./setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { apiChildEnvironment } from "../scripts/verify/api-harness.ts";
import { apiProcess } from "./api-process.ts";

const ENTRY_ARGS = ["--input-type=module", "-e", "import { startApi } from './apps/api/src/runtime.ts'; await startApi(process.env);"];
const sql = dbOf("ops");
after(closeDb);
const marker = `api-entrypoint-${process.pid}`;
const address = new URL(process.env.DATABASE_URL!);
address.searchParams.set("application_name", marker);
const secrets = {
  PUBLIC_RATE_LIMIT_SECRET: randomBytes(24).toString("hex"),
  SESSION_SECRET: randomBytes(24).toString("hex"),
  ADMIN_PASSWORD: randomBytes(24).toString("hex"),
};
const environment = (role: "public-api" | "private-api") =>
  apiChildEnvironment(role, {
    ...process.env,
    ...secrets,
    NODE_ENV: "production",
    DATABASE_URL: address.toString(),
    SITE_URL: "http://127.0.0.1:3000",
    LOG_LEVEL: "error",
  });
const settings = () => sql`SELECT key,value FROM settings WHERE key LIKE 'heartbeat.%' OR key='watchdog.worker' ORDER BY key`;
const queueSchema = async () => (await sql`SELECT to_regnamespace('pgboss')::text AS name`)[0].name;
const noConnections = async () => assert.equal((await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${marker}`)[0].n, 0);

test("API runtime rejects a different environment source before backend configuration can disagree", () => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "import { startApi } from './apps/api/src/runtime.ts'; await startApi({...process.env, NODE_ENV:'production'});"],
    {
      env: { ...environment("public-api"), NODE_ENV: "development", PUBLIC_RATE_LIMIT_SECRET: undefined },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /API startup requires the current process environment/);
});

test("the explicit API runtime rejects missing roles and credentials before database access", () => {
  const publicEnv = environment("public-api");
  const privateEnv = environment("private-api");
  const cases: [NodeJS.ProcessEnv, string][] = [
    ...[undefined, "", "api", "PRIVATE_MARKER"].map((API_ROLE): [NodeJS.ProcessEnv, string] => [{ ...publicEnv, API_ROLE }, "API_ROLE must be"]),
    ...[
      "SESSION_SECRET",
      "ADMIN_PASSWORD",
      "FEISHU_LOGIN_APP_SECRET",
      "FEISHU_APP_SECRET",
      "FEISHU_ALERT_CHAT_ID",
      "LLM_API_KEY",
      "INGEST_TOKEN",
      "AMP_CREDENTIALS_DIR",
      "DAJIALA_KEY",
      "FEISHU_PUSH_WEBHOOK_URL",
      "DB_BACKUP_STORE_SECRET_KEY",
      "ADMIN_EMAILS",
    ].map((key): [NodeJS.ProcessEnv, string] => [{ ...publicEnv, [key]: "" }, `public-api must not hold ${key}`]),
    [{ ...publicEnv, PUBLIC_RATE_LIMIT_SECRET: undefined }, "PUBLIC_RATE_LIMIT_SECRET"],
    [{ ...publicEnv, PUBLIC_RATE_LIMIT_SECRET: "" }, "PUBLIC_RATE_LIMIT_SECRET"],
    [{ ...privateEnv, SESSION_SECRET: undefined }, "SESSION_SECRET"],
    [{ ...privateEnv, ADMIN_PASSWORD: undefined }, "set ADMIN_PASSWORD"],
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

test("a public production process serves readers and feedback without private secrets or runtime writes", async (t) => {
  const before = await settings();
  const schema = await queueSchema();
  const env = environment("public-api");
  assert.equal(env.SESSION_SECRET, undefined);
  assert.equal(env.ADMIN_PASSWORD, undefined);
  assert.equal(env.IMG_PROXY_SIGN_SECRET, undefined);
  const app = await apiProcess(t, env, ENTRY_ARGS);
  await app.ready();
  assert.equal((await fetch(`${app.url}/api/site/meta`)).status, 200);
  assert.equal((await fetch(`${app.url}/api/auth/options`)).status, 404);
  const feedback = await fetch(`${app.url}/api/site/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.42", "user-agent": "Firefox" },
    body: JSON.stringify({ content: marker }),
  });
  assert.equal(feedback.status, 201);
  const { id } = (await feedback.json()) as { id: number };
  const expected = createHmac("sha256", secrets.PUBLIC_RATE_LIMIT_SECRET).update("203.0.113.42|Firefox").digest("base64url").slice(0, 24);
  assert.equal((await sql`SELECT source_hash FROM feedback WHERE id=${id}`)[0].source_hash, expected);
  await sql`DELETE FROM feedback WHERE id=${id}`;
  assert.deepEqual(await settings(), before);
  assert.equal(await queueSchema(), schema);
  assert.equal(await app.stop(), 0, app.output());
  await noConnections();
});

test("a private production process logs in without public/image secrets and closes its connections", async (t) => {
  const env = environment("private-api");
  assert.equal(env.PUBLIC_RATE_LIMIT_SECRET, undefined);
  assert.equal(env.IMG_PROXY_SIGN_SECRET, undefined);
  const app = await apiProcess(t, env, ENTRY_ARGS);
  await app.ready();
  assert.deepEqual(await (await fetch(`${app.url}/api/auth/options`)).json(), { password: true, feishu: false });
  assert.equal((await fetch(`${app.url}/api/site/meta`)).status, 404);
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
  assert.equal((await sql`SELECT count(*)::int AS n FROM settings WHERE key=${`heartbeat.private-api:${app.port}`}`)[0].n, 1);
  assert.equal(
    (await fetch(`${app.url}/api/auth/logout`, { method: "POST", redirect: "manual", headers: { cookie, "x-csrf-token": principal.csrf } })).status,
    303,
  );
  assert.equal(await app.stop(), 0, app.output());
  await noConnections();
  await sql`DELETE FROM settings WHERE key=${`heartbeat.private-api:${app.port}`}`;
});

test("development public startup warns using names while accepting shared synthetic configuration", async (t) => {
  const app = await apiProcess(
    t,
    { ...environment("public-api"), NODE_ENV: "development", SESSION_SECRET: "PRIVATE_MARKER", LLM_API_KEY: "PRIVATE_MARKER" },
    ENTRY_ARGS,
  );
  await app.ready();
  assert.match(app.output(), /public-api must not hold LLM_API_KEY, SESSION_SECRET/);
  assert.doesNotMatch(app.output(), /PRIVATE_MARKER/);
  assert.equal(await app.stop(), 0, app.output());
  await noConnections();
});
