import path from "node:path";
import { parseAllDocuments } from "yaml";
import { sha256 } from "./lib.ts";

type RecordValue = Record<string, unknown>;
type NormalizedNode = { integrity: string; dependencies: Record<string, string> };
type NormalizedGraph = { roots: Record<string, { kind: string; specifier: string; target: string }>; nodes: Record<string, NormalizedNode> };
const SQL_ROOTS = [
  ["packages/backend", "postgres"],
  ["packages/backend", "pg-boss"],
  [".", "typescript"],
] as const;
function keepNode(graph: NormalizedGraph, key: string, node: NormalizedNode): void {
  if (graph.nodes[key] && JSON.stringify(canonical(graph.nodes[key])) !== JSON.stringify(canonical(node)))
    throw new Error(`Ambiguous SQL dependency context: ${key}`);
  graph.nodes[key] = node;
}
function record(value: unknown, label: string): RecordValue {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`Unsupported lock record: ${label}`);
  return value as RecordValue;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const object = record(value, "entry");
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, canonical(object[key])]),
    );
  }
  if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) throw new Error("Unsupported lock value");
  return value;
}

/** Only the resolved SQL-driver/queue and native parser subgraphs; no general JS dependency inference. */
export function sqlLockFingerprint(text: string) {
  if (text.trimStart().startsWith("{")) return npmSqlLockFingerprint(text);
  const docs = parseAllDocuments(text);
  if (!docs.length || docs.some((doc) => doc.errors.length || doc.warnings.length)) throw new Error("Cannot parse pnpm lock documents");
  const locks = docs.map((doc) => record(doc.toJS(), "document"));
  const candidates = locks.filter((lock) => Object.hasOwn(record(lock.importers, "importers"), "packages/backend"));
  if (candidates.length !== 1 || candidates[0].lockfileVersion !== "9.0") throw new Error("Unsupported application lock document");
  const lock = candidates[0],
    importers = record(lock.importers, "importers"),
    allPackages = record(lock.packages, "packages"),
    allSnapshots = record(lock.snapshots, "snapshots");
  const packages: RecordValue = {},
    snapshots: RecordValue = {},
    roots: RecordValue = {};
  const normalized: NormalizedGraph = { roots: {}, nodes: {} };
  const versionPattern = "\\d+\\.\\d+\\.\\d+(?:-[\\w.-]+)?(?:\\+[\\w.-]+)?";
  const version = new RegExp(`^(${versionPattern})((?:\\((?:@[\\w.-]+/)?[\\w.-]+@${versionPattern}\\))*)$`);
  const visit = (name: string, reference: unknown): string => {
    if (typeof reference !== "string" || !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) throw new Error(`Unsupported lock dependency: ${name}`);
    const parts = version.exec(reference);
    if (!parts) throw new Error(`Unsupported dependency reference: ${name}`);
    const snapshotKey = `${name}@${reference}`,
      packageKey = `${name}@${parts[1]}`;
    if (Object.hasOwn(snapshots, snapshotKey)) return packageKey;
    const pkg = record(allPackages[packageKey], packageKey),
      snapshot = record(allSnapshots[snapshotKey], snapshotKey);
    const integrity = record(pkg.resolution, `${packageKey}.resolution`).integrity;
    if (typeof integrity !== "string" || !integrity || pkg.patched) throw new Error(`Unsupported package resolution: ${packageKey}`);
    packages[packageKey] = pkg;
    snapshots[snapshotKey] = snapshot;
    // Keep complete entries, including integrity/optional/peer metadata, not only version strings.
    const dependencies: Record<string, string> = {};
    for (const kind of ["dependencies", "optionalDependencies"])
      for (const [child, ref] of Object.entries(record(snapshot[kind] === undefined ? {} : snapshot[kind], `${snapshotKey}.${kind}`)))
        dependencies[child] = visit(child, ref);
    for (const peer of parts[2].matchAll(/\(((?:@[\w.-]+\/)?[\w.-]+)@([^()]+)\)/g)) dependencies[peer[1]] = visit(peer[1], peer[2]);
    keepNode(normalized, packageKey, { integrity, dependencies });
    return packageKey;
  };
  for (const [importer, name] of SQL_ROOTS) {
    const item = record(importers[importer], importer);
    const entries = ["dependencies", "devDependencies", "optionalDependencies"].flatMap((kind) => {
      const dependencies = record(item[kind] === undefined ? {} : item[kind], `${importer}.${kind}`);
      return Object.hasOwn(dependencies, name) ? [{ kind, value: record(dependencies[name], `${importer}.${name}`) }] : [];
    });
    if (entries.length !== 1) throw new Error(`Missing or ambiguous SQL/parser root: ${importer}/${name}`);
    roots[`${importer}/${name}`] = entries[0];
    const specifier = entries[0].value.specifier;
    if (typeof specifier !== "string") throw new Error(`Unsupported root specifier: ${name}`);
    normalized.roots[`${importer}/${name}`] = { kind: entries[0].kind, specifier, target: visit(name, entries[0].value.version) };
  }
  const graph = { roots, packages, snapshots };
  return {
    fingerprint: sha256(JSON.stringify(canonical(graph))),
    roots,
    packages: Object.keys(packages).sort(),
    snapshots: Object.keys(snapshots).sort(),
    normalized,
  };
}

/** npm v3 records physical locations; resolve only the same three SQL/parser roots and their actual dependencies. */
function npmSqlLockFingerprint(text: string) {
  const lock = record(JSON.parse(text), "npm document");
  if (lock.lockfileVersion !== 3) throw new Error("Unsupported npm lock version");
  const all = record(lock.packages, "npm packages"),
    roots: RecordValue = {},
    entries: RecordValue = {};
  const normalized: NormalizedGraph = { roots: {}, nodes: {} };
  const resolve = (parent: string, name: string, optionalPeer = false): string | null => {
    if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) throw new Error("Unsupported npm dependency name");
    let at = parent;
    for (;;) {
      if (path.posix.basename(at) !== "node_modules") {
        const candidate = path.posix.join(at, "node_modules", name);
        if (Object.hasOwn(all, candidate)) {
          const entry = record(all[candidate], candidate);
          if (optionalPeer && entry.version === undefined) return null;
          return candidate;
        }
      }
      if (!at) break;
      const next = path.posix.dirname(at);
      at = next === "." ? "" : next;
    }
    if (optionalPeer) return null;
    throw new Error(`Missing npm SQL dependency: ${name}`);
  };
  const visit = (name: string, location: string): string => {
    const entry = record(all[location], location);
    if (entry.link || typeof entry.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(entry.version))
      throw new Error(`Unsupported npm SQL package: ${name}`);
    if (entry.name !== undefined && entry.name !== name) throw new Error(`Unsupported npm SQL alias: ${name}`);
    const key = `${name}@${entry.version}`;
    if (Object.hasOwn(entries, location)) return key;
    const integrity = entry.integrity;
    if (typeof integrity !== "string" || !integrity || typeof entry.resolved !== "string") throw new Error(`Missing npm package integrity: ${name}`);
    const url = new URL(entry.resolved);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error(`Unsupported npm package resolution: ${name}`);
    entries[location] = entry;
    const dependencies: Record<string, string> = {};
    for (const kind of ["dependencies", "optionalDependencies"]) {
      for (const [child, spec] of Object.entries(record(entry[kind] === undefined ? {} : entry[kind], `${location}.${kind}`))) {
        if (typeof spec !== "string" || !spec) throw new Error(`Unsupported npm dependency specifier: ${child}`);
        dependencies[child] = visit(child, resolve(location, child)!);
      }
    }
    const peerMeta = record(entry.peerDependenciesMeta === undefined ? {} : entry.peerDependenciesMeta, `${location}.peerDependenciesMeta`);
    for (const [child, spec] of Object.entries(record(entry.peerDependencies === undefined ? {} : entry.peerDependencies, `${location}.peerDependencies`))) {
      if (typeof spec !== "string" || !spec) throw new Error(`Unsupported npm peer specifier: ${child}`);
      if (Object.hasOwn(dependencies, child)) continue;
      const optional = peerMeta[child] !== undefined && record(peerMeta[child], `${location}.peerDependenciesMeta.${child}`).optional === true;
      const target = resolve(location, child, optional);
      if (target) dependencies[child] = visit(child, target);
    }
    keepNode(normalized, key, { integrity, dependencies });
    return key;
  };
  for (const [importer, name] of SQL_ROOTS) {
    const location = importer === "." ? "" : importer,
      item = record(all[location], importer);
    const matches = ["dependencies", "devDependencies", "optionalDependencies"].flatMap((kind) => {
      const values = record(item[kind] === undefined ? {} : item[kind], `${importer}.${kind}`);
      return Object.hasOwn(values, name) ? [{ kind, specifier: values[name] }] : [];
    });
    if (matches.length !== 1 || typeof matches[0].specifier !== "string") throw new Error(`Missing or ambiguous SQL/parser root: ${importer}/${name}`);
    const target = resolve(location, name)!;
    roots[`${importer}/${name}`] = { ...matches[0], location: target };
    normalized.roots[`${importer}/${name}`] = { kind: matches[0].kind, specifier: matches[0].specifier, target: visit(name, target) };
  }
  return {
    fingerprint: sha256(JSON.stringify(canonical({ format: "npm-v3", roots, packages: entries }))),
    roots,
    packages: Object.keys(normalized.nodes).sort(),
    snapshots: Object.keys(entries).sort(),
    normalized,
  };
}
