// path-guard: a PR may only change what its task card allows and its lane may write; the card and lanes.yaml
// are read from the base commit, so a PR cannot widen its own paths.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ROOT } from "../lib.ts";
import { cardFromBranch, pathGuard } from "../path-guard.ts";
import { repo, scratch } from "./helpers.ts";

const lanes = readFileSync(path.join(ROOT, "lanes.yaml"), "utf8");
const card = (allowed: string[]) =>
  ["---", "id: TASK-0042", "lane: web", "allowed_paths:", ...allowed.map((p) => `  - "${p}"`), 'integration_owner: ""', "---", ""].join("\n");

test("a change outside the card's paths or the lane's ownership is stopped", () => {
  const dir = scratch();
  const [base, head] = repo(dir, [
    { "lanes.yaml": lanes, "tasks/TASK-0042.md": card(["apps/web/app/features/**", "packages/domains/sources/**"]) },
    { "apps/web/app/features/feed.tsx": "export {};\n", "packages/domains/sources/src/rss.ts": "export {};\n", "apps/api/src/app.ts": "export {};\n" },
  ]);
  const r = pathGuard(base, head, "TASK-0042", dir);
  assert.equal(r.status, "fail");
  assert.deepEqual(r.lines.sort(), ["apps/api/src/app.ts: not in the task card's allowed_paths", "packages/domains/sources/src/rss.ts: owned by lane sources"]);
});

test("widening the card inside the same PR does not help: the base version counts", () => {
  const dir = scratch();
  const [base, head] = repo(dir, [
    { "lanes.yaml": lanes, "tasks/TASK-0042.md": card(["apps/web/app/features/**"]) },
    { "tasks/TASK-0042.md": card(["**"]), "package.json": "{}\n" },
  ]);
  const r = pathGuard(base, head, "TASK-0042", dir);
  assert.equal(r.status, "fail");
  assert.ok(r.lines.includes("package.json: not in the task card's allowed_paths"));
});

test("changes inside the card and the lane pass; a missing card fails; a base without lanes.yaml is the bootstrap", () => {
  const dir = scratch();
  const [base, head] = repo(dir, [
    { "lanes.yaml": lanes, "tasks/TASK-0042.md": card(["apps/web/app/features/**", "changes/**"]) },
    { "apps/web/app/features/feed.tsx": "export {};\n", "changes/TASK-0042-feed.md": "x\n" },
  ]);
  assert.equal(pathGuard(base, head, "TASK-0042", dir).status, "pass");
  assert.equal(pathGuard(base, head, null, dir).status, "fail");
  assert.equal(pathGuard(base, head, "TASK-0043", dir).status, "fail");

  const boot = scratch();
  const [b0, b1] = repo(boot, [{ "README.md": "x\n" }, { "anything.ts": "export {};\n" }]);
  assert.equal(pathGuard(b0, b1, null, boot).status, "skipped");
});

test("the task card is found from the branch name", () => {
  assert.equal(cardFromBranch("agent/sources/TASK-0012-rss-fixtures"), "TASK-0012");
  assert.equal(cardFromBranch("feature/whatever"), null);
});
