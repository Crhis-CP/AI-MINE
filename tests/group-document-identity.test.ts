// A named document keeps one identity however late and however often it is reposted: a repost weeks
// later meets the original fact through the document key, a late-discovered repost attaches to it
// without heat or a pick and never founds an event, and a local implementing measure with a similar
// name stays apart. Recent facts left with one report get a bounded pairwise re-merge, and near-identical
// story roots of one day merge without the second review call.
import { ensureModelSourceFixture } from "./model-source-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { scopeOutput, scopeReceipt, scopeVersion } from "./scope-fixture.ts";
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { consolidate, groupArticle, remergeSingleReportFacts } from "@amp/backend/events/group";
import { stopBoss } from "@amp/backend/jobs/queue";
import { publishArticle } from "@amp/backend/publication/publish";

const T = tag();
process.env.EMBEDDINGS_ENABLED = "false";

/** content: the document rules below; apart: every pair unrelated; same: every pair the same occurrence. */
let mode: "content" | "apart" | "same" = "content";
const LAW = "生态环境法典";

function relationOf(query: string, candidate: string): { relation: string; confidence: number } {
  if (mode === "apart") return { relation: "UNRELATED", confidence: 0.95 };
  if (mode === "same") return { relation: "SAME_OCCURRENCE", confidence: 0.95 };
  if (query.includes("实施办法") || candidate.includes("实施办法")) return { relation: "UNRELATED", confidence: 0.9 };
  if (query.includes(LAW) && candidate.includes(LAW))
    // Entry into force is a development; a repost is the adoption itself, answered below the old 0.8 bar.
    return query.includes("施行") || candidate.includes("施行")
      ? { relation: "SAME_STORY", confidence: 0.9 }
      : { relation: "SAME_OCCURRENCE", confidence: 0.75 };
  return { relation: "UNRELATED", confidence: 0.9 };
}

const provider = await stub(async (_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ content: string }> };
  const user = body.messages[1]!.content;
  const pair = user.includes("【报道 A】");
  let answer: unknown;
  if (pair) {
    const [, a = "", b = ""] = user.split(/【报道 [AB]】/);
    // No evidence object: omitting quotes does not weaken the relation.
    answer = { a: "甲", b: "乙", difference: "", ...relationOf(a, b) };
  } else {
    const blocks = user.split(/【候选 (C\d+)】/);
    const query = blocks[0] ?? "";
    const decisions = [];
    for (let i = 1; i < blocks.length; i += 2) decisions.push({ id: blocks[i], note: "", ...relationOf(query, blocks[i + 1] ?? "") });
    answer = { query: "文书", queryScope: "single", decisions, selection: { addsValue: true, reason: "合成阅读价值判断" } };
  }
  return { id: "stub", choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.GROUP_REVIEW_MODEL = "deepseek-flash";

after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

const DAY = 86400_000;
let sequence = 0;
async function article(input: { name: string; title: string; summary: string; publishedAt: Date; discoveredAt?: Date; selected?: boolean }) {
  const key = `${++sequence}`;
  const sourceId = `doc-${T}-${key}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, next_fetch_at)
    VALUES (${sourceId}, ${input.name}, 'rss', 'T2', 'editorial', false, '2100-01-01')`;
  const url = `https://example.com/doc-${T}-${key}`;
  await ensureModelSourceFixture(sourceId, [url]);
  await installUsageFixtureForModel("deepseek-flash");
  const { articleId } = await upsertMaterial({
    sourceId,
    language: "zh",
    url,
    title: input.title,
    bodyText: `${input.title}。${input.summary}`,
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: input.publishedAt,
    ...(input.discoveredAt ? { discoveredAt: input.discoveredAt } : {}),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, prompt_version, receipt_ids, output)
    VALUES (${articleId}, 1, 'rule', 'pass', 'policy', ${input.title}, ${input.summary}, 70, ${input.selected ?? true}, ${scopeVersion}, ${[await scopeReceipt(articleId)]},
      ${sql.json({ ...scopeOutput, scope: "single", fact: { title: input.title, subject: input.name, action: "发布", object: input.title } })})`;
  await publishArticle(articleId);
  return articleId;
}

const factOf = async (id: string) =>
  (await sql<{ fact_id: number; role: string }[]>`SELECT fact_id, role FROM fact_articles WHERE article_id = ${id} AND role IN ('primary','report')`).map(
    (row) => Number(row.fact_id),
  );
const randomText = () => Array.from({ length: 12 }, () => String.fromCharCode(0x4e00 + Math.floor(Math.random() * 20000))).join("");

let lawFact = 0;

test("a repost of a law weeks later attaches to the original fact, and a late-discovered repost joins without heat or a pick", async () => {
  const adopted = new Date(Date.now() - 40 * DAY);
  const original = await article({
    name: "全国人大网",
    title: `全国人大常委会表决通过《中华人民共和国${LAW}》`,
    summary: "法典共十编，自公布之日起向社会公开全文。",
    publishedAt: adopted,
    discoveredAt: new Date(adopted.getTime() + 600_000),
  });
  const founded = await groupArticle(original);
  assert.equal(founded.verdict, "new-story");
  lawFact = founded.factId!;

  // Outside the 14-day similarity window: only the document key brings the original fact back.
  const repost = await article({
    name: "河南省水利厅",
    title: `河南省水利厅转载《${LAW}》全文`,
    summary: "转载全文，供干部职工学习。",
    publishedAt: new Date(),
  });
  const joined = await groupArticle(repost);
  assert.equal(joined.verdict, "same-fact", "a 0.75 same-occurrence answer joins once the review agrees");
  assert.equal(joined.factId, lawFact);

  const [storyBefore] = await sql<{ latest_at: Date }[]>`SELECT latest_at FROM stories WHERE id = ${founded.storyId!}`;
  const hits = provider.hits();
  const late = await article({
    name: "某省司法厅",
    title: `普法宣传：《中华人民共和国${LAW}》（全文）`,
    summary: "学习宣传法典全文。",
    publishedAt: new Date(Date.now() - 20 * DAY),
    selected: false,
  });
  const attached = await groupArticle(late);
  assert.equal(attached.verdict, "historical-attached");
  assert.equal(attached.factId, lawFact);
  assert.ok(provider.hits() > hits, "the attachment was judged by the model");
  assert.deepEqual(await factOf(late), [lawFact]);
  assert.equal((await sql`SELECT 1 FROM story_signals WHERE article_id = ${late}`).length, 0, "history adds no heat");
  const [storyAfter] = await sql<{ latest_at: Date }[]>`SELECT latest_at FROM stories WHERE id = ${founded.storyId!}`;
  assert.equal(storyAfter!.latest_at.getTime(), storyBefore!.latest_at.getTime(), "history does not move the story's time");
  const [state] = await sql<{ selection_adds_value: boolean }[]>`SELECT selection_adds_value FROM articles WHERE id = ${late}`;
  assert.equal(state!.selection_adds_value, false, "an attached archive is never a new pick");
  const [pub] = await sql<
    { selected: boolean; backfill: boolean; fact_id: number | null }[]
  >`SELECT selected, backfill, fact_id FROM publications WHERE article_id = ${late}`;
  assert.deepEqual({ ...pub, fact_id: Number(pub!.fact_id) }, { selected: false, backfill: true, fact_id: lawFact }, "a backfill stays out of report windows");
  const [decision] = await sql<
    { verdict: string; fact_id: number }[]
  >`SELECT verdict, fact_id FROM grouping_decisions WHERE article_id = ${late} ORDER BY id DESC LIMIT 1`;
  assert.equal(decision!.verdict, "historical-attached");
});

test("a local implementing measure with a similar name and a later development never attach, and history never founds a fact", async () => {
  assert.ok(lawFact, "runs after the repost test");
  const hits = provider.hits();
  const measure = await article({
    name: "河南省人民政府",
    title: `河南省人民政府印发《河南省${LAW}实施办法》`,
    summary: "本省结合实际制定实施办法。",
    publishedAt: new Date(Date.now() - 10 * DAY),
    selected: false,
  });
  const archived = await groupArticle(measure);
  assert.equal(archived.verdict, "historical");
  assert.equal(provider.hits(), hits, "its own document key recalls nothing and nothing is near-identical: no model call");
  assert.deepEqual(await factOf(measure), []);

  const liveMeasure = await article({
    name: "河南省生态环境厅",
    title: `河南省生态环境厅解读《河南省${LAW}实施办法》`,
    summary: "解读本省实施办法的裁量基准。",
    publishedAt: new Date(),
  });
  const own = await groupArticle(liveMeasure);
  assert.equal(own.verdict, "new-story");
  assert.notEqual(own.factId, lawFact);

  const development = await article({
    name: "某市生态环境局",
    title: `《${LAW}》将于2027年1月1日起施行`,
    summary: "法典明年起施行。",
    publishedAt: new Date(Date.now() - 5 * DAY),
    selected: false,
  });
  const kept = await groupArticle(development);
  assert.equal(kept.verdict, "historical", "a development of the law is no repost: history founds nothing");
  assert.deepEqual(await factOf(development), []);
  assert.equal((await sql`SELECT 1 FROM story_signals WHERE article_id = ${development}`).length, 0);

  const unknown = await article({
    name: "某县自然资源局",
    title: `转发《矿业权出让收益征收办法${randomText()}》全文`,
    summary: "转发全文。",
    publishedAt: new Date(Date.now() - 9 * DAY),
    selected: false,
  });
  assert.equal((await groupArticle(unknown)).verdict, "historical");
  assert.deepEqual(await factOf(unknown), [], "a document no fact carries yet is archived, not founded");
});

test("the re-merge pass joins two single-report facts of one occurrence and respects its call bound", async () => {
  const at = new Date(Date.now() - 3600_000);
  const pair = async () => {
    const title = `某矿业公司宣布${randomText()}铜矿投产`;
    const summary = `${randomText()}，年产铜精矿五万吨。`;
    // Titles differ a little, so the duplicate rule does not apply and the judge is asked.
    return [
      await article({ name: "甲媒体", title, summary, publishedAt: at }),
      await article({ name: "乙媒体", title: `${title}，年产五万吨`, summary, publishedAt: at }),
    ] as const;
  };
  mode = "apart";
  const [y1, y2] = await pair();
  const [z1, z2] = await pair();
  for (const id of [y1, y2, z1, z2]) assert.equal((await groupArticle(id)).verdict, "new-story", "the live judgement kept them apart");
  const ours = new Set([y1, y2, z1, z2]);

  mode = "same";
  const first = await remergeSingleReportFacts({ maxCalls: 1 });
  assert.equal(first.calls, 1);
  assert.equal(first.stopped, "call-limit");
  assert.equal(first.merged.filter((m) => ours.has(m.articleId)).length, 1);
  const second = await remergeSingleReportFacts();
  assert.equal(second.merged.filter((m) => ours.has(m.articleId)).length, 1, "the other pair merges on the next run");
  assert.ok(second.calls <= 1, "the merged pair is not judged again");

  for (const [early, later] of [
    [y1, y2],
    [z1, z2],
  ] as const) {
    const [earlyFact] = await factOf(early);
    assert.deepEqual(await factOf(later), [earlyFact], "the later single report moved into the earlier fact");
    const rows = await sql<{ story_id: number }[]>`SELECT story_id FROM publications WHERE article_id IN ${sql([early, later])}`;
    assert.equal(new Set(rows.map((r) => Number(r.story_id))).size, 1);
    const [decision] = await sql<{ verdict: string }[]>`SELECT verdict FROM grouping_decisions WHERE article_id = ${later} ORDER BY id DESC LIMIT 1`;
    assert.equal(decision!.verdict, "remerge");
    const [signal] = await sql<{ story_id: number }[]>`SELECT story_id FROM story_signals WHERE article_id = ${later}`;
    assert.equal(Number(signal!.story_id), Number(rows[0]!.story_id), "the heat evidence moved with the report");
  }
  const third = await remergeSingleReportFacts();
  assert.equal(third.merged.filter((m) => ours.has(m.articleId)).length, 0);
  assert.equal(third.calls, 0, "nothing left to pay for");
  mode = "content";
});

test("same-day copies with one title merge by rule in the re-merge pass, with no model call", async () => {
  const at = new Date(Date.now() - 3600_000);
  const title = `某矿业公司宣布${randomText()}锂矿投产`;
  const summary = `${randomText()}，年产碳酸锂两万吨。`;
  mode = "apart";
  const a1 = await article({ name: "丙媒体", title, summary, publishedAt: at });
  const a2 = await article({ name: "丁媒体", title, summary, publishedAt: at });
  for (const id of [a1, a2]) assert.equal((await groupArticle(id)).verdict, "new-story");
  const result = await remergeSingleReportFacts({ maxCalls: 0 });
  assert.ok(
    result.merged.some((m) => m.articleId === a2),
    "merged although no call was allowed",
  );
  assert.equal(result.calls, 0);
  assert.ok((result.ruled ?? 0) >= 1);
  const [decision] = await sql<{ verdict: string; receipt_id: number | null; input_manifest: { remerge?: { rule?: string } } }[]>`
    SELECT verdict, receipt_id, input_manifest FROM grouping_decisions WHERE article_id = ${a2} ORDER BY id DESC LIMIT 1`;
  assert.equal(decision!.verdict, "remerge");
  assert.equal(decision!.receipt_id, null);
  assert.equal(decision!.input_manifest.remerge?.rule, "certain-duplicate");
  mode = "content";
});

test("near-identical story roots of one Beijing day merge without the second review call", async () => {
  const at = new Date(Date.now() - 1800_000);
  const title = `某公司${randomText()}锂矿项目获批`;
  const summary = `${randomText()}，获批年产能二万吨。`;
  mode = "apart";
  const x1 = await article({ name: "丙媒体", title, summary, publishedAt: at });
  const x2 = await article({ name: "丁媒体", title, summary, publishedAt: at });
  const s1 = (await groupArticle(x1)).storyId!;
  const s2 = (await groupArticle(x2)).storyId!;
  assert.notEqual(s1, s2);
  mode = "same";
  const hits = provider.hits();
  const [result] = await consolidate([s1, s2]);
  assert.equal(result!.merge, true);
  assert.equal(result!.second, null, "no review call");
  assert.equal(provider.hits(), hits + 1, "one judgement, no second call");
  const [merged] = await sql<{ merged_into: number | null }[]>`SELECT merged_into FROM stories WHERE id = ${Math.max(s1, s2)}`;
  assert.equal(Number(merged!.merged_into), Math.min(s1, s2));
  mode = "content";
});
