import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadMigrationInventory } from "../migrations/inventory.ts";
import { relationIdentity } from "../db-roles/grants.ts";
import { ROOT } from "./lib.ts";
import { digest, extractOwnership } from "./ts-ownership.ts";
import { sqlOwnership } from "./sql-ownership.ts";
import { sqlLockFingerprint } from "./sql-lock.ts";
import { rekeyUnknownBudget, unknownRekeysSchema, type UnknownRekey } from "./unknown-rekeys.ts";
import { publicationProjectionBudget, publicationProjectionSchema, type PublicationProjection } from "./publication-projection.ts";
import { miningCategoryBudget, miningCategoryTransitionSchema, type MiningCategoryTransition } from "./mining-category-transition.ts";
import { stableRouteDebt } from "./route-identities.ts";

export const OWNERSHIP_MAP = "scripts/verify/data-ownership-map.json";
export const OWNERSHIP_BASELINE = "scripts/verify/data-ownership-baseline.json";
type Owner = { module: string; access: string };
export type OwnershipMap = {
  moduleAliases: Record<string, string>;
  tables: Record<string, Owner>;
  externalTables: Record<string, Owner>;
  settings: Record<string, string>;
  retiredSettings: string[];
  readModels: Record<string, string[]>;
  splitFiles: Record<string, unknown>;
};
type Inventory = ReturnType<typeof extractOwnership>;
export type Baseline = {
  debt: Record<string, number>;
  unknown: Record<string, number>;
  unknownRekeys?: UnknownRekey[];
  publicationProjection?: PublicationProjection;
  miningCategoryTransition?: MiningCategoryTransition;
};
const read = <T>(root: string, file: string): T => JSON.parse(readFileSync(path.join(root, file), "utf8")) as T;
const normalize = (name: string, map: OwnershipMap) => map.moduleAliases[name] ?? name;
const add = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};
const text = z.string().min(1);
const strings = z.record(z.string(), text);
const owners = z.record(z.string(), z.object({ module: text, access: text }));
const counts = z.record(z.string(), z.number().finite().int().nonnegative());
const budgetSchema = z.object({
  debt: counts,
  unknown: counts,
  unknownRekeys: unknownRekeysSchema.optional(),
  publicationProjection: publicationProjectionSchema.optional(),
  miningCategoryTransition: miningCategoryTransitionSchema.optional(),
});
const mapSchema = z.object({
  moduleAliases: strings,
  tables: owners,
  externalTables: owners,
  settings: strings,
  retiredSettings: z.array(text),
  readModels: z.record(z.string(), z.array(text)),
  splitFiles: z.record(z.string(), z.record(z.string(), z.unknown())),
});
const catalogueSchema = z.object({ tables: owners });
function invalid(schema: z.ZodType, value: unknown, label: string): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : [`${label}: invalid JSON shape/value at ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`];
}

export function ownershipReport(inventory: Inventory, map: OwnershipMap, lockFingerprint?: string) {
  const malformed = invalid(mapSchema, map, "ownership map");
  if (malformed.length) throw new Error(malformed.join("; "));
  const debt: Record<string, number> = {},
    unknown: Record<string, number> = {},
    totals: Record<string, number> = {};
  const references: {
    file: string;
    line: number;
    column: number;
    scopeName: string;
    scope: string;
    module: string | null;
    owner: string | null;
    table: string;
    mode: string;
    keys: string[];
    category: string;
  }[] = [];
  const unresolved: { file: string; line: number; reasons: string[]; dependencies: Record<string, string> }[] = [];
  const errors: string[] = [];
  for (const file of inventory) {
    if (file.sites.length) add(totals, `${file.scope}.sqlFiles`);
    if (map.splitFiles[file.file] && file.sites.length) add(totals, `${file.scope}.splitFilesWithSQL`);
    const names = [...new Set(file.modules.map((item) => item.name && normalize(item.name, map)))];
    const module = names.length === 1 ? names[0] : null;
    for (const site of file.sites) {
      const reasons = [...site.unknown];
      add(totals, `${file.scope}.sqlSites`);
      if (!module) reasons.push("no unique literal dbOf module");
      for (const relation of site.relations) {
        const definition = map.tables[relation.table] ?? map.externalTables[relation.table];
        if (!definition && file.scope === "runtime") errors.push(`${file.file}:${site.line}: unmapped table ${relation.table}`);
        let owner: string | null = definition?.module ?? null;
        if (relation.table === "public.settings") {
          const owners = relation.keys.map((key) => {
            const rule = Object.keys(map.settings).find((pattern) => (pattern.endsWith("*") ? key.startsWith(pattern.slice(0, -1)) : pattern === key));
            return rule && !map.retiredSettings.includes(key) ? map.settings[rule] : null;
          });
          owner = owners.length && owners.every((name) => name === owners[0]) ? owners[0] : null;
          if (!owner) reasons.push("settings key ownership unresolved");
        }
        const category =
          file.scope !== "runtime"
            ? "non-runtime"
            : !owner || !module
              ? "unknown"
              : owner === module
                ? "own"
                : module === "publication" && relation.mode === "read" && map.readModels[file.file]?.includes(relation.table)
                  ? "read-model"
                  : map.splitFiles[file.file]
                    ? "split-debt"
                    : "cross-debt";
        references.push({
          file: file.file,
          line: site.line,
          column: site.column,
          scopeName: site.scopeName,
          scope: file.scope,
          module,
          owner,
          ...relation,
          category,
        });
        add(totals, `${file.scope}.${category}`);
        if (category.endsWith("-debt")) add(debt, JSON.stringify([file.file, site.scopeName, module, relation.table, relation.mode, category]));
      }
      if (reasons.length) {
        unresolved.push({ file: file.file, line: site.line, reasons: [...new Set(reasons)], dependencies: site.dependencies });
        add(totals, `${file.scope}.unknownSites`);
        if (file.scope === "runtime") {
          const dependencies = { ...site.dependencies };
          if (Object.hasOwn(dependencies, "pnpm-lock.yaml")) {
            if (!lockFingerprint) throw new Error("SQL/parser dependency fingerprint missing");
            delete dependencies["pnpm-lock.yaml"];
            dependencies["sql/parser-locked-subgraph"] = lockFingerprint;
          }
          add(unknown, `${file.file}:${site.scopeName}:${digest(JSON.stringify([site.sourceHash, dependencies, reasons]))}`);
        }
      }
    }
  }
  return { files: inventory, references, unresolved, totals, baseline: { debt, unknown }, errors };
}

/** Per file/function/table/direction budgets: one removed crossing cannot buy one elsewhere. */
export function compareOwnership(now: Baseline, baseline: Baseline, requirePruned = true): string[] {
  const errors = [...invalid(budgetSchema, now, "current budget"), ...invalid(budgetSchema, baseline, "baseline budget")];
  if (errors.length) return errors;
  for (const kind of ["debt", "unknown"] as const)
    for (const key of new Set([...Object.keys(now[kind]), ...Object.keys(baseline[kind])])) {
      const count = now[kind][key] ?? 0,
        prior = baseline[kind][key] ?? 0;
      if (count > prior) errors.push(`${kind}: new or increased ${key} (${count} > ${prior})`);
      if (requirePruned && count < prior) errors.push(`${kind}: remove obsolete budget ${key} (${count} < ${prior})`);
    }
  return errors;
}

export function checkCatalogue(map: OwnershipMap, catalogue: { tables: Record<string, Owner> }, created: string[]): string[] {
  const errors = [...invalid(mapSchema, map, "ownership map"), ...invalid(catalogueSchema, catalogue, "role catalogue")];
  if (errors.length) return errors;
  const grants = new Map<string, Owner>();
  for (const [name, grant] of Object.entries(catalogue.tables)) {
    try {
      const identity = relationIdentity(name);
      if (grants.has(identity.name)) errors.push(`duplicate role catalogue identity: ${identity.name}`);
      if (identity.module && normalize(grant.module, map) !== identity.module) errors.push(`table owner does not match schema: ${identity.name}`);
      grants.set(identity.name, grant);
    } catch (error) {
      errors.push(`role catalogue: ${(error as Error).message}`);
    }
  }
  for (const table of new Set([...created, ...Object.keys(map.tables), ...grants.keys()])) {
    const owner = map.tables[table],
      grant = grants.get(table);
    if (!owner?.module || !owner.access || !grant || owner.module !== normalize(grant.module, map) || owner.access !== grant.access)
      errors.push(`table ownership/grant classification missing or inconsistent: ${table}`);
    if (!created.includes(table)) errors.push(`table not found in static migrations: ${table}`);
  }
  return errors;
}

/** Preserve migration budget identities while sharing the executor's validated, ordered inventory. */
export function migrationOwnership(root = ROOT) {
  return loadMigrationInventory(root).map(({ name, sha256, text }) => ({ file: name, hash: sha256, ...sqlOwnership(text) }));
}

export function buildOwnershipReport(root = ROOT, map = read<OwnershipMap>(root, OWNERSHIP_MAP)) {
  const migrations = migrationOwnership(root);
  const sqlLock = sqlLockFingerprint(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
  const report = ownershipReport(extractOwnership(root), map, sqlLock.fingerprint);
  for (const file of migrations) if (file.unknown.length) add(report.baseline.unknown, `migration:${file.file}:${file.hash}`);
  return { ...report, migrations, sqlLock };
}

export function checkDataOwnership(root = ROOT, previous?: { baseline: Baseline; map: OwnershipMap; readSource?: (file: string) => string | null }): string[] {
  const map = read<OwnershipMap>(root, OWNERSHIP_MAP),
    baseline = read<Baseline>(root, OWNERSHIP_BASELINE);
  const malformed = [...invalid(mapSchema, map, "ownership map"), ...invalid(budgetSchema, baseline, "baseline budget")];
  if (previous) malformed.push(...invalid(mapSchema, previous.map, "previous map"), ...invalid(budgetSchema, previous.baseline, "previous budget"));
  if (malformed.length) return malformed;
  const report = buildOwnershipReport(root, map);
  const created = [...new Set(report.migrations.flatMap((file) => file.relations.filter((r) => r.mode === "create").map((r) => r.table)))];
  for (const file of report.files)
    if (file.file === "scripts/migrate.ts")
      for (const site of file.sites) for (const relation of site.relations) if (relation.mode === "create") created.push(relation.table);
  const errors = [
    ...report.errors,
    ...checkCatalogue(map, read(root, "database/roles/table-grants.json"), created),
    ...compareOwnership(report.baseline, baseline),
  ];
  if (previous) {
    const routes = stableRouteDebt(baseline.debt, previous.baseline.debt, report, (file, before) =>
      before ? (previous.readSource?.(file) ?? null) : readFileSync(path.join(root, file), "utf8"),
    );
    const rekeyed = rekeyUnknownBudget(baseline.unknown, previous.baseline.unknown, baseline.unknownRekeys, (file, before) =>
      before ? (previous.readSource?.(file) ?? null) : readFileSync(path.join(root, file), "utf8"),
    );
    const projection = publicationProjectionBudget(
      baseline.unknown,
      rekeyed.budget,
      baseline.publicationProjection,
      report.files,
      report.sqlLock.fingerprint,
      (file, before) => (before ? (previous.readSource?.(file) ?? null) : readFileSync(path.join(root, file), "utf8")),
    );
    const categories = miningCategoryBudget(
      baseline.unknown,
      projection.budget,
      baseline.miningCategoryTransition,
      report.files,
      report.sqlLock.fingerprint,
      (file, before) => (before ? (previous.readSource?.(file) ?? null) : readFileSync(path.join(root, file), "utf8")),
    );
    errors.push(
      ...routes.errors,
      ...rekeyed.errors,
      ...projection.errors,
      ...categories.errors,
      ...compareOwnership(baseline, { ...previous.baseline, debt: routes.budget, unknown: categories.budget }, false),
    );
    for (const [file, tables] of Object.entries(map.readModels))
      for (const table of tables) if (!previous.map.readModels[file]?.includes(table)) errors.push(`read-model allowlist increased: ${file} ${table}`);
    for (const file of Object.keys(map.splitFiles)) if (!previous.map.splitFiles[file]) errors.push(`split-file allowlist increased: ${file}`);
    for (const [table, owner] of Object.entries(previous.map.tables))
      if (map.tables[table] && map.tables[table].module !== owner.module) errors.push(`existing table owner changed: ${table}`);
    for (const kind of ["settings", "moduleAliases", "externalTables"] as const)
      for (const [key, value] of Object.entries(map[kind]))
        if (JSON.stringify(previous.map[kind][key]) !== JSON.stringify(value)) errors.push(`ownership rule expanded or changed: ${kind}.${key}`);
  }
  return errors;
}

if (import.meta.main) {
  if (process.argv.includes("--report")) console.log(JSON.stringify(buildOwnershipReport(), null, 2));
  else {
    const errors = checkDataOwnership();
    console.log(errors.length ? errors.join("\n") : "data-ownership: no new crossings; retained UNKNOWN sites remain unproved (see --report)");
    if (errors.length) process.exitCode = 1;
  }
}
