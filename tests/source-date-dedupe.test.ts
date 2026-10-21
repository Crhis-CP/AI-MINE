import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { closeDb, sql } from "@amp/backend/db";
import { saveSourcePolicy, readSourceDateContext } from "@amp/backend/admin/sources";
import { upsertMaterial, updateMaterialSourceDate, compactDateObservations } from "@amp/backend/content/materials";
import { observeSourceDate } from "../packages/backend/src/sources/date-extraction.ts";
import { sourceDateConfigHash } from "@amp/backend/sources/config-keys";
import { sourcePolicyExample } from "./permission-fixture.ts";

const at = (n: number) => new Date(Date.parse("2026-10-07T10:00:00Z") + n * 1000);
after(() => closeDb());

async function fixture(kind = "rss") {
  const sourceId = `date-dedupe-${tag()}`,
    url = `https://source.invalid/mining/${sourceId}`;
  await sql`INSERT INTO sources(id,name,kind,enabled,config) VALUES(${sourceId},'Synthetic date source',${kind},true,'{}')`;
  const policy = { ...structuredClone(sourcePolicyExample), source_id: sourceId };
  await saveSourcePolicy(sourceId, { expectedVersion: null, policy, reason: "Synthetic fixture" }, "test");
  const { articleId } = await upsertMaterial({ sourceId, url, title: "合成铜矿日期", bodyText: "同一正文", via: "fetch" });
  const source = (await readSourceDateContext(sourceId))!;
  const send = (raw: string, tick: number, version: number, locator = "rss.pubDate") =>
    updateMaterialSourceDate(articleId, 1, {
      sourceDateObservation: observeSourceDate(source, url, raw, locator, { observedAt: at(tick).toISOString() }),
      expectedSourceDateVersion: version,
      permissionVersion: 1,
    });
  const observations = () => sql`SELECT * FROM content.source_date_observations WHERE article_id=${articleId} ORDER BY observed_at,id`;
  const state = async () =>
    (await sql`SELECT source_date_observation_id, source_date_version, source_date_state, published_at FROM articles WHERE id=${articleId}`)[0]!;
  const seen = () => sql`SELECT * FROM content.source_date_observation_seen WHERE article_id=${articleId} ORDER BY revision,config_hash`;
  return { articleId, sourceId, url, send, observations, state, seen };
}

test("an absent unconfigured list field preserves and can restore its latest bound reliable evidence, but cannot cross explicit removal", async () => {
  const f = await fixture("web_list"),
    absent = "listing publication field absent";
  await f.send("2026-10-01", 1, 0, "selector:time");
  const reliable = await f.state();
  await f.send("", 2, 1, absent);
  assert.deepEqual(await f.state(), reliable);
  const missing = (await f.observations()).find((row) => row.result.reason === "missing")!;
  assert.ok(missing, "weak observations remain auditable even when not selected");
  // Existing affected rows already have this audited weak observation selected by the old code.
  await sql`UPDATE articles SET source_date_observation_id=${missing.id},source_date_state='pending',source_date_error='missing',
    source_date_version=2,published_at=NULL,published_at_claim=NULL,timeline_at=discovered_at,
    backfill=true,backfill_reason='unknown-publication-time' WHERE id=${f.articleId}`;
  const restored = await f.send("", 3, 2, absent);
  assert.deepEqual([restored.sourceDateOutcome, restored.sourceDateVersion, restored.sourceTimeChanged], ["applied", 3, true]);
  assert.equal((await f.state()).source_date_observation_id, reliable.source_date_observation_id);
  assert.equal((await f.state()).published_at.getTime(), reliable.published_at.getTime());
  assert.equal((await f.seen())[0]!.last_observed_at.getTime(), at(3).getTime());
  await f.send("2026-10-02", 4, 3, "selector:time");
  assert.equal((await f.state()).published_at.toISOString(), "2026-10-01T16:00:00.000Z");
  await f.send("", 5, 4, "selector:time");
  assert.equal((await f.state()).source_date_state, "pending", "a configured field removal still changes the date");
  await f.send("", 6, 5, absent);
  const removed = await f.state();
  await f.send("", 7, 6, absent);
  assert.deepEqual(await f.state(), removed, "never search past the latest explicit missing observation for an older reliable date");
});

test("weak listing evidence cannot retain or recover dates across material, config, URL or conflict boundaries", async () => {
  for (const change of ["revision", "configuration", "url", "conflict"] as const) {
    const f = await fixture("web_list");
    await f.send("2026-10-01", 1, 0, "selector:time");
    let url = f.url,
      revision = 1;
    if (change === "revision") {
      const result = await upsertMaterial({ sourceId: f.sourceId, url, title: "合成铜矿日期", bodyText: "修订后的正文", via: "fetch" });
      revision = result.revision;
      assert.equal(revision, 2);
    } else if (change === "configuration") {
      const config = { sourceDate: { format: "iso8601", language: "zh-CN" } };
      await sql`UPDATE sources SET config=${sql.json(config)},source_date_config_hash=${sourceDateConfigHash("web_list", config)} WHERE id=${f.sourceId}`;
    } else if (change === "url") {
      url += "/different-material";
      await sql`UPDATE articles SET url=${url} WHERE id=${f.articleId}`;
    } else {
      const source = (await readSourceDateContext(f.sourceId))!;
      const primary = observeSourceDate(source, url, "2026-10-02", "selector:time", { observedAt: at(2).toISOString() });
      const {
        sourceId: _source,
        configHash: _config,
        observationId: _id,
        observedAt: _at,
        url: _url,
        alternatives: _alternatives,
        ...alternative
      } = observeSourceDate(source, url, "2026-10-03", "meta:published", { observedAt: at(2).toISOString() });
      await updateMaterialSourceDate(f.articleId, revision, {
        sourceDateObservation: { ...primary, alternatives: [alternative] },
        expectedSourceDateVersion: 1,
        permissionVersion: 1,
      });
      assert.equal((await f.observations()).at(-1)!.result.reason, "conflicting_candidates");
    }
    for (const tick of [3, 4]) {
      const source = (await readSourceDateContext(f.sourceId))!;
      await updateMaterialSourceDate(f.articleId, revision, {
        sourceDateObservation: observeSourceDate(source, url, "", "listing publication field absent", { observedAt: at(tick).toISOString() }),
        expectedSourceDateVersion: Number((await f.state()).source_date_version),
        permissionVersion: 1,
      });
      assert.equal((await f.state()).source_date_state, "pending", change);
      assert.equal((await f.state()).published_at, null, change);
    }
  }
});

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
