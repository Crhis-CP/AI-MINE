// The source catalogue is the database (DEC-79): which sources exist, how each is read, where it publishes from
// and in which language. This script moves that catalogue in and out as one JSON file kept outside the repository:
// a copy that does not need a whole database dump, and the way to bring many sources to an installation at once.
//   node scripts/source-catalogue.ts export > sources.json
//   node scripts/source-catalogue.ts import sources.json             dry run: what would be created
//   node scripts/source-catalogue.ts import sources.json --apply     creates the missing sources, stopped
// Import never changes a source that exists: its configuration, permissions and operator settings are the
// database's. A created source is stopped; it is previewed and enabled the usual way. It starts with the permission
// record it had at export (denied purposes, objections and instructions, conditions, expiry), with whoever publishes
// it and with a person's pinned interval, all written with the source itself. Permission history, previews and audit
// travel with database backups only. The file holds private permission evidence: keep it out of the repository.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createSource, findDuplicateSource, readCurrentSourcePolicy, sourceIdentity, validateSourceRestore } from "@amp/backend/admin/sources";
import { closeDb, initializeDb, sql } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";

export const CATALOGUE_ACTOR = "ops:source-catalogue";

// The file's own shape is loose on purpose: whether an entry can become a source is decided per entry on import, by
// the rules a new source is held to, so one bad entry is reported by id instead of rejecting the whole file.
const Scope = z.object({
  hosts: z.array(z.string()),
  path_prefixes: z.array(z.string()),
  document_types: z.array(z.string()),
  excluded_content: z.array(z.string()),
});
/** The current permission record without what is rewritten on import (source id, version, reviewer and review time). */
const Permission = z.strictObject({
  permissions: z.record(z.string(), z.string()),
  evidence: z.array(z.record(z.string(), z.unknown())),
  scope: Scope,
  conditions: z.array(z.string()),
  attachments_in_scope: z.boolean(),
  expires_at: z.string().nullable(),
  licence_label_zh: z.string(),
});
export const CatalogueEntry = z.strictObject({
  id: z.string(),
  lane: z.enum(["news", "policy"]),
  name: z.string(),
  kind: z.string(),
  config: z.record(z.string(), z.unknown()),
  tags: z.array(z.string()),
  first_party: z.boolean(),
  owner_entity_id: z.string().nullable(),
  tier: z.string(),
  participation_mode: z.string(),
  interval_minutes: z.number().int(),
  interval_pinned: z.boolean(),
  site_fulltext: z.boolean(),
  syndicate_fulltext: z.boolean(),
  jurisdiction: z.string().nullable(),
  language: z.string().nullable(),
  /** State at export, for the reader of the file; import creates every source stopped. */
  enabled: z.boolean(),
  archived: z.boolean(),
  /** Null when the source has no permission record; such a source cannot be created from the file. */
  permission: Permission.nullable(),
});
export type CatalogueEntry = z.infer<typeof CatalogueEntry>;
export const Catalogue = z.strictObject({ format: z.literal("amp-source-catalogue/1"), exported_at: z.string(), sources: z.array(CatalogueEntry) });

/** Every source as the database has it, in id order. */
export async function exportCatalogue(now = new Date()): Promise<z.infer<typeof Catalogue>> {
  const rows = await sql<Array<Omit<CatalogueEntry, "permission">>>`
    SELECT id, lane, name, kind, config, tags, first_party, owner_entity_id, tier, participation_mode, interval_minutes, interval_pinned,
      site_fulltext, syndicate_fulltext, jurisdiction, language, enabled, archived_at IS NOT NULL AS archived
    FROM sources ORDER BY id`;
  const sources: CatalogueEntry[] = [];
  for (const row of rows) {
    const policy = await readCurrentSourcePolicy(row.id);
    const permission = policy && {
      permissions: policy.permissions,
      evidence: policy.evidence,
      scope: policy.scope,
      conditions: policy.conditions,
      attachments_in_scope: policy.attachments_in_scope,
      expires_at: policy.expires_at,
      licence_label_zh: policy.licence_label_zh,
    };
    sources.push(CatalogueEntry.parse({ ...row, permission }));
  }
  return { format: "amp-source-catalogue/1", exported_at: now.toISOString(), sources };
}

export interface ImportResult {
  applied: boolean;
  /** Created, or in a dry run exactly what --apply would create. */
  created: string[];
  existing: string[];
  /** Same address as a source that exists under another id, or as an earlier entry of the file. */
  duplicates: Array<{ id: string; existingId: string }>;
  /** Cannot be created from the file: archived at export, or without a permission record. */
  skipped: Array<{ id: string; reason: string }>;
  /** Refused by the rules every new source is held to; nothing of it is written. */
  invalid: Array<{ id: string; reason: string }>;
  /** Created stopped though running at export: preview and enable these. */
  toEnable: string[];
}

const refusal = (error: unknown) =>
  error instanceof z.ZodError
    ? error.issues.map((issue) => `${issue.path.join(".") || "entry"}: ${issue.message}`).join("; ")
    : error instanceof Error
      ? error.message
      : String(error);

/** Creates the file's sources that the database lacks. Existing sources are never changed. */
export async function importCatalogue(input: unknown, apply: boolean): Promise<ImportResult> {
  const catalogue = Catalogue.parse(input);
  const ids = catalogue.sources.map((s) => s.id);
  if (new Set(ids).size !== ids.length) throw new Error("The catalogue names a source id twice");
  const present = new Set((await sql<{ id: string }[]>`SELECT id FROM sources WHERE id = ANY(${ids}::text[])`).map((r) => r.id));
  const result: ImportResult = { applied: apply, created: [], existing: [], duplicates: [], skipped: [], invalid: [], toEnable: [] };

  // Every entry is judged before the first source is written, the same way with and without --apply: a file with a
  // bad entry never stops half-way, and the dry run is the list of what --apply creates.
  const accepted: Array<{ entry: CatalogueEntry; checked: ReturnType<typeof validateSourceRestore> }> = [];
  const addresses = new Map<string, string>();
  for (const entry of catalogue.sources) {
    if (present.has(entry.id)) {
      result.existing.push(entry.id);
      continue;
    }
    if (entry.archived) {
      result.skipped.push({ id: entry.id, reason: "archived at export" });
      continue;
    }
    if (!entry.permission) {
      result.skipped.push({ id: entry.id, reason: "no permission record in the file" });
      continue;
    }
    const { scope, attachments_in_scope, ...permission } = entry.permission;
    let checked: ReturnType<typeof validateSourceRestore>;
    try {
      checked = validateSourceRestore(
        {
          id: entry.id,
          name: entry.name,
          kind: entry.kind,
          config: entry.config,
          tier: entry.tier,
          participation_mode: entry.participation_mode,
          interval_minutes: entry.interval_minutes,
          first_party: entry.first_party,
          tags: entry.tags,
          site_fulltext: entry.site_fulltext,
          syndicate_fulltext: entry.syndicate_fulltext,
          permission_scope: scope,
          attachments_in_scope,
        },
        { permission, owner_entity_id: entry.owner_entity_id, interval_pinned: entry.interval_pinned },
        CATALOGUE_ACTOR,
      );
    } catch (error) {
      result.invalid.push({ id: entry.id, reason: refusal(error) });
      continue;
    }
    const identity = sourceIdentity(checked.source.config);
    const address = identity === null ? null : `${checked.source.kind}:${identity}`;
    const existingId = (await findDuplicateSource(checked.source.kind, checked.source.config))?.id ?? (address === null ? undefined : addresses.get(address));
    if (existingId) {
      result.duplicates.push({ id: entry.id, existingId });
      continue;
    }
    if (address !== null) addresses.set(address, entry.id);
    accepted.push({ entry, checked });
  }

  for (const { entry, checked } of accepted) {
    if (apply) {
      const created = await createSource(checked.source, CATALOGUE_ACTOR, {
        lane: entry.lane,
        profile: { jurisdiction: entry.jurisdiction, language: entry.language },
        restore: checked.restore,
      });
      // Only a source created by someone else since the check above ends here.
      if (!created.created) {
        result.duplicates.push({ id: entry.id, existingId: created.duplicate.id });
        continue;
      }
    }
    result.created.push(entry.id);
    if (entry.enabled) result.toEnable.push(entry.id);
  }
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [command, ...rest] = process.argv.slice(2);
  const apply = rest.includes("--apply");
  const files = rest.filter((a) => a !== "--apply");
  const usage = () => {
    console.error("usage: source-catalogue.ts export | import <file> [--apply]; nothing written");
    process.exit(2);
  };
  if (command === "export" ? rest.length : command === "import" ? files.length !== 1 : true) usage();
  await initializeDb("worker");
  try {
    if (command === "export") console.log(JSON.stringify(await exportCatalogue(), null, 2));
    else console.log(JSON.stringify(await importCatalogue(JSON.parse(readFileSync(files[0]!, "utf8")), apply), null, 2));
  } finally {
    await stopBoss();
    await closeDb();
  }
}
