// Stage `boundaries`, first cut (T-0001; docs/06-agents/01-parallel-development-rules.md §4, ADR-0015):
// the workspace dependency graph and the imports that would get around it.
//   1. Every workspace package is listed below with the workspace packages it may depend on; its
//      package.json may declare only those (the graph only points down: apps → backend → contracts → industry).
//   2. Every import of a workspace package is declared in the importer's package.json. pnpm's strict layout
//      does not catch this on its own: Node also finds packages in the root node_modules.
//   3. No relative import leaves its workspace package (`../../packages/...`): go through the package.
//   4. The web app imports no database driver or job queue; nothing imports a model provider SDK (paid calls
//      will go through ai-gateway only, which does not exist yet).
//   5. package.json `exports` has no wildcard, except the packages T-0003 still has to narrow (listed below;
//      the list can only shrink).
// Root `tests/` and `scripts/` are integration code outside the workspace packages and are not checked.
// T-0003 adds the module edges of 03-module-map.md §3, `dbFor(role)` and the per-process configuration checks.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

export const ALLOWED_EDGES: Record<string, readonly string[]> = {
  "@aihot/industry": [],
  "@aihot/contracts": ["@aihot/industry"],
  "@aihot/backend": ["@aihot/contracts", "@aihot/industry"],
  "@aihot/api": ["@aihot/backend", "@aihot/contracts", "@aihot/industry"],
  "@aihot/worker": ["@aihot/backend", "@aihot/contracts", "@aihot/industry"],
  "@aihot/web": ["@aihot/contracts", "@aihot/industry"],
};

/** Packages whose `exports` still has a `./*` wildcard; T-0003 replaces each with an explicit list. */
export const PENDING_EXPORT_WILDCARDS: readonly string[] = ["@aihot/backend", "@aihot/contracts", "@aihot/industry"];

const SERVER_ONLY = [/^postgres$/, /^pg$/, /^pg-boss$/, /^pg-[\w-]+$/];
const MODEL_SDKS = [/^openai$/, /^@anthropic-ai\//, /^@google\/(genai|generative-ai)$/, /^@mistralai\//, /^cohere-ai$/, /^groq-sdk$/, /^@ai-sdk\//, /^ai$/];

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SPECIFIERS = [
  /\bfrom\s+["']([^"'\n]+)["']/g,
  /\bimport\s+["']([^"'\n]+)["']/g,
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*[,)]/g,
  /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
];

interface Workspace {
  dir: string;
  name: string;
  deps: Set<string>;
  exports: unknown;
}

/** Module specifiers a source file imports (bare and relative), without Vite's `?raw`-style suffixes. */
export function importsOf(text: string): string[] {
  const out = new Set<string>();
  for (const re of SPECIFIERS) {
    for (const m of text.matchAll(re)) {
      // Only strings shaped like a module path (SQL such as `substring(x from '/status/…')` also says "from").
      if (/^(\.{1,2}(\/|$)|node:|@?[a-z0-9])/i.test(m[1])) out.add(m[1].replace(/\?.*$/, ""));
    }
  }
  return [...out];
}

/** The package a bare specifier names: `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
const packageOf = (spec: string) =>
  spec
    .split("/")
    .slice(0, spec.startsWith("@") ? 2 : 1)
    .join("/");

function workspaces(root: string, files: readonly string[]): Workspace[] {
  const globs = ((parse(readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8")) ?? {}) as { packages?: string[] }).packages ?? [];
  const dirs = new Set<string>();
  for (const f of files) {
    if (!f.endsWith("/package.json")) continue;
    const dir = f.slice(0, -"/package.json".length);
    if (globs.some((g) => (g.endsWith("/*") ? path.posix.dirname(dir) === g.slice(0, -2) : dir === g))) dirs.add(dir);
  }
  return [...dirs].sort().map((dir) => {
    const pkg = JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8"));
    const deps = new Set<string>();
    for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const d of Object.keys(pkg[k] ?? {})) deps.add(d);
    }
    return { dir, name: pkg.name, deps, exports: pkg.exports };
  });
}

/** Boundary problems in the tracked `files` under `root`. */
export function checkBoundaries(root: string, files: readonly string[]): string[] {
  const problems: string[] = [];
  const spaces = workspaces(root, files);
  const names = new Set(spaces.map((w) => w.name));

  for (const w of spaces) {
    const allowed = ALLOWED_EDGES[w.name];
    if (!allowed) {
      problems.push(`${w.dir}/package.json: ${w.name} is not in the boundaries table (scripts/verify/boundaries.ts); add it with the packages it may use`);
      continue;
    }
    for (const d of w.deps) {
      if (names.has(d) && !allowed.includes(d)) problems.push(`${w.dir}/package.json: ${w.name} may not depend on ${d}`);
    }
    const wildcard = JSON.stringify(w.exports ?? {}).includes("*");
    if (wildcard && !PENDING_EXPORT_WILDCARDS.includes(w.name)) problems.push(`${w.dir}/package.json: exports may not use a wildcard; list each public entry`);
    if (!wildcard && PENDING_EXPORT_WILDCARDS.includes(w.name)) {
      problems.push(`${w.name} no longer exports a wildcard: remove it from PENDING_EXPORT_WILDCARDS in scripts/verify/boundaries.ts`);
    }
  }

  for (const f of files) {
    if (!SOURCE.test(f) || f.includes("/node_modules/")) continue;
    const w = spaces.find((s) => f.startsWith(`${s.dir}/`));
    if (!w) continue;
    const text = readFileSync(path.join(root, f), "utf8");
    for (const spec of importsOf(text)) {
      if (spec.startsWith(".")) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
        if (!target.startsWith(`${w.dir}/`)) problems.push(`${f}: imports ${spec}, outside ${w.dir}; use the other package's public entry`);
        continue;
      }
      if (spec.startsWith("node:")) continue;
      const pkg = packageOf(spec);
      if (names.has(pkg) && pkg !== w.name && !w.deps.has(pkg)) problems.push(`${f}: imports ${pkg}, which ${w.dir}/package.json does not declare`);
      if (w.name === "@aihot/web" && SERVER_ONLY.some((re) => re.test(pkg)))
        problems.push(`${f}: the web app may not import ${pkg} (no database or job queue in the front end)`);
      if (MODEL_SDKS.some((re) => re.test(pkg))) problems.push(`${f}: imports the model SDK ${pkg}; paid calls go through ai-gateway only`);
    }
  }
  return problems;
}
