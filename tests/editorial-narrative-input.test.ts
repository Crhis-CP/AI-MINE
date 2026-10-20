import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { loadAnalyzeInput, buildMaterial } from "../packages/backend/src/editorial/input.ts";
import { periodPrompt } from "../packages/backend/src/reports/period-writing.ts";
import type { Candidate } from "../packages/backend/src/reports/compose.ts";
import { buildScoreInput } from "@amp/backend/editorial/analyze";
import { buildArticlePrompt, finalizeCopy, translateInputOf } from "../packages/backend/src/editorial/writing.ts";
import { sanitizeBody } from "@amp/backend/content/sanitize";

after(closeDb);
test("analysis excludes a standalone linked article card while preserving the original, genuine quotations and inline references", async () => {
  const html =
    '<p>Main Miner won approval. Financing remains conditional.</p><figure><blockquote><a href="https://news.invalid/another-story">Other Miner announces a separate acquisition</a></blockquote></figure><blockquote><p>The official said approval <a href="https://news.invalid/source">remains conditional</a>.</p></blockquote><figure><img src="https://news.invalid/chart.png"><figcaption>Measured capacity is 100 tonnes.</figcaption></figure><p>A <a href="https://news.invalid/context">context link</a> belongs to the actual story.</p>';
  const raw =
    "Main Miner won approval. Financing remains conditional. Other Miner announces a separate acquisition The official said approval remains conditional. Measured capacity is 100 tonnes. A context link belongs to the actual story.";
  await sql`INSERT INTO sources(id,name,kind) VALUES('narrative-fixture','Synthetic news','rss')`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,body_html,body_text,language,body_status,discovered_at,timeline_at,raw)
    VALUES('narrative-article','narrative-fixture','narrative-key','https://news.invalid/main','Main Miner approval',${html},${raw},'en','ok',now(),now(),'{}')`;
  const input = (await loadAnalyzeInput("narrative-article"))!;
  assert.doesNotMatch(input.bodyText!, /Other Miner/);
  assert.match(input.bodyText!, /official said approval/);
  assert.match(input.bodyText!, /100 tonnes/);
  assert.match(input.bodyText!, /context link/);
  for (const prompt of [buildMaterial(input), buildScoreInput(input), buildArticlePrompt(translateInputOf(input))]) assert.doesNotMatch(prompt, /Other Miner/);
  const [stored] = await sql`SELECT body_text,body_html FROM articles WHERE id='narrative-article'`;
  assert.equal(stored.body_text, raw);
  assert.equal(stored.body_html, html);
});

test("a genuine linked quotation retains its safe citation through extraction cleanup and analysis", async () => {
  const html = sanitizeBody(
    '<figure><blockquote cite="/primary-evidence"><a href="https://other.invalid/evidence">The permit remains conditional on consultation.</a></blockquote></figure><p>The application continues.</p>',
    "https://news.invalid/main",
  );
  assert.match(html, /cite="https:\/\/news\.invalid\/primary-evidence"/);
  assert.doesNotMatch(sanitizeBody('<blockquote cite="javascript:alert(1)">Evidence</blockquote>'), /javascript:/);
  await sql`INSERT INTO sources(id,name,kind) VALUES('quotation-fixture','Synthetic quoted news','rss')`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,body_html,body_text,language,body_status,discovered_at,timeline_at,raw)
    VALUES('quotation-article','quotation-fixture','quotation-key','https://news.invalid/main','Permit conditions',${html},
    'The permit remains conditional on consultation. The application continues.','en','ok',now(),now(),'{}')`;
  assert.match((await loadAnalyzeInput("quotation-article"))!.bodyText!, /conditional on consultation/);
});

test("a valid received summary retains later conditions and negations instead of silently cutting at the first sentence", () => {
  const beginning = "某矿业公司董事会披露，其负责人因一项早期矿业投资被判处监禁，并承担罚款及民事赔偿责任。";
  const background = "该判决已经过上诉审查，原文同时列明案件发生时间、审理机构及赔偿金额。".repeat(4);
  const condition = "刑罚执行已附条件暂停五年，须按月付款并于期满支付赔偿额的60%；未履行条件可能恢复执行。";
  const summary = beginning + background + condition;
  assert.ok(summary.length > 200);
  const result = finalizeCopy({ title: "矿企负责人判决", text: summary, sourceKind: "rss" }, { titleZh: "矿企披露负责人判决及执行状态", summaryZh: summary });
  assert.equal(result.summaryZh, summary);
  assert.match(result.summaryZh, /附条件暂停五年/);
  assert.match(result.summaryZh, /60%/);
  const brief = periodPrompt("weekly", "2020-01-01", "2020-01-07", [
    { itemId: "synthetic", title: "矿企执行状态", summary: result.summaryZh, category: "company_project" } as Candidate,
  ]);
  assert.ok(brief.user.includes(condition), "report composition must receive the complete qualified summary");
});
