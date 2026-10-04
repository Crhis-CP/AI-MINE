// Seeds a fresh site from the industry pack. New sources stay disabled until explicitly enabled;
// existing sources are never overwritten, including the operator's activation and permission edits.
// Re-runnable:  node --env-file=.env scripts/seed.ts   (--topics-only: just the topics, as the tests use)
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@amp/backend/config";
import { closeDb, dbOf, initializeDb } from "@amp/backend/db";
import { seedTopics } from "@amp/backend/publication/topics";
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

if (import.meta.main) {
  await initializeDb("migrate");
  try {
    console.log(`topics: ${await seedTopics()}`);
    if (!process.argv.includes("--topics-only")) {
      const { sources } = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8")) as { sources: SeedSource[] };
      const added = await seedSources(sources);
      console.log(`sources: ${added} added (disabled), ${sources.length - added} already there`);
    }
  } finally {
    await closeDb();
  }
}
