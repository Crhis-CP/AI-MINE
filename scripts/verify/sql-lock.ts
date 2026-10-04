import { parseAllDocuments } from "yaml";
import { sha256 } from "./lib.ts";

type RecordValue = Record<string, unknown>;
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
  const rootsToRead = [
    ["packages/backend", "postgres"],
    ["packages/backend", "pg-boss"],
    [".", "typescript"],
  ] as const;
  const versionPattern = "\\d+\\.\\d+\\.\\d+(?:-[\\w.-]+)?(?:\\+[\\w.-]+)?";
  const version = new RegExp(`^(${versionPattern})((?:\\((?:@[\\w.-]+/)?[\\w.-]+@${versionPattern}\\))*)$`);
  const visit = (name: string, reference: unknown): void => {
    if (typeof reference !== "string" || !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) throw new Error(`Unsupported lock dependency: ${name}`);
    const parts = version.exec(reference);
    if (!parts) throw new Error(`Unsupported dependency reference: ${name}`);
    const snapshotKey = `${name}@${reference}`,
      packageKey = `${name}@${parts[1]}`;
    if (Object.hasOwn(snapshots, snapshotKey)) return;
    const pkg = record(allPackages[packageKey], packageKey),
      snapshot = record(allSnapshots[snapshotKey], snapshotKey);
    const integrity = record(pkg.resolution, `${packageKey}.resolution`).integrity;
    if (typeof integrity !== "string" || !integrity || pkg.patched) throw new Error(`Unsupported package resolution: ${packageKey}`);
    packages[packageKey] = pkg;
    snapshots[snapshotKey] = snapshot;
    // Keep complete entries, including integrity/optional/peer metadata, not only version strings.
    for (const kind of ["dependencies", "optionalDependencies"])
      for (const [child, ref] of Object.entries(record(snapshot[kind] === undefined ? {} : snapshot[kind], `${snapshotKey}.${kind}`))) visit(child, ref);
    for (const peer of parts[2].matchAll(/\(((?:@[\w.-]+\/)?[\w.-]+)@([^()]+)\)/g)) visit(peer[1], peer[2]);
  };
  for (const [importer, name] of rootsToRead) {
    const item = record(importers[importer], importer);
    const entries = ["dependencies", "devDependencies", "optionalDependencies"].flatMap((kind) => {
      const dependencies = record(item[kind] === undefined ? {} : item[kind], `${importer}.${kind}`);
      return Object.hasOwn(dependencies, name) ? [{ kind, value: record(dependencies[name], `${importer}.${name}`) }] : [];
    });
    if (entries.length !== 1) throw new Error(`Missing or ambiguous SQL/parser root: ${importer}/${name}`);
    roots[`${importer}/${name}`] = entries[0];
    visit(name, entries[0].value.version);
  }
  const graph = { roots, packages, snapshots };
  return { fingerprint: sha256(JSON.stringify(canonical(graph))), roots, packages: Object.keys(packages).sort(), snapshots: Object.keys(snapshots).sort() };
}
