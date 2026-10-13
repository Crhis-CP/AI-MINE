import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { test } from "node:test";

// Reuse the real grouping fixtures in this file's isolated database with the smallest worker pool.
// A reader transaction which tries to borrow another connection cannot finish this regression.
test("event root and candidate reads finish with a single database connection", { timeout: 90_000 }, async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_POOL_MAX: "1" };
  delete env.NODE_TEST_CONTEXT;
  const result = await promisify(execFile)(
    process.execPath,
    ["--test", "--test-reporter=spec", "--test-timeout=60000", "--test-name-pattern=root is the fact|two stories.*roots", "tests/events.test.ts"],
    { env, timeout: 80_000, maxBuffer: 1024 * 1024 },
  );
  assert.match(result.stdout, /pass 3/);
});
