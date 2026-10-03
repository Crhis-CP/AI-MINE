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
  assert.deepEqual(
    importsOf('import x from /* note */ "postgres"; export { x } from /* note */ "pg-native"; import(/* note */ "pg"); require(// note\n "openai");'),
    ["postgres", "pg-native", "pg", "openai"],
  );
});

test("template, escaped and constant-composed imports cannot cross the web boundary", () => {
  for (const expression of [
    "`../../packages/backend/src/db.ts`",
    '"\\u002e\\u002e/../../packages/backend/src/db.ts"',
    '"../../packages/" + "backend/src/db.ts"',
    '"./%2e%2e/%2e%2e/packages/backend/src/db.ts#cached"',
    JSON.stringify("./..\\..\\packages/backend/src/db.ts"),
    `\`../../packages/\${"backend"}/src/db.ts\``,
  ]) {
    const { dir, files } = workspace({ "apps/web/probe.ts": `export const load = () => import(${expression});` });
    assert.ok(
      checkBoundaries(dir, files).some((p) => p.includes("outside apps/web")),
      expression,
    );
  }
  const aliases = workspace({
    "apps/web/probe.ts": 'import { createRequire as make } from "node:module"; const load = make(import.meta.url); load(`postgres`);',
  });
  assert.ok(checkBoundaries(aliases.dir, aliases.files).some((p) => p.includes("may not import postgres")));
});

test("unresolved module paths fail closed; query-only interpolation keeps a fixed module identity", () => {
  for (const expression of ["target", `\`./\${name}.ts\``, '"./" + name']) {
    const { dir, files } = workspace({ "apps/web/probe.ts": `const loaded = import(${expression});` });
    assert.ok(checkBoundaries(dir, files).some((p) => p.includes("must be statically known")));
  }
  assert.deepEqual(importsOf(`const state = import(\`./state.ts?test=\${instance++}\`);`), ["./state.ts"]);
  assert.deepEqual(importsOf('export * from "./helper.ts#version";'), ["./helper.ts"]);
  assert.throws(() => importsOf('import "./bad%zz.ts";'), /invalid encoding/);
  assert.deepEqual(importsOf('/* import "postgres" */ const s = "from \\"pg\\""; sql`from "openai"`;'), []);
  const jsx = workspace({ "apps/web/probe.tsx": '<span>from "postgres"</span>;' });
  assert.deepEqual(checkBoundaries(jsx.dir, jsx.files), []);
  const malformed = workspace({ "apps/web/probe.ts": 'import { broken from "postgres";' });
  assert.ok(checkBoundaries(malformed.dir, malformed.files).some((p) => p.includes("cannot parse module syntax")));
});

test("only the existing top-level web build import can use the fixed path resolver", () => {
  const source = 'import path from "node:path"; const build = await import(path.resolve(import.meta.dirname, "build/server/index.js"));';
  const valid = workspace({ "apps/web/server.ts": source });
  assert.deepEqual(checkBoundaries(valid.dir, valid.files), []);
  for (const [file, text] of [
    ["apps/web/other.ts", source],
    ["apps/web/server.ts", source.replace("build/server/index.js", "../../packages/backend/src/db.ts")],
    ["apps/web/server.ts", source.replace("const build = await", "async function nested(path: any) { return await").concat("}")],
  ]) {
    const invalid = workspace({ [file!]: text! });
    assert.ok(checkBoundaries(invalid.dir, invalid.files).some((p) => p.includes("must be statically known")));
  }
  for (const spec of ["file:///tmp/backend.ts", "/tmp/backend.ts", "data:text/javascript,export default 1", "#backend"]) {
    const invalid = workspace({ "apps/web/probe.ts": `import ${JSON.stringify(spec)};` });
    assert.ok(checkBoundaries(invalid.dir, invalid.files).some((p) => p.includes("not public workspace entries")));
  }
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
    "packages/domains/content/src/logic.ts": 'import postgres from /* annotation */ "postgres";',
    "packages/platform/config/package.json": pkg("@amp/config", ["postgres"]),
    "packages/platform/config/src/db.ts": 'import postgres from "postgres";',
    "packages/domains/ai-gateway/package.json": pkg("@amp/ai-gateway", ["openai"]),
    "packages/domains/ai-gateway/src/providers/openai.ts": 'import OpenAI from "openai";',
    "packages/domains/ai-gateway/src/index.ts": 'import OpenAI from "openai";',
    "packages/domains/policy/package.json": pkg("@amp/policy", ["openai"]),
    "packages/domains/policy/src/index.ts": 'import OpenAI from "openai";',
  });
  const problems = checkBoundaries(dir, files);
  assert.equal(problems.length, 4);
  assert.ok(problems.some((p) => p.includes("ai-gateway/src/index.ts: imports the model SDK")));
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

test("fetch-runtime cannot reach a store directly or through a helper and workspace re-export", () => {
  const common = {
    "packages/domains/acquisition/package.json": pkg("@amp/acquisition", ["@amp/content"], { "./fetch-runtime": "./src/fetch-runtime.ts" }),
    "packages/domains/acquisition/src/helper.ts": 'import "@amp/content";',
    "packages/domains/content/package.json": pkg("@amp/content", ["postgres"]),
    "packages/domains/content/src/index.ts": 'export { query } from "./store/query.ts";',
    "packages/domains/content/src/store/query.ts": 'import postgres from "postgres";',
    "packages/domains/acquisition/src/store/query.ts": "export const query = 1;",
  };
  for (const source of ['import "./store/query.ts";', 'import "./helper.ts";']) {
    const bad = workspace({ ...common, "packages/domains/acquisition/src/fetch-runtime.ts": source });
    assert.ok(checkBoundaries(bad.dir, bad.files).some((p) => p.includes("store/ is reachable")));
  }
  const good = workspace({ ...common, "packages/domains/acquisition/src/fetch-runtime.ts": "export const fetch = () => null;" });
  assert.deepEqual(checkBoundaries(good.dir, good.files), []);
});
