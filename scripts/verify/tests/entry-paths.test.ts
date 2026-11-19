// The entry documents name only paths that exist; a planned path carries a mark and must not exist yet.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkEntryPaths, pathClaims } from "../entry-paths.ts";
import { scratch, write } from "./helpers.ts";

test("a path that is not there is reported with its line; placeholders, commands and URLs are not paths", () => {
  const dir = scratch();
  write(dir, {
    "AGENTS.md": [
      "Read `apps/web` and `apps/fetcher`, then `tasks/TASK-nnnn.md`.",
      "Run `npm run check`; the API is under `/api/v1`; see `docs/*.md` and `docs/none/*.md`.",
      "```bash",
      "npm test -- `apps/ghost`",
      "```",
      "The word `lane` and the file `README.md` are not directories of the repository.",
    ].join("\n"),
    "apps/web/package.json": "{}\n",
    "docs/a.md": "x\n",
    "tasks/_template.md": "x\n",
  });
  assert.deepEqual(checkEntryPaths(dir, ["AGENTS.md", "CLAUDE.md"]), [
    "AGENTS.md:1: apps/fetcher does not exist",
    "AGENTS.md:2: docs/none/*.md does not exist",
    "CLAUDE.md: the entry document is missing",
  ]);
});

test("a planned path must not exist yet: the mark comes off in the change that creates it", () => {
  const dir = scratch();
  write(dir, { "AGENTS.md": "New code goes to `apps/web/reader`（未建） and `apps/web/app`（未建）.\n", "apps/web/app/root.tsx": "export {};\n" });
  assert.deepEqual(checkEntryPaths(dir, ["AGENTS.md"]), ["AGENTS.md:1: apps/web/app exists now: remove “（未建）”"]);
  assert.deepEqual(pathClaims("`apps/web/reader`（未建） `apps/web`", new Set(["apps"])), [
    { line: 1, path: "apps/web/reader", planned: true },
    { line: 1, path: "apps/web", planned: false },
  ]);
});

test("this repository's entry documents name only paths that exist", () => {
  assert.deepEqual(checkEntryPaths(), []);
});
