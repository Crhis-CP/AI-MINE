// Stage `names` (TASK-0003 completion condition 1; docs/04-architecture/04-aihot-adoption.md 4.3 and 4.6
// item 1; docs/05-quality/03-testing-standards.md 1.1): the upstream project's name, its two brand colours and
// its ring loader appear only on the exception paths of names.json, and no tracked file has the SHA-256 of an
// upstream brand asset (no exceptions). Paths and file names of the registration and handoff files are not
// hits. The same patterns, with no path exceptions, apply to the reader site's build output (stage build-web)
// and to the pages, machine outputs and MCP of the running site (stage smoke).
//   node scripts/verify/names.ts            the repository check, as the stage runs it
//   node scripts/verify/names.ts --counts   lines with hits in each excepted file (for the acceptance record)
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { patternRegExp, ROOT, sha256 } from "./lib.ts";

type Exception = string | { path: string; sameAs: string };
export interface NameRules {
  names: string[];
  marks: string[];
  exceptions: Record<string, Exception[]>;
  references: string[];
  brand: { manifest: string; prefixes: string[] };
}
export interface Hit {
  line: number;
  match: string;
}

export const loadRules = (root = ROOT): NameRules => JSON.parse(readFileSync(path.join(root, "scripts/verify/names.json"), "utf8")) as NameRules;

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hitPattern = (rules: NameRules) => new RegExp([...rules.names, ...rules.marks].map(literal).join("|"), "gi");

/** The text with every path or file name of a registration or handoff file blanked out, lines kept in place. */
export function withoutReferences(text: string, rules: NameRules): string {
  return rules.references.reduce((t, r) => t.replace(new RegExp(r, "g"), (m) => "\0".repeat(m.length)), text);
}

/** Hits in one file or response. Files are read byte for byte (latin1), so binary files are searched too. */
export function findHits(content: Buffer | string, rules: NameRules): Hit[] {
  const text = withoutReferences(typeof content === "string" ? content : content.toString("latin1"), rules);
  const hits: Hit[] = [];
  let line = 1;
  let at = 0;
  for (const m of text.matchAll(hitPattern(rules))) {
    for (; at < m.index; at++) if (text.charCodeAt(at) === 10) line++;
    hits.push({ line, match: m[0] });
  }
  return hits;
}

const sameBytes = (root: string, a: string, b: string) => {
  try {
    return readFileSync(path.join(root, a)).equals(readFileSync(path.join(root, b)));
  } catch {
    return false;
  }
};

/** The exception that covers a file (the most specific pattern wins), or null. */
export function exemption(root: string, file: string, rules: NameRules): string | null {
  let best: { name: string; length: number } | null = null;
  for (const [name, entries] of Object.entries(rules.exceptions)) {
    for (const entry of entries) {
      const pattern = typeof entry === "string" ? entry : entry.path;
      if (!patternRegExp(pattern).test(file) || (best && best.length >= pattern.length)) continue;
      if (typeof entry !== "string" && !sameBytes(root, file, entry.sameAs)) continue;
      best = { name, length: pattern.length };
    }
  }
  return best?.name ?? null;
}

/** SHA-256 → upstream path of every brand asset in the source manifest. */
export function brandHashes(root: string, rules: NameRules): Map<string, string> {
  const manifest = JSON.parse(readFileSync(path.join(root, rules.brand.manifest), "utf8")) as { files: Array<{ path: string; sha256: string }> };
  return new Map(manifest.files.filter((f) => rules.brand.prefixes.some((p) => f.path.startsWith(p))).map((f) => [f.sha256, f.path]));
}

const OUTSIDE = "outside the exception paths of scripts/verify/names.json";

/** Problems in the repository: hits outside the exceptions, paths that name the project, upstream brand assets. */
export function checkNames(root: string, files: readonly string[], rules = loadRules(root)): string[] {
  const problems: string[] = [];
  const templates = new Map(
    Object.values(rules.exceptions)
      .flat()
      .flatMap((e) => (typeof e === "string" ? [] : [[e.path, e.sameAs] as const])),
  );
  const brand = brandHashes(root, rules);
  if (!brand.size) problems.push(`${rules.brand.manifest}: no brand assets under ${rules.brand.prefixes.join(", ")}; the hash check would be empty`);
  for (const file of files) {
    let content: Buffer;
    try {
      content = readFileSync(path.join(root, file));
    } catch {
      continue; // deleted in the working tree (pnpm check)
    }
    const asset = brand.get(sha256(content));
    if (asset) problems.push(`${file}: same bytes as the upstream brand asset ${asset} (no exceptions)`);
    if (exemption(root, file, rules)) continue;
    const found = [
      ...findHits(file, rules).map((h) => `${file}: the path contains "${h.match}"`),
      ...findHits(content, rules).map((h) => `${file}:${h.line}: "${h.match}" ${OUTSIDE}`),
    ];
    const template = templates.get(file);
    if (found.length && template) found.push(`${file}: differs from ${template}, so the governance exception does not cover it`);
    problems.push(...found);
  }
  return problems;
}

/** Problems in the files under `dir` (the reader site's build output): no hits and no brand asset, no exceptions. */
export function checkOutputTree(dir: string, root = ROOT, rules = loadRules(root)): string[] {
  const problems: string[] = [];
  const brand = brandHashes(root, rules);
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile());
  if (!files.length) return [`${path.relative(root, dir)}: no files to check`];
  for (const d of files) {
    const file = path.join(d.parentPath, d.name);
    const shown = path.relative(root, file);
    const content = readFileSync(file);
    for (const h of findHits(content, rules)) problems.push(`${shown}:${h.line}: "${h.match}" in the build output`);
    const asset = brand.get(sha256(content));
    if (asset) problems.push(`${shown}: same bytes as the upstream brand asset ${asset}`);
  }
  return problems;
}

/** Pages and machine outputs of the running site checked by the smoke stage (TASK-0003 :126). */
export const SITE_OUTPUTS = [
  "/",
  "/all",
  "/hot",
  "/daily",
  "/daily/archive",
  "/topics",
  "/starred",
  "/agent",
  "/about",
  "/changelog",
  "/feedback",
  "/terms",
  "/privacy",
  "/more",
  "/admin/login",
  "/no-such-page",
  "/llms.txt",
  "/openapi-v1.json",
  "/feed.xml",
  "/feed/full.xml",
  "/feed/all.xml",
  "/feed/daily.xml",
  "/robots.txt",
  "/sitemap.xml",
  "/manifest.webmanifest",
  "/.well-known/security.txt",
  "/api/v1/items",
  "/api/v1/hot-topics",
  "/api/v1/dailies",
  "/api/v1/dailies/latest",
  "/api/v1/selected/snapshot",
  "/api/v1/selected/changes",
];
const MCP_REQUESTS: Array<[method: string, params: Record<string, unknown>]> = [
  ["initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1" } }],
  ["tools/list", {}],
];

/** The bodies of SITE_OUTPUTS (whatever the status) and the MCP handshake and tool list, labelled by path. */
export async function fetchSiteOutputs(base: string): Promise<Array<{ label: string; text: string }>> {
  const out: Array<{ label: string; text: string }> = [];
  for (const url of SITE_OUTPUTS) {
    const r = await fetch(base + url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    out.push({ label: `${url} (HTTP ${r.status})`, text: await r.text() });
  }
  for (const [i, [method, params]] of MCP_REQUESTS.entries()) {
    const r = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: i + 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    out.push({ label: `MCP ${method} (HTTP ${r.status})`, text: await r.text() });
  }
  return out;
}

/** Problems in labelled outputs (responses, a command's output): no hits, no exceptions. */
export function checkOutputs(outputs: ReadonlyArray<{ label: string; text: string }>, rules = loadRules()): string[] {
  return outputs.flatMap(({ label, text }) => findHits(text, rules).map((h) => `${label}, line ${h.line}: "${h.match}"`));
}

/** Lines with hits in each excepted file, by exception (references not counted), for the acceptance record. */
export function exceptionCounts(root: string, files: readonly string[], rules = loadRules(root)): Map<string, Map<string, number>> {
  const counts = new Map<string, Map<string, number>>();
  for (const file of files) {
    const name = exemption(root, file, rules);
    if (!name) continue;
    let content: Buffer;
    try {
      content = readFileSync(path.join(root, file));
    } catch {
      continue;
    }
    const lines = new Set(findHits(content, rules).map((h) => h.line)).size;
    if (!lines) continue;
    if (!counts.has(name)) counts.set(name, new Map());
    counts.get(name)!.set(file, lines);
  }
  return counts;
}

if (import.meta.main) {
  const { trackedFiles } = await import("./toolchain.ts");
  if (process.argv.includes("--counts")) {
    const counts = exceptionCounts(ROOT, trackedFiles());
    for (const name of Object.keys(loadRules().exceptions)) {
      const files = counts.get(name) ?? new Map<string, number>();
      const total = [...files.values()].reduce((a, b) => a + b, 0);
      console.log(`${name}: ${files.size} files, ${total} lines`);
      for (const [file, n] of [...files].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`  ${String(n).padStart(5)}  ${file}`);
    }
  } else {
    const problems = checkNames(ROOT, trackedFiles());
    for (const p of problems) console.log(p);
    console.log(problems.length ? `${problems.length} problems` : "names: no hits outside the exceptions, no upstream brand asset");
    process.exit(problems.length ? 1 : 0);
  }
}
