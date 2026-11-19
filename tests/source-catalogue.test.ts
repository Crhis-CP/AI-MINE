import "./setup.ts";
// The source catalogue is the database: it goes out as one file and comes back in without loss, and what a
// policy source needs at run time (its country and its language) is read from its own row.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import type { AdminPrincipal } from "@amp/backend/admin/auth";
import { createSource, openNewsFulltext, readCurrentSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";
import { closeDb, sql } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { SOURCE_PURPOSES } from "@amp/contracts/source-policy";
import { CATALOGUE_ACTOR, exportCatalogue, importCatalogue } from "../scripts/source-catalogue.ts";

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
const feed = (path: string) => ({ feedUrl: `https://fixture.invalid/${path}.xml` });
const sourceIds = async () => (await sql<{ id: string }[]>`SELECT id FROM sources ORDER BY id`).map((r) => r.id);

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
  assert.deepEqual([policy.permission?.scope, policy.permission?.attachments_in_scope], [scope, true]);
  assert.deepEqual(file.sources.find((s) => s.id === "catalogue-news")!.jurisdiction, null);

  // Into the same database: nothing to create, nothing changed.
  const before = await sql`SELECT id, updated_at FROM sources ORDER BY id`;
  const same = await importCatalogue(file, true);
  assert.deepEqual([same.created, same.existing.includes("catalogue-news"), same.existing.includes("catalogue-policy")], [[], true, true]);
  assert.deepEqual(await sql`SELECT id, updated_at FROM sources ORDER BY id`, before);

  // The same source under another id and address, as it would arrive on a fresh installation.
  const moved = { ...policy, id: "catalogue-moved", config: feed("moved") };
  const arriving = { ...file, sources: [moved] };
  const dry = await importCatalogue(arriving, false);
  assert.deepEqual([dry.applied, dry.created, dry.toEnable], [false, ["catalogue-moved"], ["catalogue-moved"]]);
  assert.equal((await sql`SELECT 1 FROM sources WHERE id='catalogue-moved'`).length, 0, "a dry run writes nothing");

  const applied = await importCatalogue(arriving, true);
  assert.deepEqual([applied.created, applied.duplicates, applied.skipped, applied.invalid], [["catalogue-moved"], [], [], []]);
  const back = (await exportCatalogue()).sources.find((s) => s.id === "catalogue-moved")!;
  assert.deepEqual(back, { ...moved, enabled: false }, "everything returns as exported, except that a created source is stopped");

  // Who publishes it and the pinned interval arrive with the row itself, not in a later statement that an interrupted
  // run could lose: the row, its permission record and its audit row are one transaction, and the audit row names both.
  const written = await sql<{ source: string; permission: string; audit: string; n: number; after: Record<string, unknown>; actor: string }[]>`
    SELECT s.xmin::text AS source, v.xmin::text AS permission, a.xmin::text AS audit, a.actor, a.after,
      (SELECT count(*)::int FROM audit_log WHERE subject='source:catalogue-moved') AS n
    FROM sources s JOIN sources.source_policy_versions v ON v.source_id=s.id JOIN audit_log a ON a.subject='source:'||s.id AND a.action='source.create'
    WHERE s.id='catalogue-moved'`;
  assert.equal(written.length, 1);
  const row = written[0]!;
  assert.deepEqual([row.permission, row.audit, row.n, row.actor], [row.source, row.source, 1, CATALOGUE_ACTOR]);
  assert.deepEqual(
    { owner: row.after.owner_entity_id, pinned: row.after.interval_pinned, permission: row.after.permission_restored },
    { owner: "合成机构", pinned: true, permission: true },
  );
  // A restore is an operations import only: a signed-in person's create request cannot carry one.
  await assert.rejects(
    createSource(input("catalogue-by-hand", "by-hand"), "test", {
      principal: { userId: 1, name: "合成管理员", csrf: "x", dev: false } as AdminPrincipal,
      restore: {},
    }),
    /operations import/,
  );
});

test("a source that was tightened comes back tightened: denied purposes, the objection, conditions and expiry", async () => {
  await createSource(input("catalogue-tightened", "tightened"), "test");
  const at = "2026-11-01T00:00:00.000Z";
  const tightened = {
    permissions: {
      ...Object.fromEntries(SOURCE_PURPOSES.map((purpose) => [purpose, "allow"])),
      external_model: "deny",
      public_original_fulltext: "deny",
      public_translation: "deny",
    },
    evidence: [
      {
        kind: "written_authorization",
        url: "https://fixture.invalid/licence",
        checked_at: at,
        valid_until: "2027-06-30T00:00:00.000Z",
        basis_zh: "合成授权书",
        capabilities: [...SOURCE_PURPOSES],
        scope,
      },
      {
        kind: "source_objection",
        url: null,
        checked_at: at,
        valid_until: null,
        basis_zh: "合成异议：来源不同意全文转载",
        capabilities: ["public_original_fulltext", "public_translation"],
        scope,
      },
    ],
    scope,
    conditions: ["attribution_required"],
    attachments_in_scope: false,
    expires_at: "2027-06-30T00:00:00.000Z",
    licence_label_zh: "合成授权；须署名",
  };
  await saveSourcePolicy("catalogue-tightened", { policy: tightened, expectedVersion: 1, reason: "synthetic objection" }, "test");

  const file = await exportCatalogue();
  const exported = file.sources.find((s) => s.id === "catalogue-tightened")!;
  assert.deepEqual(exported.permission, tightened, "the file carries the current permission record, not only its scope");

  const arriving = { ...exported, id: "catalogue-tightened-moved", config: feed("tightened-moved") };
  const result = await importCatalogue({ ...file, sources: [arriving] }, true);
  assert.deepEqual([result.created, result.invalid], [["catalogue-tightened-moved"], []]);
  const current = (await readCurrentSourcePolicy("catalogue-tightened-moved"))!;
  const { source_id, permission_version, reviewed_by, reviewed_at, ...restored } = current;
  assert.deepEqual(restored, tightened, "the created source's current permission is the exported one");
  assert.deepEqual([source_id, permission_version, reviewed_by], ["catalogue-tightened-moved", 1, CATALOGUE_ACTOR]);
  assert.ok(Date.parse(reviewed_at) > Date.parse(at));
  assert.equal(
    (await sql`SELECT 1 FROM sources.source_policy_versions WHERE source_id='catalogue-tightened-moved'`).length,
    1,
    "it never had the allow-all default, not even as an earlier version",
  );

  // The run that opens news full text reads exactly this evidence: the objection keeps both sources closed.
  const opening = await openNewsFulltext("test");
  assert.deepEqual(
    opening.sources.filter((s) => s.id.startsWith("catalogue-tightened")).map((s) => [s.id, s.status]),
    [
      ["catalogue-tightened", "kept_tightened"],
      ["catalogue-tightened-moved", "kept_tightened"],
    ],
  );
});

test("import refuses what it cannot rebuild and reports the same address under another id", async () => {
  const file = await exportCatalogue();
  const base = file.sources.find((s) => s.id === "catalogue-news")!;
  const result = await importCatalogue(
    {
      ...file,
      sources: [
        { ...base, id: "catalogue-archived", config: feed("archived"), archived: true },
        { ...base, id: "catalogue-unscoped", config: feed("unscoped"), permission: null },
        { ...base, id: "catalogue-same-address" },
      ],
    },
    true,
  );
  assert.deepEqual([result.created, result.invalid], [[], []]);
  assert.deepEqual(result.skipped.map((s) => s.id).sort(), ["catalogue-archived", "catalogue-unscoped"]);
  assert.deepEqual(result.duplicates, [{ id: "catalogue-same-address", existingId: "catalogue-news" }]);
  await assert.rejects(importCatalogue({ ...file, sources: [base, base] }, false), /twice/);
});

test("the dry run lists exactly what --apply does, and a bad entry is reported instead of stopping the file half-way", async () => {
  const file = await exportCatalogue();
  const base = file.sources.find((s) => s.id === "catalogue-news")!;
  const arriving = {
    ...file,
    sources: [
      base,
      { ...base, id: "catalogue-first", config: feed("shared"), enabled: true },
      { ...base, id: "Bad_ID", config: feed("bad-id") },
      { ...base, id: "catalogue-bad-kind", kind: "html", config: feed("bad-kind") },
      { ...base, id: "catalogue-bad-config", config: { ...feed("bad-config"), noSuchSetting: true } },
      { ...base, id: "catalogue-bad-interval", config: feed("bad-interval"), interval_minutes: 0 },
      // Every purpose allowed with nothing to support it: the permission rules refuse the record.
      { ...base, id: "catalogue-bad-permission", config: feed("bad-permission"), permission: { ...base.permission!, evidence: [] } },
      { ...base, id: "catalogue-bad-owner", config: feed("bad-owner"), owner_entity_id: "机".repeat(121) },
      { ...base, id: "catalogue-same-as-existing" },
      { ...base, id: "catalogue-same-as-first", config: feed("shared") },
      { ...base, id: "catalogue-archived", config: feed("archived"), archived: true },
      { ...base, id: "catalogue-last", config: feed("last") },
    ],
  };
  const before = await sourceIds();
  const dry = await importCatalogue(arriving, false);
  assert.deepEqual(await sourceIds(), before, "a dry run writes nothing");
  assert.deepEqual(dry.created, ["catalogue-first", "catalogue-last"]);
  assert.deepEqual(dry.toEnable, ["catalogue-first"]);
  assert.deepEqual(dry.existing, ["catalogue-news"]);
  assert.deepEqual(dry.duplicates, [
    { id: "catalogue-same-as-existing", existingId: "catalogue-news" },
    { id: "catalogue-same-as-first", existingId: "catalogue-first" },
  ]);
  assert.deepEqual(dry.skipped, [{ id: "catalogue-archived", reason: "archived at export" }]);
  assert.deepEqual(
    dry.invalid.map((entry) => entry.id),
    ["Bad_ID", "catalogue-bad-kind", "catalogue-bad-config", "catalogue-bad-interval", "catalogue-bad-permission", "catalogue-bad-owner"],
  );
  assert.ok(dry.invalid.every((entry) => entry.reason.length > 0));
  assert.match(dry.invalid.find((entry) => entry.id === "catalogue-bad-permission")!.reason, /allow requires supporting evidence/);

  // The entry after the bad ones is created too, and the result is the dry run's, word for word.
  const applied = await importCatalogue(arriving, true);
  assert.deepEqual(applied, { ...dry, applied: true });
  assert.deepEqual(
    (await sourceIds()).filter((id) => !before.includes(id)),
    ["catalogue-first", "catalogue-last"],
  );
  const again = await importCatalogue(arriving, true);
  assert.deepEqual([again.created, again.existing], [[], ["catalogue-news", "catalogue-first", "catalogue-last"]]);
});

test("the migration gave the policy sources that existed their country and language, and a new one states its own", async () => {
  // The test database is migrated empty, so the migration's own back-fill is replayed on rows written the way they
  // were before it: no country, no language, the country only as the tag the seed wrote (which an operator can edit).
  const migration = readFileSync(new URL("../database/migrations/sources/202611191000_source_jurisdiction_language.sql", import.meta.url), "utf8");
  const backfill = migration.slice(migration.indexOf("UPDATE public.sources"));
  assert.ok(backfill.startsWith("UPDATE public.sources") && !backfill.includes("ALTER TABLE"), "only the back-fill is replayed");
  await sql`INSERT INTO sources(id,name,kind,config,lane,tags) VALUES
    ('policy-ca-002','合成公报','rss','{}','policy','{CA}'),
    ('policy-ca-005','合成公报（法语）','rss','{}','policy','{CA}'),
    ('policy-kz-001','合成公报（两种语言）','rss','{}','policy','{KZ}'),
    ('policy-cn-p01','合成试点源','rss','{}','policy','{CN}'),
    ('policy-ar-005','标签被人改过的源','rss','{}','policy','{AR,试点}'),
    ('policy-ar-006','标签被清空的源','rss','{}','policy','{}'),
    ('policy-zz-999','目录里没有的法规源','rss','{}','policy','{CA}'),
    ('catalogue-news-tagged','带国家标签的资讯源','rss','{}','news','{CA}')`;
  await sql`INSERT INTO sources(id,name,kind,config,lane,tags,jurisdiction,language) VALUES('policy-us-001','已经写明的源','rss','{}','policy','{US}','US-TX','es')`;
  await sql.unsafe(backfill);
  await createSource(input("policy-new-fixture", "new"), "test", { lane: "policy", profile: { jurisdiction: "AR", language: "es" } });
  assert.deepEqual(
    [
      ...(await sql`SELECT id, jurisdiction, language FROM sources
        WHERE id LIKE 'policy-__-___' OR id IN ('catalogue-news-tagged','policy-new-fixture') ORDER BY id`),
    ],
    [
      // Neither is in the catalogue the migration carries: the old lookup knew no country for them either.
      { id: "catalogue-news-tagged", jurisdiction: null, language: null },
      // By id, as the old lookup was: the edited and the emptied tags change nothing.
      { id: "policy-ar-005", jurisdiction: "AR", language: "es" },
      { id: "policy-ar-006", jurisdiction: "AR", language: "es" },
      { id: "policy-ca-002", jurisdiction: "CA", language: "en" },
      { id: "policy-ca-005", jurisdiction: "CA", language: "fr" },
      { id: "policy-cn-p01", jurisdiction: "CN", language: "zh-CN" },
      { id: "policy-kz-001", jurisdiction: "KZ", language: "ru (also kk)" },
      { id: "policy-new-fixture", jurisdiction: "AR", language: "es" },
      // What a row already states is not overwritten.
      { id: "policy-us-001", jurisdiction: "US-TX", language: "es" },
      { id: "policy-zz-999", jurisdiction: null, language: null },
    ],
  );
});
