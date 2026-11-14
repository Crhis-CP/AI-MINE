// Every editorial prompt lives in the industry pack as a Markdown file (industry/prompts/*.md), so a new
// industry changes its taste by editing text, not code. Two template forms, nothing else:
//   {{name}}     a value the calling step passes (plus siteName, from industry/site.ts)
//   {{> file}}   another prompt file, inserted as it is (shared rules)
// A missing value or file is an error, never a silent blank. Versions are content hashes, so a receipt
// and the admin's model page always say which wording produced a result.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SITE } from "@amp/industry/site";
import { REPO_ROOT } from "../config.ts";

const DIR = path.join(REPO_ROOT, "industry/prompts");
const TOKEN = /\{\{(>\s*)?([A-Za-z][\w.-]*)\s*\}\}/g;

const files = new Map<string, string>();

function raw(name: string): string {
  let text = files.get(name);
  if (text === undefined) {
    text = readFileSync(path.join(DIR, `${name}.md`), "utf8");
    files.set(name, text);
  }
  return text;
}

/** Includes read from another file: `{ a: "b" }` renders b.md wherever a template says {{> a}}. */
export type PromptSwap = Readonly<Record<string, string>>;

/** The file with its includes expanded, and the names of every file it read. */
function expand(name: string, seen: string[] = [], swap: PromptSwap = {}): { text: string; used: string[] } {
  if (seen.includes(name)) throw new Error(`prompt include cycle: ${[...seen, name].join(" → ")}`);
  const used = [name];
  const text = raw(name).replace(TOKEN, (token, include: string | undefined, key: string) => {
    if (!include) return token;
    const inner = expand(Object.hasOwn(swap, key) ? swap[key]! : key, [...seen, name], swap);
    used.push(...inner.used);
    return inner.text;
  });
  return { text, used };
}

/**
 * A prompt with its values filled in. `swap` reads other files for some includes: the shared analysis prompt is one
 * template for both selection rule sets (analysis-layout.ts).
 */
export function promptText(name: string, values: Record<string, string> = {}, swap: PromptSwap = {}): string {
  const all: Record<string, string> = { siteName: SITE.name, ...values };
  return expand(name, [], swap).text.replace(TOKEN, (_token, _include, key: string) => {
    const value = all[key];
    if (value === undefined) throw new Error(`prompt ${name}: no value for {{${key}}}`);
    return value;
  });
}

const versions = new Map<string, string>();

/**
 * `name@hash` over the files a prompt reads, so any edit shows up as a new version. Files are read once per process
 * (see `raw`), so a version is computed once too: public reads check recipes on every request.
 */
export function promptVersion(...names: string[]): string {
  const key = names.join("\n");
  let version = versions.get(key);
  if (version === undefined) {
    const used = [...new Set(names.flatMap((n) => expand(n).used))].sort();
    const hash = createHash("sha256");
    for (const n of used) hash.update(`${n}\n${raw(n)}\n`);
    version = `${names.join("+")}@${hash.digest("hex").slice(0, 10)}`;
    versions.set(key, version);
  }
  return version;
}

/** The hash of one prompt file as written, without the files it includes (the selection config check, selection-config.ts). */
export const promptFileHash = (name: string) => createHash("sha256").update(raw(name)).digest("hex").slice(0, 10);

export const quoteTranslationRecipe = () => `post-quote-v1:${promptVersion("translate-post")}`;

/**
 * Existing analysis evidence is reusable only for this material revision and scope wording (`version`: the prefilter's
 * version in the rule set and analysis prompt layout in use).
 */
export function currentPrefilter(
  analysis: { input_revision: number; prompt_version: string | null; output: unknown } | undefined,
  revision: number,
  version: string,
) {
  if (analysis?.input_revision !== revision || !analysis.prompt_version?.split("+").includes(version)) return null;
  const output = analysis.output as { prefilter?: { label?: unknown } } | null;
  const label = output?.prefilter?.label;
  return label === "PASS" || label === "BLOCK" || label === "UNKNOWN" ? label : null;
}

/** Version only the rendered configuration actually consumed by this prompt, not unused parameters. */
export function configuredPromptVersion(name: string, values: Record<string, string> = {}): string {
  const hash = createHash("sha256").update(promptText(name, values)).digest("hex").slice(0, 10);
  return `${name}@${hash}`;
}
