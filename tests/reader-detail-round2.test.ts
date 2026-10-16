import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { loadItemDetail, siteItemDetail } from "@amp/backend/publication/detail";
import { loadStoryFollowups } from "@amp/backend/publication/followups";
import { v3Item } from "@amp/backend/publication/v1";

after(closeDb);
const source = `reader-r2-${tag()}`;
const now = new Date("2030-10-12T04:00:00Z");
const published = new Date("2020-01-01T04:00:00Z");
const firstPublic = new Date("2026-10-12T04:00:00Z");
async function seed(id: string, status: string, body: string | null, firstParty = false, publicTime: Date | null = null) {
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,language,body_status,body_html,body_text,discovered_at,timeline_at,raw)
    VALUES(${id},${source},${id},${`https://example.invalid/${id}`},${id},'zh',${status},${body},${body},${published},${published},'{}')`;
  await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,published_at,discovered_at,timeline_at,sort_at,visibility,eligible,body_mode,first_party,representative_priority,first_public_at,first_publication_observed)
    VALUES(${id},${id},'真实当前导读',${source},'news',${`https://example.invalid/${id}`},${published},${published},${published},${published},'public',true,${body ? "full" : "summary"},${firstParty},${firstParty ? 0 : 3},${publicTime},${publicTime !== null})`;
}
async function detail(id: string) {
  const value = await loadItemDetail(id, now);
  assert.equal(value.kind, "found");
  if (value.kind !== "found") throw new Error("fixture missing");
  return value.detail;
}
test("detail distinguishes pending, unavailable, and restricted bodies without inventing first public time", async () => {
  await sql`INSERT INTO sources(id,name,kind,participation_mode,site_fulltext) VALUES(${source},'原始发布方','rss','editorial',true)`;
  await seed(`${source}-pending`, "pending", null);
  await seed(`${source}-none`, "none", null);
  await seed(`${source}-full`, "ok", "<p>中文来源完整正文。</p>", false, firstPublic);
  await seed(`${source}-historic-full`, "ok", "<p>历史中文来源正文。</p>");
  assert.equal((await detail(`${source}-pending`)).readingState, "pending");
  assert.equal((await detail(`${source}-none`)).readingState, "unavailable");
  const full = await detail(`${source}-full`);
  assert.equal(full.readingState, "available");
  assert.equal((await detail(`${source}-historic-full`)).firstPublicAt, null, "discovery and source publication do not prove first public time");
  const known = await detail(`${source}-full`);
  assert.equal(known.firstPublicAt, firstPublic.toISOString());
  assert.notEqual(known.firstPublicAt, known.publishedAt);
  assert.equal((await v3Item(`${source}-full`, true, now))!.first_public_at.utc, firstPublic.toISOString());
  assert.equal((await v3Item(`${source}-none`, true, now))!.first_public_basis, "unknown");
  await sql`UPDATE sources SET site_fulltext=false WHERE id=${source}`;
  const restricted = siteItemDetail(await detail(`${source}-full`));
  assert.equal(restricted.readingState, "restricted");
  assert.equal(restricted.body, null);
  await sql`UPDATE sources SET site_fulltext=true WHERE id=${source}`;
});

test("event representation prefers the first party, latest means a distinct fact, and withdrawn pointers disappear", async () => {
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories(public_id,title) VALUES('6d11ec01-480e-4bb4-8568-238e5dbfd084','测试事件') RETURNING id`;
  const [oldFact] = await sql<
    { id: number; public_id: string }[]
  >`INSERT INTO facts(public_id,story_id,title) VALUES(${`${source}-old-fact`},${story!.id},'旧事实') RETURNING id,public_id`;
  const [newFact] = await sql<
    { id: number; public_id: string }[]
  >`INSERT INTO facts(public_id,story_id,title) VALUES(${`${source}-new-fact`},${story!.id},'新事实') RETURNING id,public_id`;
  const official = `${source}-official`,
    duplicate = `${source}-duplicate`,
    latest = `${source}-latest`;
  for (const [id, fact, at, firstParty] of [
    [official, oldFact!, "2026-10-01T00:00:00Z", true],
    [duplicate, oldFact!, "2026-10-03T00:00:00Z", false],
    [latest, newFact!, "2026-10-02T00:00:00Z", false],
  ] as const) {
    await seed(id, "ok", "<p>中文事件正文。</p>", firstParty);
    await sql`UPDATE publications SET story_id=${story!.id},fact_id=${fact.id},timeline_at=${new Date(at)},sort_at=${new Date(at)} WHERE article_id=${id}`;
    await sql`INSERT INTO fact_articles(fact_id,article_id,manual) VALUES(${fact.id},${id},true)`;
  }
  const value = (await detail(duplicate)).eventCoverage!;
  assert.equal(value.reportCount, 3);
  assert.equal(value.representative.id, official);
  assert.equal(value.latest.id, latest, "a later duplicate does not become a new development");
  const followups = await loadStoryFollowups("6d11ec01-480e-4bb4-8568-238e5dbfd084");
  assert.equal(followups!.items.length, 2, "unselected qualified developments remain visible");
  assert.equal(followups!.items[0]!.representative.summary, "真实当前导读");
  assert.equal(followups!.items[0]!.representative.sourceTime, null, "a timeline anchor does not establish the source publication time");
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id IN (${official},${latest})`;
  assert.equal((await detail(duplicate)).eventCoverage, null, "one remaining public report has no redundant coverage block");
  assert.ok(!(await loadStoryFollowups("6d11ec01-480e-4bb4-8568-238e5dbfd084"))!.items.some((f) => f.representative.id === latest));
});
