import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

test("init-env creates an independent public secret only in fresh temporary directories and refuses overwrite", (t) => {
  const keys: string[] = [];
  for (let i = 0; i < 2; i++) {
    const dir = mkdtempSync(path.join(tmpdir(), "amp-api-init-test-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    copyFileSync(new URL("../.env.example", import.meta.url), path.join(dir, ".env.example"));
    const run = () =>
      spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/init-env.ts", import.meta.url))], {
        cwd: dir,
        env: { PATH: process.env.PATH },
        encoding: "utf8",
        timeout: 10_000,
      });
    const first = run();
    assert.equal(first.error, undefined);
    assert.equal(first.status, 0, first.stderr);
    const target = path.join(dir, ".env");
    const generated = readFileSync(target);
    const env = parseEnv(generated.toString());
    const key = env.PUBLIC_RATE_LIMIT_SECRET;
    assert.ok(typeof key === "string" && /^[0-9a-f]{64}$/.test(key), "PUBLIC_RATE_LIMIT_SECRET must contain 32 random bytes");
    assert.ok(key !== env.SESSION_SECRET && key !== env.IMG_PROXY_SIGN_SECRET, "public and private secrets must be independent");
    assert.ok(!first.stdout.includes(key) && !first.stderr.includes(key), "the public key must not be logged");
    assert.equal(statSync(target).mode & 0o777, 0o600);
    const template = parseEnv(readFileSync(path.join(dir, ".env.example"), "utf8"));
    const generatedKeys = new Set(["ADMIN_PASSWORD", "SESSION_SECRET", "IMG_PROXY_SIGN_SECRET", "POSTGRES_PASSWORD", "PUBLIC_RATE_LIMIT_SECRET"]);
    for (const [name, value] of Object.entries(template)) if (!generatedKeys.has(name)) assert.equal(env[name], value, name);
    keys.push(key);
    const second = run();
    assert.equal(second.error, undefined);
    assert.equal(second.status, 1);
    assert.ok(readFileSync(target).equals(generated), "an existing generated test .env must remain byte-identical");
    assert.ok(!second.stdout.includes(key) && !second.stderr.includes(key));
  }
  assert.ok(keys[0] !== keys[1], "each generated environment must receive a fresh public key");
});
