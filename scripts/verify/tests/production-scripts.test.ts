// production-scripts: a script the production image runs (setup's migrate and seed, verify's smoke, one-off
// corrections such as retime-day-only) loads only what the image installs: Node's own modules and the
// dependencies of the package.json files above it, never devDependencies (Dockerfile: `pnpm install --prod`).
// The tests pass because a development install has both (PIT-073), so this reads the imports instead.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { importsOf } from "../boundaries.ts";
import { ROOT } from "../lib.ts";
import { scratch, write } from "./helpers.ts";

/** Scripts under scripts/ that run on a development machine or the verify executor, never in the image. */
const EXEMPT: Record<string, string> = {
  "brand-icons.ts": "generates the brand icons with sharp, on a development machine",
  "nameplates.ts": "generates the report nameplates with opentype.js, on a development machine",
  "mcp-check.ts": "verify's smoke stage runs it on the executor (scripts/verify/run.ts); smoke.ts itself runs in the image",
  "debrand.ts": "the debranding tool, development machine only; it uses the verify checks and yaml",
};
const DATA = /\.(?:json|md|txt|csv|svg|png|ico)$/i;
// A whole `import type … from` (or `export type … from`) is erased before it runs; `import { type X }` is not.
const TYPE_ONLY = /^[ \t]*(?:import|export)[ \t]+type[ \t]+(?!from\b)[^;]*?\bfrom[ \t]*(["'])[^"'\n]*\1[ \t]*;?/gm;

type Manifest = { name?: string; dependencies?: Record<string, string>; exports?: unknown };

/** What the image would fail to load, from each script directly under scripts/ through its relative imports. */
function productionImports(root: string, exempt: Record<string, string> = EXEMPT) {
  const read = (file: string): Manifest | null => (existsSync(path.join(root, file)) ? JSON.parse(readFileSync(path.join(root, file), "utf8")) : null);
  const globs = (parse(readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8")) as { packages?: string[] }).packages ?? [];
  const workspaces = new Map<string, Manifest>();
  for (const glob of globs)
    for (const dir of !glob.endsWith("/*")
      ? [glob]
      : !existsSync(path.join(root, glob.slice(0, -2)))
        ? []
        : readdirSync(path.join(root, glob.slice(0, -2)), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => `${glob.slice(0, -2)}/${entry.name}`)) {
      const manifest = read(`${dir}/package.json`);
      if (manifest?.name) workspaces.set(manifest.name, manifest);
    }
  // Node looks for a package beside each package.json from the file's directory up to the root.
  const installed = (file: string) => {
    const names = new Set<string>();
    for (let dir = path.posix.dirname(file); ; dir = path.posix.dirname(dir)) {
      for (const name of Object.keys(read(`${dir}/package.json`)?.dependencies ?? {})) names.add(name);
      if (dir === ".") return names;
    }
  };
  const exported = (manifest: Manifest, subpath: string) => {
    const exports = manifest.exports;
    const keys = exports && typeof exports === "object" && Object.keys(exports).some((key) => key.startsWith(".")) ? Object.keys(exports) : ["."];
    return keys.some((key) =>
      key.includes("*")
        ? new RegExp(
            `^${key
              .split("*")
              .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
              .join(".+")}$`,
          ).test(subpath)
        : key === subpath,
    );
  };
  const problems: string[] = [],
    checked: string[] = [];
  const entries = readdirSync(path.join(root, "scripts")).filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"));
  for (const name of Object.keys(exempt)) if (!entries.includes(name)) problems.push(`scripts/${name}: listed as an exception but missing`);
  const queue = entries
    .filter((name) => !Object.hasOwn(exempt, name))
    .sort()
    .map((name) => `scripts/${name}`);
  for (let file = queue.shift(); file; file = queue.shift()) {
    if (checked.includes(file)) continue;
    checked.push(file);
    const allowed = installed(file);
    for (const spec of importsOf(readFileSync(path.join(root, file), "utf8").replace(TYPE_ONLY, ""))) {
      if (isBuiltin(spec) || (spec.startsWith(".") && DATA.test(spec))) continue;
      if (spec.startsWith(".")) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
        if (!target.endsWith(".ts") || !existsSync(path.join(root, target))) problems.push(`${file}: cannot follow ${spec}`);
        else queue.push(target);
        continue;
      }
      const pkg = spec
        .split("/")
        .slice(0, spec.startsWith("@") ? 2 : 1)
        .join("/");
      const manifest = workspaces.get(pkg);
      if (!allowed.has(pkg)) problems.push(`${file}: ${spec} is not installed in the production image (not in the dependencies above it)`);
      else if (manifest && !exported(manifest, `.${spec.slice(pkg.length)}`)) problems.push(`${file}: ${spec} is not in ${pkg}'s exports`);
    }
  }
  return { checked, problems };
}

test("every script the production image runs loads only what the image installs", () => {
  const { checked, problems } = productionImports(ROOT);
  assert.deepEqual(problems, []);
  assert.ok(
    checked.some((file) => !/^scripts\/[^/]+$/.test(file)),
    `relative imports are followed: ${checked.join(", ")}`,
  );
});

function workspace(files: Record<string, string>) {
  const dir = scratch();
  write(dir, {
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "package.json": JSON.stringify({
      dependencies: { "@amp/backend": "workspace:*", zod: "4" },
      devDependencies: { "@amp/contracts": "workspace:*", yaml: "2" },
    }),
    "packages/backend/package.json": JSON.stringify({ name: "@amp/backend", exports: { "./db": "./src/db.ts" } }),
    "packages/contracts/package.json": JSON.stringify({ name: "@amp/contracts", exports: { "./time": "./src/time.ts" } }),
    "scripts/helper/data.json": "{}",
    ...files,
  });
  return productionImports(dir, {}).problems;
}

test("a development dependency, an unexported path or a relatively imported file that needs one is stopped", () => {
  for (const [script, extra, expected] of [
    ['import { beijingDate } from "@amp/contracts/time";', {}, "scripts/a.ts: @amp/contracts/time is not installed"],
    ['import { parse } from "yaml";', {}, "scripts/a.ts: yaml is not installed"],
    ['import { publish } from "@amp/backend/publication/publish";', {}, "scripts/a.ts: @amp/backend/publication/publish is not in @amp/backend's exports"],
    ['import { type Document, parse } from "yaml";', {}, "scripts/a.ts: yaml is not installed"],
    ['import pkg from "@amp/contracts/package.json" with { type: "json" };', {}, "scripts/a.ts: @amp/contracts/package.json is not installed"],
    [
      'import { run } from "./helper/run.ts";',
      { "scripts/helper/run.ts": 'import { parse } from "yaml";\nexport const run = parse;' },
      "scripts/helper/run.ts: yaml is not installed",
    ],
  ] as const) {
    const problems = workspace({ "scripts/a.ts": script, ...extra });
    assert.equal(problems.length, 1, `${script}: ${problems.join("; ")}`);
    assert.ok(problems[0]!.startsWith(expected), problems[0]);
  }
});

test("a whole type-only import, Node's own modules, root dependencies and data files are allowed", () => {
  const problems = workspace({
    "scripts/a.ts": [
      'import type { Time } from "@amp/contracts/time";',
      'export type { Parsed } from "yaml";',
      "import type {\n  Document,\n  Node,\n} from 'yaml';",
      'import { readFileSync } from "node:fs";',
      'import path from "path";',
      'import { z } from "zod";',
      'import { dbOf } from "@amp/backend/db";',
      'import data from "./helper/data.json" with { type: "json" };',
    ].join("\n"),
  });
  assert.deepEqual(problems, []);
});
