import { tag, stub } from "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbOf, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { groupArticle } from "@amp/backend/events/group";
import { publishArticle } from "@amp/backend/publication/publish";
import { stopBoss } from "@amp/backend/jobs/queue";
import { grantDateFixture } from "./source-date-fixture.ts";
import { scopeVersion, scopeOutput, scopeReceipt } from "./scope-fixture.ts";
const sql = dbOf("events");
const provider = await stub(() => ({ error: "identical URL should not need a model" }));
process.env.DEEPSEEK_API_KEY = "synthetic-test";
process.env.DEEPSEEK_BASE_URL = provider.url;
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});
test("two source entrances to the same current document reuse its fact without a paid judgement", async () => {
  const prefix = tag();
  const url = `https://example.com/news/${prefix}`;
  const ids: string[] = [];
  for (const suffix of ["rss", "list", "json"]) {
    const sourceId = `same-url-${prefix}-${suffix}`;
    await sql`INSERT INTO sources(id,name,kind,tier,site_fulltext) VALUES(${sourceId},'合成来源','rss','T1',true)`;
    await grantDateFixture(sourceId, [url]);
    const material = await upsertMaterial({
      sourceId,
      url,
      title: "甲矿业铜矿建设取得批准",
      bodyText: "甲矿业铜矿建设取得批准，正式公告列明了建设范围与要求。",
      language: "zh",
      via: "fetch",
      publishedAt: new Date(Date.now() - 60000),
    });
    ids.push(material.articleId);
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,prompt_version,receipt_ids,output)
      VALUES(${material.articleId},1,'rule','pass','company_project','甲矿业铜矿建设取得批准','正式公告列明了建设范围与要求。',${scopeVersion},${[await scopeReceipt(material.articleId)]},${sql.json({ ...scopeOutput, scope: "single" })})`;
    await publishArticle(material.articleId);
  }
  assert.notEqual(ids[0], ids[1]);
  const [story] = await sql`INSERT INTO stories(public_id,title) VALUES(${randomUUID()},'甲矿业铜矿获批') RETURNING id`;
  const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${tag()},${story!.id},'铜矿获批') RETURNING id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${fact!.id},${ids[0]!},'report',1)`;
  const result = await groupArticle(ids[1]!);
  assert.equal(result.verdict, "same-url");
  assert.equal(result.factId, Number(fact!.id));
  assert.equal(provider.hits(), 0);
  await sql`UPDATE fact_articles SET input_revision=NULL,created_at=now()-interval '1 day' WHERE article_id=${ids[0]!}`;
  const third = await groupArticle(ids[2]!);
  assert.equal(third.verdict, "same-url", "an older unproven membership must not hide the current matching source");
  assert.equal(third.factId, Number(fact!.id));
  assert.equal(provider.hits(), 0);
});
