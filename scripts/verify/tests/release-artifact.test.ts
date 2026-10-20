import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("release artifacts, admission and existing recovery controls retain their required evidence", () => {
  const result = spawnSync("python3", ["-B", "-m", "unittest", "discover", "-s", "deploy", "-p", "test_release_*.py"], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
