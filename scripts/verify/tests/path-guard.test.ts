// path-guard: a PR may only change what its task card allows and its lane may write. The card may arrive with
// the work; for guarded paths (deployment, the checks, migrations, prompts) it must already be on the base, so
// a PR cannot open those for itself.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ROOT } from "../lib.ts";
import { parse } from "yaml";
import { cardFromBranch, pathGuard } from "../path-guard.ts";
import { repo, scratch } from "./helpers.ts";

const lanes = readFileSync(path.join(ROOT, "lanes.yaml"), "utf8");
const card = (allowed: string[], lane = "web") =>
  ["---", "id: TASK-0042", `lane: ${lane}`, "allowed_paths:", ...allowed.map((p) => `  - "${p}"`), 'integration_owner: ""', "---", ""].join("\n");

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

test("a card that arrives with the work covers ordinary paths, inside its own list and its lane", () => {
  const dir = scratch();
  const [base, head, outside, listed] = repo(dir, [
    { "lanes.yaml": lanes },
    { "tasks/TASK-0042.md": card(["apps/web/app/features/**"]), "apps/web/app/features/feed.tsx": "export {};\n" },
    { "apps/api/src/app.ts": "export {};\n", "packages/domains/sources/src/rss.ts": "export {};\n" },
    { "tasks/TASK-0042.md": card(["apps/web/app/features/**", "apps/api/**", "packages/domains/sources/**"]) },
  ]);
  assert.deepEqual(pathGuard(base, head, "TASK-0042", dir), {
    status: "pass",
    lines: ["2 changed files within TASK-0042 (lane web; the card arrives in this change)"],
  });
  // The card it brings is still the limit, and listing a path does not move it into the lane.
  assert.deepEqual(pathGuard(base, outside, "TASK-0042", dir).lines.sort(), [
    "apps/api/src/app.ts: not in the task card's allowed_paths",
    "packages/domains/sources/src/rss.ts: not in the task card's allowed_paths",
  ]);
  assert.deepEqual(pathGuard(base, listed, "TASK-0042", dir).lines.sort(), [
    "apps/api/src/app.ts: integrator territory (no lane owns it): the card needs an integration_owner",
    "packages/domains/sources/src/rss.ts: owned by lane sources",
  ]);
});

test("a card that arrives with the work does not open guarded paths: that card must be on the base first", () => {
  const dir = scratch();
  const open = card(["apps/web/app/features/**", "deploy/**", "database/migrations/**", "modules/*/migrations/**", "scripts/verify/**"], "architect");
  const [base, head] = repo(dir, [
    { "lanes.yaml": lanes },
    {
      "tasks/TASK-0042.md": open,
      "apps/web/app/features/feed.tsx": "export {};\n",
      "deploy/release.sh": "#!/bin/sh\n",
      "database/migrations/0999_x.sql": "SELECT 1;\n",
      "modules/metals/migrations/0999_y.sql": "SELECT 1;\n",
      "scripts/verify/path-guard.ts": "export {};\n",
    },
  ]);
  const r = pathGuard(base, head, "TASK-0042", dir);
  assert.equal(r.status, "fail");
  assert.deepEqual(
    r.lines.sort(),
    ["database/migrations/0999_x.sql", "deploy/release.sh", "modules/metals/migrations/0999_y.sql", "scripts/verify/path-guard.ts"].map(
      (f) => `${f}: guarded path, and tasks/TASK-0042.md is not on the base commit yet: merge a PR that only adds the card first`,
    ),
  );

  // With the same card already on the base, the same change passes.
  const merged = scratch();
  const [b, h] = repo(merged, [
    { "lanes.yaml": lanes, "tasks/TASK-0042.md": open },
    { "apps/web/app/features/feed.tsx": "export {};\n", "deploy/release.sh": "#!/bin/sh\n", "database/migrations/0999_x.sql": "SELECT 1;\n" },
  ]);
  assert.equal(pathGuard(b, h, "TASK-0042", merged).status, "pass");
});

test("widening the card in the same PR works for ordinary paths and not for guarded ones (PIT-108)", () => {
  const dir = scratch();
  const [base, head] = repo(dir, [
    { "lanes.yaml": lanes, "tasks/TASK-0042.md": card(["apps/web/app/features/feed.tsx"], "architect") },
    {
      "tasks/TASK-0042.md": card(["apps/web/app/features/**", "deploy/**"], "architect"),
      "apps/web/app/features/hot.tsx": "export {};\n",
      "deploy/release.sh": "#!/bin/sh\n",
    },
  ]);
  const r = pathGuard(base, head, "TASK-0042", dir);
  assert.deepEqual(r, {
    status: "fail",
    lines: [
      "deploy/release.sh: guarded path, and the card on the base commit does not list it: land the card change first in a PR that changes only tasks/TASK-0042.md (PIT-108)",
    ],
  });
});

test("the guarded list is the base's: a PR cannot shorten it for itself, and a base without one gets the built-in list", () => {
  const own = `${lanes.replace(/^guarded:\n(?:[ \t]+-.*\n)+/m, "")}\nguarded:\n  - "apps/web/app/features/secret/**"\n`;
  assert.deepEqual((parse(own) as { guarded: string[] }).guarded, ["apps/web/app/features/secret/**"]);
  const dir = scratch();
  const [base, head] = repo(dir, [
    { "lanes.yaml": own },
    {
      "lanes.yaml": own.replace("apps/web/app/features/secret/**", "nothing/**"),
      "tasks/TASK-0042.md": card(["apps/web/app/features/**", "lanes.yaml", "deploy/**"], "architect"),
      "apps/web/app/features/secret/key.ts": "export {};\n",
      "deploy/release.sh": "#!/bin/sh\n",
    },
  ]);
  // The base's list names one path; deploy/** is ordinary there, lanes.yaml too.
  assert.deepEqual(pathGuard(base, head, "TASK-0042", dir).lines, [
    "apps/web/app/features/secret/key.ts: guarded path, and tasks/TASK-0042.md is not on the base commit yet: merge a PR that only adds the card first",
  ]);

  const bare = scratch();
  const none = lanes.replace(/^guarded:\n(?:[ \t]+-.*\n)+/m, "");
  assert.equal((parse(none) as { guarded?: string[] }).guarded, undefined);
  const [b, h] = repo(bare, [{ "lanes.yaml": none }, { "tasks/TASK-0042.md": card(["deploy/**"], "architect"), "deploy/release.sh": "#!/bin/sh\n" }]);
  assert.equal(pathGuard(b, h, "TASK-0042", bare).status, "fail");
});

test("this repository guards the guard: lanes.yaml and the checks are on its own guarded list", () => {
  const guarded = (parse(lanes) as { guarded: string[] }).guarded;
  for (const p of [
    "lanes.yaml",
    "scripts/verify/**",
    "scripts/docs-check/**",
    "package.json",
    "biome.jsonc",
    "tsconfig.base.json",
    "deploy/**",
    "database/migrations/**",
    "modules/*/migrations/**",
    "industry/prompts/**",
  ])
    assert.ok(guarded.includes(p), p);
});

test("a PR may not delete the card it names", () => {
  const dir = scratch();
  const [base, head] = repo(dir, [
    { "lanes.yaml": lanes, "tasks/TASK-0042.md": card(["apps/web/app/features/**"]) },
    { "apps/web/app/features/feed.tsx": "export {};\n" },
  ]);
  execFileSync("git", ["rm", "-q", "tasks/TASK-0042.md"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "drop"], { cwd: dir });
  const dropped = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(pathGuard(base, head, "TASK-0042", dir).status, "pass");
  assert.deepEqual(pathGuard(base, dropped, "TASK-0042", dir), {
    status: "fail",
    lines: ["tasks/TASK-0042.md is not in this change (a PR may not delete its own card)"],
  });
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

test("a plan PR passes when it adds the card it names and changes only tasks/ (TASK-0015)", () => {
  const dir = scratch();
  const plan = card(["apps/web/app/features/**"]).replace("TASK-0042", "TASK-0077");
  const [base, head] = repo(dir, [{ "lanes.yaml": lanes, "tasks/TASK-0042.md": card(["apps/web/**"]) }, { "tasks/TASK-0077.md": plan }]);
  const r = pathGuard(base, head, "TASK-0077", dir);
  assert.deepEqual(r, { status: "pass", lines: ["plan PR: adds tasks/TASK-0077.md and changes only task cards (1 files)"] });
});

test("a card that is neither on the base nor added by the PR still fails (a mistyped card number)", () => {
  const dir = scratch();
  const plan = card(["apps/web/app/features/**"]).replace("TASK-0042", "TASK-0077");
  const [base, head] = repo(dir, [{ "lanes.yaml": lanes }, { "tasks/TASK-0077.md": plan }]);
  const r = pathGuard(base, head, "TASK-0078", dir);
  assert.deepEqual(r, { status: "fail", lines: ["tasks/TASK-0078.md is not on the base commit; merge the plan PR with the card first"] });
});
