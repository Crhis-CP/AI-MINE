// TASK-0004 PR1: explicit public entries, module-map §3 edges, and driver / SDK ownership.
// The six existing packages retain their transitional edges (TASK-0004 D10). New domain packages follow
// the map. Root tests/ and scripts/ are integration code outside workspace packages.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const amp = (names: readonly string[]) => names.map((name) => `@amp/${name}`);
const PLATFORM = amp(["identity", "ops", "queue", "storage", "config", "telemetry"]);
const L0 = ["@amp/contracts", ...PLATFORM];
const DOMAIN_EDGES: Record<string, readonly string[]> = {
  "ai-gateway": [],
  sources: ["ai-gateway"],
  content: ["sources", "ai-gateway"],
  acquisition: ["sources", "content"],
  entities: ["content", "ai-gateway"],
  enrichment: ["content", "entities", "sources", "ai-gateway"],
  policy: ["content", "entities", "sources", "ai-gateway"],
  events: ["content", "enrichment", "entities", "policy", "ai-gateway"],
  editorial: ["content", "enrichment", "events", "policy"],
  publication: ["sources", "content", "enrichment", "entities", "events", "policy", "editorial"],
  reports: ["publication", "events", "policy", "enrichment", "ai-gateway"],
  feedback: ["publication"],
};
const DOMAINS = amp(Object.keys(DOMAIN_EDGES));
export const ALLOWED_EDGES: Record<string, readonly string[]> = {
  ...Object.fromEntries(PLATFORM.map((name) => [name, L0.filter((other) => other !== name)])),
  ...Object.fromEntries(Object.entries(DOMAIN_EDGES).map(([name, deps]) => [`@amp/${name}`, [...L0, ...amp(deps)]])),
  "@amp/industry": [],
  "@amp/contracts": ["@amp/industry"],
  "@amp/backend": ["@amp/contracts", "@amp/industry"],
  "@amp/api": ["@amp/backend", "@amp/industry", ...L0, ...DOMAINS],
  "@amp/worker": ["@amp/backend", "@amp/industry", ...L0, ...DOMAINS],
  "@amp/fetcher": amp(["acquisition", "storage", "config", "telemetry", "contracts"]),
  "@amp/web": amp(["contracts", "industry", "api-client", "ui"]),
  "@amp/api-client": ["@amp/contracts"],
  "@amp/ui": ["@amp/contracts"],
  "@amp/testkit": L0,
  "@amp/tooling": ["@amp/contracts"],
};

const DRIVERS = [/^postgres$/, /^pg$/, /^pg-(?!boss$)[\w-]+$/];
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
export interface BackendBaseline {
  snapshot: Record<string, string>;
  exports: Record<string, string>;
}

const privatePath = (s: string) => /(^|\/)(internal|store)(\/|$)/.test(path.posix.normalize(s));
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
const publicEntries = (v: unknown): Record<string, unknown> => {
  if (v == null) return {};
  if (typeof v === "object" && !Array.isArray(v) && (!Object.keys(v).length || Object.keys(v).some((key) => key.startsWith("."))))
    return v as Record<string, unknown>;
  return { ".": v };
};
const driverAllowed = (w: Workspace, f: string) =>
  ["@amp/backend", "@amp/config", "@amp/queue"].includes(w.name) || (DOMAINS.includes(w.name) && f.startsWith(`${w.dir}/src/store/`));

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
export function checkBoundaries(root: string, files: readonly string[], backendBaseline?: BackendBaseline): string[] {
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
      if (d.startsWith("@amp/") && !allowed.includes(d)) problems.push(`${w.dir}/package.json: ${w.name} may not depend on ${d}`);
      if (MODEL_SDKS.some((re) => re.test(d)) && w.name !== "@amp/ai-gateway") problems.push(`${w.dir}/package.json: model SDK ${d} belongs to ai-gateway`);
      if (DRIVERS.some((re) => re.test(d)) && !driverAllowed(w, `${w.dir}/src/store/index.ts`))
        problems.push(`${w.dir}/package.json: database driver ${d} is not allowed in ${w.name}`);
    }
    const wildcard = JSON.stringify(w.exports ?? {}).includes("*");
    if (wildcard) problems.push(`${w.dir}/package.json: exports may not use a wildcard; list each public entry`);
    const entries = publicEntries(w.exports);
    for (const [entry, target] of Object.entries(entries)) {
      if (privatePath(entry) || strings(target).some(privatePath)) problems.push(`${w.dir}/package.json: ${entry} exposes internal/ or store/`);
    }
    if (w.name === "@amp/backend") {
      const snapshot = JSON.parse(readFileSync(path.join(root, "scripts/verify/backend-exports.json"), "utf8")) as Record<string, string>;
      if (backendBaseline) {
        for (const [entry, target] of Object.entries(snapshot)) {
          if (backendBaseline.snapshot[entry] !== target) problems.push(`scripts/verify/backend-exports.json: ${entry} expands or retargets the base snapshot`);
        }
      }
      for (const [entry, target] of Object.entries(entries)) {
        if (snapshot[entry] !== target || (backendBaseline && backendBaseline.exports[entry] !== target))
          problems.push(`${w.dir}/package.json: ${entry} is not an unchanged backend export; new code belongs in a module`);
      }
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
      if (pkg.startsWith("@amp/") && pkg !== w.name) {
        const target = spaces.find((s) => s.name === pkg);
        const entry = spec === pkg ? "." : `.${spec.slice(pkg.length)}`;
        if (privatePath(entry)) problems.push(`${f}: imports ${spec}, a private internal/ or store/ path`);
        else if (!target || !strings(publicEntries(target.exports)[entry]).length) problems.push(`${f}: ${spec} is not an explicit public export`);
        if (w.name === "@amp/fetcher" && pkg === "@amp/acquisition" && entry !== "./fetch-runtime")
          problems.push(`${f}: fetcher may only import @amp/acquisition/fetch-runtime`);
      }
      if (w.name === "@amp/web" && (DRIVERS.some((re) => re.test(pkg)) || pkg === "pg-boss"))
        problems.push(`${f}: the web app may not import ${pkg} (no database or job queue in the front end)`);
      else if (DRIVERS.some((re) => re.test(pkg)) && !driverAllowed(w, f)) problems.push(`${f}: database driver ${pkg} belongs in a module's store/`);
      if (MODEL_SDKS.some((re) => re.test(pkg)) && w.name !== "@amp/ai-gateway")
        problems.push(`${f}: imports the model SDK ${pkg}; paid calls go through ai-gateway only`);
    }
  }
  return problems;
}
