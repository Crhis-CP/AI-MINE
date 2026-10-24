import { stub } from "./setup.ts";
import { ensureModelSourceFixture } from "./model-source-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { closeDb, sql } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { composeStoryDigest } from "@amp/backend/events/digest";
import { buildArticlePrompt } from "../packages/backend/src/editorial/writing.ts";
import { periodPrompt } from "../packages/backend/src/reports/period-writing.ts";
import type { Candidate } from "../packages/backend/src/reports/compose.ts";

const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
const provider = await stub(async (_hit, req) => {
  requests.push(JSON.parse(req.body));
  return {
    choices: [{ message: { content: JSON.stringify({ title: "合成事件标题", digest: "只用于测试的上一版合成综述。", latest: "合成变化" }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "synthetic-test-key";
await installUsageFixtureForModel("deepseek-flash");
after(async () => {
  await provider.close();
  await closeDb();
});

test("unchanged title-summary material has the same request across Beijing midnight", (t) => {
  const input = {
    title: "Synthetic lithium project",
    text: "Synthetic project received a conditional permit on the published date.",
    sourceName: "Synthetic source",
    sourceKind: "rss" as const,
    publishedAt: new Date("2026-10-20T08:00Z"),
  };
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T15:59:59Z") });
  const before = buildArticlePrompt(input);
  t.mock.timers.setTime(Date.parse("2026-10-23T16:00:01Z"));
  assert.equal(buildArticlePrompt(input), before, "wall-clock time must not invalidate an unchanged paid answer");
  assert.match(before, /2026-10-20/);
  assert.notEqual(buildArticlePrompt({ ...input, text: "Corrected original content." }), before);
});

test("period-specific instructions do not fragment the shared report system prefix", () => {
  const entries = [1, 2, 3].map((id) => ({
    itemId: String(id),
    title: `合成事件${id}`,
    summary: `有据可查的合成摘要${id}`,
    category: "company_project",
  })) as Candidate[];
  const weekly = periodPrompt("weekly", "2026-10-12", "2026-10-18", entries);
  const monthly = periodPrompt("monthly", "2026-10-01", "2026-10-31", entries.slice(0, 1));
  assert.equal(weekly.system, monthly.system);
  assert.match(weekly.user, /周报/);
  assert.match(monthly.user, /月报/);
  assert.match(weekly.user, /2026-10-12 至 2026-10-18/);
  assert.match(monthly.user, /无；sections 返回空对象/);
  assert.ok(weekly.user.includes(entries[2]!.summary));
});

test("story updates preserve the existing report prefix, while corrections omit the old digest", async () => {
  const source = `cache-${randomUUID()}`;
  await sql`INSERT INTO sources(id,name,kind,lane) VALUES(${source},'Synthetic source','external','news')`;
  await ensureModelSourceFixture(source, ["https://example.invalid/source"]);
  const [story] =
    await sql`INSERT INTO stories(public_id,title,first_report_at,latest_at) VALUES(${randomUUID()},'Initial synthetic title',now(),now()) RETURNING id`;
  const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${randomUUID()},${story.id},'Synthetic fact') RETURNING id`;
  for (const index of [1, 2]) {
    const at = new Date(`2026-10-${20 + index}T08:00:00Z`);
    const { articleId } = await upsertMaterial({
      sourceId: source,
      title: `Synthetic article ${index}`,
      url: `https://example.invalid/${source}/${index}`,
      discoveredAt: at,
      publishedAt: at,
      via: "fetch",
    });
    await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,discovered_at,published_at,timeline_at,sort_at,visible_after,eligible)
      VALUES(${articleId},${`合成报道${index}`},${`合成事实${index}`},${source},'news',${`https://example.invalid/${source}/${index}`},${at},${at},${at},${at},${at},true)`;
    await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${fact.id},${articleId},'report',1)`;
    assert.equal((await composeStoryDigest(Number(story.id))).updated, true);
  }
  const first = requests[0]!.messages.at(-1)!.content,
    second = requests[1]!.messages.at(-1)!.content;
  const reportEnd = first.indexOf("合成事实1") + "合成事实1".length;
  assert.ok(reportEnd > "合成事实1".length);
  assert.equal(second.slice(0, reportEnd), first.slice(0, reportEnd), "changing title, previous digest and new flags must follow the shared report prefix");
  const calls = provider.hits();
  assert.equal((await composeStoryDigest(Number(story.id))).updated, false);
  assert.equal(provider.hits(), calls, "unchanged reports use the stored digest without another provider request");
  await sql`UPDATE publications SET summary='经人工更正的事实' WHERE source_id=${source}`;
  assert.equal((await composeStoryDigest(Number(story.id), { afterCorrection: true })).updated, true);
  const corrected = requests.at(-1)!.messages.at(-1)!.content;
  assert.ok(corrected.includes("经人工更正的事实"));
  assert.ok(!corrected.includes("只用于测试的上一版合成综述。"));
});
