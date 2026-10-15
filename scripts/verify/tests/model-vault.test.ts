import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("release model-vault setup preserves existing and rollback keys without exposing them", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const result = spawnSync("python3", ["-B", "-m", "unittest", "discover", "-s", "deploy", "-p", "test_model_vault.py"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stdout, "", "setup verification does not print secret values");
});
