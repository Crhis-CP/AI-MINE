import { confirmGroupingFixture } from "./grouping-fixture.ts";
import { tag } from "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { groupArticle, GroupingSupersededError } from "@amp/backend/events/group";
import { stopBoss } from "@amp/backend/jobs/queue";

after(async () => {
  await stopBoss();
  await closeDb();
});
test("source revision invalidates automatic membership while preserving manual membership", async () => {
  const sourceId = `regroup-${tag()}`,
    url = `https://example.com/${sourceId}`;
  await sql`INSERT INTO sources(id,name,kind,participation_mode) VALUES(${sourceId},'Test','rss','editorial')`;
  const m = await upsertMaterial({
    sourceId,
    url,
    title: "甲项目新闻",
    bodyText: "甲项目获得建设批准，当前材料为合成测试。",
    language: "zh",
    via: "fetch",
    publishedAt: new Date(),
  });
  const [story] = await sql`INSERT INTO stories(public_id,title) VALUES(${randomUUID()},'旧事件') RETURNING id`;
  const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${tag()},${story!.id},'旧事实') RETURNING id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${fact!.id},${m.articleId},'report',1)`;
  await confirmGroupingFixture(m.articleId);
  await upsertMaterial({
    sourceId,
    url,
    title: "乙项目更正",
    bodyText: "更正为乙项目申请阶段，尚未批准建设。",
    language: "zh",
    via: "fetch",
    publishedAt: new Date(),
  });
  await assert.rejects(groupArticle(m.articleId), GroupingSupersededError);
  const [waiting] = await sql`SELECT grouping_status FROM articles WHERE id=${m.articleId}`;
  assert.equal(waiting!.grouping_status, "pending", "a revised material cannot confirm grouping before its new analysis");
  assert.equal((await sql`SELECT * FROM fact_articles WHERE article_id=${m.articleId}`).length, 0);
  await sql`INSERT INTO fact_articles(fact_id,article_id,role,manual,input_revision) VALUES(${fact!.id},${m.articleId},'report',true,1)`;
  assert.equal((await groupArticle(m.articleId)).verdict, "manual");
  assert.equal((await sql`SELECT * FROM fact_articles WHERE article_id=${m.articleId}`).length, 1);
});
