import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runTestFiles, testFiles } from "../test-files.ts";
import { openLog, run } from "../lib.ts";

test("file selection rejects omissions, duplicates and escapes before any database connection", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "file-selection-"));
  try {
    mkdirSync(path.join(root, "tests"));
    writeFileSync(path.join(root, "tests/a.test.ts"), "");
    symlinkSync("a.test.ts", path.join(root, "tests/link.test.ts"));
    assert.deepEqual(testFiles(root, ["tests/a.test.ts"]), ["tests/a.test.ts"]);
    for (const files of [["tests/missing.test.ts"], ["tests/a.test.ts", "tests/a.test.ts"], ["../a.test.ts"], ["tests/link.test.ts"]])
      assert.throws(() => testFiles(root, files));
    await assert.rejects(runTestFiles(["tests/a.test.ts"], { root, env: { DATABASE_URL: "postgres://localhost/production" } }), /isolated/);
    await assert.rejects(
      runTestFiles(["tests/a.test.ts"], { root, env: { DATABASE_URL: "postgres://localhost/safe_test", TEST_FILE_CONCURRENCY: "3" } }),
      /1 or 2/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify timeout waits for a test executor's shutdown before returning failure", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "test-shutdown-")),
    marker = path.join(root, "closed");
  try {
    const code = await run(
      process.execPath,
      [
        "-e",
        `process.on('SIGTERM', () => setTimeout(() => { require('fs').writeFileSync(process.argv[1], 'closed'); process.exit(0); }, 100)); setInterval(() => {}, 1000);`,
        marker,
      ],
      {
        log: openLog(path.join(root, "log")),
        env: {},
        timeoutMs: 500,
        shutdownMs: 2_000,
      },
    );
    assert.equal(code, 124);
    assert.equal((await import("node:fs")).readFileSync(marker, "utf8"), "closed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
