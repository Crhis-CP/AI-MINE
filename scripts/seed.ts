// Seeds a fresh site from the industry pack. New sources stay disabled until explicitly enabled;
// existing sources are never overwritten, including the operator's activation and permission edits.
// Re-runnable:  node --env-file=.env scripts/seed.ts   (--topics-only: just the topics, as the tests use)
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@amp/backend/config";
import { closeDb, dbOf, initializeDb } from "@amp/backend/db";
import { seedTopics } from "@amp/backend/publication/topics";
import { POLICY_SOURCES, type PolicySource } from "@amp/industry/policy-sources";
import { createSource } from "@amp/backend/admin/sources";
import { SourceCreateRequest } from "@amp/contracts/http/private";
import { assertSupportedConfig } from "@amp/backend/sources/config-keys";

const sql = dbOf("sources");

interface SeedSource {
  id: string;
  name: string;
  kind: "rss" | "web_list" | "json_list" | "mp_account" | "external";
  config: Record<string, unknown>;
  tier?: string;
  first_party?: boolean;
  owner_entity_id?: string | null;
  participation_mode?: string;
  interval_minutes?: number;
  tags?: string[];
  site_fulltext?: boolean;
  syndicate_fulltext?: boolean;
  enabled?: boolean;
}

export async function seedSources(sources: SeedSource[]): Promise<number> {
  let added = 0;
  for (const s of sources) {
    assertSupportedConfig(s.kind, s.config);
    const inserted = await sql`
    INSERT INTO sources (id, name, kind, config, tier, first_party, owner_entity_id, participation_mode, interval_minutes, tags, site_fulltext, syndicate_fulltext, enabled, next_fetch_at)
    VALUES (${s.id}, ${s.name}, ${s.kind}, ${sql.json(s.config as never)}, ${s.tier ?? "T2"}, ${s.first_party ?? false}, ${s.owner_entity_id ?? null},
            ${s.participation_mode ?? "editorial"}, ${s.interval_minutes ?? 60}, ${s.tags ?? []}, ${s.site_fulltext ?? false}, ${s.syndicate_fulltext ?? false},
            false, NULL)
    ON CONFLICT (id) DO NOTHING RETURNING id`;
    added += inserted.length;
  }
  return added;
}

// The default only grants public full text where the catalogue establishes open terms.
// Reseeding never changes an existing source's permission or operator settings.
const POLICY_FULLTEXT_TERMS: readonly PolicySource["terms"][] = ["open"];

export async function seedPolicySources(entries: readonly PolicySource[]) {
  const eligible = entries.filter((entry) => entry.collect && ["ready", "needs_overseas"].includes(entry.status));
  // Validate the entire batch before writing any source, including entries later found to exist.
  const prepared = eligible.map((entry) => {
    const collect = entry.collect!;
    assertSupportedConfig(collect.kind, collect.config);
    const input = SourceCreateRequest.parse({
      id: `policy-${entry.id.toLowerCase()}`,
      name: `${entry.authority.zh} · ${entry.name.zh}`,
      kind: collect.kind,
      config: collect.config,
      tier: "T1",
      participation_mode: "editorial",
      interval_minutes: 360,
      first_party: true,
      tags: [entry.jurisdiction],
      site_fulltext: POLICY_FULLTEXT_TERMS.includes(entry.terms),
      syndicate_fulltext: false,
      permission_scope: { hosts: [new URL(entry.entry).hostname], path_prefixes: ["/"], document_types: [], excluded_content: [] },
      attachments_in_scope: true,
    });
    return { entry, input };
  });
  const result = { added: { ready: 0, needs_overseas: 0 }, existing: 0, duplicates: [] as { id: string; existingId: string }[], skipped: { noConfiguration: 0, waitingReader: 0, otherStatus: 0 } };
  for (const entry of entries) {
    if (entry.status === "needs_reader") result.skipped.waitingReader++;
    else if (!entry.collect) result.skipped.noConfiguration++;
    else if (!["ready", "needs_overseas"].includes(entry.status)) result.skipped.otherStatus++;
  }
  for (const { entry, input } of prepared) {
    if ((await sql`SELECT 1 FROM sources WHERE id = ${input.id}`).length) { result.existing++; continue; }
    const created = await createSource(input, "seed:policy-sources", { lane: "policy" });
    if (created.created) result.added[entry.status as "ready" | "needs_overseas"]++;
    else result.duplicates.push({ id: input.id, existingId: created.duplicate.id });
  }
  return result;
}

if (import.meta.main) {
  await initializeDb("migrate");
  try {
    console.log(`topics: ${await seedTopics()}`);
    if (!process.argv.includes("--topics-only")) {
      const { sources } = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8")) as { sources: SeedSource[] };
      const added = await seedSources(sources);
      console.log(`sources: ${added} added (disabled), ${sources.length - added} already there`);
      const policies = await seedPolicySources(POLICY_SOURCES);
      console.log(`法规信源（全部停用）：${JSON.stringify(policies)}`);
      for (const duplicate of policies.duplicates) console.log(`与现有信源同址，未建：${duplicate.id} → ${duplicate.existingId}`);
    }
  } finally {
    await closeDb();
  }
}
