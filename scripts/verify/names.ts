// Stage `names` (TASK-0003 completion condition 1; docs/04-architecture/04-aihot-adoption.md 4.3 and 4.6
// item 1; docs/05-quality/03-testing-standards.md 1.1): the upstream project's name, its two brand colours and
// its ring loader appear only on the exception paths of names.json, and no tracked file has the SHA-256 of an
// upstream brand asset (no exceptions). Paths and file names of the registration and handoff files are not
// hits. The same patterns apply, with no exception paths, to the reader site's build output (stage build-web) and
// to the pages, machine outputs and MCP answers of the running site (stage smoke); the one allowance there is the
// changelog's thanks, the exact phrases of names.json `allowedPhrases` in the outputs it names. In the repository
// those phrases, each exactly as many times as names.json says, are also the only hits allowed in the files it
// names, which are exactly the files of exception 7. JSON files are read with their \uXXXX escapes decoded.
//   node scripts/verify/names.ts            the repository check, as the stage runs it
//   node scripts/verify/names.ts --counts   lines with hits in each excepted file (for the acceptance record)
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { patternRegExp, ROOT, sha256 } from "./lib.ts";
import { fetchWithHost } from "./api-split.ts";

/** An exception path; with `sameAs` it covers the file only while the file is byte-identical to that handoff
 *  template, with `upstream` only while its SHA-256 is that upstream file's in the source manifest. */
type Exception = string | { path: string; sameAs: string } | { path: string; upstream: string };
export interface NameRules {
  names: string[];
  marks: string[];
  exceptions: Record<string, Exception[]>;
  notExceptions: string[];
  references: string[];
  manifest: string;
  brand: { prefixes: string[] };
  /** Exact phrases (the changelog's thanks), each with the number of times it appears in each file named. In those
   *  files the counts must match and the phrases are blanked before the search (the limit of exception 7); in the
   *  outputs named they are blanked without counting (the only allowance in what the site serves). */
  allowedPhrases?: { phrases: Record<string, number>; files: string[]; outputs: string[] };
}
export interface Hit {
  line: number;
  match: string;
}

export const loadRules = (root = ROOT): NameRules => JSON.parse(readFileSync(path.join(root, "scripts/verify/names.json"), "utf8")) as NameRules;

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hitPattern = (rules: NameRules) => new RegExp([...rules.names, ...rules.marks].map(literal).join("|"), "gi");

/** The text with the allowed phrases blanked out, lines kept in place. */
const withoutPhrases = (text: string, rules: NameRules): string =>
  Object.keys(rules.allowedPhrases?.phrases ?? {}).reduce((t, p) => t.replaceAll(p, "\0".repeat(p.length)), text);

/** The text with every path or file name of a registration or handoff file blanked out, lines kept in place. */
export function withoutReferences(text: string, rules: NameRules): string {
  return rules.references.reduce((t, r) => t.replace(new RegExp(r, "g"), (m) => "\0".repeat(m.length)), text);
}

/** Hits in one file or response. Files are read byte for byte (latin1), so binary files are searched too. In the
 *  repository the references are not hits; the build output and the site's outputs pass `references: false`. */
export function findHits(content: Buffer | string, rules: NameRules, { references = true } = {}): Hit[] {
  const raw = typeof content === "string" ? content : content.toString("latin1");
  const text = references ? withoutReferences(raw, rules) : raw;
  const hits: Hit[] = [];
  let line = 1;
  let at = 0;
  for (const m of text.matchAll(hitPattern(rules))) {
    for (; at < m.index; at++) if (text.charCodeAt(at) === 10) line++;
    hits.push({ line, match: m[0] });
  }
  return hits;
}

/** A JSON file's text with its \uXXXX escapes decoded, so a name written as escapes is found; an escaped backslash
 *  stays as it is. A decoded line break becomes a tab, neither a space nor a line break: hits keep the file's own line
 *  numbers, and an allowed phrase with its space written as an escaped line break is not that phrase. */
export function jsonUnescaped(text: string): string {
  return text.replace(/\\(?:\\|u([0-9a-fA-F]{4}))/g, (sequence: string, hex?: string) => {
    if (hex === undefined) return sequence;
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return char === "\n" || char === "\r" ? "\t" : char;
  });
}

/** A repository file's text as the check reads it: JSON with its escapes decoded. */
const readable = (file: string, text: string) => (file.endsWith(".json") ? jsonUnescaped(text) : text);

type ManifestFile = { path: string; sha256: string };
const manifestFiles = (root: string, rules: NameRules) =>
  (JSON.parse(readFileSync(path.join(root, rules.manifest), "utf8")) as { files: ManifestFile[] }).files;

/** Whether a conditional exception's file is still its original: the handoff template byte for byte, or the
 *  upstream file by SHA-256. */
function isOriginal(root: string, file: string, entry: Exclude<Exception, string>, rules: NameRules): boolean {
  try {
    const bytes = readFileSync(path.join(root, file));
    if ("sameAs" in entry) return bytes.equals(readFileSync(path.join(root, entry.sameAs)));
    const hash = sha256(bytes);
    return manifestFiles(root, rules).some((f) => f.path === entry.upstream && f.sha256 === hash);
  } catch {
    return false;
  }
}

/** The exception that covers a file (the most specific pattern wins), or null. `notExceptions` are never covered. */
export function exemption(root: string, file: string, rules: NameRules): string | null {
  if (rules.notExceptions.some((p) => patternRegExp(p).test(file))) return null;
  let best: { name: string; length: number } | null = null;
  for (const [name, entries] of Object.entries(rules.exceptions)) {
    for (const entry of entries) {
      const pattern = typeof entry === "string" ? entry : entry.path;
      if (!patternRegExp(pattern).test(file) || (best && best.length >= pattern.length)) continue;
      if (typeof entry !== "string" && !isOriginal(root, file, entry, rules)) continue;
      best = { name, length: pattern.length };
    }
  }
  return best?.name ?? null;
}

/** SHA-256 → upstream path of every brand asset in the source manifest. */
export function brandHashes(root: string, rules: NameRules): Map<string, string> {
  const brand = manifestFiles(root, rules).filter((f) => rules.brand.prefixes.some((p) => f.path.startsWith(p)));
  return new Map(brand.map((f) => [f.sha256, f.path]));
}

/** A tracked file's bytes (for a symbolic link, the target path git stores), or null once the working tree no
 *  longer has it. Any other read error is a problem: a file the check cannot read is not a file it checked. */
function readTracked(root: string, file: string, problems: string[]): Buffer | null {
  const full = path.join(root, file);
  try {
    return lstatSync(full).isSymbolicLink() ? Buffer.from(readlinkSync(full)) : readFileSync(full);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`${file}: cannot be read (${(e as Error).message})`);
    return null; // ENOENT: deleted in the working tree (pnpm check)
  }
}

const OUTSIDE = "outside the exception paths of scripts/verify/names.json";
const BEYOND = "outside the allowed phrases of scripts/verify/names.json";

/** A file of `allowedPhrases`, read as UTF-8: each phrase as many times as names.json says, and no other hit once
 *  the phrases are blanked. */
function phraseProblems(file: string, text: string, rules: NameRules): string[] {
  const counts = Object.entries(rules.allowedPhrases?.phrases ?? {}).flatMap(([phrase, allowed]) => {
    const n = text.split(phrase).length - 1;
    return n === allowed ? [] : [`${file}: "${phrase}" appears ${n} times, scripts/verify/names.json allows ${allowed}`];
  });
  return [...counts, ...findHits(withoutPhrases(text, rules), rules).map((h) => `${file}:${h.line}: "${h.match}" ${BEYOND}`)];
}

/** The files of allowedPhrases are exactly one exception's list (exception 7): a file added to only one of the two
 *  lists would be excepted without its phrases counted, or counted without being excepted. */
function phraseListProblems(rules: NameRules): string[] {
  const files = rules.allowedPhrases?.files ?? [];
  if (!files.length)
    return Object.keys(rules.allowedPhrases?.phrases ?? {}).length
      ? ["scripts/verify/names.json: allowedPhrases has phrases but no files, so no file is limited to them"]
      : [];
  const lists = Object.entries(rules.exceptions).map(([name, entries]) => ({ name, paths: entries.map((e) => (typeof e === "string" ? e : e.path)) }));
  const owners = lists.filter(({ paths }) => files.some((file) => paths.includes(file)));
  if (owners.length !== 1)
    return [
      `scripts/verify/names.json: allowedPhrases.files must be the files of one exception, not of ${owners.map((o) => `"${o.name}"`).join(" and ") || "none"}`,
    ];
  const [{ name, paths }] = owners as [(typeof lists)[number]];
  const onlyExcepted = paths.filter((path) => !files.includes(path)),
    onlyCounted = files.filter((file) => !paths.includes(file));
  if (!onlyExcepted.length && !onlyCounted.length) return [];
  const list = (names: string[]) => names.join(", ") || "none";
  return [
    `scripts/verify/names.json: exception "${name}" and allowedPhrases.files must list the same files (only in the exception: ${list(onlyExcepted)}; only in allowedPhrases.files: ${list(onlyCounted)})`,
  ];
}

/** Problems in the repository: hits outside the exceptions, paths that name the project, upstream brand assets. */
export function checkNames(root: string, files: readonly string[], rules = loadRules(root)): string[] {
  const problems: string[] = phraseListProblems(rules);
  const originals = new Map(
    Object.values(rules.exceptions)
      .flat()
      .flatMap((e) => {
        if (typeof e === "string") return [];
        const why = "sameAs" in e ? `${e.sameAs}, so the governance exception` : `the upstream ${e.upstream} in ${rules.manifest}, so the exception`;
        return [[e.path, why] as const];
      }),
  );
  const brand = brandHashes(root, rules);
  if (!brand.size) problems.push(`${rules.manifest}: no brand assets under ${rules.brand.prefixes.join(", ")}; the hash check would be empty`);
  for (const file of files) {
    const excepted = exemption(root, file, rules) !== null;
    const found = excepted ? [] : findHits(file, rules).map((h) => `${file}: the path contains "${h.match}"`);
    const content = readTracked(root, file, problems);
    if (content) {
      const asset = brand.get(sha256(content));
      if (asset) problems.push(`${file}: same bytes as the upstream brand asset ${asset} (no exceptions)`);
      if (!excepted) found.push(...findHits(readable(file, content.toString("latin1")), rules).map((h) => `${file}:${h.line}: "${h.match}" ${OUTSIDE}`));
      else if (rules.allowedPhrases?.files.includes(file)) found.push(...phraseProblems(file, readable(file, content.toString("utf8")), rules));
    }
    const original = originals.get(file);
    if (found.length && original) found.push(`${file}: differs from ${original} does not cover it`);
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
    for (const h of findHits(content, rules, { references: false })) problems.push(`${shown}:${h.line}: "${h.match}" in the build output`);
    const asset = brand.get(sha256(content));
    if (asset) problems.push(`${shown}: same bytes as the upstream brand asset ${asset}`);
  }
  return problems;
}

/** Pages and machine outputs of the running site checked by the smoke stage (TASK-0003 :126), each with the
 *  statuses it may answer on the fresh database of a verify run. The changes feed is fetched after these, with
 *  the snapshot's cursor (without one it answers 409 snapshot_required). */
export const SITE_OUTPUTS: ReadonlyArray<readonly [path: string, statuses: readonly number[]]> = [
  ["/", [200]],
  ["/all", [200]],
  ["/hot", [200]],
  ["/daily", [200]],
  ["/daily/archive", [200]],
  ["/topics", [200]],
  ["/starred", [200]],
  ["/agent", [200]],
  ["/about", [200]],
  ["/changelog", [200]],
  ["/feedback", [200]],
  ["/terms", [200]],
  ["/privacy", [200]],
  ["/more", [200]],
  ["/admin/login", [404]],
  ["/no-such-page", [404]],
  ["/llms.txt", [200]],
  ["/openapi-v1.json", [200]],
  ["/feed.xml", [200]],
  ["/feed/full.xml", [200]],
  ["/feed/all.xml", [200]],
  ["/feed/daily.xml", [200]],
  ["/robots.txt", [200]],
  ["/sitemap.xml", [200]],
  ["/manifest.webmanifest", [200]],
  ["/.well-known/security.txt", [200, 404]], // 404 while industry/site.ts has no contact address
  ["/api/v1/items", [200]],
  ["/api/v1/hot-topics", [200]],
  ["/api/v1/dailies", [200]],
  ["/api/v1/dailies/latest", [200, 404]], // 404 until a daily is published
  ["/api/v1/selected/snapshot", [200]],
  ["/api/site/changelog", [200]], // the changelog's data: the thanks phrases of names.json pass here and on /changelog only
];

export interface McpRequest {
  label: string;
  method: string;
  params: Record<string, unknown>;
  /** The tool must answer with a result, not an error result (`isError`). */
  mustSucceed: boolean;
}

/** The MCP handshake, the tool list, and one call of each tool. Each answer is checked whole, structured content
 *  and _meta included. latest, search and hot have answers on an empty database, so an error result from them
 *  fails the stage; get_story asks for a story that does not exist and an empty database has no daily, so their
 *  error answers are what gets checked. The tool names come from the contract, loaded here only, so that the
 *  rename script and the other stages run without the product's packages. */
export async function mcpRequests(): Promise<McpRequest[]> {
  const { MCP_TOOL_NAMES: T } = await import("@amp/contracts/mcp");
  const calls: Array<[name: string, args: Record<string, unknown>, mustSucceed: boolean]> = [
    [T.latest, { limit: 2 }, true],
    [T.search, { q: "copper", limit: 2 }, true],
    [T.hot, { limit: 3 }, true],
    [T.story, { public_id: "no-such-story" }, false],
    [T.daily, {}, false],
  ];
  return [
    {
      label: "initialize",
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1" } },
      mustSucceed: true,
    },
    { label: "tools/list", method: "tools/list", params: {}, mustSucceed: true },
    ...calls.map(([name, args, mustSucceed]) => ({ label: `tools/call ${name}`, method: "tools/call", params: { name, arguments: args }, mustSucceed })),
  ];
}

/** The JSON object in a response body: plain JSON, or the `data:` line of a server-sent event (MCP). */
function jsonBody(body: string): Record<string, unknown> | null {
  const candidates = [body, ...body.split("\n").flatMap((l) => (l.startsWith("data:") ? [l.slice(5)] : []))];
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === "object") return value as Record<string, unknown>;
    } catch {
      // not this one
    }
  }
  return null;
}

export interface SiteOutputs {
  outputs: Array<{ label: string; text: string }>;
  /** Unexpected statuses, a snapshot without a cursor, MCP requests without a JSON-RPC result or with an error result. */
  problems: string[];
}

/** The bodies of SITE_OUTPUTS, the changes feed and the mcpRequests() answers, labelled by path or request. */
export async function fetchSiteOutputs(base: string, privateHost: string): Promise<SiteOutputs> {
  if (!privateHost) throw new Error("Name output probe requires PRIVATE_HOST");
  const outputs: SiteOutputs["outputs"] = [];
  const problems: string[] = [];
  const get = async (url: string, statuses: readonly number[], shown = url, host?: string) => {
    const r = host ? await fetchWithHost(base + url, host) : await fetch(base + url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    outputs.push({ label: `${shown} (HTTP ${r.status})`, text });
    if (!statuses.includes(r.status)) problems.push(`${shown}: HTTP ${r.status}, expected ${statuses.join(" or ")}`);
    if (!host && url === "/admin/login" && r.headers.has("set-cookie")) problems.push("/admin/login: public rejection set a cookie");
    return text;
  };
  let snapshot = "";
  for (const [url, statuses] of SITE_OUTPUTS) {
    const text = await get(url, statuses);
    if (url === "/api/v1/selected/snapshot") snapshot = text;
  }
  await get("/admin/login", [200], "private /admin/login", privateHost);
  const cursor = (jsonBody(snapshot) as { cursor?: unknown } | null)?.cursor;
  if (typeof cursor === "string" && cursor)
    await get(`/api/v1/selected/changes?cursor=${encodeURIComponent(cursor)}`, [200], "/api/v1/selected/changes?cursor=<snapshot cursor>");
  else problems.push("/api/v1/selected/snapshot: no cursor, so the changes feed was not fetched");
  for (const [i, { label, method, params, mustSucceed }] of (await mcpRequests()).entries()) {
    const r = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: i + 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    outputs.push({ label: `MCP ${label} (HTTP ${r.status})`, text });
    const answer = jsonBody(text);
    const result = answer?.result as { isError?: unknown; content?: Array<{ text?: unknown }> } | null | undefined;
    if (r.status !== 200 || !answer || !("result" in answer)) {
      problems.push(`MCP ${label}: HTTP ${r.status}, ${answer && "error" in answer ? `error ${JSON.stringify(answer.error)}` : "no JSON-RPC result"}`);
    } else if (mustSucceed && result?.isError === true) {
      problems.push(`MCP ${label}: an error result (${String(result.content?.[0]?.text ?? "no text").slice(0, 200)})`);
    }
  }
  return { outputs, problems };
}

/** Problems in labelled outputs (responses, a command's output): no hits, no exceptions, no references; the only
 *  allowance is the exact phrases names.json allows in the outputs it names (the changelog's thanks, exception 7). */
export function checkOutputs(outputs: ReadonlyArray<{ label: string; text: string }>, rules = loadRules()): string[] {
  return outputs.flatMap(({ label, text }) => {
    const allowed = rules.allowedPhrases?.outputs.some((o) => label.startsWith(`${o} (`));
    return findHits(allowed ? withoutPhrases(text, rules) : text, rules, { references: false }).map((h) => `${label}, line ${h.line}: "${h.match}"`);
  });
}

/** Lines with hits in each excepted file, by exception (references not counted), for the acceptance record. */
export function exceptionCounts(root: string, files: readonly string[], rules = loadRules(root)): Map<string, Map<string, number>> {
  const counts = new Map<string, Map<string, number>>();
  for (const file of files) {
    const name = exemption(root, file, rules);
    if (!name) continue;
    const content = readTracked(root, file, []);
    if (!content) continue;
    const lines = new Set(findHits(readable(file, content.toString("latin1")), rules).map((h) => h.line)).size;
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
