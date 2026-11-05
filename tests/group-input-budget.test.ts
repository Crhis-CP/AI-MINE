// The paid group_article request stays bounded: at most five candidate facts in recall order, full
// originals only for the query and the two most similar candidates, the rest by stored summary,
// fact frame and a short original excerpt.
import { confirmGroupingFixture } from "./grouping-fixture.ts";
import { ensureModelSourceFixture } from "./model-source-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { scopeVersion, scopeOutput, scopeReceipt } from "./scope-fixture.ts";
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { groupArticle } from "@amp/backend/events/group";
import { GROUP_ARTICLE_CANDIDATES, GROUP_BRIEF_EXCERPT_CHARS, lexicalSimilarity, reportText } from "@amp/backend/events/relate";
import { stopBoss } from "@amp/backend/jobs/queue";
import { publishArticle } from "@amp/backend/publication/publish";

const T = tag();
const SOURCE = `test-group-budget-${T}`;
const TITLE = `预算测试${T}项目获批建设`;
const QUERY_SUMMARY = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥";
const users: string[] = [];
const provider = await stub(async (_hit, req) => {
  const user = (JSON.parse(req.body) as { messages: Array<{ content: string }> }).messages[1]!.content;
  users.push(user);
  const ids = [...user.matchAll(/【候选 (C\d+)】/g)].map((m) => m[1]!);
  const answer = {
    query: "项目获批",
    queryScope: "single",
    selection: { addsValue: true, reason: "合成新增信息判断" },
    decisions: ids.map((id) => ({ id, relation: "UNRELATED", confidence: 0.9, note: "合成判断为不同发生" })),
  };
  return { id: "stub", choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";

let sequence = 0;
const body = (n: number) => `Andes project construction permit report ${n} ${T}. ${"Synthetic paragraph about the permit and the plant. ".repeat(120)}`;
/** Candidate k keeps the first 22-3k characters of the query summary; distinct filler keeps every summary the same size. */
const summaryOf = (k: number) =>
  `${QUERY_SUMMARY.slice(0, 22 - 3 * k)}${Array.from({ length: 3 * k }, (_, i) => String.fromCharCode(0x5c00 + k * 32 + i)).join("")}`;
async function report(summary: string) {
  const n = ++sequence;
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE,
    language: "en",
    url: `https://example.com/group-budget-${T}-${n}`,
    title: `Andes permit ${T} ${n}`,
    bodyText: body(n),
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, prompt_version, receipt_ids, output)
    VALUES (${articleId}, 1, 'rule', 'pass', 'ai-models', ${TITLE}, ${summary}, 80, false, ${scopeVersion}, ${[await scopeReceipt(articleId)]},
      ${sql.json({ ...scopeOutput, scope: "single", fact: { title: TITLE, subject: "Andes", action: "获批", object: "建设许可" } })})`;
  await publishArticle(articleId);
  return articleId;
}

const facts: number[] = [];
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Test budget', 'rss', 'T1', 'editorial', '2100-01-01')`;
  await ensureModelSourceFixture(SOURCE, ["https://example.com/source"]);
  await installUsageFixtureForModel("deepseek-flash");
  // Seven recalled facts; each shares less of the query summary than the one before it.
  for (let k = 1; k <= 7; k++) {
    const [story] = await sql<
      { id: number }[]
    >`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${TITLE}, now(), now()) RETURNING id`;
    const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title, subject, action, object)
      VALUES (${`f-${T}-${k}`}, ${story!.id}, ${TITLE}, 'Andes', '获批', '建设许可') RETURNING id`;
    const id = await report(summaryOf(k));
    await sql`INSERT INTO fact_articles (fact_id, article_id, role, input_revision) VALUES (${fact!.id}, ${id}, 'report', 1)`;
    await confirmGroupingFixture(id);
    facts.push(Number(fact!.id));
  }
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("group_article judges the five most similar candidates and sends full originals only for the query and the top two", async () => {
  const query = await report(QUERY_SUMMARY);
  const result = await groupArticle(query);
  assert.equal(result.verdict, "new-story");
  assert.equal(users.length, 1, "one grouping request, no review pairs for unrelated candidates");
  const user = users[0]!;
  assert.match(user, new RegExp(`^事实候选数：${GROUP_ARTICLE_CANDIDATES}\\n`));
  const [decision] = await sql<{ candidates: Array<{ id: number; score: number }> }[]>`
    SELECT candidates FROM grouping_decisions WHERE article_id=${query} ORDER BY id DESC LIMIT 1`;
  const judged = decision!.candidates.map((c) => Number(c.id));
  assert.equal(judged.length, GROUP_ARTICLE_CANDIDATES);
  const queryText = reportText(TITLE, QUERY_SUMMARY);
  const scoreOf = (k: number) => lexicalSimilarity(queryText, reportText(TITLE, summaryOf(k)));
  assert.ok(scoreOf(7) < scoreOf(1), "the synthetic summaries really rank the facts");
  const omitted = facts.filter((id) => !judged.includes(id));
  assert.equal(omitted.length, 2, "all seven were recalled and two were cut");
  const lowestJudged = Math.min(...decision!.candidates.map((c) => c.score));
  for (const id of omitted) assert.ok(scoreOf(facts.indexOf(id) + 1) <= lowestJudged + 0.001, "only the least similar candidates are cut");
  assert.ok(
    decision!.candidates.every((c, i, all) => i === 0 || all[i - 1]!.score >= c.score),
    "candidates keep recall-similarity order",
  );

  const blocks = user.split("\n\n");
  const block = (label: string) => blocks.find((part) => part.startsWith(`【${label}】`))!;
  assert.ok(block("新报道").includes(`原文证据：Andes permit ${T} 8\n${body(8)}`), "the query keeps its full original");
  for (const label of ["候选 C1", "候选 C2"]) {
    assert.match(block(label), /原文证据：Andes permit/);
    assert.doesNotMatch(block(label), /节选/);
  }
  for (const label of ["候选 C3", "候选 C4", "候选 C5"]) {
    assert.ok(block(label).includes(`原文证据（节选前${GROUP_BRIEF_EXCERPT_CHARS}字`), `${label} is described by its stored summary`);
    assert.match(block(label), /摘要：甲乙/);
    assert.match(block(label), /事实要素：主体=Andes；动作=获批/);
  }
  assert.ok(user.length < body(1).length * 4, "three full originals plus brief candidates, not six full originals");
});
