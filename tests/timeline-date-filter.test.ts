import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { loadPool } from "@amp/backend/publication/pool";
import { v1Items, v3Events } from "@amp/backend/publication/v1";
import { publicStoryDirectory } from "@amp/backend/publication/stories";
import { encodeCursor, InvalidCursorError, queryBinding } from "@amp/backend/lib/cursor";
import { buildApp } from "../apps/api/src/app.ts";

const sql = dbOf("publication"),
  source = `timeline-date-${tag()}`;
const day = "2026-10-11",
  now = new Date("2026-10-12T12:00:00+08:00");
const fixture = [
  { key: "before", timeline: "2026-10-10T15:59:59.999Z", published: "2026-10-11T01:00:00Z" },
  { key: "start", timeline: "2026-10-10T16:00:00Z", published: "2026-10-09T12:00:00Z" },
  { key: "unknown", timeline: "2026-10-11T15:59:59.999Z", published: null },
  { key: "date-only", timeline: "2026-10-11T01:00:00Z", published: "2026-10-09T16:00:00Z" },
  { key: "end", timeline: "2026-10-11T16:00:00Z", published: "2026-10-11T01:00:00Z" },
  { key: "old", timeline: "2026-10-08T01:00:00Z", published: "2026-10-08T01:00:00Z" },
].map((row) => ({ ...row, id: `${source}-${row.key}`, event: randomUUID() }));
const expected = fixture.filter((row) => ["start", "unknown", "date-only"].includes(row.key));
const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();
const base = { channel: "all" as const, category: null, tag: null, source, now };
const apiBase = { mode: "all" as const, window: "all" as const, by: "timeline" as const, category: null, q: null, source, limit: 100, cursor: null };
const app = await buildApp("public-api");
after(async () => {
  await app.close();
  await closeDb();
});
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,config) VALUES(${source},'北京日期合成来源','rss','{}')`;
  for (const row of fixture) {
    const timeline = new Date(row.timeline),
      published = row.published ? new Date(row.published) : null;
    const [story] = await sql<{ id: number }[]>`INSERT INTO stories(public_id,title) VALUES(${row.event},'日期合成事件') RETURNING id`;
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,published_at,language,body_status,body_text,raw)
      VALUES(${row.id},${source},${row.id},${`https://example.invalid/${row.id}`},'铜矿日期边界',${now},${timeline},${published},'zh','ok','中文合成材料','{}')`;
    await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,published_at,discovered_at,timeline_at,sort_at,visibility,eligible,selected,body_mode,tags,story_id,search_text)
      VALUES(${row.id},'铜矿日期边界','中文合成导读',${source},'news',${`https://example.invalid/${row.id}`},${published},${now},${timeline},${timeline},'public',true,false,'summary',ARRAY['铜'],${story!.id},'铜矿日期边界 中文合成导读')`;
    await sql`INSERT INTO pool_search(article_id,direct,body) VALUES(${row.id},'铜矿日期边界 中文合成导读','')`;
  }
});

test("Beijing timeline day controls lists, search, facets and API, while source dates stay intact", async () => {
  for (const filters of [{ on: day }, { from: day, to: day }]) {
    for (const search of [{}, { q: "铜矿", tab: "time" as const }, { q: "铜矿", tab: "relevance" as const }]) {
      const pool = await loadPool({ ...base, ...filters, ...search, now: new Date("2026-10-11T23:59:59.999+08:00") });
      assert.deepEqual(ids(pool.items), ids(expected), JSON.stringify({ filters, search }));
      assert.equal(pool.total, 3);
      assert.equal(pool.todayCount, 3, "today and the selected Beijing day use the same timeline");
      assert.equal(pool.facets?.sources.find((row) => row.id === source)?.count, 3);
      assert.equal(pool.items.find((row) => row.id === `${source}-unknown`)?.publishedAt, null);
      assert.equal(pool.items.find((row) => row.id === `${source}-date-only`)?.publishedAt, "2026-10-09T16:00:00.000Z");
    }
    for (const by of ["timeline", "published"] as const) {
      const listing = await v1Items({ ...apiBase, ...filters, by }, now);
      assert.deepEqual(ids(listing.items), ids(expected), "ordering does not change date qualification");
    }
    const params = new URLSearchParams({ source, facets: "true" });
    for (const [key, value] of Object.entries(filters)) if (value !== undefined) params.set(key, value);
    const response = await app.inject({ method: "GET", url: `/api/v3/items?${params}` });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(ids(response.json().items), ids(expected));
    assert.equal(response.json().facets.sources.find((row: { id: string }) => row.id === source).count, 3);
    const events = await publicStoryDirectory({ view: "all", source, limit: 100, ...filters });
    assert.deepEqual(ids(events), expected.map((row) => row.event).sort());
  }
  const rows = await sql<{ id: string; published_at: Date | null }[]>`SELECT article_id AS id,published_at FROM publications WHERE source_id=${source}`;
  for (const row of rows)
    assert.equal(
      row.published_at?.toISOString() ?? null,
      fixture.find((item) => item.id === row.id)!.published ? new Date(fixture.find((item) => item.id === row.id)!.published!).toISOString() : null,
    );
});

test("one-sided ranges include their stated day and never move old reports into today", async () => {
  const from = await loadPool({ ...base, from: day });
  assert.deepEqual(ids(from.items), ids(fixture.filter((row) => ["start", "unknown", "date-only", "end"].includes(row.key))));
  const to = await loadPool({ ...base, to: day });
  assert.deepEqual(ids(to.items), ids(fixture.filter((row) => row.key !== "end")));
  const today = await loadPool({ ...base, on: "2026-10-12" });
  assert.deepEqual(ids(today.items), [`${source}-end`]);
  assert.equal((await loadPool(base)).total, fixture.length, "unknown source dates still appear without filtering");
});

test("date-filtered cursors bind the new meaning; normal continuation and unfiltered cursors remain usable", async () => {
  const first = await v1Items({ ...apiBase, on: day, limit: 1 }, now);
  assert.ok(first.page.nextCursor);
  const rest = await v1Items({ ...apiBase, on: day, cursor: first.page.nextCursor }, now);
  assert.deepEqual(ids([...first.items, ...rest.items]), ids(expected));
  const legacy = encodeCursor("it3", {
    a: Date.parse(expected[1]!.timeline),
    i: expected[1]!.id,
    c: queryBinding({ m: "all", w: "all", b: "timeline", c: null, q: null, source, on: day }),
  });
  await assert.rejects(v1Items({ ...apiBase, on: day, cursor: legacy }, now), InvalidCursorError);
  const noDate = await v1Items({ ...apiBase, limit: 1 }, now);
  const noDateRest = await v1Items({ ...apiBase, cursor: noDate.page.nextCursor }, now);
  assert.deepEqual(ids([...noDate.items, ...noDateRest.items]), ids(fixture));
  const oldEvent = encodeCursor("v3-page", {
    binding: queryBinding({ type: "events", view: "all", source, on: day }),
    after: "2026-10-12T00:00:00.000Z|legacy",
  });
  await assert.rejects(v3Events({ view: "all", source, on: day, limit: 20, cursor: oldEvent }), InvalidCursorError);
});
