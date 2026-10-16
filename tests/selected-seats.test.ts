import { tag } from "./setup.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { dbOf, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { publishArticle } from "@amp/backend/publication/publish";
import { pushSelected } from "../packages/backend/src/notify/selected.ts";
import { setVisibility, detachFromFact } from "@amp/backend/admin/content";
import { loadTimeline } from "@amp/backend/publication/timeline";
import { stopBoss } from "@amp/backend/jobs/queue";
import { buildApp } from "./site-app.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
import { confirmGroupingFixture } from "./grouping-fixture.ts";
import { scopeVersion, scopeOutput, scopeReceipt } from "./scope-fixture.ts";
const sql = dbOf("publication");
const app = await buildApp("public-api");
after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});

async function material(tier: "T1" | "T2", fact: number) {
  const sourceId = `seat-${tag()}`;
  const url = `https://example.com/${sourceId}`;
  await sql`INSERT INTO sources(id,name,kind,tier,first_party,site_fulltext,syndicate_fulltext) VALUES(${sourceId},${tier === "T1" ? "合成官方" : "合成媒体"},'rss',${tier},${tier === "T1"},true,true)`;
  await grantDateFixture(sourceId, [url]);
  const { articleId } = await upsertMaterial({
    sourceId,
    url,
    title: `合成铜矿项目 ${sourceId}`,
    bodyText: "合成铜矿建设披露了设计产能和投产日期。",
    language: "zh",
    via: "fetch",
    publishedAt: new Date(Date.now() - 60000),
  });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected,prompt_version,receipt_ids,output)
    VALUES(${articleId},1,'rule','pass','company_project',${`合成铜矿项目 ${sourceId}`},'合成项目公布新的建设计划',${tier === "T1" ? 70 : 90},true,${scopeVersion},${[await scopeReceipt(articleId)]},${sql.json(scopeOutput)})`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${fact},${articleId},'report',1)`;
  await confirmGroupingFixture(articleId);
  return articleId;
}
async function fact() {
  const [story] = await sql`INSERT INTO stories(public_id,title) VALUES(${crypto.randomUUID()},'合成铜矿进展') RETURNING id`;
  const [row] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${`f${tag()}`},${story!.id},'合成铜矿建设') RETURNING id`;
  return Number(row!.id);
}
async function seats(ids: string[]) {
  return (await sql<{ article_id: string }[]>`SELECT article_id FROM publications WHERE article_id=ANY(${ids}) AND seat`).map((r) => r.article_id).sort();
}

test("a better representative replaces the prior selected seat across API, RSS, ledger and website", async () => {
  const f = await fact(),
    media = await material("T2", f),
    official = await material("T1", f);
  await publishArticle(media);
  const snapshot = (await app.inject("/api/v1/selected/snapshot")).json();
  assert.ok(snapshot.items.some((item: { id: string }) => item.id === media));
  await publishArticle(official);
  assert.deepEqual(await seats([media, official]), [official]);
  assert.equal((await pushSelected(media)).status, "skipped", "a non-representative cannot send a second selected push");
  const items = (await app.inject("/api/v1/items?mode=selected&limit=100")).json().items as { id: string }[];
  assert.deepEqual(
    items.filter((r) => [media, official].includes(r.id)).map((r) => r.id),
    [official],
  );
  const feed = await app.inject("/feed.xml");
  assert.ok(feed.body.includes(official));
  assert.ok(!feed.body.includes(media));
  const state = await sql<{ article_id: string; in_set: boolean }[]>`SELECT article_id,in_set FROM selected_state WHERE article_id=ANY(${[media, official]})`;
  assert.equal(state.find((r) => r.article_id === media)?.in_set, false);
  assert.equal(state.find((r) => r.article_id === official)?.in_set, true);
  const delta = (await app.inject(`/api/v1/selected/changes?cursor=${encodeURIComponent(snapshot.cursor)}&limit=100`)).json();
  assert.ok(JSON.stringify(delta).includes(media) && JSON.stringify(delta).includes(official));
  const cards = (await loadTimeline({ channel: "all", category: null, tag: null })).cards;
  assert.deepEqual(
    cards.filter((c) => [media, official].includes(c.item.id)).map((c) => c.item.id),
    [official],
  );
  const revisions = (await sql`SELECT revision FROM publications WHERE article_id=${official}`)[0]!.revision;
  await publishArticle(official);
  assert.equal((await sql`SELECT revision FROM publications WHERE article_id=${official}`)[0]!.revision, revisions, "reprojection is idempotent");
  await setVisibility(official, { visibility: "withdrawn", reason: "合成撤回", version: 0 }, "synthetic-owner");
  assert.deepEqual(await seats([media, official]), [media]);
  assert.equal((await app.inject(`/api/site/items/${official}`)).statusCode, 404);
  await setVisibility(official, { visibility: "public", reason: "合成恢复", version: 1 }, "synthetic-owner");
  assert.deepEqual(await seats([media, official]), [official]);
  await detachFromFact(official, "合成人工独立报道", "synthetic-owner");
  assert.deepEqual(await seats([media, official]), [media, official].sort(), "moving a representative releases its old fact seat");
});

test("simultaneous publications choose one stable seat and record both results without deadlock", { timeout: 10000 }, async () => {
  const f = await fact(),
    media = await material("T2", f),
    official = await material("T1", f);
  await Promise.all([publishArticle(media), publishArticle(official)]);
  assert.deepEqual(await seats([media, official]), [official]);
  const rows = await sql`SELECT article_id FROM selected_state WHERE article_id=ANY(${[media, official]}) AND in_set`;
  assert.deepEqual(
    rows.map((r) => r.article_id),
    [official],
  );
});
