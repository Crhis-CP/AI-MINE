import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { webEnvironment } from "../apps/web/runtime-env.ts";

const base = webEnvironment(process.env);
const run = (args: string[], env: Record<string, string>) => spawnSync(process.execPath, args, { env: { ...base, ...env }, encoding: "utf8", timeout: 10_000 });

test("web rejects polluted environments before loading SSR or listening", () => {
  for (const [name, value] of [
    ["DATABASE_URL", ""],
    ["NEW_SERVICE_TOKEN", "PRIVATE_MARKER"],
    ["https_proxy", ""],
  ]) {
    const result = run(["apps/web/server.ts"], { NODE_ENV: "production", WEB_PORT: "0", [name!]: value! });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`web must not hold ${name}`));
    assert.ok(!result.stderr.includes("PRIVATE_MARKER"));
    assert.ok(!result.stdout.includes("web started"));
  }
  const clean = webEnvironment({ PATH: "/test/path", DATABASE_URL: "PRIVATE_MARKER", https_proxy: "PRIVATE_MARKER", FUTURE_TOKEN: "PRIVATE_MARKER" });
  assert.deepEqual(clean, { PATH: "/test/path" });
});

test("development login and production login requirements depend on NODE_ENV, not the deployment label", () => {
  for (const production of [true, false]) {
    const result = run(
      [
        "--input-type=module",
        "-e",
        `
      import { sessionPrincipal } from '@amp/backend/admin/auth';
      const principal = await sessionPrincipal(undefined);
      if (${production} ? principal !== null : principal?.dev !== true) process.exit(1);
    `,
      ],
      { NODE_ENV: production ? "production" : "development", AMP_ENVIRONMENT: production ? "development" : "production", DEV_AUTH_ROLE: "admin" },
    );
    assert.equal(result.status, 0, result.stderr);
  }
  const result = run(["apps/api/src/main.ts"], {
    API_ROLE: "private-api",
    NODE_ENV: "production",
    AMP_ENVIRONMENT: "development",
    DATABASE_URL: "postgres://postgres@127.0.0.1:1/environment_test",
    SESSION_SECRET: "process-test-session-0123456789",
    API_PORT: "0",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("set ADMIN_PASSWORD"));
});
