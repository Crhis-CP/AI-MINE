// tasks and format-lint: a task card with missing or invalid fields is stopped; lint warnings above the
// baseline are stopped, and so are counts below it until the baseline is rewritten.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { compareWarnings } from "../lint.ts";
import { checkCard, checkTasks, known, renderIndex } from "../tasks.ts";

const k = known();
const card = (fields: string) => `---\n${fields}\n---\n\n## 背景\n`;
const valid = [
  "id: TASK-0042",
  "wbs: T-0001",
  "lane: web",
  "title: 读者站首页按北京时间分组",
  "milestone: M1",
  "specs: [AC-M0-08]",
  "allowed_paths: [apps/web/app/features/feed/**]",
  "verify: [make verify]",
  "contracts: { change: none }",
  "base_sha: 3a0541719eba4f73de168fc55dd22cfad07d372b",
].join("\n");

test("a complete card passes", () => {
  assert.deepEqual(checkCard("TASK-0042.md", card(valid), k), []);
});

test("missing and invalid fields are each reported", () => {
  const bad = card(
    [
      "id: TASK-0042",
      "wbs: T-9999",
      "lane: marketing",
      "milestone: M9",
      "specs: [AC-XX-99]",
      "allowed_paths: []",
      "contracts: { change: maybe }",
      "base_sha: main",
      "budget: { model_calls: 10, cny_limit: 15 }",
    ].join("\n"),
  );
  assert.deepEqual(checkCard("TASK-0042.md", bad, k), [
    "TASK-0042.md: wbs T-9999 is not in docs/06-agents/02-roadmap-and-wbs.md",
    "TASK-0042.md: lane marketing is not in lanes.yaml",
    "TASK-0042.md: title is missing",
    "TASK-0042.md: milestone must be M0–M5",
    "TASK-0042.md: spec AC-XX-99 does not appear anywhere in docs/",
    "TASK-0042.md: allowed_paths needs at least one path",
    "TASK-0042.md: verify needs at least one acceptance command",
    "TASK-0042.md: contracts.change must be none, additive or breaking",
    "TASK-0042.md: base_sha must be a full 40-character commit",
    "TASK-0042.md: cny_limit was removed (BR-COST-15): budgets count calls, not money",
  ]);
  assert.deepEqual(checkCard("TASK-0043.md", card(valid), k), ["TASK-0043.md: id must be TASK-nnnn and match the file name (got TASK-0042)"]);
  assert.deepEqual(checkCard("TASK-0042.md", "# no front matter\n", k), ["TASK-0042.md: no YAML front matter (--- … ---) at the top"]);
});

test("lint warnings may only go down, and the baseline follows", () => {
  const baseline = { "a.ts": { "lint/x": 2 } };
  assert.deepEqual(compareWarnings({ "a.ts": { "lint/x": 2 } }, baseline), []);
  assert.deepEqual(compareWarnings({ "a.ts": { "lint/x": 2 }, "b.ts": { "lint/y": 1 } }, baseline), ["b.ts: lint/y 1 warnings, 0 allowed — fix the new ones"]);
  assert.deepEqual(compareWarnings({ "a.ts": { "lint/x": 1 } }, baseline), [
    "a.ts: lint/x down from 2 to 1 — rewrite the list: node scripts/verify/lint.ts --write",
  ]);
});

test("environment reads are warned only in the approved backend scope", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "aimine-lint-scope-"));
  const cases = [
    ["packages/backend/src/config.ts", true],
    ["apps/api/src/main.ts", true],
    ["apps/worker/src/main.ts", true],
    ["packages/backend/src/process-config.ts", false],
    ["apps/web/server.ts", false],
    ["scripts/migrate.ts", false],
    ["tests/config.test.ts", false],
  ] as const;
  try {
    copyFileSync("biome.jsonc", path.join(directory, "biome.jsonc"));
    for (const [file] of cases) {
      mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      writeFileSync(path.join(directory, file), "export const value = process.env.EXAMPLE;\n");
    }
    const result = spawnSync("npm", ["exec", "--", "biome", "lint", `--config-path=${directory}`, "--vcs-enabled=false", "--reporter=json", directory], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const diagnostics = JSON.parse(result.stdout).diagnostics as { category: string; location: { path: string } }[];
    for (const [file, warned] of cases) {
      assert.equal(
        diagnostics.some((d) => d.category === "lint/style/noProcessEnv" && d.location.path.endsWith(file)),
        warned,
        file,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live and accepted task states require usable evidence references", () => {
  const credential = new URL("https://example.com/proof");
  credential.username = "fixture-user";
  credential.password = "fixture-password";
  for (const status of ["live_verified", "quality_accepted"]) {
    const text = `${valid}\nstatus: ${status}`;
    for (const evidence of ["", "\nevidence: []", "\nevidence: [null]", "\nevidence: ['']"])
      assert.match(checkCard("TASK-0042.md", card(text + evidence), k).join("\n"), /requires evidence/);
    for (const ref of ["docs/missing-proof.md", "tasks", "../outside.md", "https://", credential.href])
      assert.ok(checkCard("TASK-0042.md", card(`${text}\nevidence: [${JSON.stringify(ref)}]`), k).length, ref);
    for (const ref of ["docs/acceptance/release-polish-20261014/README.md", "https://example.com/release/42"])
      assert.deepEqual(checkCard("TASK-0042.md", card(`${text}\nevidence: [${JSON.stringify(ref)}]`), k), []);
  }
  assert.deepEqual(checkCard("TASK-0042.md", card(`${valid}\nstatus: locally_verified\nevidence: []`), k), []);
});

test("index detects missing cards and changed states without depending on commit history", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aimine-task-index-"));
  try {
    mkdirSync(path.join(root, "tasks"));
    mkdirSync(path.join(root, "docs/06-agents"), { recursive: true });
    writeFileSync(path.join(root, "lanes.yaml"), "lanes: {web: {}}\n");
    writeFileSync(path.join(root, "docs/06-agents/02-roadmap-and-wbs.md"), "T-0001 AC-M0-08\n");
    writeFileSync(path.join(root, "tasks/TASK-0042.md"), card(valid));
    assert.match(checkTasks(root).problems.join("\n"), /INDEX.md is stale/);
    writeFileSync(path.join(root, "tasks/INDEX.md"), renderIndex(root));
    assert.deepEqual(checkTasks(root).problems, []);
    writeFileSync(path.join(root, "tasks/TASK-0042.md"), card(`${valid}\nstatus: locally_verified`));
    assert.match(checkTasks(root).problems.join("\n"), /INDEX.md is stale/);
    writeFileSync(path.join(root, "tasks/INDEX.md"), renderIndex(root));
    writeFileSync(path.join(root, "tasks/TASK-0043.md"), card(valid.replace("TASK-0042", "TASK-0043")));
    assert.match(checkTasks(root).problems.join("\n"), /INDEX.md is stale/);
    writeFileSync(path.join(root, "tasks/INDEX.md"), renderIndex(root));
    assert.deepEqual(checkTasks(root).problems, []);
    assert.equal(renderIndex(root), renderIndex(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
