import { tag } from "./setup.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial, updateMaterialSourceDate, decideTimeline } from "@amp/backend/content/materials";
import { completeMaterialGrouping } from "../packages/backend/src/content/grouping.ts";
import { saveSourcePolicy, readSourceDateContext } from "@amp/backend/admin/sources";
import { observeSourceDate } from "../packages/backend/src/sources/date-extraction.ts";
import { sourcePolicyExample } from "./permission-fixture.ts";
import { beijingDate, beijingMidnight, addDays } from "@amp/contracts/time";

after(closeDb);
async function fixture(backfill?: string) {
  const sourceId = `archive-date-${tag()}`,
    url = `https://source.invalid/mining/${sourceId}`,
    discoveredAt = new Date();
  await sql`INSERT INTO sources(id,name,kind,enabled,config) VALUES(${sourceId},'Synthetic archive date','rss',true,'{}')`;
  await saveSourcePolicy(
    sourceId,
    { expectedVersion: null, policy: { ...structuredClone(sourcePolicyExample), source_id: sourceId }, reason: "synthetic permission" },
    "test",
  );
  const source = (await readSourceDateContext(sourceId))!;
  const material = { sourceId, url, title: "合成日期恢复材料", bodyText: "同一份矿业公告正文。", via: "fetch" as const, discoveredAt, backfill };
  const observation = (raw: string, version: number) => ({
    sourceDateObservation: observeSourceDate(source, url, raw, "rss.pubDate"),
    expectedSourceDateVersion: version,
    permissionVersion: 1,
  });
  return { material, observation, discoveredAt, today: beijingDate(discoveredAt) };
}
const row = async (id: string) =>
  (await sql`SELECT revision,published_at,timeline_at,backfill,backfill_reason,grouping_status,selection_adds_value FROM articles WHERE id=${id}`)[0]!;

test("unknown and implausibly future dates are archived without inventing a publication time", () => {
  const at = new Date("2026-10-15T10:00:00Z");
  for (const claim of [null, new Date("invalid"), new Date("2026-10-15T12:00:00Z")]) {
    const result = decideTimeline(claim, at);
    assert.equal(result.publishedAt, null);
    assert.equal(result.backfill, true);
    assert.equal(result.backfillReason, "unknown-publication-time");
    assert.equal(result.timelineAt, at);
  }
});

test("a day-only observation on insertion updates the returned archive status as well as storage", async () => {
  const f = await fixture();
  const saved = await upsertMaterial({ ...f.material, ...f.observation(f.today, 0) });
  assert.equal(saved.backfill, false);
  const stored = await row(saved.articleId);
  assert.equal(stored.published_at.toISOString(), beijingMidnight(f.today).toISOString());
  assert.equal(stored.timeline_at.toISOString(), f.discoveredAt.toISOString());
  const [evidence] = await sql`SELECT result FROM content.source_date_observations WHERE article_id=${saved.articleId}`;
  assert.equal(evidence!.result.evidence.time.precision, "date");
  assert.equal(evidence!.result.evidence.time.utc, null);
});

test("filling an old day uses first discovery, retains the material revision, and invalidates old grouping", async () => {
  const f = await fixture(),
    saved = await upsertMaterial(f.material);
  assert.equal(saved.backfill, true);
  await completeMaterialGrouping(saved.articleId, 1, { addsValue: true, reason: "synthetic old decision" }, null);
  const day = addDays(f.today, -4);
  const changed = await updateMaterialSourceDate(saved.articleId, 1, f.observation(day, 0));
  assert.equal(changed.sourceTimeChanged, true);
  const stored = await row(saved.articleId);
  assert.equal(stored.revision, 1);
  assert.equal(stored.backfill_reason, "stale-on-discovery");
  assert.equal(stored.timeline_at.toISOString(), beijingMidnight(day).toISOString());
  assert.equal(stored.grouping_status, "pending");
  assert.equal(stored.selection_adds_value, null);
});

test("a fresh recovered date can leave automatic quarantine while an explicit import stays archived", async () => {
  for (const reason of [undefined, "first-import"]) {
    const f = await fixture(reason),
      saved = await upsertMaterial(f.material);
    await updateMaterialSourceDate(saved.articleId, 1, f.observation(f.today, 0));
    const stored = await row(saved.articleId);
    assert.equal(stored.backfill, !!reason);
    assert.equal(stored.backfill_reason, reason ?? null);
    assert.equal(stored.timeline_at.toISOString(), reason ? beijingMidnight(f.today).toISOString() : f.discoveredAt.toISOString());
  }
});

test("equivalent date spelling changes evidence without withdrawing a confirmed grouping decision", async () => {
  const f = await fixture(),
    saved = await upsertMaterial({ ...f.material, ...f.observation(f.today, 0) });
  await completeMaterialGrouping(saved.articleId, 1, { addsValue: true, reason: "synthetic confirmed decision" }, null);
  const changed = await updateMaterialSourceDate(saved.articleId, 1, f.observation(` ${f.today} `, 1));
  assert.equal(changed.sourceTimeChanged, false);
  assert.equal((await row(saved.articleId)).grouping_status, "complete");
  assert.equal((await row(saved.articleId)).published_at.toISOString(), beijingMidnight(f.today).toISOString());
});
