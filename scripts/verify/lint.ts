// Stage `format-lint` (T-0001; docs/04-architecture/05-engineering-conventions.md item 2): `biome ci` fails on
// any formatting difference or lint error, and the warnings the imported code already had are held to
// scripts/verify/lint-baseline.json, per file and rule: a count above the list fails (new code adds no
// warnings), a count below it fails until the list is rewritten, so the list only ever shrinks.
//   node scripts/verify/lint.ts --write     rewrite the list from the current tree
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { capture, type Log, ROOT, run } from "./lib.ts";

export const BASELINE_FILE = "scripts/verify/lint-baseline.json";
type Counts = Record<string, Record<string, number>>;

interface Diagnostic {
  severity: string;
  category: string;
  location?: { path?: string };
}

export function countWarnings(diagnostics: readonly Diagnostic[]): Counts {
  const counts: Counts = {};
  for (const d of diagnostics) {
    if (d.severity !== "warning" || !d.location?.path) continue;
    const file = counts[d.location.path] ?? {};
    file[d.category] = (file[d.category] ?? 0) + 1;
    counts[d.location.path] = file;
  }
  return sorted(counts);
}

const sorted = (counts: Counts): Counts =>
  Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((f) => [f, Object.fromEntries(Object.entries(counts[f]).sort(([a], [b]) => a.localeCompare(b)))]),
  );

/** Differences between the warnings now and the baseline, one line each; empty when they match. */
export function compareWarnings(now: Counts, baseline: Counts): string[] {
  const out: string[] = [];
  for (const file of new Set([...Object.keys(now), ...Object.keys(baseline)])) {
    for (const rule of new Set([...Object.keys(now[file] ?? {}), ...Object.keys(baseline[file] ?? {})])) {
      const n = now[file]?.[rule] ?? 0;
      const b = baseline[file]?.[rule] ?? 0;
      if (n > b) out.push(`${file}: ${rule} ${n} warnings, ${b} allowed — fix the new ones`);
      if (n < b) out.push(`${file}: ${rule} down from ${b} to ${n} — rewrite the list: node scripts/verify/lint.ts --write`);
    }
  }
  return out.sort();
}

async function lintCounts(log: Log, env: NodeJS.ProcessEnv): Promise<Counts | null> {
  const r = await capture("pnpm", ["exec", "biome", "lint", "--reporter=json", "--max-diagnostics=none", "--colors=off", "."], { log, env });
  try {
    return countWarnings((JSON.parse(r.stdout) as { diagnostics: Diagnostic[] }).diagnostics);
  } catch {
    log.line(`biome lint did not produce a JSON report (exit ${r.code})`);
    return null;
  }
}

/** The stage: `biome ci`, then the warning counts against the baseline. Returns the problems found. */
export async function formatLint(log: Log, env: NodeJS.ProcessEnv): Promise<string[]> {
  const problems: string[] = [];
  if ((await run("pnpm", ["exec", "biome", "ci", "--colors=off", "."], { log, env })) !== 0) {
    problems.push("biome ci failed (formatting or a lint error); run pnpm exec biome check --write . and fix the rest");
  }
  const now = await lintCounts(log, env);
  if (!now) return [...problems, "could not count the lint warnings"];
  const baseline = JSON.parse(readFileSync(path.join(ROOT, BASELINE_FILE), "utf8")) as Counts;
  const diff = compareWarnings(now, baseline);
  for (const line of diff) log.line(line);
  if (diff.length) problems.push(`lint warnings differ from ${BASELINE_FILE} (${diff.length} lines, see the log)`);
  return problems;
}

if (import.meta.main && process.argv.includes("--write")) {
  const log = { file: "/dev/stderr", line: (t: string) => process.stderr.write(`${t}\n`) };
  const counts = await lintCounts(log, process.env);
  if (!counts) process.exit(1);
  writeFileSync(path.join(ROOT, BASELINE_FILE), `${JSON.stringify(counts, null, 2)}\n`);
  const total = Object.values(counts).reduce((n, f) => n + Object.values(f).reduce((a, b) => a + b, 0), 0);
  console.log(`${BASELINE_FILE}: ${total} warnings in ${Object.keys(counts).length} files`);
}
