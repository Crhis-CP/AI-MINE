import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { recordResources, resourcePrefix } from "../../../tests/test-resources.ts";

test("resource journals accept only their file namespace and direct tests preserve their names", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "resource-journal-"));
  const keys = ["AMP_TEST_RESOURCE_PREFIX", "AMP_TEST_RESOURCE_JOURNAL"] as const;
  const saved = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(resourcePrefix("existing_fixture"), "existing_fixture");
    recordResources("database", ["direct_test"]);
    process.env.AMP_TEST_RESOURCE_PREFIX = "tf_0123456789_0";
    process.env.AMP_TEST_RESOURCE_JOURNAL = path.join(dir, "resources.jsonl");
    const prefix = resourcePrefix("unused");
    assert.match(prefix, /^tf_0123456789_0_[a-f0-9]{8}$/);
    recordResources("database", [`${prefix}_test`]);
    recordResources("role", [`${prefix}_worker`]);
    const content = readFileSync(process.env.AMP_TEST_RESOURCE_JOURNAL, "utf8");
    assert.deepEqual(
      content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      [
        { kind: "database", name: `${prefix}_test` },
        { kind: "role", name: `${prefix}_worker` },
      ],
    );
    for (const name of ["other_test", `${prefix}_unsafe;`, `${prefix}_${"x".repeat(63)}`]) assert.throws(() => recordResources("database", [name]), /Unowned/);
    assert.equal(readFileSync(process.env.AMP_TEST_RESOURCE_JOURNAL, "utf8"), content);
  } finally {
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
