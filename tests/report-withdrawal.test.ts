import { tag } from "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { dbOf, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { loadReport, listReports, v1Dailies } from "@amp/backend/publication/reports";
const sql = dbOf("publication");
after(closeDb);
test("withdrawn report citations invalidate all synthesized prose and directory metadata", async () => {
  const sourceId = `reports-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind) VALUES(${sourceId},'Test','rss')`;
  const m = await upsertMaterial({ sourceId, url: `https://example.com/${sourceId}`, title: "引用", via: "fetch" });
  await sql`INSERT INTO publications(article_id,title,source_id,channel,url,discovered_at,timeline_at,sort_at,eligible,visibility)
 VALUES(${m.articleId},'引用',${sourceId},'news','https://example.com',now(),now(),now(),true,'public')`;
  const c = {
    title: "撤回标题",
    lead: { title: "撤回导语", leadParagraph: "撤回综合文字" },
    overview: "撤回综述",
    themes: [{ heading: "撤回主题", summary: "撤回栏目总结", storyRefs: [{ itemId: m.articleId, title: "撤回引用", summary: "撤回内容" }] }],
  };
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at) VALUES('weekly','2026-W41',now(),now(),${sql.json(c)},now())`;
  assert.equal((await loadReport("weekly", "2026-W41"))!.overview, "撤回综述");
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${m.articleId}`;
  const report = (await loadReport("weekly", "2026-W41"))!;
  assert.equal(report.lead, null);
  assert.equal(report.overview, null);
  assert.equal(report.sections[0]!.summary, null);
  assert.ok(!JSON.stringify(report).includes("撤回综述"));
  assert.equal((await listReports("weekly"))[0]!.title, null);
  const daily = { lead: c.lead, sections: [{ label: "栏目", items: [] }], flashes: [{ itemId: m.articleId, title: "撤回引用" }] };
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at) VALUES('daily','2026-10-11',now(),now(),${sql.json(daily)},now())`;
  assert.equal((await v1Dailies(1)).items[0]!.leadParagraph, null);
});
