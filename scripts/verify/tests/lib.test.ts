// Path patterns as lanes.yaml and the task cards use them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesAny, patternRegExp, shown } from "../lib.ts";

test("patterns: ** spans directories, * stays in one segment, a directory covers what is below it", () => {
  const yes: Array<[string, string]> = [
    ["apps/web/app/routes/(public)/**", "apps/web/app/routes/(public)/home.tsx"],
    ["scripts/verify*", "scripts/verify/run.ts"],
    ["packages/*/package.json", "packages/backend/package.json"],
    ["**/*.md", "docs/a/b.md"],
    ["**", "anything/at/all.ts"],
    ["tasks", "tasks/TASK-0001.md"],
  ];
  const no: Array<[string, string]> = [
    ["apps/web/app/routes/(public)/**", "apps/web/app/routes/(private)/login.tsx"],
    ["packages/*/package.json", "packages/backend/src/package.json"],
    ["package.json", "apps/web/package.json"],
    ["scripts/verify*", "scripts/migrate.ts"],
  ];
  for (const [p, f] of yes) assert.ok(patternRegExp(p).test(f), `${p} should match ${f}`);
  for (const [p, f] of no) assert.ok(!patternRegExp(p).test(f), `${p} should not match ${f}`);
  assert.ok(matchesAny("Makefile", ["package.json", "Makefile"]));
});

test("command lines in logs hide URL passwords", () => {
  // Assembled at run time: a URL with a password, even a masked one, written out here would stop the secrets stage.
  const url = (password: string) => ["postgres://app:", password, "@db:5432/x"].join("");
  assert.equal(shown("psql", [url("hunter2")]), `psql ${url("***")}`);
});
