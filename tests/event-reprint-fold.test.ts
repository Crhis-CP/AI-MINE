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
import { loadHotStrip } from "@amp/backend/events/hot-read";
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
  const anchorOf = (line: string) =>
    line.includes("矿产资源目录")
      ? "矿产资源目录"
      : line.includes("中非矿业合作")
        ? "中非矿业合作"
        : line.includes("某铜矿")
          ? "某铜矿"
          : line.includes("加达锂矿")
            ? "加达锂矿"
            : line.includes("试验文书甲")
              ? "试验文书甲"
              : "";
  const verb = (line: string) =>
    line.includes("公布") ? "公布" : line.includes("发布") ? "发布" : line.includes("印发") ? "印发" : line.includes("提出") ? "提出" : "报道";
  const stageOf = (line: string) =>
    line.includes("拟议") ? "proposed" : line.includes("批准") ? "approved" : line.includes("停产") ? "stopped" : line.includes("复产") ? "resumed" : "other";
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
      queryStage: stageOf(query),
      candidateStage: stageOf(candidate),
      change: "",
    };
  };
  const relation = (index: number) => {
    const proof = evidence(index);
    if (proof.anchor === "没有共同锚点") return "UNRELATED";
    return proof.queryStage !== proof.candidateStage ? "SAME_STORY" : "SAME_OCCURRENCE";
  };
  const answer = pair
    ? { a: "甲", b: "乙", relation: relation(1), difference: "", confidence: relation(1) === "SAME_STORY" ? 0.95 : 0.7, evidence: evidence(1) }
    : {
        query: "归组",
        selection: { addsValue: true, reason: "合成阅读价值判断" },
        queryScope: "single",
        decisions: [...user.matchAll(/【候选 (C\d+)】/g)].map((m) => {
          const index = Number(m[1]!.slice(1));
          return { id: m[1], relation: relation(index), confidence: relation(index) === "SAME_STORY" ? 0.95 : 0.7, note: "", evidence: evidence(index) };
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
    country: false,
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
    country: false,
    score: 72,
    title: "自然资源部会同国家发展改革委公布优化调整后的《矿产资源目录》",
    summary: "新目录沿用能源矿产、金属矿产、非金属矿产和水气矿产四类框架，亚矿种增至119个。",
    body: "中国自然资源部公布优化调整后的矿产资源目录",
    frame: { subject: "自然资源部", action: "公布", object: "矿产资源分类目录" },
    publishedAt: new Date(now - 40 * 60_000),
  });
  const speechReprint = await article({
    key: "speech-reprint",
    name: "省自然资源厅",
    firstParty: false,
    country: false,
    selected: false,
    score: 40,
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
    country: true,
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
    country: false,
    score: 70,
    title: "四川加达锂矿新增氧化锂资源量42.37万吨",
    summary: "四川加达锂矿新增氧化锂资源量，圈定找矿靶区。",
    body: "中国四川加达锂矿新增氧化锂资源量42万吨",
    frame: { subject: "四川地勘单位", action: "新增", object: "加达锂矿" },
    publishedAt: new Date(now - 10 * 60_000),
  });
  const places = await sql<{ article_id: string; primary_jurisdiction: string | null }[]>`
    SELECT article_id, primary_jurisdiction FROM publication.news_geography
    WHERE article_id IN ${sql([catalogReprint, catalogOfficial, speechReprint, speechOfficial, lone])}`;
  const place = (id: string) => places.find((row) => row.article_id === id)?.primary_jurisdiction ?? null;
  assert.equal(place(catalogReprint), null);
  assert.equal(place(catalogOfficial), null);
  assert.equal(place(speechReprint), null);
  assert.equal(place(speechOfficial), "CN");
  assert.equal(place(lone), null);

  const catalogProvince = await article({
    key: "catalog-province",
    name: "安徽省自然资源厅",
    firstParty: true,
    country: "CN-AH",
    mention: "安徽",
    score: 61,
    title: "安徽印发矿产资源目录转发通知",
    summary: "安徽省转发优化调整后的矿产资源目录。",
    body: "安徽省自然资源厅印发矿产资源目录通知",
    frame: { subject: "安徽省自然资源厅", action: "印发", object: "矿产资源目录" },
    publishedAt: new Date(now - 35 * 60_000),
  });
  const speechProvince = await article({
    key: "speech-province",
    name: "福建省自然资源厅",
    firstParty: false,
    country: "CN-FJ",
    mention: "福建",
    selected: false,
    score: 36,
    title: "福建转述中非矿业合作4点主张",
    summary: "福建省转述中非矿业合作的4点主张。",
    body: "福建省自然资源厅转述中非矿业合作提出4点主张",
    frame: { subject: "福建省自然资源厅", action: "提出", object: "中非矿业合作4点主张" },
    publishedAt: new Date(now - 15 * 60_000),
  });
  const speechChile = await article({
    key: "speech-chile",
    name: "智利矿政简报",
    firstParty: false,
    country: "CL",
    mention: "智利",
    score: 70,
    title: "智利媒体编译中非矿业合作4点主张",
    summary: "智利媒体编译了中非矿业合作的4点主张。",
    body: "智利媒体编译中非矿业合作提出4点主张",
    frame: { subject: "智利矿政简报", action: "提出", object: "中非矿业合作4点主张" },
    publishedAt: new Date(now - 12 * 60_000),
  });
  const copperProposed = await article({
    key: "copper-proposed",
    name: "西部矿业公司",
    firstParty: true,
    country: "CN",
    score: 66,
    title: "西部矿业拟议开发某铜矿",
    summary: "某铜矿仍在拟议阶段。",
    body: "中国西部矿业拟议开发某铜矿",
    frame: { subject: "西部矿业公司", action: "拟议", object: "某铜矿" },
    publishedAt: new Date(now - 8 * 60_000),
  });
  const copperApproved = await article({
    key: "copper-approved",
    name: "西部矿业公司",
    firstParty: true,
    country: "CN",
    score: 80,
    title: "西部矿业某铜矿获得批准",
    summary: "某铜矿已获批准。",
    body: "中国西部矿业某铜矿获得批准",
    frame: { subject: "西部矿业公司", action: "批准", object: "某铜矿" },
    publishedAt: new Date(now - 6 * 60_000),
  });

  assert.equal((await groupArticle(catalogReprint)).verdict, "new-story");
  assert.equal((await groupArticle(catalogOfficial)).verdict, "same-fact");
  assert.equal((await groupArticle(catalogProvince)).verdict, "same-fact");
  assert.equal((await groupArticle(speechReprint)).verdict, "new-story");
  assert.equal((await groupArticle(speechOfficial)).verdict, "same-fact");
  assert.equal((await groupArticle(speechProvince)).verdict, "same-fact");
  assert.equal((await groupArticle(speechChile)).verdict, "same-fact");
  assert.equal((await groupArticle(lone)).verdict, "new-story");
  assert.equal((await groupArticle(copperProposed)).verdict, "new-story");
  assert.equal((await groupArticle(copperApproved)).verdict, "new-fact-in-story");

  const tracked = [
    catalogReprint,
    catalogOfficial,
    catalogProvince,
    speechReprint,
    speechOfficial,
    speechProvince,
    speechChile,
    lone,
    copperProposed,
    copperApproved,
  ];
  const rows = await sql<{ article_id: string; story_id: number; fact_id: number; title: string }[]>`
    SELECT p.article_id, p.story_id, p.fact_id, st.title FROM publications p JOIN stories st ON st.id = p.story_id
    WHERE p.article_id IN ${sql(tracked)}`;
  const storyOf = (id: string) => Number(rows.find((r) => r.article_id === id)!.story_id);
  assert.equal(storyOf(catalogReprint), storyOf(catalogOfficial));
  assert.equal(storyOf(speechReprint), storyOf(speechOfficial));
  assert.notEqual(storyOf(catalogOfficial), storyOf(speechOfficial));
  assert.equal(storyOf(catalogProvince), storyOf(catalogOfficial));
  assert.equal(storyOf(speechProvince), storyOf(speechOfficial));
  assert.equal(storyOf(speechChile), storyOf(speechOfficial));
  assert.notEqual(storyOf(lone), storyOf(catalogOfficial));
  assert.notEqual(storyOf(lone), storyOf(copperProposed));
  assert.equal(storyOf(copperProposed), storyOf(copperApproved));
  assert.notEqual(rows.find((row) => row.article_id === copperProposed)!.fact_id, rows.find((row) => row.article_id === copperApproved)!.fact_id);
  assert.notEqual(storyOf(copperApproved), storyOf(catalogOfficial));
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
  assert.ok(catalogHot && catalogHot.participantCount >= 2 && catalogHot.heat >= 15, "多家来源的目录热度应高于单篇入选线");
  assert.ok(speechHot && speechHot.participantCount >= 2 && speechHot.heat >= 15, "多家来源的讲话热度应高于单篇入选线");
  assert.equal(hot.has(storyOf(lone)), false);

  const strip = await loadHotStrip();
  const stripTitles = (strip ?? []).map((entry) => entry.title);
  assert.ok(stripTitles.includes("自然资源部会同国家发展改革委公布优化调整后的《矿产资源目录》"), "两家以上来源的目录出现在首页热点榜");
  assert.ok(stripTitles.includes("习近平就推动中非矿业合作提出4点主张"), "两家以上来源的讲话出现在首页热点榜");
  assert.equal(stripTitles.includes("四川加达锂矿新增氧化锂资源量42.37万吨"), false, "只有一家来源的矿项目不上首页热点榜");
  assert.ok((strip ?? []).every((entry) => entry.heat > 0));
});

async function article(input: {
  key: string;
  name: string;
  firstParty: boolean;
  country?: boolean | string;
  mention?: string;
  selected?: boolean;
  score: number;
  title: string;
  summary: string;
  body: string;
  frame: { subject: string; action: string; object: string };
  publishedAt: Date;
}) {
  const sourceId = `fold-${T}-${input.key}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, next_fetch_at)
    VALUES (${sourceId}, ${input.name}, 'rss', ${input.firstParty ? "T1" : "T2"}, 'editorial', ${input.firstParty}, '2100-01-01')`;
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
  const country = input.country === true ? "CN" : typeof input.country === "string" ? input.country : null;
  const mention = input.mention ?? "中国";
  const geography = country
    ? validateGeography(
        {
          status: "identified",
          primary: country,
          assignments: [{ code: country, role: "event_location", mention, segment: "body_head", quote: input.body }],
          reason: "合成地理证据",
        },
        { title: input.title, bodyText: input.body, excerpt: null, bodyStatus: "ok" },
      )
    : null;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, prompt_version, receipt_ids, output)
    VALUES (${articleId}, 1, 'rule', 'pass', 'ai-models', ${input.title}, ${input.summary}, ${input.score}, ${input.selected !== false}, ${scopeVersion}, ${[await scopeReceipt(articleId)]},
      ${sql.json({ ...scopeOutput, scope: "single", fact: { title: input.title, ...input.frame }, ...(geography ? { geography } : {}) })})`;
  await publishArticle(articleId);
  return articleId;
}
