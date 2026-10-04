import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/** Canonical module paths and schemas; mapping alone never enables execution of a new schema. */
export const MODULE_SCHEMAS: Readonly<Record<string, readonly string[]>> = {
  sources: ["sources"],
  acquisition: ["acquisition"],
  content: ["content"],
  enrichment: ["enrichment"],
  entities: ["entities"],
  events: ["events"],
  policy: ["policy"],
  editorial: ["editorial"],
  publication: ["publication"],
  reports: ["reports"],
  "ai-gateway": ["ai"],
  feedback: ["feedback"],
  "platform/identity": ["identity", "audit"],
  "platform/ops": ["ops"],
  "platform/queue": ["pgboss"],
  "platform/storage": ["storage"],
  "platform/config": ["config"],
  "platform/telemetry": ["telemetry"],
};
const manifestSchema = z
  .object({
    version: z.literal(1),
    historicalCommit: z.string().regex(/^[a-f0-9]{40}$/),
    legacy: z.array(z.object({ name: z.string().regex(/^\d{4}_[a-z0-9_]+\.sql$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1),
    migrations: z.array(z.object({ name: z.string(), dependsOn: z.array(z.string()) }).strict()),
  })
  .strict();
export interface Migration {
  name: string;
  module: string | null;
  schemas: readonly string[];
  dependsOn: string[];
  sha256: string;
  text: string;
}

/** One filesystem inventory for execution and, next, schema-aware verification/role catalogues. */
export function loadMigrationInventory(root: string): Migration[] {
  root = realpathSync(root);
  if (lstatSync(path.join(root, "database")).isSymbolicLink()) throw new Error("Migration database directory symlink");
  const directory = path.join(root, "database/migrations");
  const manifestFile = path.join(root, "database/migration-inventory.json");
  if (!lstatSync(manifestFile).isFile() || lstatSync(manifestFile).isSymbolicLink()) throw new Error("Migration manifest must be a regular file");
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestFile, "utf8")));
  const files = new Set<string>();
  const discover = (dir: string) => {
    if (lstatSync(dir).isSymbolicLink()) throw new Error(`Migration directory symlink: ${dir}`);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Migration symlink: ${full}`);
      if (entry.isDirectory()) discover(full);
      else if (/\.sql$/i.test(entry.name)) {
        if (!entry.isFile()) throw new Error(`Migration must be a regular file: ${full}`);
        files.add(path.relative(directory, full).split(path.sep).join("/"));
      }
    }
  };
  discover(directory);
  const legacy = [...manifest.legacy].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (new Set(legacy.map((entry) => entry.name)).size !== legacy.length) throw new Error("Duplicate migration identity in historical manifest");
  // Fingerprint of the a32baebb originals: editing SQL and repinning its manifest cannot bless old bytes.
  const historical = createHash("sha256")
    .update(JSON.stringify({ historicalCommit: manifest.historicalCommit, legacy }))
    .digest("hex");
  if (historical !== "b2472aec53517345137f74313e72013fe096b5876f755a5a658abadd9c7d1e76") throw new Error("Historical manifest identity mismatch");
  const entries: Array<Migration & { order: string }> = [];
  const add = (name: string, module: string | null, dependsOn: string[], expected?: string) => {
    if (entries.some((entry) => entry.name === name)) throw new Error(`Duplicate migration identity: ${name}`);
    if (!files.delete(name)) throw new Error(`Missing migration file: ${name}`);
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`Duplicate migration dependency: ${name}`);
    const bytes = readFileSync(path.join(directory, name));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (expected !== undefined && sha256 !== expected) throw new Error(`Historical migration hash mismatch: ${name}`);
    const time = module ? path.posix.basename(name).slice(0, 12) : "";
    entries.push({
      name,
      module,
      schemas: module ? MODULE_SCHEMAS[module]! : ["public"],
      dependsOn,
      sha256,
      text: bytes.toString("utf8"),
      order: module ? `1/${time}/${name}` : `0/${name}`,
    });
  };
  for (const [i, entry] of legacy.entries()) add(entry.name, null, i ? [legacy[i - 1]!.name] : [], entry.sha256);
  for (const entry of manifest.migrations) {
    const module = path.posix.dirname(entry.name),
      file = path.posix.basename(entry.name);
    if (path.posix.normalize(entry.name) !== entry.name || entry.name.includes("\\") || !Object.hasOwn(MODULE_SCHEMAS, module))
      throw new Error(`Unknown module or noncanonical migration path: ${entry.name}`);
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})_[a-z][a-z0-9_]*\.sql$/.exec(file);
    const stamp = match && `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00.000Z`;
    if (!stamp || !Number.isFinite(Date.parse(stamp)) || new Date(stamp).toISOString() !== stamp) throw new Error(`Invalid UTC migration name: ${entry.name}`);
    if (new Set(entry.dependsOn).size !== entry.dependsOn.length) throw new Error(`Duplicate migration dependency: ${entry.name}`);
    add(entry.name, module, [...new Set([legacy.at(-1)!.name, ...entry.dependsOn])]);
  }
  if (files.size) throw new Error(`Unregistered migration files: ${[...files].sort().join(", ")}`);
  const names = new Set(entries.map((entry) => entry.name));
  for (const entry of entries)
    for (const dependency of entry.dependsOn) if (!names.has(dependency)) throw new Error(`Missing dependency ${dependency} for ${entry.name}`);
  entries.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  const result: Migration[] = [],
    done = new Set<string>();
  while (entries.length) {
    const index = entries.findIndex((entry) => entry.dependsOn.every((dependency) => done.has(dependency)));
    if (index < 0) throw new Error(`Migration dependency cycle: ${entries.map((entry) => entry.name).join(", ")}`);
    const [entry] = entries.splice(index, 1);
    const { order: _, ...migration } = entry!;
    result.push(migration);
    done.add(migration.name);
  }
  return result;
}

export function validateAppliedMigrations(inventory: readonly Migration[], rows: readonly { name: string; sha256: string | null }[]): void {
  const known = new Map(inventory.map((entry) => [entry.name, entry.sha256]));
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.name)) throw new Error(`Duplicate applied migration: ${row.name}`);
    seen.add(row.name);
    if (!known.has(row.name)) throw new Error(`Unknown applied migration: ${row.name}`);
    if (row.sha256 !== null && known.get(row.name) !== row.sha256) throw new Error(`Applied migration hash mismatch: ${row.name}`);
  }
}
