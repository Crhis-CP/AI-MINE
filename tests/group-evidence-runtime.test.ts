import { confirmGroupingFixture } from "./grouping-fixture.ts";
import { tag, stub } from "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbOf, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { completeMaterialGrouping } from "../packages/backend/src/content/grouping.ts";
import { groupArticle } from "@amp/backend/events/group";
import { publishArticle } from "@amp/backend/publication/publish";
import { stopBoss } from "@amp/backend/jobs/queue";
import { grantDateFixture } from "./source-date-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { scopeVersion, scopeOutput, scopeReceipt } from "./scope-fixture.ts";
const sql = dbOf("events"),
  quote = "甲矿业项目获得批准，将启动锂矿建设。正式来源发布明确建设范围。";
let beforeAnswer: (() => Promise<void>) | null = null;
const provider = await stub(async () => {
  await beforeAnswer?.();
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            query: "同一项目批准",
            selection: { addsValue: true, reason: "合成新增信息判断" },
            queryScope: "single",
            decisions: [
              {
                id: "C1",
                relation: "SAME_OCCURRENCE",
                confidence: 0.95,
                note: "有双方原文依据",
                evidence: {
                  queryQuote: quote,
                  candidateQuote: quote,
                  anchor: "甲矿业项目",
                  queryAction: "批准",
                  candidateAction: "批准",
                  queryStage: "approved",
                  candidateStage: "approved",
                  change: "",
                },
              },
            ],
          }),
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 100 },
  };
});
process.env.DEEPSEEK_BASE_URL = provider.url;
process.env.DEEPSEEK_API_KEY = "synthetic-test";
process.env.GROUP_REVIEW_MODEL = "deepseek-flash";
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});
test("current source evidence permits a genuine same-occurrence runtime join", async () => {
  const sourceId = `group-proof-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,tier,site_fulltext) VALUES(${sourceId},'合成来源','rss','T1',true)`;
  await grantDateFixture(sourceId, ["https://example.com/source"]);
  await installUsageFixtureForModel("deepseek-flash");
  const report = async (suffix: string) => {
    const m = await upsertMaterial({
      sourceId,
      url: `https://example.com/${sourceId}/${suffix}`,
      title: "甲矿业项目建设获得批准",
      bodyText: quote,
      bodyHtml: `<p>${quote}</p>`,
      language: "zh",
      publishedAt: new Date(Date.now() - 60000),
      via: "fetch",
    });
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,prompt_version,receipt_ids,output)
    VALUES(${m.articleId},1,'rule','pass','company_project','甲矿业项目建设获得批准',${quote},${scopeVersion},${[await scopeReceipt(m.articleId)]},${sql.json({ ...scopeOutput, scope: "single", fact: { title: "甲项目批准", subject: "甲矿业", object: "甲项目", action: "批准" } })})`;
    await publishArticle(m.articleId);
    await sql`UPDATE publication.news_geography SET primary_jurisdiction='CN',jurisdictions=ARRAY['CN'],state='identified' WHERE article_id=${m.articleId}`;
    return m.articleId;
  };
  const first = await report("a"),
    second = await report("b");
  const [story] = await sql`INSERT INTO stories(public_id,title) VALUES(${randomUUID()},'项目批准') RETURNING id`;
  const [fact] =
    await sql`INSERT INTO facts(public_id,story_id,title,subject,object,action) VALUES(${tag()},${story!.id},'甲项目批准','甲矿业','甲项目','批准') RETURNING id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${fact!.id},${first},'report',1)`;
  await confirmGroupingFixture(first);
  const result = await groupArticle(second);
  assert.equal(result.verdict, "same-fact");
  assert.equal(result.factId, Number(fact!.id));
  assert.equal(provider.hits(), 1);
  // A selected background can be withdrawn or revised while the provider is answering.
  // Its old public projection must never be accepted as evidence of what readers have seen.
  await completeMaterialGrouping(first, 1, { addsValue: true, reason: "合成已公开精选" }, null);
  await sql`UPDATE publications SET fact_id=${fact!.id},selected=true,eligible=true,visible_after=now()-interval '1 minute' WHERE article_id=${first}`;
  const racing = await report("changed-reading-background");
  beforeAnswer = async () => {
    await sql`UPDATE publications SET revision=revision+1,visibility='withdrawn' WHERE article_id=${first}`;
  };
  await assert.rejects(groupArticle(racing), /精选背景|输入|input|fallback/i);
  beforeAnswer = null;
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id=${racing}`).length, 0, "stale reading context does not write a membership");

  // Isolate the new-fact insertion path after proving the valid same-occurrence join.
  await sql`DELETE FROM fact_articles WHERE article_id IN (${first},${second})`;
  const malformed = await report("malformed-frame");
  await sql`UPDATE analyses SET output=jsonb_set(output,'{fact,subject}','{"unexpected":"object"}'::jsonb) WHERE article_id=${malformed}`;
  const created = await groupArticle(malformed);
  assert.equal(created.verdict, "new-story");
  assert.ok(created.factId);
  const [stored] = await sql`SELECT subject,action,object FROM facts WHERE id=${created.factId!}`;
  assert.deepEqual({ ...stored }, { subject: null, action: null, object: null }, "malformed model frames cannot become SQL text values");
});
