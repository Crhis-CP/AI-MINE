import "./setup.ts";
// The entity library in the database (pipeline/entities/store.ts, admin.ts, scripts/entities-seed.ts): an empty
// library answers from the code seed and stores no link; the seed script adds what is absent and changes nothing that
// is there; a merge points the loser at the winner without rewriting spellings or links, and its undo gives back the
// earlier mapping; a person's links survive a replacement. The tests run in order on one database.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { EntityMergeRefused, mergeEntities, undoMerge } from "../packages/backend/src/pipeline/entities/admin.ts";
import { linkText } from "../packages/backend/src/pipeline/entities/link.ts";
import type { EntityLink } from "../packages/backend/src/pipeline/entities/model.ts";
import { aliasKey } from "../packages/backend/src/pipeline/entities/normalize.ts";
import { seedRows } from "../packages/backend/src/pipeline/entities/seed.ts";
import { articleLinkCoverage, loadEntityIndex, replaceArticleLinks, seedEntityLibrary } from "../packages/backend/src/pipeline/entities/store.ts";

after(closeDb);

const seed = seedRows();
const script = fileURLToPath(new URL("../scripts/entities-seed.ts", import.meta.url));
const seedScript = async (...args: string[]) =>
  JSON.parse((await promisify(execFile)(process.execPath, [script, ...args], { env: process.env, encoding: "utf8" })).stdout);

const link = (entityId: string, extra: Partial<EntityLink> = {}): EntityLink => ({
  entityId,
  role: "mention",
  method: "text",
  alias: entityId,
  segment: "body",
  position: 0,
  hits: 1,
  ...extra,
});
const storedLinks = async (articleId: string) => [
  ...(await sql<
    { input_revision: number; entity_id: string; method: string; role: string; position: number | null; linker_version: string; analysis_id: number | null }[]
  >`
    SELECT input_revision, entity_id, method, role, position, linker_version, analysis_id FROM entities.article_links
    WHERE article_id = ${articleId} ORDER BY input_revision, entity_id, method`),
];
const pointers = async () => [
  ...(await sql<{ id: string; merged_into: string | null }[]>`SELECT id, merged_into FROM entities.entities WHERE id LIKE 'acme-%' ORDER BY id`),
];
const refused = (reason: string) => (error: unknown) => error instanceof EntityMergeRefused && error.reason === reason;

async function entity(id: string, nameZh: string, nameOriginal: string, aliases: string[], origin = "admin") {
  await sql`INSERT INTO entities.entities (id, name_zh, name_original, origin, updated_by) VALUES (${id}, ${nameZh}, ${nameOriginal}, ${origin}, 'test')`;
  for (const value of aliases)
    await sql`INSERT INTO entities.statements (entity_id, property, value, norm, scope, origin, updated_by)
      VALUES (${id}, 'alias', ${value}, ${aliasKey(value)}, 'text', ${origin}, 'test')`;
}

test("an empty library answers from the code seed, and links found with it are not stored", async () => {
  const loaded = await loadEntityIndex();
  assert.equal(loaded.source, "code_seed");
  assert.equal(loaded.index.entities.size, seed.entities.length);
  const links = linkText(loaded.index, { title: "Teck Resources and Glencore sign deal", body: "", language: "en" });
  assert.deepEqual(
    links.map((l) => l.entityId),
    ["teck", "glencore"],
  );
  assert.equal(await replaceArticleLinks(sql, { articleId: "lib-empty", revision: 1, lane: "news", analysisId: null }, links), 0);
  assert.deepEqual(await storedLinks("lib-empty"), []);
  assert.deepEqual(await articleLinkCoverage([{ articleId: "lib-empty", revision: 1 }]), { linked: 0, library: 0 });
});

test("the seed script: a dry run writes nothing; --apply adds the absent rows once and never changes a row", async () => {
  const dry = await seedScript();
  assert.deepEqual(dry, {
    mode: "dry-run",
    entities: { seed: seed.entities.length, present: 0, wouldAdd: seed.entities.length },
    statements: { seed: seed.statements.length, present: 0, wouldAdd: seed.statements.length },
  });
  assert.equal((await sql`SELECT 1 FROM entities.entities`).length, 0, "a dry run writes nothing");
  await assert.rejects(seedScript("--bogus"), "an unknown argument stops the script");

  const first = await seedScript("--apply");
  assert.deepEqual(first.entities, { seed: seed.entities.length, present: 0, added: seed.entities.length });
  assert.deepEqual(first.statements, { seed: seed.statements.length, present: 0, added: seed.statements.length });
  const [teck] = await sql<{ name_zh: string; name_original: string; show_original: boolean; origin: string; updated_by: string }[]>`
    SELECT name_zh, name_original, show_original, origin, updated_by FROM entities.entities WHERE id = 'teck'`;
  assert.deepEqual(teck, { name_zh: "泰克资源", name_original: "Teck Resources", show_original: true, origin: "glossary", updated_by: "entities-seed" });
  const statements = await sql<{ entity_id: string; property: string; value: string; norm: string; scope: string | null; case_sensitive: boolean }[]>`
    SELECT entity_id, property, value, norm, scope, case_sensitive FROM entities.statements ORDER BY id`;
  assert.deepEqual(
    statements.map((s) => [s.entity_id, s.property, s.value, s.scope, s.case_sensitive]),
    seed.statements.map((s) => [s.entityId, s.property, s.value, s.scope, s.caseSensitive]),
  );
  assert.ok(statements.every((s) => s.norm === aliasKey(s.value)));

  // A person corrected a name in the database: the seed never overwrites it.
  await sql`UPDATE entities.entities SET name_zh = '泰克', updated_at = now(), updated_by = 'test' WHERE id = 'teck'`;
  const again = await seedScript("--apply");
  assert.deepEqual(again.entities, { seed: seed.entities.length, present: seed.entities.length, added: 0 });
  assert.deepEqual(again.statements, { seed: seed.statements.length, present: seed.statements.length, added: 0 });
  assert.equal((await sql`SELECT name_zh FROM entities.entities WHERE id = 'teck'`)[0]!.name_zh, "泰克");
  assert.deepEqual((await seedEntityLibrary(seed, "test", { apply: false })).statements, {
    seed: seed.statements.length,
    present: seed.statements.length,
    added: 0,
  });
  await sql`UPDATE entities.entities SET name_zh = '泰克资源', updated_at = now(), updated_by = 'test' WHERE id = 'teck'`;
});

test("the index is read from the tables, kept while they are unchanged and rebuilt when they change", async () => {
  const first = await loadEntityIndex();
  assert.equal(first.source, "database");
  assert.equal(first.index.entities.size, seed.entities.length);
  assert.equal((await loadEntityIndex()).index, first.index, "unchanged tables answer from memory");
  await entity("acme-copper", "阿克米铜业", "Acme Copper", ["Acme Copper", "阿克米铜业"]);
  const grown = await loadEntityIndex();
  assert.notEqual(grown.index, first.index);
  assert.equal(grown.index.resolve("acme-copper"), "acme-copper");
  assert.deepEqual(
    linkText(grown.index, { title: "Acme Copper expands", body: "", language: "en" }).map((l) => l.entityId),
    ["acme-copper"],
  );
  // A change that keeps the counts still moves the latest updated_at.
  await sql`UPDATE entities.statements SET status = 'retired', updated_at = now(), updated_by = 'test' WHERE entity_id = 'acme-copper' AND value = 'Acme Copper'`;
  const retired = await loadEntityIndex();
  assert.deepEqual(linkText(retired.index, { title: "Acme Copper expands", body: "", language: "en" }), []);
  await sql`UPDATE entities.statements SET status = 'active', updated_at = now(), updated_by = 'test' WHERE entity_id = 'acme-copper' AND value = 'Acme Copper'`;
  // Ten minutes on, the index is rebuilt even if nothing seems to have changed.
  const settled = await loadEntityIndex();
  assert.notEqual((await loadEntityIndex(sql, Date.now() + 11 * 60_000)).index, settled.index);
});

test("a person's links survive a replacement; links to entities that are not rows are left out", async () => {
  const article = { articleId: "lib-links", revision: 2, lane: "news" as const, analysisId: 41 };
  assert.equal(await replaceArticleLinks(sql, article, [link("bhp"), link("rio-tinto", { method: "publisher_domain", role: "publisher", position: null })]), 2);
  await sql`INSERT INTO entities.article_links (article_id, input_revision, entity_id, lane, role, method, alias, segment, linker_version)
    VALUES ('lib-links', 2, 'glencore', 'news', 'subject', 'manual', 'Glencore', 'title', 'manual')`;
  // Another revision of the same article keeps its own links.
  await replaceArticleLinks(sql, { ...article, revision: 1 }, [link("vale")]);
  assert.equal(await replaceArticleLinks(sql, { ...article, analysisId: 42 }, [link("bhp", { hits: 3 }), link("not-a-row")]), 1);
  assert.deepEqual(await storedLinks("lib-links"), [
    { input_revision: 1, entity_id: "vale", method: "text", role: "mention", position: 0, linker_version: "entity-linker-v1", analysis_id: 41 },
    { input_revision: 2, entity_id: "bhp", method: "text", role: "mention", position: 0, linker_version: "entity-linker-v1", analysis_id: 42 },
    { input_revision: 2, entity_id: "glencore", method: "manual", role: "subject", position: null, linker_version: "manual", analysis_id: null },
  ]);
  assert.equal(await replaceArticleLinks(sql, article, []), 0);
  assert.deepEqual(
    (await storedLinks("lib-links")).map((l) => [l.input_revision, l.entity_id]),
    [
      [1, "vale"],
      [2, "glencore"],
    ],
  );
  // Coverage counts only links the program found, and the library's size.
  assert.deepEqual(
    await articleLinkCoverage([
      { articleId: "lib-links", revision: 1 },
      { articleId: "lib-links", revision: 2 },
      { articleId: "lib-none", revision: 1 },
    ]),
    { linked: 1, library: seed.entities.length + 1 },
  );
});

test("a merge points the loser at the winner, moves what pointed at the loser, and its undo restores the mapping", async () => {
  await entity("acme-mining", "阿克米矿业", "Acme Mining", ["Acme Mining"]);
  await entity("acme-old", "老阿克米", "Old Acme", ["Old Acme"]);
  await replaceArticleLinks(sql, { articleId: "lib-merge", revision: 1, lane: "news", analysisId: null }, [link("acme-copper")]);
  const first = await mergeEntities({ loserId: "acme-old", winnerId: "acme-copper", reason: "同一家公司的旧名", actor: "admin:1" });
  assert.deepEqual(first.repointed, []);
  const before = await loadEntityIndex();

  const merged = await mergeEntities({ loserId: "acme-copper", winnerId: "acme-mining", reason: "重复建档", actor: "admin:1" });
  assert.deepEqual(merged.repointed, ["acme-old"]);
  assert.deepEqual(await pointers(), [
    { id: "acme-copper", merged_into: "acme-mining" },
    { id: "acme-mining", merged_into: null },
    { id: "acme-old", merged_into: "acme-mining" },
  ]);
  const [row] = await sql`SELECT loser_id, winner_id, repointed, actor, reason, undone_at FROM entities.merges WHERE id = ${merged.mergeId}`;
  assert.deepEqual(row, { loser_id: "acme-copper", winner_id: "acme-mining", repointed: ["acme-old"], actor: "admin:1", reason: "重复建档", undone_at: null });
  const after = await loadEntityIndex();
  assert.equal(after.index.resolve("acme-old"), "acme-mining");
  assert.deepEqual(
    linkText(after.index, { title: "Acme Copper and Old Acme", body: "", language: "en" }).map((l) => l.entityId),
    ["acme-mining"],
  );
  assert.deepEqual(
    (await storedLinks("lib-merge")).map((l) => l.entity_id),
    ["acme-copper"],
    "links keep the entity as linked",
  );
  assert.equal((await sql`SELECT count(*)::int AS n FROM entities.statements WHERE entity_id = 'acme-copper'`)[0]!.n, 2, "spellings stay");

  assert.deepEqual(await undoMerge({ mergeId: merged.mergeId, reason: "合并错了", actor: "admin:2" }), { restored: ["acme-old"] });
  assert.deepEqual(await pointers(), [
    { id: "acme-copper", merged_into: null },
    { id: "acme-mining", merged_into: null },
    { id: "acme-old", merged_into: "acme-copper" },
  ]);
  const undone = await loadEntityIndex();
  for (const id of ["acme-copper", "acme-mining", "acme-old", "bhp"]) assert.equal(undone.index.resolve(id), before.index.resolve(id), id);
  assert.deepEqual([...undone.index.entities.keys()].sort(), [...before.index.entities.keys()].sort());
  const [stamped] = await sql`SELECT undone_by, undone_at IS NOT NULL AS undone FROM entities.merges WHERE id = ${merged.mergeId}`;
  assert.deepEqual(stamped, { undone_by: "admin:2", undone: true });
  assert.deepEqual(
    (await sql`SELECT actor, action, subject FROM audit_log WHERE subject IN ('entity:acme-old', 'entity:acme-copper') ORDER BY id`).map((r) => [
      r.actor,
      r.action,
      r.subject,
    ]),
    [
      ["admin:1", "entities.merge", "entity:acme-old"],
      ["admin:1", "entities.merge", "entity:acme-copper"],
      ["admin:2", "entities.merge.undo", "entity:acme-copper"],
    ],
  );
  await assert.rejects(undoMerge({ mergeId: merged.mergeId, reason: "再撤一次", actor: "admin:2" }), refused("already_undone"));
});

test("merges that would orphan an id or break the pointers are refused", async () => {
  const merge = (loserId: string, winnerId: string, reason = "测试") => mergeEntities({ loserId, winnerId, reason, actor: "admin:1" });
  // The tag vocabulary's ids are what analyses.subjects and the paid prompt hold.
  await assert.rejects(merge("bhp", "rio-tinto"), refused("taxonomy_loser"));
  await assert.rejects(merge("acme-mining", "acme-mining"), refused("same_entity"));
  await assert.rejects(merge("acme-mining", "no-such-entity"), refused("missing"));
  await assert.rejects(merge("acme-mining", "teck", "  "), refused("no_reason"));
  await assert.rejects(merge("acme-old", "acme-mining"), refused("already_merged"), "acme-old still points at acme-copper");
  await entity("acme-gone", "已停用", "Gone Corp", ["Gone Corp"]);
  await sql`UPDATE entities.entities SET status = 'retired', updated_at = now(), updated_by = 'test' WHERE id = 'acme-gone'`;
  await assert.rejects(merge("acme-gone", "acme-mining"), refused("retired"));
  await assert.rejects(merge("acme-mining", "acme-old"), refused("winner_merged"));
  // A later merge of the winner moves the loser on: the earlier merge can only be undone after the later one.
  const intoMining = await merge("acme-copper", "acme-mining");
  const intoTeck = await merge("acme-mining", "teck");
  assert.deepEqual(intoTeck.repointed, ["acme-copper", "acme-old"]);
  await assert.rejects(undoMerge({ mergeId: intoMining.mergeId, reason: "顺序不对", actor: "admin:1" }), refused("moved_on"));
  assert.deepEqual(await undoMerge({ mergeId: intoTeck.mergeId, reason: "先撤后一次", actor: "admin:1" }), { restored: ["acme-copper", "acme-old"] });
  assert.deepEqual(await undoMerge({ mergeId: intoMining.mergeId, reason: "再撤前一次", actor: "admin:1" }), { restored: ["acme-old"] });
  await assert.rejects(undoMerge({ mergeId: 999_999, reason: "不存在", actor: "admin:1" }), refused("merge_missing"));
});
