// Same policy, many outlets, and same speech, many outlets, become one featured card.
// Heat counts each outlet once. A different project stays on its own and off the board.
import { ensureModelSourceFixture } from "./model-source-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { validateGeography } from "../packages/backend/src/editorial/geography.ts";
import { scopeOutput, scopeReceipt, scopeVersion } from "./scope-fixture.ts";
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { groupArticle } from "@amp/backend/events/group";
import { computeHotRanking } from "@amp/backend/events/hot";
import { stopBoss } from "@amp/backend/jobs/queue";
import { publishArticle } from "@amp/backend/publication/publish";
import { loadTimeline } from "@amp/backend/publication/timeline";

const sql = dbOf("events");
const T = tag();
process.env.EMBEDDINGS_ENABLED = "false";

const provider = await stub(async (_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ content: string }> };
  const user = body.messages[1]!.content;
  const pair = user.includes("报道 A");
  const quotes = [...user.matchAll(/原文证据：([\s\S]*?)\n法域：/g)].map((m) => m[1]!.split("\n").at(-1)!);
  const anchorOf = (line: string) => (line.includes("矿产资源目录") ? "矿产资源目录" : line.includes("中非矿业合作") ? "中非矿业合作" : "");
  const verb = (line: string) => (line.includes("公布") ? "公布" : line.includes("发布") ? "发布" : line.includes("提出") ? "提出" : "报道");
  const evidence = (index: number) => {
    const query = quotes[0] ?? "";
    const candidate = quotes[index] ?? "";
    const shared = anchorOf(query) && anchorOf(query) === anchorOf(candidate) ? anchorOf(query) : "";
    return {
      queryQuote: query,
      candidateQuote: candidate,
      anchor: shared || "没有共同锚点",
      queryAction: verb(query),
      candidateAction: verb(candidate),
      queryStage: "other" as const,
      candidateStage: "other" as const,
      change: "",
    };
  };
  const relation = (index: number) => (evidence(index).anchor === "没有共同锚点" ? "UNRELATED" : "SAME_OCCURRENCE");
  const answer = pair
    ? { a: "甲", b: "乙", relation: relation(1), difference: "", confidence: 0.95, evidence: evidence(1) }
    : {
        query: "归组",
        decisions: [...user.matchAll(/【候选 (C\d+)】/g)].map((m) => {
          const index = Number(m[1]!.slice(1));
          return { id: m[1], relation: relation(index), confidence: 0.95, note: "", evidence: evidence(index) };
        }),
      };
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

test("reprints of one policy and one speech fold into one featured item with stacked heat", async () => {
  const now = Date.now();
  const catalogReprint = await article({
    key: "catalog-reprint",
    name: "中国地质调查局",
    firstParty: false,
    score: 90,
    title: "自然资源部会同国家发展改革委发布《矿产资源目录》，共174个矿种、119个亚矿种",
    summary: "该目录在原分类细目基础上优化调整形成，包括174个矿种。",
    body: "中国自然资源部发布矿产资源目录共174个矿种",
    frame: { subject: "中国地质调查局", action: "发布", object: "《矿产资源目录》" },
    publishedAt: new Date(now - 50 * 60_000),
  });
  const catalogOfficial = await article({
    key: "catalog-official",
    name: "自然资源部",
    firstParty: true,
    score: 72,
    title: "自然资源部会同国家发展改革委公布优化调整后的《矿产资源目录》",
    summary: "新目录沿用能源矿产、金属矿产、非金属矿产和水气矿产四类框架，亚矿种增至119个。",
    body: "中国自然资源部公布优化调整后的矿产资源目录",
    frame: { subject: "自然资源部", action: "公布", object: "矿产资源目录" },
    publishedAt: new Date(now - 40 * 60_000),
  });
  const speechReprint = await article({
    key: "speech-reprint",
    name: "省自然资源厅",
    firstParty: false,
    score: 80,
    title: "习近平同博茨瓦纳总统博科会谈，就中非矿业合作提出4点主张",
    summary: "双方会谈中，习近平就推动中非矿业合作提出4点主张。",
    body: "中国习近平主席同博茨瓦纳总统会谈并就中非矿业合作提出4点主张",
    frame: { subject: "省自然资源厅", action: "提出", object: "中非矿业合作4点主张" },
    publishedAt: new Date(now - 30 * 60_000),
  });
  const speechOfficial = await article({
    key: "speech-official",
    name: "自然资源部地矿",
    firstParty: true,
    score: 62,
    title: "习近平就推动中非矿业合作提出4点主张",
    summary: "习近平会见博茨瓦纳总统，就中非矿业合作提出4点主张。",
    body: "中国习近平就推动中非矿业合作提出4点主张",
    frame: { subject: "习近平", action: "提出", object: "中非矿业合作4点主张" },
    publishedAt: new Date(now - 20 * 60_000),
  });
  const lone = await article({
    key: "lone-mine",
    name: "四川地勘单位",
    firstParty: true,
    score: 70,
    title: "四川加达锂矿新增氧化锂资源量42.37万吨",
    summary: "四川加达锂矿新增氧化锂资源量，圈定找矿靶区。",
    body: "中国四川加达锂矿新增氧化锂资源量42万吨",
    frame: { subject: "四川地勘单位", action: "新增", object: "加达锂矿" },
    publishedAt: new Date(now - 10 * 60_000),
  });

  assert.equal((await groupArticle(catalogReprint)).verdict, "new-story");
  assert.equal((await groupArticle(catalogOfficial)).verdict, "same-fact");
  assert.equal((await groupArticle(speechReprint)).verdict, "new-story");
  assert.equal((await groupArticle(speechOfficial)).verdict, "same-fact");
  assert.equal((await groupArticle(lone)).verdict, "new-story");

  const rows = await sql<{ article_id: string; story_id: number; title: string }[]>`
    SELECT p.article_id, p.story_id, st.title FROM publications p JOIN stories st ON st.id = p.story_id
    WHERE p.article_id IN ${sql([catalogReprint, catalogOfficial, speechReprint, speechOfficial, lone])}`;
  const storyOf = (id: string) => Number(rows.find((r) => r.article_id === id)!.story_id);
  assert.equal(storyOf(catalogReprint), storyOf(catalogOfficial));
  assert.equal(storyOf(speechReprint), storyOf(speechOfficial));
  assert.notEqual(storyOf(catalogOfficial), storyOf(speechOfficial));
  assert.notEqual(storyOf(lone), storyOf(catalogOfficial));
  assert.equal(rows.find((r) => r.article_id === catalogOfficial)!.title, "自然资源部会同国家发展改革委公布优化调整后的《矿产资源目录》");
  assert.equal(rows.find((r) => r.article_id === speechOfficial)!.title, "习近平就推动中非矿业合作提出4点主张");

  const timeline = await loadTimeline({ channel: "all", category: null, tag: null, now: new Date() });
  const ours = new Set([catalogReprint, catalogOfficial, speechReprint, speechOfficial, lone]);
  const cards = timeline.cards.filter((card) => ours.has(card.item.id));
  assert.deepEqual(cards.map((card) => card.item.id).sort(), [catalogOfficial, speechOfficial, lone].sort());
  const catalogCard = cards.find((card) => card.item.id === catalogOfficial)!;
  const speechCard = cards.find((card) => card.item.id === speechOfficial)!;
  assert.equal(catalogCard.item.title, "自然资源部会同国家发展改革委公布优化调整后的《矿产资源目录》");
  assert.equal(catalogCard.item.score, 72);
  assert.ok(catalogCard.group && catalogCard.group.additionalSourceCount >= 1 && catalogCard.group.reportCount >= 2);
  assert.equal(speechCard.item.title, "习近平就推动中非矿业合作提出4点主张");
  assert.equal(speechCard.item.score, 62);
  assert.ok(speechCard.group && speechCard.group.additionalSourceCount >= 1 && speechCard.group.reportCount >= 2);
  assert.equal(cards.find((card) => card.item.id === lone)!.group, null);

  const ranking = await computeHotRanking();
  const [stored] = await sql<{ entries: Array<{ storyId: number; heat: number; participantCount: number }> }[]>`
    SELECT entries FROM hot_rankings WHERE id = ${ranking.id}`;
  const hot = new Map(stored!.entries.map((entry) => [Number(entry.storyId), entry]));
  const catalogHot = hot.get(storyOf(catalogOfficial));
  const speechHot = hot.get(storyOf(speechOfficial));
  assert.ok(catalogHot && catalogHot.participantCount === 2 && catalogHot.heat >= 15, "两家来源的目录热度应高于单篇入选线");
  assert.ok(speechHot && speechHot.participantCount === 2 && speechHot.heat >= 15, "两家来源的讲话热度应高于单篇入选线");
  assert.equal(hot.has(storyOf(lone)), false);
});

async function article(input: {
  key: string;
  name: string;
  firstParty: boolean;
  score: number;
  title: string;
  summary: string;
  body: string;
  frame: { subject: string; action: string; object: string };
  publishedAt: Date;
}) {
  const sourceId = `fold-${T}-${input.key}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, next_fetch_at)
    VALUES (${sourceId}, ${input.name}, 'rss', 'T1', 'editorial', ${input.firstParty}, '2100-01-01')`;
  const url = `https://example.com/fold-${T}-${input.key}`;
  await ensureModelSourceFixture(sourceId, [url]);
  await installUsageFixtureForModel("deepseek-flash");
  const { articleId } = await upsertMaterial({
    sourceId,
    language: "zh",
    url,
    title: input.title,
    bodyText: input.body,
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: input.publishedAt,
  });
  const geography = validateGeography(
    {
      status: "identified",
      primary: "CN",
      assignments: [{ code: "CN", role: "event_location", mention: "中国", segment: "body_head", quote: input.body }],
      reason: "合成地理证据",
    },
    { title: input.title, bodyText: input.body, excerpt: null, bodyStatus: "ok" },
  );
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, prompt_version, receipt_ids, output)
    VALUES (${articleId}, 1, 'rule', 'pass', 'ai-models', ${input.title}, ${input.summary}, ${input.score}, true, ${scopeVersion}, ${[await scopeReceipt(articleId)]},
      ${sql.json({ ...scopeOutput, fact: { title: input.title, ...input.frame }, geography })})`;
  await publishArticle(articleId);
  return articleId;
}
