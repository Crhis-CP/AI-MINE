import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { webEnvironment } from "../apps/web/runtime-env.ts";

const call = `import { feedbackSourceHash as hash } from '@amp/backend/operations/feedback';`;
const run = (code: string, extra: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, ["--input-type=module", "-e", call + code], {
    env: {
      ...webEnvironment(process.env),
      NODE_ENV: "production",
      PUBLIC_RATE_LIMIT_SECRET: "synthetic-public-secret",
      SESSION_SECRET: "synthetic-private-secret",
      ...extra,
    },
    encoding: "utf8",
    timeout: 10_000,
  });

test("feedback identity depends on the public key and is unchanged by session-key rotation", () => {
  const result = run(`
    const first=hash('127.0.0.1','Firefox');
    process.env.SESSION_SECRET='different-private';
    if (hash('127.0.0.1','Firefox')!==first) process.exit(2);
    process.env.PUBLIC_RATE_LIMIT_SECRET='different-public-secret';
    if (hash('127.0.0.1','Firefox')===first) process.exit(3);`);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test("missing or empty production public keys never fall back to the private key or a constant", () => {
  for (const key of [undefined, "", " "]) {
    const result = run("hash('127.0.0.1','Firefox');", { PUBLIC_RATE_LIMIT_SECRET: key });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /PUBLIC_RATE_LIMIT_SECRET is required in production/);
    assert.doesNotMatch(result.stderr, /synthetic-private-secret|synthetic-public-secret/);
  }
});

test("the public production entrypoint requires its key before listening", () => {
  const result = spawnSync(process.execPath, ["apps/api/src/main.ts"], {
    env: {
      ...webEnvironment(process.env),
      API_ROLE: "public-api",
      NODE_ENV: "production",
      DATABASE_URL: "postgres://postgres@127.0.0.1:1/feedback_secret_test",
      API_PORT: "0",
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Refusing to start in production: PUBLIC_RATE_LIMIT_SECRET/);
  assert.doesNotMatch(result.stderr, /ECONNREFUSED/);
});

test("missing development public keys use the stable existing fallback and warn once with the key name", () => {
  const result = run("if(hash('127.0.0.1','Firefox')!==hash('127.0.0.1','Firefox')) process.exit(2);", {
    NODE_ENV: "development",
    PUBLIC_RATE_LIMIT_SECRET: "",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.match(/PUBLIC_RATE_LIMIT_SECRET is missing/g)?.length, 1);
  assert.match(result.stderr, /using the development feedback secret/);
  assert.doesNotMatch(result.stderr, /synthetic-private-secret/);
});
