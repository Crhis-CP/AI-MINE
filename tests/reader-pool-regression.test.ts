import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { loadPool, withSearchCapacity, searchTerms } from "@amp/backend/publication/pool";

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
  const filtered = await loadPool({ ...base, mineral: "铜", on: "2026-10-12" });
  assert.equal(filtered.total, 1005);
  assert.equal(filtered.filters.source, source);
  assert.equal(filtered.filters.on, "2026-10-12");
  assert.equal((await loadPool({ ...base, mineral: "镍" })).total, 0);
  assert.equal((await loadPool({ ...base, from: "2026-10-13" })).total, 0);
  assert.equal((await loadPool({ ...base, to: "2026-10-10" })).total, 0);
  assert.equal((await loadPool({ ...base, selected: true })).total, 0);
  await sql`UPDATE publications SET published_at=NULL WHERE article_id=${`${source}-1`}`;
  assert.equal((await loadPool({ ...base, on: "2026-10-12" })).total, 1005, "source date stays unknown while timeline date remains searchable");
  assert.equal((await loadPool({ ...base, on: "2026-10-12", from: "2026-10-11", to: "2026-10-11" })).total, 1005, "an explicit day wins over range parameters");
});

test("unfiltered all folds duplicate reports into fact cards while filtered results stay individual", async () => {
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

test("overlapping searches keep source, mineral, date, selection and page scopes separate and never reuse settled content", async () => {
  await sql`UPDATE publications SET search_text=title WHERE source_id=${source}`;
  await sql`INSERT INTO pool_search(article_id,direct,body) SELECT article_id,title,'' FROM publications WHERE source_id=${source} ON CONFLICT(article_id) DO NOTHING`;
  const query = { channel: "all" as const, category: null, tag: null, source, q: "铜矿", mineral: "铜", on: "2026-10-12" };
  const first = loadPool(query),
    same = loadPool({ ...query }),
    second = loadPool({ ...query, page: 2 }),
    nickel = loadPool({ ...query, mineral: "镍" }),
    otherDay = loadPool({ ...query, on: "2026-10-13" }),
    selected = loadPool({ ...query, selected: true }),
    otherSource = loadPool({ ...query, source: "missing-source" });
  const values = await Promise.all([first, same, second, nickel, otherDay, selected, otherSource]);
  assert.equal(values[0]!.total, 1005);
  assert.deepEqual(values[0]!.items, values[1]!.items);
  assert.ok(values[2]!.items.every((item) => !values[0]!.items.some((first) => first.id === item.id)));
  for (const empty of values.slice(3)) assert.equal(empty.total, 0);
  const removed = values[0]!.items[0]!.id;
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${removed}`;
  const fresh = await loadPool(query);
  assert.equal(fresh.total, 1004);
  assert.ok(!fresh.items.some((item) => item.id === removed));
  // Occupy all search workers. Duplicate readers must use one waiting slot, not exhaust the queue.
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holders = Array.from({ length: Number(process.env.SEARCH_MAX_CONCURRENCY || 4) }, () => withSearchCapacity(async () => hold));
  const readers = Array.from({ length: Number(process.env.SEARCH_MAX_QUEUE || 8) + 2 }, () => loadPool(query));
  const joined = Promise.all(readers);
  release();
  await Promise.all(holders);
  const results = await joined;
  assert.ok(results.every((result) => result.total === fresh.total));
});

test("mixed Chinese and Latin search terms stay searchable and equal relevance prefers selected quality", async () => {
  assert.deepEqual(searchTerms("铜矿BHP2026项目 10月"), ["铜矿", "bhp2026", "项目", "10月"]);
  const ids = [1, 2, 3].map((n) => `${source}-rank-${n}`);
  for (const [index, id] of ids.entries()) {
    const at = new Date(now.getTime() + index * 1000);
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,language,body_text,raw)
      VALUES(${id},${source},${id},${`https://example.invalid/${id}`},'铜矿 nickel','2026-10-12',${at},'zh','合成材料','{}')`;
    await sql`INSERT INTO publications(article_id,title,source_id,channel,url,discovered_at,timeline_at,sort_at,visibility,eligible,selected,seat,visible_after,score,search_text)
      VALUES(${id},'铜矿 nickel',${source},'news',${`https://example.invalid/${id}`},${at},${at},${at},'public',true,${index === 0},${index === 0},${now},${index === 0 ? 60 : index === 1 ? 90 : 70},'铜矿 nickel')`;
    await sql`INSERT INTO pool_search(article_id,direct,body) VALUES(${id},'铜矿 nickel','')`;
  }
  for (const q of ["nickel", "铜矿nickel"]) {
    const result = await loadPool({ ...base, now: new Date(now.getTime() + 10000), q, tab: "relevance" });
    assert.deepEqual(
      result.items.map((item) => item.id),
      ids,
      "selected first, then quality, even when the lower quality report is newer",
    );
  }
});
