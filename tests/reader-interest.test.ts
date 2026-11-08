import { tag } from "./setup.ts";
// 读者兴趣记录 (TASK-0596): a complete day's page views summed by the reader filters' own classification (category,
// mineral, company, country), the most read articles and the list and topic pages; recorded once the day has
// settled, replaced when recorded again, kept after visit_pages is gone, and read by 访问概况.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { CATEGORY_LABELS } from "@amp/industry/taxonomy";
import { seedTopics } from "@amp/backend/publication/topics";
import { VisitOverview } from "@amp/contracts/http/private";
import { geographyRecipe } from "../packages/backend/src/editorial/geography.ts";
import {
  computeInterestDay,
  interestDaysToRecord,
  lastCompleteDay,
  recordReaderInterest,
  storeInterestDay,
} from "../modules/site-admin/backend/reader-interest.ts";
import { visitOverview } from "../modules/site-admin/backend/visits.ts";

after(closeDb);
const at = (iso: string) => new Date(iso);

test("a complete day is summed by category, mineral, company and country as the filters classify, once, and kept", async () => {
  const source = tag(),
    when = new Date("2026-11-03T02:00:00Z");
  await sql`INSERT INTO sources(id,name,kind) VALUES(${source},'Synthetic interest source','rss')`;
  async function item(key: string, title: string, fields: { category?: string; tags?: string[]; search?: string; codes?: string[]; visibility?: string }) {
    const id = `${source}-${key}`;
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
      VALUES(${id},${source},${id},${`https://example.invalid/${id}`},${title},${when},${when})`;
    await sql`INSERT INTO publications(article_id,source_id,channel,url,title,category,tags,search_text,eligible,visibility,discovered_at,timeline_at,sort_at)
      VALUES(${id},${source},'news',${`https://example.invalid/${id}`},${title},${fields.category ?? null},${fields.tags ?? []},${fields.search ?? title},true,
        ${fields.visibility ?? "public"},${when},${when},${when})`;
    if (fields.codes)
      await sql`INSERT INTO publication.news_geography(article_id,article_revision,analysis_id,recipe,state,jurisdictions)
        VALUES(${id},1,NULL,${geographyRecipe()},'identified',${fields.codes})`;
    return id;
  }
  // Copper by tag, Zijin by the alias in its search text, Argentina by geography evidence (not by the tag).
  const copper = await item("copper", "合成铜价文章", { category: "commodity_market", tags: ["铜"], search: "合成铜价文章 紫金矿业 扩产", codes: ["AR"] });
  // A retired category key is shown (and summed) as its successor; "阿根廷" only as a tag is not country evidence.
  const lithium = await item("lithium", "合成锂矿文章", { category: "safety_incident", tags: ["锂", "阿根廷"], codes: ["CL"] });
  const withdrawn = await item("withdrawn", "已撤回的合成文章", { category: "commodity_market", tags: ["铜"], visibility: "withdrawn" });
  await seedTopics();

  const day = "2026-11-03";
  await sql`INSERT INTO ops.visit_days(day,page_views,english_views) VALUES(${day}::date,40,0)`;
  const page = (path: string, route: string, views: number) =>
    sql`INSERT INTO ops.visit_pages(day,path,route,views) VALUES(${day}::date,${path},${route},${views})`;
  await page(`/items/${copper}`, "/items/:id", 10);
  await page(`/items/${lithium}`, "/items/:id", 4);
  await page(`/items/${withdrawn}`, "/items/:id", 3);
  await page("/items/:id", "/items/:id", 2); // past the day's address limit: counted, not attributable
  await page("/topics/copper", "/topics/:slug", 6);
  await page("/all", "/all", 5);
  await page("/about", "/about", 9); // not a list page
  await page("/items/:id/original", "/items/:id/original", 1);

  // Not complete before 00:15 Beijing on the next day; then it is.
  assert.equal(lastCompleteDay(at("2026-11-03T16:10:00Z")), "2026-11-02");
  assert.equal(lastCompleteDay(at("2026-11-03T16:20:00Z")), day);
  assert.deepEqual(await recordReaderInterest(at("2026-11-03T16:10:00Z")), { recorded: [] });
  assert.deepEqual(await recordReaderInterest(at("2026-11-03T16:25:00Z")), { recorded: [day] });

  const [stored] = await sql`SELECT item_views,classified_views,list_views FROM ops.reader_interest_days WHERE day=${day}::date`;
  assert.deepEqual({ ...stored }, { item_views: 19, classified_views: 14, list_views: 11 });
  const facets = (await sql`SELECT dimension,key,label,views FROM ops.reader_interest_facets WHERE day=${day}::date`)
    .map((r) => `${r.dimension}:${r.key}:${r.label}:${r.views}`)
    .sort();
  assert.deepEqual(facets, [
    `category:commodity_market:${CATEGORY_LABELS.commodity_market}:10`,
    `category:safety_environment:${CATEGORY_LABELS.safety_environment}:4`,
    "company:zijin:紫金矿业:10",
    "country:AR:阿根廷:10",
    "country:CL:智利:4",
    "mineral:铜:铜:10",
    "mineral:锂:锂:4",
    "page:/all:/all:5",
    "page:/topics/copper:铜:6",
  ]);
  const items = (await sql`SELECT article_id,title,category,views FROM ops.reader_interest_items WHERE day=${day}::date ORDER BY views DESC`).map((r) => [
    r.article_id,
    r.title,
    r.category,
    r.views,
  ]);
  assert.deepEqual(items, [
    [copper, "合成铜价文章", "commodity_market", 10],
    [lithium, "合成锂矿文章", "safety_environment", 4],
    [withdrawn, null, null, 3],
  ]);

  // Recorded days are skipped; recording again replaces the day instead of adding to it.
  assert.deepEqual(await interestDaysToRecord(at("2026-11-04T02:00:00Z")), []);
  assert.deepEqual(await interestDaysToRecord(at("2026-11-04T02:00:00Z"), { again: true }), [day]);
  await sql`UPDATE ops.visit_pages SET views=views+1 WHERE day=${day}::date AND path=${`/items/${copper}`}`;
  await storeInterestDay(await computeInterestDay(day));
  await storeInterestDay(await computeInterestDay(day));
  const [again] = await sql`SELECT item_views FROM ops.reader_interest_days WHERE day=${day}::date`;
  assert.equal(again!.item_views, 20);
  assert.equal(Number((await sql`SELECT count(*)::int AS n FROM ops.reader_interest_facets WHERE day=${day}::date`)[0]!.n), 9);

  // The record outlives the raw page rows, and 访问概况 reads it (complete days only, last 7 and 30).
  await sql`DELETE FROM ops.visit_pages WHERE day=${day}::date`;
  const overview = VisitOverview.parse(await visitOverview(at("2026-11-05T04:00:00Z"))).interest!;
  assert.equal(overview.since, day);
  assert.equal(overview.week.days, 1);
  assert.equal(overview.week.item_views, 20);
  assert.deepEqual(
    overview.week.mineral.map((r) => [r.key, r.views]),
    [
      ["铜", 11],
      ["锂", 4],
    ],
  );
  assert.deepEqual(overview.month.items[0], { article_id: copper, title: "合成铜价文章", category: "commodity_market", views: 11 });
  assert.equal(overview.week.page[0]!.label, "铜");
  const later = VisitOverview.parse(await visitOverview(at("2026-11-12T04:00:00Z"))).interest!;
  assert.equal(later.week.days, 0, "a day older than the last seven complete days leaves the 7-day range");
  assert.equal(later.month.days, 1);
  // Only counts: nothing about a visitor is in the record.
  const columns = (
    await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='ops' AND table_name LIKE 'reader_interest_%' ORDER BY 1`
  ).map((r) => r.column_name);
  assert.ok(!columns.some((name) => /visitor|address|agent|salt/.test(name)), columns.join(","));
});
