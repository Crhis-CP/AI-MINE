import "./setup.ts";
// The source catalogue is the database: it goes out as one file and comes back in without loss, and what a
// policy source needs at run time (its country and its language) is read from its own row.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSource } from "@amp/backend/admin/sources";
import { closeDb, sql } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { exportCatalogue, importCatalogue } from "../scripts/source-catalogue.ts";

after(async () => {
  await stopBoss();
  await closeDb();
});

const scope = { hosts: ["fixture.invalid"], path_prefixes: ["/"], document_types: [], excluded_content: [] };
const input = (id: string, path: string) => ({
  id,
  name: `合成信源 ${id}`,
  kind: "rss",
  config: { feedUrl: `https://fixture.invalid/${path}.xml` },
  tier: "T1",
  participation_mode: "editorial",
  interval_minutes: 45,
  first_party: true,
  tags: ["铜"],
  site_fulltext: false,
  syndicate_fulltext: false,
  permission_scope: scope,
  attachments_in_scope: true,
});

test("export then import: existing sources are left alone, a missing one comes back stopped with every field", async () => {
  await createSource(input("catalogue-news", "news"), "test");
  await createSource(input("catalogue-policy", "policy"), "test", { lane: "policy", profile: { jurisdiction: "CA", language: "fr" } });
  await sql`UPDATE sources SET owner_entity_id='合成机构', interval_pinned=true, enabled=true, health='ok' WHERE id='catalogue-policy'`;

  const file = await exportCatalogue(new Date("2026-11-19T00:00:00Z"));
  const policy = file.sources.find((s) => s.id === "catalogue-policy")!;
  assert.deepEqual(
    {
      lane: policy.lane,
      jurisdiction: policy.jurisdiction,
      language: policy.language,
      owner: policy.owner_entity_id,
      pinned: policy.interval_pinned,
      enabled: policy.enabled,
    },
    { lane: "policy", jurisdiction: "CA", language: "fr", owner: "合成机构", pinned: true, enabled: true },
  );
  assert.deepEqual(policy.permission_scope, scope);
  assert.deepEqual(file.sources.find((s) => s.id === "catalogue-news")!.jurisdiction, null);

  // Into the same database: nothing to create, nothing changed.
  const before = await sql`SELECT id, updated_at FROM sources ORDER BY id`;
  const same = await importCatalogue(file, true);
  assert.deepEqual([same.created, same.existing.includes("catalogue-news"), same.existing.includes("catalogue-policy")], [[], true, true]);
  assert.deepEqual(await sql`SELECT id, updated_at FROM sources ORDER BY id`, before);

  // The same source under another id and address, as it would arrive on a fresh installation.
  const moved = { ...policy, id: "catalogue-moved", config: { feedUrl: "https://fixture.invalid/moved.xml" } };
  const arriving = { ...file, sources: [moved] };
  const dry = await importCatalogue(arriving, false);
  assert.deepEqual([dry.applied, dry.created, dry.toEnable], [false, ["catalogue-moved"], ["catalogue-moved"]]);
  assert.equal((await sql`SELECT 1 FROM sources WHERE id='catalogue-moved'`).length, 0, "a dry run writes nothing");

  const applied = await importCatalogue(arriving, true);
  assert.deepEqual([applied.created, applied.duplicates, applied.skipped], [["catalogue-moved"], [], []]);
  const back = (await exportCatalogue()).sources.find((s) => s.id === "catalogue-moved")!;
  assert.deepEqual(back, { ...moved, enabled: false }, "everything returns as exported, except that a created source is stopped");
  assert.equal((await sql`SELECT 1 FROM sources.source_policy_current WHERE source_id='catalogue-moved'`).length, 1, "it has a permission record");
});

test("import refuses what it cannot rebuild and reports the same address under another id", async () => {
  const file = await exportCatalogue();
  const base = file.sources.find((s) => s.id === "catalogue-news")!;
  const result = await importCatalogue(
    {
      ...file,
      sources: [
        { ...base, id: "catalogue-archived", config: { feedUrl: "https://fixture.invalid/archived.xml" }, archived: true },
        { ...base, id: "catalogue-unscoped", config: { feedUrl: "https://fixture.invalid/unscoped.xml" }, permission_scope: null },
        { ...base, id: "catalogue-same-address" },
      ],
    },
    true,
  );
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.skipped.map((s) => s.id).sort(), ["catalogue-archived", "catalogue-unscoped"]);
  assert.deepEqual(result.duplicates, [{ id: "catalogue-same-address", existingId: "catalogue-news" }]);
  await assert.rejects(importCatalogue({ ...file, sources: [base, base] }, false), /twice/);
});

test("the migration gave the policy sources that existed their country and language, and a new one states its own", async () => {
  // The test database is migrated empty, so the migration's own UPDATEs are shown on rows written the way they were.
  await sql`INSERT INTO sources(id,name,kind,config,lane,tags) VALUES('policy-ca-002','合成公报','rss','{}','policy','{CA}')`;
  await sql`UPDATE public.sources SET jurisdiction = tags[1] WHERE id='policy-ca-002' AND tags[2] IS NULL`;
  await createSource(input("policy-new-fixture", "new"), "test", { lane: "policy", profile: { jurisdiction: "AR", language: "es" } });
  assert.deepEqual(
    [...(await sql`SELECT id, jurisdiction, language FROM sources WHERE id IN ('policy-ca-002','policy-new-fixture') ORDER BY id`)],
    [
      { id: "policy-ca-002", jurisdiction: "CA", language: null },
      { id: "policy-new-fixture", jurisdiction: "AR", language: "es" },
    ],
  );
});
