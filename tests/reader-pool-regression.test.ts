import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { loadPool } from "@amp/backend/publication/pool";
const sql = dbOf("publication");
const source = `reader-pool-${tag()}`;
const now = new Date("2026-10-12T12:00:00+08:00");
after(closeDb);
const base = { channel: "all" as const, category: null, tag: null, source, now };

test("all numeric pages stay reachable beyond page 50 and totals stay exact", async () => {
  await sql`INSERT INTO sources(id,name,kind,config) VALUES(${source},'Reader fixture','rss','{}')`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,language,body_text,raw)
    SELECT ${source}||'-'||n::text,${source},${source}||'-'||n::text,'https://example.invalid/'||${source}||'/'||n::text,
      '铜矿测试 '||n::text, ${now}::timestamptz, ${now}::timestamptz, 'zh','body','{}'::jsonb FROM generate_series(1,1005) n`;
  await sql`INSERT INTO publications(article_id,title,source_id,channel,url,published_at,discovered_at,timeline_at,sort_at,visibility,eligible,selected,tags)
    SELECT id,title,source_id,'news',url,${new Date("2026-10-11T12:00:00+08:00")},discovered_at,timeline_at,timeline_at,'public',true,false,ARRAY['铜']
    FROM articles WHERE source_id=${source}`;
  const first = await loadPool(base);
  assert.equal(first.total, 1005);
  assert.equal(first.items.length, 20);
  assert.equal(first.pageCount, 51);
  const last = await loadPool({ ...base, page: 51 });
  assert.equal(last.page, 51);
  assert.equal(last.items.length, 5);
  const beyond = await loadPool({ ...base, page: 52 });
  assert.equal(beyond.page, 52);
  assert.deepEqual(beyond.items, []);
});

test("source, mineral and date conditions combine without silently losing parameters", async () => {
  const filtered = await loadPool({ ...base, mineral: "铜", on: "2026-10-11" });
  assert.equal(filtered.total, 1005);
  assert.equal(filtered.filters.source, source);
  assert.equal(filtered.filters.on, "2026-10-11");
  assert.equal((await loadPool({ ...base, mineral: "镍" })).total, 0);
  assert.equal((await loadPool({ ...base, from: "2026-10-12" })).total, 0);
  assert.equal((await loadPool({ ...base, to: "2026-10-10" })).total, 0);
  assert.equal((await loadPool({ ...base, selected: true })).total, 0);
  await sql`UPDATE publications SET published_at=NULL WHERE article_id=${`${source}-1`}`;
  assert.equal((await loadPool({ ...base, on: "2026-10-11" })).total, 1004, "unknown publication dates cannot be invented from discovery time");
  assert.equal((await loadPool({ ...base, on: "2026-10-11", from: "2026-10-12", to: "2026-10-12" })).total, 1004, "an explicit day wins over range parameters");
});

test("unfiltered all folds reports into event cards while filtered results stay individual", async () => {
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories(public_id,title) VALUES('71c4bad1-4b3d-463b-9a46-dfca3c000123','合成事件') RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,story_id,title) VALUES(${`${source}-fact`},${story!.id},'合成事实') RETURNING id`;
  const members = [`${source}-1005`, `${source}-1004`];
  for (const id of members) {
    await sql`UPDATE publications SET story_id=${story!.id},fact_id=${fact!.id},sort_at=${new Date("2026-10-12T13:00:00+08:00")} WHERE article_id=${id}`;
    await sql`INSERT INTO fact_articles(fact_id,article_id) VALUES(${fact!.id},${id})`;
  }
  const grouped = await loadPool({ channel: "all", category: null, tag: null, now });
  assert.equal(grouped.reportTotal, 1005);
  assert.equal(grouped.total, 1004);
  const group = grouped.cards?.find((card) => card.group?.factId === `${source}-fact`);
  assert.equal(group?.group?.reportCount, 2);
  assert.equal(group?.group?.developmentCount, 1);
  const filtered = await loadPool(base);
  assert.equal(filtered.cards, undefined);
  assert.equal(filtered.total, 1005);
});
