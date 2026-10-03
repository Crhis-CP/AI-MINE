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
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n  - packages/domains/*\n  - packages/platform/*\n  - industry\n",
    "industry/package.json": pkg("@amp/industry", [], { "./site": "./site.ts" }),
    "packages/contracts/package.json": pkg("@amp/contracts", ["@amp/industry"]),
    "packages/backend/package.json": pkg("@amp/backend", ["@amp/contracts", "@amp/industry"], { "./db": "./src/db.ts" }),
    "scripts/verify/backend-exports.json": JSON.stringify({ "./db": "./src/db.ts" }),
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

test("wildcards, private export aliases and new backend exports are rejected", () => {
  const { dir, files } = workspace({
    "packages/backend/package.json": pkg("@amp/backend", [], { "./new": "./src/new.ts" }),
    "industry/package.json": pkg("@amp/industry", [], { "./*": "./*.ts" }),
    "packages/domains/content/package.json": pkg("@amp/content", [], { ".": { import: "./src/store/index.ts" } }),
  });
  const problems = checkBoundaries(dir, files);
  assert.ok(problems.some((p) => p.includes("./new is not an unchanged backend export")));
  assert.ok(problems.some((p) => p.includes("industry/package.json: exports may not use a wildcard")));
  assert.ok(problems.some((p) => p.includes("content/package.json: . exposes internal/ or store/")));
});

test("editing the snapshot cannot add or restore an export removed from the base", () => {
  const { dir, files } = workspace({
    "packages/backend/package.json": pkg("@amp/backend", [], { "./new": "./src/new.ts", "./removed": "./src/removed.ts" }),
    "scripts/verify/backend-exports.json": JSON.stringify({ "./new": "./src/new.ts", "./removed": "./src/removed.ts" }),
  });
  const baseline = { snapshot: { "./removed": "./src/removed.ts" }, exports: {} };
  const problems = checkBoundaries(dir, files, baseline);
  assert.ok(problems.some((p) => p.includes("./new expands or retargets the base snapshot")));
  assert.ok(problems.some((p) => p.includes("./removed is not an unchanged backend export")));
  const reduced = workspace({ "packages/backend/package.json": pkg("@amp/backend", [], {}) });
  assert.deepEqual(checkBoundaries(reduced.dir, reduced.files, { snapshot: { "./db": "./src/db.ts" }, exports: { "./db": "./src/db.ts" } }), []);
});

test("private deep imports and unexported paths cannot bypass a declared dependency", () => {
  const { dir, files } = workspace({
    "packages/domains/content/package.json": pkg("@amp/content"),
    "packages/domains/entities/package.json": pkg("@amp/entities", ["@amp/content"]),
    "packages/domains/entities/src/index.ts": 'import "@amp/content/store/query"; import "@amp/content/internal/x"; import "@amp/content/src/hidden";',
  });
  const problems = checkBoundaries(dir, files);
  assert.equal(problems.filter((p) => p.includes("a private internal/ or store/ path")).length, 2);
  assert.ok(problems.some((p) => p.includes("@amp/content/src/hidden is not an explicit public export")));
});

test("news may read policy, while policy cannot depend on news or enrichment", () => {
  const valid = {
    "packages/domains/policy/package.json": pkg("@amp/policy"),
    "packages/domains/events/package.json": pkg("@amp/events", ["@amp/policy"]),
    "packages/domains/events/src/index.ts": 'export { x } from "@amp/policy";',
  };
  const good = workspace(valid);
  assert.deepEqual(checkBoundaries(good.dir, good.files), []);
  const bad = workspace({ ...valid, "packages/domains/policy/package.json": pkg("@amp/policy", ["@amp/events", "@amp/enrichment"]) });
  const problems = checkBoundaries(bad.dir, bad.files);
  for (const name of ["events", "enrichment"]) assert.ok(problems.some((p) => p.includes(`@amp/policy may not depend on @amp/${name}`)));
});

test("database drivers stay in stores or config/queue, model SDKs stay in the gateway", () => {
  const { dir, files } = workspace({
    "packages/domains/content/package.json": pkg("@amp/content", ["postgres"]),
    "packages/domains/content/src/store/query.ts": 'import postgres from "postgres";',
    "packages/domains/content/src/logic.ts": 'import postgres from "postgres";',
    "packages/platform/config/package.json": pkg("@amp/config", ["postgres"]),
    "packages/platform/config/src/db.ts": 'import postgres from "postgres";',
    "packages/domains/ai-gateway/package.json": pkg("@amp/ai-gateway", ["openai"]),
    "packages/domains/ai-gateway/src/providers/openai.ts": 'import OpenAI from "openai";',
    "packages/domains/policy/package.json": pkg("@amp/policy", ["openai"]),
    "packages/domains/policy/src/index.ts": 'import OpenAI from "openai";',
  });
  const problems = checkBoundaries(dir, files);
  assert.equal(problems.length, 3);
  assert.ok(problems.some((p) => p.includes("content/src/logic.ts: database driver")));
  assert.ok(problems.some((p) => p.includes("policy/package.json: model SDK")));
  assert.ok(problems.some((p) => p.includes("policy/src/index.ts: imports the model SDK")));
});

test("fetcher can use only acquisition's fetch-runtime entry", () => {
  const common = {
    "packages/domains/acquisition/package.json": pkg("@amp/acquisition", [], { ".": "./src/index.ts", "./fetch-runtime": "./src/fetch-runtime.ts" }),
    "apps/fetcher/package.json": pkg("@amp/fetcher", ["@amp/acquisition"]),
  };
  const good = workspace({ ...common, "apps/fetcher/src/main.ts": 'import "@amp/acquisition/fetch-runtime";' });
  assert.deepEqual(checkBoundaries(good.dir, good.files), []);
  const bad = workspace({ ...common, "apps/fetcher/src/main.ts": 'import "@amp/acquisition";' });
  assert.ok(checkBoundaries(bad.dir, bad.files).some((p) => p.includes("fetcher may only import")));
});
