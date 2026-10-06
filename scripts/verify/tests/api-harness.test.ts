import assert from "node:assert/strict";
import { chmodSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { parseDocument } from "yaml";
import { assertPublicApiCredentials, environmentProblems } from "@amp/config";
import { webEnvironmentProblems } from "../../../apps/web/runtime-env.ts";
import { apiChildEnvironment, siteChildEnvironments } from "../api-harness.ts";
import { checkApiSplit } from "../api-split.ts";
import { composeEnvironmentProblems } from "../compose-environment.ts";
import { checkRoleConfig } from "../role-config.ts";
import { stopSiteProcesses } from "../site-processes.ts";
import { scratch, write } from "./helpers.ts";
import { ROOT } from "../lib.ts";

const input = {
  PATH: "/test/bin",
  DATABASE_URL: "postgres://fixture@127.0.0.1:1/harness_test",
  SITE_URL: "http://127.0.0.1:3100",
  API_PORT: "0",
  PUBLIC_RATE_LIMIT_SECRET: "public-fixture-key",
  SESSION_SECRET: "session-fixture-key",
  ADMIN_PASSWORD: "admin-fixture-password",
  HTTP_PROXY: "PRIVATE_MARKER",
  https_proxy: "PRIVATE_MARKER",
  LLM_API_KEY: "PRIVATE_MARKER",
  DAJIALA_KEY: "PRIVATE_MARKER",
  AMP_CREDENTIALS_DIR: "PRIVATE_MARKER",
  DATABASE_URL_WORKER: "PRIVATE_MARKER",
  DEV_AUTH_ROLE: "PRIVATE_MARKER",
};
test("API child environments retain explicit test identity and only their own secrets", () => {
  for (const role of ["public-api", "private-api"] as const) {
    const env = apiChildEnvironment(role, input);
    assert.equal(env.API_ROLE, role);
    assert.equal(env.API_PORT, "0");
    assert.equal(env.DATABASE_URL, input.DATABASE_URL);
    assert.equal(env.MODEL_CALLS_ENABLED, "false");
    assert.ok(!Object.values(env).includes("PRIVATE_MARKER"));
    assert.deepEqual(environmentProblems(role, env), []);
    if (role === "public-api") {
      assert.equal(env.PUBLIC_RATE_LIMIT_SECRET, input.PUBLIC_RATE_LIMIT_SECRET);
      for (const name of ["SESSION_SECRET", "ADMIN_PASSWORD", "AMP_CREDENTIALS_DIR"]) assert.equal(env[name], undefined);
      assert.doesNotThrow(() => assertPublicApiCredentials(env));
    } else {
      assert.equal(env.SESSION_SECRET, input.SESSION_SECRET);
      assert.equal(env.ADMIN_PASSWORD, input.ADMIN_PASSWORD);
      assert.equal(env.PUBLIC_RATE_LIMIT_SECRET, undefined);
    }
  }
  assert.equal(apiChildEnvironment("public-api", { DATABASE_URL: input.DATABASE_URL }).PUBLIC_RATE_LIMIT_SECRET, undefined);
  assert.equal(apiChildEnvironment("public-api", { ...input, NODE_ENV: "development" }).NODE_ENV, "development");
  assert.throws(() => apiChildEnvironment("public-api", { DATABASE_URL: "postgres://fixture@localhost/production" }), /DATABASE_URL/);
});
test("the three-process fixture uses distinct local endpoints and never adopts caller auth material", () => {
  const envs = siteChildEnvironments({ ...input, API_BASE_URL: "http://127.0.0.1:3101", PRIVATE_API_BASE_URL: "http://127.0.0.1:3102" });
  assert.equal(envs["public-api"].API_PORT, "3101");
  assert.equal(envs["private-api"].API_PORT, "3102");
  assert.equal(envs.web.WEB_PORT, "3100");
  assert.equal(envs.web.PRIVATE_HOST, "private.localhost");
  assert.equal(envs["private-api"].PRIVATE_HOST, envs.web.PRIVATE_HOST);
  assert.equal(envs.web.PRIVATE_API_BASE_URL, "http://127.0.0.1:3102");
  assert.notEqual(envs["private-api"].SESSION_SECRET, input.SESSION_SECRET);
  assert.notEqual(envs["public-api"].PUBLIC_RATE_LIMIT_SECRET, input.PUBLIC_RATE_LIMIT_SECRET);
  assert.deepEqual(webEnvironmentProblems(envs.web), []);
  const validate = spawnSync(process.execPath, [`${ROOT}/scripts/verify/site-process.ts`, "validate"], {
    env: { DATABASE_URL: input.DATABASE_URL },
    timeout: 2000,
  });
  assert.equal(validate.error, undefined);
  assert.equal(validate.status, 0);
  assert.throws(() => siteChildEnvironments({ ...input, PRIVATE_API_BASE_URL: input.SITE_URL }), /distinct/);
  const credentialed = new URL("http://localhost:3001");
  credentialed.username = "user";
  credentialed.password = "PRIVATE_MARKER";
  for (const value of ["PRIVATE_MARKER", "https://example.test", credentialed.href]) {
    assert.throws(
      () => siteChildEnvironments({ ...input, API_BASE_URL: value }),
      (error: Error) => !error.message.includes("PRIVATE_MARKER"),
    );
  }
});
test("public Compose validation is explicit, expands inherited configuration, and does not expose values", () => {
  const inspect = (text: string) => composeEnvironmentProblems(parseDocument(text, { merge: true }).toJS(), "public-api");
  assert.deepEqual(inspect("services: {public-api: {environment: {API_ROLE: public-api, PUBLIC_RATE_LIMIT_SECRET: fixture, INDEXNOW_KEY: fixture}}}"), []);
  assert.deepEqual(inspect("services: {public-api: {environment: [API_ROLE=public-api, PUBLIC_RATE_LIMIT_SECRET=fixture]}}"), []);
  const bad = inspect(
    "x-common: &common {env_file: .env, environment: {API_ROLE: public-api, PUBLIC_RATE_LIMIT_SECRET: fixture, SESSION_SECRET: PRIVATE_MARKER}}\nservices: {public-api: {<<: *common}}",
  );
  assert.ok(bad.some((p) => p.includes("env_file")) && bad.some((p) => p.includes("SESSION_SECRET")));
  assert.ok(!bad.join().includes("PRIVATE_MARKER"));
  for (const entry of ["SESSION_SECRET=", "LLM_API_KEY=PRIVATE_MARKER", "AMP_CREDENTIALS_DIR", "HTTP_PROXY="]) {
    const errors = inspect(`services: {public-api: {environment: [API_ROLE=public-api, PUBLIC_RATE_LIMIT_SECRET=fixture, ${entry}]}}`);
    assert.ok(errors.some((p) => p.includes("must not hold")) && !errors.join().includes("PRIVATE_MARKER"));
  }
  for (const text of ["services: {}", "services: {public-api: {}}", "services: {public-api: {environment: [API_ROLE=private-api, PUBLIC_RATE_LIMIT_SECRET]}}"])
    assert.ok(inspect(text).length);
});
test("the full Compose check can require both services before activation changes its default", () => {
  const dir = scratch();
  write(dir, { "docker-compose.yml": "services: {web: {image: web}}" });
  assert.ok(checkRoleConfig(dir).some((p) => p.includes("public-api service is missing")));
  assert.ok(checkRoleConfig(dir, ["web", "public-api"]).some((p) => p.includes("public-api service is missing")));
  write(dir, { "docker-compose.yml": "services: {web: {image: web}, public-api: {environment: {API_ROLE: public-api, PUBLIC_RATE_LIMIT_SECRET: fixture}}}" });
  assert.deepEqual(checkRoleConfig(dir, ["web", "public-api"]), []);
});
test("cleanup waits for all three owned processes and kills a child that ignores termination", async (t) => {
  const children = [false, false, true].map((ignore) =>
    spawn(process.execPath, ["-e", `process.on('SIGTERM', () => ${ignore ? "{}" : "process.exit(0)"}); console.log('ready'); setInterval(() => {}, 1000);`], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: {},
    }),
  );
  t.after(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  await Promise.all(children.map((child) => new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()))));
  // Long enough for the two children that exit on SIGTERM to do so on a busy machine; the one that ignores it is still killed when the wait runs out.
  await stopSiteProcesses(children, 3000);
  assert.equal(children[0].exitCode, 0);
  assert.equal(children[1].exitCode, 0);
  assert.equal(children[2].signalCode, "SIGKILL");
});
test("the shared HTTP probe checks actual positive and reverse routes, health JSON and login options", async (t) => {
  const servers: Server[] = [];
  const seen: string[] = [];
  let broken = false;
  const urls = await Promise.all(
    ["public", "private", "web"].map(async (role) => {
      const server = createServer((req, res) => {
        const health = req.url === "/api/health" && role !== "web";
        const auth = req.url === "/api/auth/options" && (role === "private" || (role === "web" && req.headers.host === "private.example.test"));
        const reader = req.url === "/api/site/meta" && role === "public";
        if (auth) seen.push(String(role === "web" ? req.headers.host : req.headers["x-forwarded-host"]));
        res.writeHead(health || auth || reader ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(health ? { ok: true, db: "ok" } : auth ? { password: !broken, feishu: false } : {}));
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    }),
  );
  t.after(() => Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve())))));
  const targets = { publicUrl: urls[0]!, privateUrl: urls[1]!, webUrl: urls[2]!, privateHost: "private.example.test" };
  assert.deepEqual(await checkApiSplit(targets), []);
  assert.deepEqual(seen.sort(), ["private.example.test", "private.example.test"]);
  broken = true;
  assert.ok((await checkApiSplit(targets)).some((p) => p.includes("invalid fixture login options")));
  const wrong = await checkApiSplit({ ...targets, privateUrl: targets.publicUrl });
  assert.ok(wrong.some((p) => p.startsWith("private auth")) && wrong.some((p) => p.startsWith("private reader absent")));
});

test("Caddy startup strips only the optional configured port using safe Compose shell arguments", () => {
  const document = parseDocument(readFileSync(`${ROOT}/docker-compose.yml`, "utf8")).toJS();
  const [program, ...args] = document.services.caddy.command as string[];
  const dir = scratch();
  write(dir, { caddy: '#!/bin/sh\nprintf "%s\\n" "$PRIVATE_HOSTNAME"\n' });
  chmodSync(`${dir}/caddy`, 0o700);
  for (const [authority, expected] of [
    ["private.test", "private.test"],
    ["PRIVATE.test:8443", "PRIVATE.test"],
    ["[::1]", "[::1]"],
    ["[::1]:8443", "[::1]"],
    ["private.test:$(exit 9)", "private.test"],
  ]) {
    const result = spawnSync(
      program!,
      args.map((value) => value.replaceAll("$$", "$")),
      { env: { PATH: dir, PRIVATE_HOST: authority }, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }
});
