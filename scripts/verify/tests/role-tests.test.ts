import assert from "node:assert/strict";
import { test } from "node:test";
import { backendTestGroups, partitionBackendTests, ROLE_TEST_FILES, runRoleTests } from "../role-tests.ts";
import { ROOT } from "../lib.ts";

test("all backend tests belong to exactly one group and missing role coverage fails closed", () => {
  const files = [...ROLE_TEST_FILES, "tests/db-handles.test.ts", "tests/feedback.test.ts"];
  const grouped = partitionBackendTests(files);
  assert.deepEqual(grouped.role, [...ROLE_TEST_FILES]);
  assert.deepEqual(grouped.backend, ["tests/db-handles.test.ts", "tests/feedback.test.ts"]);
  assert.deepEqual([...grouped.role, ...grouped.backend].sort(), files.toSorted());
  assert.ok(grouped.role.every((file) => !grouped.backend.includes(file)));
  assert.throws(() => partitionBackendTests(files.slice(1)), /Missing required/);
  assert.throws(() => partitionBackendTests([...files, files[0]]), /unique/);
  assert.throws(() => partitionBackendTests([...files, "tests/nested/hidden.test.ts"]), /top-level/);
  const actual = backendTestGroups(ROOT);
  assert.ok(actual.backend.length > 0);
  assert.ok(actual.role.every((file) => !actual.backend.includes(file)));
});

test("quick runs only pure planning even when a database is present; full without a database stays skipped", async () => {
  const calls: string[][] = [];
  const execute = async (files: readonly string[]) => {
    calls.push([...files]);
    return 0;
  };
  for (const hasDatabase of [false, true]) {
    const result = await runRoleTests({ quick: true, hasDatabase, execute });
    assert.equal(result.status, "pass");
    assert.deepEqual(calls.at(-1), [ROLE_TEST_FILES[0]]);
  }
  assert.equal((await runRoleTests({ quick: false, hasDatabase: false, execute })).status, "skipped");
  assert.equal(calls.length, 2, "no matrix process is started without a database");
});

test("full dispatches the complete matrix once and propagates its failure to role-config", async () => {
  let calls = 0;
  for (const code of [0, 1]) {
    const result = await runRoleTests({
      quick: false,
      hasDatabase: true,
      execute: async (files) => {
        calls++;
        assert.deepEqual(files, ROLE_TEST_FILES);
        return code;
      },
    });
    assert.equal(result.status, code === 0 ? "pass" : "fail");
  }
  assert.equal(calls, 2);
});
