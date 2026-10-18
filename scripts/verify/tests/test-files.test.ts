import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runTestFiles, testFailureSummary, testFiles } from "../test-files.ts";
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

test("failure summary excludes later passes and bounds noisy, empty and missing logs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "test-failure-summary-"));
  try {
    const log = path.join(root, "noisy.log"),
      empty = path.join(root, "empty.log");
    writeFileSync(log, `${"irrelevant line\n".repeat(100_000)}${"x".repeat(8_192)}\nactual failure detail\n`);
    writeFileSync(empty, "");
    const summary = testFailureSummary([
      { file: "tests/a-failed.test.ts", log, code: 1 },
      { file: "tests/timeout.test.ts", log: empty, code: 124 },
      { file: "tests/missing-log.test.ts", log: path.join(root, "missing.log"), code: 1 },
      { file: "tests/z-passed.test.ts", log, code: 0 },
    ]);
    assert.match(summary, /3 failed of 4 completed/);
    assert.match(summary, /tests\/a-failed.test.ts \(exit 1\)/);
    assert.match(summary, /tests\/timeout.test.ts \(exit 124\)/);
    assert.match(summary, /actual failure detail/);
    assert.match(summary, /no test output captured/);
    assert.match(summary, /test output unavailable/);
    assert.doesNotMatch(summary, /z-passed|irrelevant line/);
    assert.ok(summary.length < 3_000);
    const many = testFailureSummary(Array.from({ length: 2_000 }, (_, i) => ({ file: `tests/failure-${i}.test.ts`, log, code: 1 })));
    assert.ok(many.slice(0, many.lastIndexOf("Failed test files:")).length < 12_600);
    assert.match(many, /Error excerpts omitted/);
    const lastLines = many.trimEnd().split("\n").slice(-25).join("\n");
    for (let i = 0; i < 2_000; i++) assert.ok(lastLines.includes(`tests/failure-${i}.test.ts (exit 1)`));
    assert.equal(testFailureSummary([{ file: "tests/passed.test.ts", log, code: 0 }]), "");
    assert.equal(testFailureSummary([]), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner ends with failed-file summary after later passes, timeout and cleanup failure", () => {
  const root = mkdtempSync(path.join(tmpdir(), "test-failure-runner-"));
  const runner = new URL("../test-files.ts", import.meta.url).href;
  try {
    mkdirSync(path.join(root, "tests"));
    mkdirSync(path.join(root, "scripts"));
    writeFileSync(path.join(root, "scripts/migrate.ts"), "");
    writeFileSync(path.join(root, "scripts/seed.ts"), "");
    writeFileSync(
      path.join(root, "tests/a-failed.test.ts"),
      `import { appendFileSync } from 'node:fs';
       appendFileSync(process.env.AMP_TEST_RESOURCE_JOURNAL, JSON.stringify({kind:'role',name:process.env.AMP_TEST_RESOURCE_PREFIX+'_role'})+'\\n');
       throw new Error('early failure retained');`,
    );
    writeFileSync(path.join(root, "tests/z-passed.test.ts"), "console.log('later passing file');");
    writeFileSync(path.join(root, "tests/timeout.test.ts"), "setInterval(() => {}, 1000);");
    const runFixture = (files: string[], cleanupFailure = false, timeoutMs = 5_000, abort = false) =>
      spawnSync(
        process.execPath,
        [
          "--experimental-test-module-mocks",
          "--input-type=module",
          "-e",
          `import { mock } from 'node:test';
           import { existsSync, rmSync } from 'node:fs';
           const controller = new AbortController();
           const control = (parts, ...values) => {
             if (typeof parts === 'string') return parts;
             const query = parts.join('?');
             if (query.includes('pg_namespace')) return [{sources:0,receipts:0,queues:0}];
             if (query.includes('count(*)')) return [{n:0}];
             if (${abort} && query.startsWith('CREATE DATABASE') && values[1] !== 'template0') setTimeout(() => controller.abort(), 100);
             if (${cleanupFailure} && query.startsWith('DROP ROLE')) throw new Error('simulated role cleanup failure');
             return [];
           };
           mock.module('@amp/backend/db', { namedExports: { createDatabaseAccess: () => ({ dbFor: () => control, close: async () => console.error('database access closed') }) } });
           const { runTestFiles } = await import(${JSON.stringify(runner)});
           try {
             const code = await runTestFiles(${JSON.stringify(files)}, {
               root: ${JSON.stringify(root)}, timeoutMs: ${timeoutMs}, signal: controller.signal,
               env: { DATABASE_URL:'postgres://localhost/isolated_test', TEST_FILE_CONCURRENCY:'1' }
             });
             console.error('runner exit '+code);
             process.exitCode = code;
           } catch (error) {
             console.error('caught '+error.constructor.name+': '+error.errors.map(e => e.message).join('; '));
             const retained = error.message.match(/resource journal retained at (.+)$/)?.[1];
             if (retained) {
               console.error('resource journal retained: '+existsSync(retained));
               rmSync(retained, {recursive:true,force:true});
             }
             process.exitCode = 1;
           }`,
        ],
        { cwd: path.resolve(import.meta.dirname, "../../.."), encoding: "utf8", timeout: 20_000 },
      );
    const ordinary = runFixture(["tests/a-failed.test.ts", "tests/z-passed.test.ts"]);
    assert.equal(ordinary.status, 1, ordinary.stderr);
    assert.match(ordinary.stdout, /later passing file/);
    assert.match(ordinary.stderr, /1 failed of 2 completed/);
    assert.match(ordinary.stderr, /early failure retained/);
    assert.ok(ordinary.stderr.lastIndexOf("database access closed") < ordinary.stderr.indexOf("Test file failure summary"));
    assert.match(ordinary.stderr, /runner exit 1/);
    assert.match(ordinary.stderr.trimEnd().split("\n").slice(-25).join("\n"), /Failed test files: tests\/a-failed.test.ts \(exit 1\)/);
    const timedOut = runFixture(["tests/timeout.test.ts"], false, 100);
    assert.equal(timedOut.status, 1, timedOut.stderr);
    assert.match(timedOut.stderr, /tests\/timeout.test.ts \(exit 124\)/);
    assert.match(timedOut.stderr, /1 failed of 1 completed/);
    const aborted = runFixture(["tests/timeout.test.ts", "tests/z-passed.test.ts"], false, 5_000, true);
    assert.equal(aborted.status, 130, aborted.stderr);
    assert.match(aborted.stderr, /runner exit 130/);
    assert.doesNotMatch(aborted.stdout, /later passing file/);
    const cleanup = runFixture(["tests/a-failed.test.ts", "tests/z-passed.test.ts"], true);
    assert.equal(cleanup.status, 1, cleanup.stderr);
    assert.match(cleanup.stderr, /1 failed of 2 completed/);
    assert.match(cleanup.stderr, /caught AggregateError: simulated role cleanup failure/);
    assert.match(cleanup.stderr, /resource journal retained: true/);
    assert.ok(cleanup.stderr.indexOf("Test file failure summary") < cleanup.stderr.indexOf("caught AggregateError"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
