import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("owner preview only forwards authenticated public reads", () => {
  execFileSync(process.execPath, ["--test", "deploy/preview/reader.test.mjs"]);
});
