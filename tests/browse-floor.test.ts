// The browse floor (Owner 2026-11-05): unsearched "all" lists leave out items scored below SELECTION.browseFloor,
// on the web pool, the public API and its unfiltered machine list; picks and unscored items stay; a search finds all.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { loadPool } from "@amp/backend/publication/pool";
import { v1Items } from "@amp/backend/publication/v1";
import { SELECTION } from "@amp/industry/selection";

const source = `browse-floor-${tag()}`;
const now = new Date("2026-11-05T12:00:00+08:00");
after(closeDb);

test("an unsearched all list hides capped noise; picks, unscored items and searches keep it", async () => {
  await sql`INSERT INTO sources(id,name,kind,config) VALUES(${source},'Floor fixture','rss','{}')`;
  const rows: Array<[string, number | null, boolean]> = [
    ["low", SELECTION.browseFloor - 5, false],
    ["edge", SELECTION.browseFloor, false],
    ["unscored", null, false],
    ["picked-low", SELECTION.browseFloor - 10, true],
  ];
  for (const [name, score, selected] of rows) {
    const id = `${source}-${name}`;
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,language,body_text,raw)
      VALUES(${id},${source},${id},${`https://example.invalid/${id}`},${`铜矿浏览下限 ${name}`},${now},${now},'zh','body','{}'::jsonb)`;
    await sql`INSERT INTO publications(article_id,title,source_id,channel,url,published_at,discovered_at,timeline_at,sort_at,visibility,eligible,selected,selection_candidate,score,visible_after,search_text)
      VALUES(${id},${`铜矿浏览下限 ${name}`},${source},'news',${`https://example.invalid/${id}`},${now},${now},${now},${now},'public',true,${selected},${selected},${score},${new Date(now.getTime() - 3600_000)},${`铜矿浏览下限 ${name}`})`;
    await sql`INSERT INTO pool_search(article_id,direct,body) VALUES(${id},${`铜矿浏览下限 ${name}`},'') ON CONFLICT(article_id) DO NOTHING`;
  }
  const ids = (items: Array<{ id: string }>) => items.map((i) => i.id.slice(source.length + 1)).sort();
  const base = { channel: "all" as const, category: null, tag: null, source, now };
  const browse = await loadPool(base);
  assert.deepEqual(ids(browse.items), ["edge", "picked-low", "unscored"], "below the floor is not browsed; a pick and an unscored item stay");
  const search = await loadPool({ ...base, q: "浏览下限" });
  assert.ok(
    search.items.some((i) => i.id === `${source}-low`),
    "a search still finds it",
  );

  const api = await v1Items({ mode: "all", window: "all", by: "timeline", category: null, q: null, limit: 50, cursor: null, source }, now);
  assert.ok(!api.items.some((i) => i.id === `${source}-low`), "the API all mode applies the floor");
  assert.ok(
    api.items.some((i) => i.id === `${source}-picked-low`),
    "a confirmed pick stays below the floor",
  );
  assert.ok(api.items.some((i) => i.id.endsWith("-edge")));
  const apiSearch = await v1Items({ mode: "all", window: "all", by: "timeline", category: null, q: "浏览下限", limit: 50, cursor: null, source }, now);
  assert.ok(
    apiSearch.items.some((i) => i.id === `${source}-low`),
    "an API search finds it",
  );
});
