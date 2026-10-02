// boundaries: imports that cross the workspace graph, leave their package, or bring a database driver into
// the web app or a model SDK anywhere are stopped.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkBoundaries, importsOf } from "../boundaries.ts";
import { scratch, write } from "./helpers.ts";

const pkg = (name: string, deps: string[] = [], exports: unknown = { ".": "./src/index.ts" }) =>
  JSON.stringify({ name, exports, dependencies: Object.fromEntries(deps.map((d) => [d, "workspace:*"])) });

function workspace(files: Record<string, string>): { dir: string; files: string[] } {
  const dir = scratch();
  const all: Record<string, string> = {
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n  - industry\n",
    "industry/package.json": pkg("@amp/industry", [], { "./*": "./*.ts" }),
    "packages/contracts/package.json": pkg("@amp/contracts", ["@amp/industry"], { ".": "./src/index.ts", "./*": "./src/*.ts" }),
    "packages/backend/package.json": pkg("@amp/backend", ["@amp/contracts", "@amp/industry"], { "./*": "./src/*.ts" }),
    "apps/web/package.json": pkg("@amp/web", ["@amp/contracts", "@amp/industry"]),
    ...files,
  };
  write(dir, all);
  return { dir, files: Object.keys(all) };
}

test("the current shape of the workspace passes", () => {
  const { dir, files } = workspace({ "apps/web/app/root.tsx": 'import { SITE } from "@amp/industry/site";\nimport { x } from "./lib/x.ts";\n' });
  assert.deepEqual(checkBoundaries(dir, files), []);
});

test("the web app importing the backend, a database driver or another package's files is stopped", () => {
  const { dir, files } = workspace({
    "apps/web/app/routes/feed.tsx": [
      'import { sql } from "@amp/backend/db";',
      'import postgres from "postgres";',
      'import { items } from "../../../../packages/backend/src/publication/items.ts";',
    ].join("\n"),
  });
  assert.deepEqual(checkBoundaries(dir, files).sort(), [
    "apps/web/app/routes/feed.tsx: imports ../../../../packages/backend/src/publication/items.ts, outside apps/web; use the other package's public entry",
    "apps/web/app/routes/feed.tsx: imports @amp/backend, which apps/web/package.json does not declare",
    "apps/web/app/routes/feed.tsx: the web app may not import postgres (no database or job queue in the front end)",
  ]);
});

test("a dependency against the graph, a model SDK, a new wildcard export and an unknown package are stopped", () => {
  const { dir, files } = workspace({
    "packages/contracts/package.json": pkg("@amp/contracts", ["@amp/industry", "@amp/backend"], { ".": "./src/index.ts", "./*": "./src/*.ts" }),
    "packages/backend/src/llm.ts": 'import OpenAI from "openai";\n',
    "apps/web/package.json": pkg("@amp/web", ["@amp/contracts"], { "./*": "./app/*.ts" }),
    "packages/extra/package.json": pkg("@amp/extra"),
  });
  const problems = checkBoundaries(dir, files);
  assert.ok(problems.includes("packages/contracts/package.json: @amp/contracts may not depend on @amp/backend"));
  assert.ok(problems.includes("packages/backend/src/llm.ts: imports the model SDK openai; paid calls go through ai-gateway only"));
  assert.ok(problems.includes("apps/web/package.json: exports may not use a wildcard; list each public entry"));
  assert.ok(problems.some((p) => p.startsWith("packages/extra/package.json: @amp/extra is not in the boundaries table")));
});

test("import specifiers are read from code, not from SQL that says FROM", () => {
  assert.deepEqual(importsOf("import a from \"x\";\nconst b = await import('y/z?raw');\nsql`substring(u from '/status/([0-9]+)')`"), ["x", "y/z"]);
});
