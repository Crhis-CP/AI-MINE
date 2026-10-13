import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { closeDb, dbOf } from "@amp/backend/db";
import { saveSourcePolicy, readSourceDateContext } from "@amp/backend/admin/sources";
import { upsertMaterial, updateMaterialSourceDate, compactDateObservations } from "@amp/backend/content/materials";
import { observeSourceDate } from "../packages/backend/src/sources/date-extraction.ts";
import { sourcePolicyExample } from "./permission-fixture.ts";

const sql = dbOf("content");
const at = (n: number) => new Date(Date.parse("2026-10-07T10:00:00Z") + n * 1000);
after(() => closeDb());

async function fixture() {
  const sourceId = `date-dedupe-${tag()}`,
    url = `https://source.invalid/mining/${sourceId}`;
  await sql`INSERT INTO sources(id,name,kind,enabled,config) VALUES(${sourceId},'Synthetic date source','rss',true,'{}')`;
  const policy = { ...structuredClone(sourcePolicyExample), source_id: sourceId };
  await saveSourcePolicy(sourceId, { expectedVersion: null, policy, reason: "Synthetic fixture" }, "test");
  const { articleId } = await upsertMaterial({ sourceId, url, title: "合成铜矿日期", bodyText: "同一正文", via: "fetch" });
  const source = (await readSourceDateContext(sourceId))!;
  const send = (raw: string, tick: number, version: number) =>
    updateMaterialSourceDate(articleId, 1, {
      sourceDateObservation: observeSourceDate(source, url, raw, "rss.pubDate", { observedAt: at(tick).toISOString() }),
      expectedSourceDateVersion: version,
      permissionVersion: 1,
    });
  const observations = () => sql`SELECT * FROM content.source_date_observations WHERE article_id=${articleId} ORDER BY observed_at,id`;
  const state = async () =>
    (await sql`SELECT source_date_observation_id, source_date_version, source_date_state, published_at FROM articles WHERE id=${articleId}`)[0]!;
  const seen = () => sql`SELECT * FROM content.source_date_observation_seen WHERE article_id=${articleId} ORDER BY revision,config_hash`;
  return { articleId, sourceId, send, observations, state, seen };
}

test("three identical listing observations keep one immutable row and advance only the seen time", async () => {
  const f = await fixture();
  await f.send("2026-10-01", 1, 0);
  const original = await f.observations(),
    state = await f.state();
  for (const n of [2, 3]) {
    const result = await f.send("2026-10-01", n, 1);
    assert.deepEqual([result.sourceDateOutcome, result.sourceDateVersion, result.metadataChanged], ["unchanged", 1, false]);
  }
  assert.equal((await f.observations()).length, 1);
  assert.deepEqual(await f.observations(), original, "evidence itself remains immutable");
  assert.deepEqual(await f.state(), state);
  assert.equal((await f.seen())[0]!.last_observed_at.getTime(), at(3).getTime());
});

test("a changed date and a later return each retain a new observation and advance the current pointer", async () => {
  const f = await fixture(),
    pointers = [];
  for (const [n, raw] of [
    [1, "2026-10-01"],
    [2, "2026-10-02"],
    [3, "2026-10-01"],
  ] as const) {
    const result = await f.send(raw, n, n - 1);
    assert.deepEqual([result.sourceDateOutcome, result.sourceDateVersion], ["applied", n]);
    pointers.push((await f.state()).source_date_observation_id);
  }
  assert.equal(new Set(pointers).size, 3);
  const rows = await f.observations();
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.semantic_hash, rows[2]!.semantic_hash);
  assert.notEqual(rows[0]!.semantic_hash, rows[1]!.semantic_hash);
});

test("a delayed different observation cannot overtake a later deduplicated observation", async () => {
  const f = await fixture();
  await f.send("2026-10-01", 1, 0);
  await f.send("2026-10-01", 3, 1);
  const state = await f.state();
  assert.equal((await f.send("2026-10-02", 2, 1)).sourceDateOutcome, "stale");
  assert.deepEqual(await f.state(), state);
  assert.equal((await f.seen())[0]!.last_observed_at.getTime(), at(3).getTime());
  // Permission, configuration and explicit version checks still protect the material.
  await sql`UPDATE sources SET enabled=false WHERE id=${f.sourceId}`;
  await assert.rejects(f.send("2026-10-02", 4, 1), /configuration/);
  assert.deepEqual(await f.state(), state);
});

test("compaction is read-only by default and preserves every run boundary plus the current pointer", async () => {
  const f = await fixture();
  await f.send("2026-10-01", 1, 0);
  await f.send("2026-10-02", 4, 1);
  const originals = await f.observations(),
    ids: string[] = [];
  await sql`UPDATE articles SET source_date_observation_id=null WHERE id=${f.articleId}`;
  await sql`DELETE FROM content.source_date_observations WHERE article_id=${f.articleId}`;
  await sql`DELETE FROM content.source_date_observation_seen WHERE article_id=${f.articleId}`;
  for (const [i, kind] of [0, 0, 0, 1, 0, 0, 0].entries()) {
    const old = originals[kind]!,
      id = createHash("sha256").update(`${f.articleId}:${i}`).digest("hex");
    ids.push(id);
    const row = {
      ...old,
      id,
      observation_id: `legacy-${i}`,
      observed_at: at(i + 1),
      created_at: at(i + 1),
      observation: sql.json(old.observation),
      result: sql.json(old.result),
    };
    await sql`INSERT INTO content.source_date_observations ${sql(row)}`;
  }
  await sql`UPDATE articles SET source_date_observation_id=${ids[1]!} WHERE id=${f.articleId}`;
  const before = await f.observations(),
    state = await f.state();
  const preview = await compactDateObservations(sql);
  const planned = preview.materials.find((row) => row.articleId === f.articleId)!;
  assert.deepEqual([planned.before, planned.after, planned.removable], [7, 7, 1]);
  assert.ok(planned.bytes > 0);
  assert.deepEqual(await f.observations(), before);
  assert.equal((await f.seen()).length, 0);
  const applied = (await compactDateObservations(sql, { apply: true })).materials.find((row) => row.articleId === f.articleId)!;
  assert.deepEqual([applied.before, applied.after, applied.removable], [7, 6, 1]);
  assert.deepEqual(
    (await f.observations()).map((row) => row.id),
    ids.filter((_id, i) => i !== 5),
  );
  assert.deepEqual(await f.state(), state);
  assert.equal((await f.seen())[0]!.last_observed_at.getTime(), at(7).getTime());
  assert.equal((await compactDateObservations(sql, { apply: true })).removableRows, 0);
  assert.equal((await f.send("2026-10-03", 6, 2)).sourceDateOutcome, "stale");
  assert.deepEqual(await f.state(), state);
});
