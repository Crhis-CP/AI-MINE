// The parts being rewritten block by block (DEC-79) are listed in legacy-zones.json. For each zone:
//   - new code (`next`) never imports the old code (`legacy`): the rewrite does not lean on what it replaces. A zone
//     marked `transitive` also refuses a chain of imports through other files (the reader: a page that imports a
//     shared module which imports an old component would ship the old code all the same);
//   - the files outside the zone that import the old code (`importers`) are listed, and the list only gets
//     shorter: a new importer is a new seam to cut later, so it fails; one that stopped importing must come
//     off the list in the same change;
//   - a zone whose old code is gone is removed from the file.
//   - against the base commit a zone's list never has more entries: adding an importer together with its list
//     entry fails, while gathering many callers behind one entry file (fewer entries) passes.
// The importers list is the seam list of the rewrite: when it is empty, the old code can be deleted.
// legacy-zones.json is a guarded path (lanes.yaml): a change that cuts a seam, redefines a zone or removes one needs
// a task card already on main that lists scripts/verify/legacy-zones.json, so a change cannot loosen the list for itself.
// Tests are not importers here: a test of old code is deleted together with it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { readModuleSyntax } from "./boundary-imports.ts";
import { git, matchesAny, ROOT } from "./lib.ts";

export interface Zone {
  name: string;
  why: string;
  legacy: string[];
  except?: string[];
  next: string[];
  /** New code may not reach the old code through any chain of imports, not only directly. */
  transitive?: boolean;
  importers: string[];
}

const SOURCE = /\.(ts|tsx|mts|cts)$/;
const TEST = /(^|\/)(tests|e2e|fixtures)\/|\.test\.tsx?$/;
const ROOTS = /^(apps|packages|modules|industry|site|scripts|deploy)\//;

interface Workspace {
  dir: string;
  exports: Record<string, string>;
}

/** Workspace packages by name, with their explicit export maps (no workspace here exports by wildcard). */
function workspaces(root: string, files: readonly string[]): Map<string, Workspace> {
  const out = new Map<string, Workspace>();
  for (const file of files) {
    if (!/(^|\/)package\.json$/.test(file) || file === "package.json") continue;
    const manifest = JSON.parse(readFileSync(path.join(root, file), "utf8")) as { name?: string; exports?: unknown };
    if (!manifest.name) continue;
    const exports: Record<string, string> = {};
    if (manifest.exports && typeof manifest.exports === "object") {
      for (const [key, value] of Object.entries(manifest.exports as Record<string, unknown>)) if (typeof value === "string") exports[key] = value;
    }
    out.set(manifest.name, { dir: path.posix.dirname(file), exports });
  }
  return out;
}

/** The tracked file an import names, or null when it is not a file of this repository. */
export function resolveImport(from: string, spec: string, tracked: ReadonlySet<string>, packages: ReadonlyMap<string, Workspace>): string | null {
  const candidates = (base: string) => [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  if (spec.startsWith(".")) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    return candidates(base).find((c) => tracked.has(c)) ?? null;
  }
  const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
  const workspace = packages.get(name);
  if (!workspace) return null;
  const sub = `.${spec.slice(name.length)}`;
  const target = workspace.exports[sub === "." ? "." : sub];
  if (target) return path.posix.normalize(path.posix.join(workspace.dir, target));
  return candidates(path.posix.normalize(path.posix.join(workspace.dir, sub))).find((c) => tracked.has(c)) ?? null;
}

/** For each zone, the production files outside it that import its old code, and the new files that do. */
export function zoneImports(
  zones: readonly Zone[],
  root = ROOT,
  files?: readonly string[],
): Map<string, { old: string[]; importers: string[]; leaning: string[]; reaching: Map<string, string[]> }> {
  const all = files ?? git(["ls-files", "-z"], root).split("\0").filter(Boolean);
  const tracked = new Set(all);
  const packages = workspaces(root, all);
  const sources = all.filter((f) => ROOTS.test(f) && SOURCE.test(f) && !TEST.test(f));
  const syntax = readModuleSyntax(Object.fromEntries(sources.map((f) => [f, readFileSync(path.join(root, f), "utf8")])));
  const targets = new Map(
    sources.map((f) => [
      f,
      [
        ...new Set(
          syntax
            .get(f)!
            .imports.map((spec) => resolveImport(f, spec, tracked, packages))
            .filter((t): t is string => t !== null),
        ),
      ],
    ]),
  );
  const out = new Map<string, { old: string[]; importers: string[]; leaning: string[]; reaching: Map<string, string[]> }>();
  for (const zone of zones) {
    const isOld = (f: string) => matchesAny(f, zone.legacy) && !matchesAny(f, zone.except ?? []);
    const old = all.filter(isOld);
    const users = sources.filter((f) => !isOld(f) && targets.get(f)!.some(isOld));
    const leaning = users.filter((f) => matchesAny(f, zone.next)).sort();
    const reaching = new Map<string, string[]>();
    if (zone.transitive)
      for (const f of sources.filter((s) => matchesAny(s, zone.next) && !leaning.includes(s)).sort()) {
        const chain = chainToOld(f, targets, isOld);
        if (chain) reaching.set(f, chain);
      }
    out.set(zone.name, { old, importers: users.filter((f) => !matchesAny(f, zone.next)).sort(), leaning, reaching });
  }
  return out;
}

/** The shortest chain of imports from `start` to an old file (both ends included), or null when there is none. */
function chainToOld(start: string, targets: ReadonlyMap<string, readonly string[]>, isOld: (f: string) => boolean): string[] | null {
  const from = new Map<string, string>([[start, ""]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const file = queue[i]!;
    for (const next of targets.get(file) ?? []) {
      if (from.has(next)) continue;
      from.set(next, file);
      if (isOld(next)) {
        const chain = [next];
        for (let at = file; at; at = from.get(at)!) chain.unshift(at);
        return chain;
      }
      queue.push(next);
    }
  }
  return null;
}

export const loadZones = (root = ROOT): Zone[] =>
  (JSON.parse(readFileSync(path.join(root, "scripts/verify/legacy-zones.json"), "utf8")) as { zones: Zone[] }).zones;

/** Every way the repository departs from legacy-zones.json, and every zone whose list grew since `baseZones`. */
export function checkLegacyZones(root = ROOT, zones = loadZones(root), files?: readonly string[], baseZones?: readonly Zone[]): string[] {
  const problems: string[] = [];
  for (const zone of zones) {
    const before = baseZones?.find((z) => z.name === zone.name);
    if (before && zone.importers.length > before.importers.length)
      problems.push(`zone ${zone.name}: the importers list grew from ${before.importers.length} to ${zone.importers.length}; it only gets shorter`);
  }
  for (const [name, found] of zoneImports(zones, root, files)) {
    const zone = zones.find((z) => z.name === name)!;
    if (!found.old.length) {
      problems.push(`zone ${name}: its old code is gone; remove the zone from scripts/verify/legacy-zones.json`);
      continue;
    }
    for (const f of found.leaning) problems.push(`${f}: new code of zone ${name} imports the old code it replaces`);
    for (const [f, chain] of found.reaching) problems.push(`${f}: new code of zone ${name} reaches the old code it replaces through ${chain.join(" -> ")}`);
    const listed = new Set(zone.importers);
    for (const f of found.importers) if (!listed.has(f)) problems.push(`${f}: a new importer of the old code of zone ${name}; the list only gets shorter`);
    const now = new Set(found.importers);
    for (const f of zone.importers) if (!now.has(f)) problems.push(`${f}: no longer imports the old code of zone ${name}; take it off the importers list`);
  }
  return problems;
}

if (import.meta.main) {
  if (process.argv.includes("--print")) {
    for (const [name, found] of zoneImports(loadZones()))
      console.log(JSON.stringify({ zone: name, old: found.old.length, importers: found.importers }, null, 2));
  } else {
    const problems = checkLegacyZones();
    for (const p of problems) console.error(p);
    process.exit(problems.length ? 1 : 0);
  }
}
