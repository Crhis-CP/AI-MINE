import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { computeHotRanking } from "@amp/backend/events/hot";
import { stopBoss } from "@amp/backend/jobs/queue";
import { SearchSuggestions } from "@amp/contracts/http/public";
import { buildApp } from "./site-app.ts";
import { confirmGroupingFixture } from "./grouping-fixture.ts";

const app = await buildApp("public-api");
after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});
test("search navigation returns only catalogue links and currently qualified hot events, with no processing writes", async () => {
  const now = new Date(),
    at = new Date(now.getTime() - 3600000);
  await sql`INSERT INTO topics(slug,name,grp,tags,definition,position) VALUES('synthetic-copper','合成铜矿','company','{}','不应进入搜索导航的长介绍',1)`;
  const empty = await app.inject({ method: "GET", url: "/api/site/search/suggestions" });
  assert.equal(empty.statusCode, 200, empty.body);
  const initial = SearchSuggestions.parse(empty.json());
  assert.deepEqual(
    initial.topics.find((topic) => topic.slug === "synthetic-copper"),
    { slug: "synthetic-copper", name: "合成铜矿", group: "company" },
  );
  assert.deepEqual(initial.hot, []);
  const publicId = randomUUID();
  const [story] = await sql`INSERT INTO stories(public_id,title,first_report_at,latest_at) VALUES(${publicId},'合成矿山扩建',${at},${at}) RETURNING id`;
  const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${randomUUID()},${story!.id},'合成扩建获批') RETURNING id`;
  const articleIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const source = randomUUID(),
      url = `https://example.invalid/${source}`;
    await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,created_at,last_ok_at) VALUES(${source},${`合成来源${i}`},'rss','T2','editorial','2020-01-01',${now})`;
    const { articleId } = await upsertMaterial({
      sourceId: source,
      url,
      title: "合成扩建公告",
      bodyText: "不得在导航传输的完整合成材料",
      language: "zh",
      publishedAt: at,
      discoveredAt: at,
      via: "fetch",
    });
    articleIds.push(articleId);
    await confirmGroupingFixture(articleId);
    await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${fact!.id},${articleId},'report',1)`;
    await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,discovered_at,published_at,timeline_at,sort_at,visible_after,selected,eligible,fact_id,story_id)
      VALUES(${articleId},'合成扩建获批','不应进入导航的摘要',${source},'news',${url},${at},${at},${at},${at},${at},false,true,${fact!.id},${story!.id})`;
    await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at) VALUES(${story!.id},${articleId},${`source:${source}`},${source},'editorial',${at})`;
  }
  await computeHotRanking(now);
  const readState = () =>
    sql`SELECT (SELECT count(*)::int FROM receipts) AS receipts,(SELECT count(*)::int FROM analyses) AS analyses,(SELECT count(*)::int FROM articles) AS materials`;
  const before = await readState();
  const response = await app.inject({ method: "GET", url: "/api/site/search/suggestions" });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(SearchSuggestions.parse(response.json()).hot[0]!.to, `/story/${publicId}`);
  assert.doesNotMatch(response.body, /完整合成材料|长介绍|不应进入导航的摘要|receipt|sourceIds/);
  assert.deepEqual(await readState(), before);
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${articleIds[0]!}`;
  const changed = await app.inject({ method: "GET", url: "/api/site/search/suggestions", headers: { "if-none-match": String(response.headers.etag) } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.deepEqual(SearchSuggestions.parse(changed.json()).hot, []);
});
