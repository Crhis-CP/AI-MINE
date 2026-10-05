// The judging and writing steps (editorial/analyze.ts): the prefilter decides relevance, two scores
// against the tier threshold decide 精选, selected and near-selected items are written by the content
// understanding and the rest by the title/summary prompts, a structure step gives the category, subjects
// and fact. Material with only a feed summary has its page fetched first. The steps run on the models the
// upstream project assigns them (set through the environment here); every prompt in the pack renders.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { analyzeArticle, SCORE_SYSTEM, tierThreshold } from "@amp/backend/editorial/analyze";
import { processArticle, queueProcessing } from "@amp/backend/jobs/content";
import { QUEUES, stopBoss } from "@amp/backend/jobs/queue";
import { compactAnswerFirstSummary, enforceIdentity, parseTranslateOutput, PREFILTER_SYSTEM } from "@amp/backend/editorial/writing";
import { promptText } from "@amp/backend/editorial/prompts";
import { config } from "@amp/backend/config";
import { publishArticle } from "@amp/backend/publication/publish";
import { setVisibility } from "@amp/backend/admin/content";
import { buildApp } from "../apps/api/src/app.ts";
import { SITE } from "@amp/industry/site";
import { CATEGORY_TAGS, ENTITY_TAGS, TAG_SYNONYMS, TOPIC_TAGS } from "@amp/industry/taxonomy";

const sql = dbOf("enrichment");

const publicApp = await buildApp("public-api");
const T = tag();
const SOURCE = `test-analyze-${T}`;

type Step = "prefilter" | "score" | "understand" | "summarize" | "structure";
interface Req {
  step: Step;
  marker: string;
  system: string;
  user: string;
  body: Record<string, any>;
}
const requests: Req[] = [];
// Prescribed fake labels test the admission plumbing, not the model's mining judgement quality.
const mining = [
  ["COPPER", "铜矿产量公告", "PASS"],
  ["FERRUM", "铁矿项目建设进展", "PASS"],
  ["ALUMINUM", "铝矿资源调查", "PASS"],
  ["SALTLAKE", "盐湖卤水提锂扩建", "PASS"],
  ["ORELITHIUM", "锂矿石选矿试验", "PASS"],
  ["MIXEDCOAL", "煤炭集团铜矿项目投产", "PASS"],
  ["LAW", "适用于金属矿山的通用安全规定", "PASS"],
  ["COAL", "独立煤矿生产公告", "BLOCK"],
  ["URANIUM", "独立铀矿勘探公告", "BLOCK"],
  ["GRAVEL", "独立砂石开采公告", "BLOCK"],
  ["UNCERTAIN", "矿企一般活动，缺少经营信息", "UNKNOWN"],
] as const;
const MARKERS = [
  "CLEAR",
  "RESCUE",
  "LOW",
  "OFFTOPIC",
  "BARE",
  "VAGUE",
  "THIN",
  "SENSITIVE",
  "SCFAIL",
  "SCREFUSED",
  "TITLEONLY",
  "EMPTYCASE",
  "TRIMMED",
  ...mining.map(([m]) => m),
];
const scoreAnswers: Record<string, number[]> = {
  CLEAR: [78, 72],
  RESCUE: [56, 50],
  LOW: [45, 40],
  THIN: [70, 70],
  SENSITIVE: [80, 80],
  BARE: [30, 34],
  VAGUE: [60, 62],
  TITLEONLY: [80, 80],
};

const stepOf = (system: string, user: string): Step =>
  system.includes("宽召回的金属矿业范围预筛")
    ? "prefilter"
    : system.includes("事件注意力评分器")
      ? "score"
      : system.includes("内容理解编辑")
        ? "understand"
        : system.includes("资料结构化助手")
          ? "structure"
          : user.includes("title_zh")
            ? "summarize"
            : (() => {
                throw new Error("unknown request");
              })();

// One stub stands in for DashScope (prefilter, structure), Zhipu (score, understand) and DeepSeek (summarize).
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> } & Record<string, any>;
  const system = body.messages[0]!.role === "system" ? String(body.messages[0]!.content) : "";
  const last = body.messages[body.messages.length - 1]!.content;
  const user = typeof last === "string" ? last : JSON.stringify(last);
  const step = stepOf(system, user);
  const marker = MARKERS.find((m) => user.includes(m)) ?? "";
  requests.push({ step, marker, system, user, body });
  const answer = (content: unknown) => ({
    id: `stub-${requests.length}`,
    model: "stub",
    choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  if (step === "prefilter")
    return answer({
      label:
        marker === "TRIMMED"
          ? " pass "
          : (mining.find(([m]) => m === marker)?.[2] ?? (marker === "OFFTOPIC" || marker === "BARE" ? "BLOCK" : marker === "VAGUE" ? "UNKNOWN" : "PASS")),
      reason: "合成预筛",
    });
  if (step === "score") {
    if (marker === "SCFAIL") return new Reply(503, { error: { message: "synthetic score outage" } });
    if (marker === "SCREFUSED")
      return new Reply(400, { contentFilter: [{ level: 1, role: "user" }], error: { code: "1301", message: "synthetic content refusal" } });
    return answer({ attentionScore: marker === "EMPTYCASE" ? 80 : (scoreAnswers[marker]?.shift() ?? 10) });
  }
  if (step === "understand") {
    if (marker === "SENSITIVE")
      return new Reply(400, {
        contentFilter: [{ level: 1, role: "user" }],
        error: { code: "1301", message: "系统检测到输入或生成内容可能包含不安全或敏感内容" },
      });
    return answer({
      itemType: "company_project",
      authorRole: "principal",
      tags: ["法规政策", "铜", "不存在的标签"],
      editorialJudgment: `理由 ${marker}`,
      titleZh: `理解标题 ${marker}`,
      summaryZh: `理解摘要 ${marker}。第二句补充一个关键数字。`,
    });
  }
  if (step === "structure")
    return answer({
      category: "company_project",
      tags: ["企业与项目", "锂"],
      subjects: ["zijin", "unknown-co"],
      fact: { title: `事实 ${marker}`, subject: "某公司", action: "发布", object: "模型", occurredAt: null },
    });
  return answer(`title_zh: 翻译标题 ${marker}\nsummary_zh: 翻译摘要 ${marker}。第二句补充影响。`);
});
for (const env of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[env] = `${provider.url}/v1`;
for (const env of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[env] = "test-key";
// The upstream project's own assignment of models to steps (the open-source default is one model for all
// of them).
Object.assign(process.env, {
  PREFILTER_MODEL: "qwen3.7-flash",
  SCORE_MODEL: "glm-5.3-flash-selection",
  UNDERSTAND_MODEL: "glm-5.3-flash",
  SUMMARIZE_MODEL: "deepseek-flash",
  STRUCTURE_MODEL: "qwen3.8-flash",
});

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES
    (${SOURCE}, 'Test analyze source', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await publicApp.close();
  await provider.close();
  await stopBoss();
  await closeDb();
});

// The tag keeps each material unique: identical input would reuse an earlier run's paid answers.
const LONG = "a lab released a model with a benchmark table and pricing details. ".repeat(8);
const article = async (marker: string, extra: Record<string, unknown> = {}) =>
  (
    await upsertMaterial({
      sourceId: SOURCE,
      url: `https://example.com/${marker}-${T}`,
      title: `${marker} model release ${T}`,
      language: "en",
      bodyText: `${marker}: ${LONG} (${T})`,
      bodyStatus: "ok",
      via: "fetch",
      publishedAt: new Date("2026-09-28T01:02:03Z"),
      ...extra,
    } as never)
  ).articleId;
const calls = (marker: string) => requests.filter((r) => r.marker === marker).map((r) => r.step);
const row = async (id: string) =>
  (
    await sql<
      {
        selected: boolean;
        relevance: string;
        score: string | null;
        title_zh: string;
        reason_zh: string | null;
        category: string | null;
        tags: string[];
        subjects: string[];
        receipt_ids: string[];
        output: Record<string, any>;
      }[]
    >`
    SELECT selected, relevance, score, title_zh, reason_zh, category, tags, subjects, receipt_ids, output FROM analyses WHERE article_id = ${id} ORDER BY id DESC LIMIT 1`
  )[0]!;

test("every prompt in the pack renders, and carries the site's own name", () => {
  const dir = new URL("../industry/prompts/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  // Every value any prompt asks for, so each renders on its own.
  const names = new Set(files.flatMap((f) => [...readFileSync(new URL(f, dir), "utf8").matchAll(/\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/g)].map((m) => m[1]!)));
  const values = Object.fromEntries([...names].map((n) => [n, "x"]));
  for (const file of files) {
    const text = promptText(file.slice(0, -3), values);
    assert.ok(text.length > 20 && !/\{\{/.test(text), file);
  }
  assert.ok(PREFILTER_SYSTEM.startsWith(`为${SITE.name}做宽召回的金属矿业范围预筛`));
});

test("a selected item: prefilter, two scores, the content understanding and the structure", async () => {
  assert.equal(tierThreshold("T1"), 60);
  const id = await article("CLEAR");
  const res = await analyzeArticle(id);
  assert.deepEqual([res!.output!.selected, res!.output!.score], [true, 75], "78 + 72 = 150 >= 120");
  assert.deepEqual(calls("CLEAR").sort(), ["prefilter", "score", "score", "structure", "understand"]);
  const r = await row(id);
  assert.deepEqual([r.title_zh, r.reason_zh, r.category, r.receipt_ids.length], ["理解标题 CLEAR", "理由 CLEAR", "company_project", 5]);
  assert.deepEqual(r.tags, ["企业与项目", "铜", "紫金矿业"], "vocabulary tags (synonyms mapped, unknown dropped) and the subject's tag");
  assert.deepEqual(r.subjects, ["zijin"]);
  assert.deepEqual([r.output.writer, r.output.itemType, r.output.prefilter.label, r.output.fact.title], ["understand", "company_project", "PASS", "事实 CLEAR"]);
  const score = requests.find((q) => q.marker === "CLEAR" && q.step === "score")!;
  assert.match(score.user, /【标题】\nCLEAR model release/, "the score reads the original title, before any writing");
  assert.deepEqual([score.body.temperature, score.body.reasoning_effort, score.body.max_tokens], [1, "high", 65536]);
  const understand = requests.find((q) => q.marker === "CLEAR" && q.step === "understand")!;
  assert.ok(understand.user.startsWith("请按系统规则理解以下单篇材料，一次返回全部六个字段。"));
  assert.ok(understand.system.includes("【摘要答案前置规则") && understand.system.includes("【标题自洽规则"));
  const prefilter = requests.find((q) => q.marker === "CLEAR" && q.step === "prefilter")!;
  assert.ok(JSON.parse(prefilter.user).includes("【材料质量】"), "the material context, sent as a JSON string");
});

test("a near-selected item is written like a selected one; below the floor it is translated", async () => {
  const near = await analyzeArticle(await article("RESCUE"));
  assert.deepEqual([near!.output!.selected, near!.output!.reasonZh], [false, "理由 RESCUE"], "56 + 50 = 106 > 100");
  const lowId = await article("LOW");
  const low = await analyzeArticle(lowId);
  assert.deepEqual([low!.output!.selected, low!.output!.titleZh, low!.output!.reasonZh], [false, "翻译标题 LOW", null]);
  assert.deepEqual(calls("LOW").sort(), ["prefilter", "score", "score", "structure", "summarize"]);
  const summarize = requests.find((q) => q.marker === "LOW" && q.step === "summarize")!;
  assert.equal(summarize.body.messages.length, 1, "the title/summary prompt is one user message");
  assert.equal(summarize.body.response_format, undefined, "answered in its own text format");
  assert.deepEqual((await row(lowId)).tags, ["企业与项目", "锂", "紫金矿业"], "structure tags");
});

test("the prefilter's BLOCK stops everything; UNKNOWN stays private after high scores and writing", async () => {
  const off = await analyzeArticle(await article("OFFTOPIC"));
  assert.deepEqual([off!.output!.relevance, off!.output!.selected], ["block", false]);
  assert.deepEqual(calls("OFFTOPIC"), ["prefilter"]);
  // Even 60 + 62 >= 2 x 60 and usable copy cannot settle the missing scope evidence.
  const vagueId = await article("VAGUE");
  const vague = await analyzeArticle(vagueId);
  assert.deepEqual([vague!.output!.relevance, vague!.output!.selected, vague!.output!.titleZh], ["unknown", false, "理解标题 VAGUE"]);
  assert.equal((await row(vagueId)).output.prefilter.label, "UNKNOWN", "the prefilter's own answer stays on record");
  await publishArticle(vagueId);
  assert.equal((await publicApp.inject(`/api/site/items/${vagueId}`)).statusCode, 404);
  // Nothing but a title and no page to fetch: the BLOCK counts as UNKNOWN and is scored, but the
  // translation writes nothing from a bare title, so it waits for material instead of being published.
  const bare = await analyzeArticle(await article("BARE", { bodyText: null, excerpt: null, bodyStatus: "none" }));
  assert.deepEqual([bare!.output!.relevance, bare!.output!.selected, bare!.output!.score], ["unknown", false, 32]);
  assert.deepEqual(calls("BARE").sort(), ["prefilter", "score", "score", "structure"]);
});

test("a feed summary alone: the article page is fetched first, then the whole article is judged", async () => {
  const id = await article("THIN", { bodyText: null, bodyStatus: "pending", excerpt: `THIN: a short feed summary (${T}).` });
  // The queue sends it to extraction although its source does not ask for full text (the safety net
  // does the same after a failed fetch, so extraction failures add up to "unconfirmed" and end).
  await queueProcessing(id);
  const [job] = await sql<{ name: string }[]>`SELECT name FROM pgboss.job WHERE data->>'articleId' = ${id}`;
  assert.equal(job?.name, QUEUES.extractBody);
  const first = await analyzeArticle(id);
  assert.deepEqual([first!.needsBody, first!.output], [true, null]);
  assert.deepEqual(calls("THIN"), [], "no model call before the page");
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id = ${id}`).length, 0, "nothing committed");
  // What extraction does: the body lands as a new revision.
  await sql`UPDATE articles SET body_text = ${`THIN: ${LONG} (${T}) full page`}, body_status = 'ok', revision = revision + 1 WHERE id = ${id}`;
  const second = await analyzeArticle(id);
  assert.deepEqual([second!.needsBody ?? false, second!.output!.selected], [false, true]);
});

test("a content-filter refusal of the content understanding is translated instead", async () => {
  const sensitive = await analyzeArticle(await article("SENSITIVE"));
  assert.deepEqual([sensitive!.output!.selected, sensitive!.output!.titleZh], [true, "翻译标题 SENSITIVE"]);
  assert.deepEqual(
    calls("SENSITIVE").filter((s) => s === "understand" || s === "summarize"),
    ["understand", "summarize"],
  );
});

test("guards: a company the input does not name is not written in; long summaries are cut at sentences", () => {
  const input = { title: "某矿企公布扩产计划", text: "某矿企公布了一座铜矿的扩产计划，产能和投资额都有说明。", sourceKind: "rss" };
  const guarded = enforceIdentity(input, { titleZh: "紫金矿业公布扩产计划", summaryZh: "某矿企公布扩产计划。" });
  assert.deepEqual([guarded.titleZh, guarded.summaryZh, guarded.identityGuard.outcome], ["某矿企公布扩产计划", "某矿企公布扩产计划。", "fallback"]);
  // The identity lexicon: a Chinese rendering of a company the input names in English is no invention.
  const zijin = { title: "Zijin Mining raises copper output", text: "Zijin Mining raised copper output at its mines in the third quarter.", sourceKind: "rss" };
  assert.equal(enforceIdentity(zijin, { titleZh: "紫金矿业提高铜产量", summaryZh: "紫金矿业第三季度提高了旗下矿山的铜产量。" }).identityGuard.outcome, "pass");
  const long = "第一句交代了谁做了什么以及关键结果，这一句本身已经足够说明核心事件的来龙去脉。".repeat(3) + "第二句补充数字。".repeat(20);
  assert.ok(compactAnswerFirstSummary(long).length <= 190);
  assert.deepEqual(parseTranslateOutput("title_zh: 标题\nsummary_zh: 第一句。\n第二句。"), { titleZh: "标题", summaryZh: "第一句。\n第二句。", bodyZh: "" });
  assert.equal(
    parseTranslateOutput("title_zh: 标题\nbody_zh: 我们懂你。\n\n来源：X：PixVerse (@PixVerse)").bodyZh,
    "我们懂你。",
    "a repeated prompt line is dropped",
  );
});

test("guards: everyday Chinese that contains a short company name names no company; other renderings of a named company count", () => {
  const rss = (title: string, text: string) => ({ title, text, sourceKind: "rss" });
  // 大力拓展 (力拓), 其中铝产量 (中铝), 黑龙江铜山 and 长江铜价 (江铜): a summary is not emptied for them.
  const everyday: Array<[ReturnType<typeof rss>, string]> = [
    [rss("Aluminium output rises", "Aluminium output rose, mostly in Yunnan."), "铝产量上升，其中铝产量增长主要来自云南。"],
    [rss("Ivanhoe expands Kamoa-Kakula", "Ivanhoe Mines is expanding the Kamoa-Kakula copper complex."), "艾芬豪矿业大力拓展卡莫阿-卡库拉铜矿。"],
    [rss("Zijin buys a copper mine in Heilongjiang", "Zijin Mining bought the Tongshan copper mine in Heilongjiang."), "紫金矿业收购黑龙江铜山铜矿。"],
    [rss("Copper prices in China", "Spot copper on the Changjiang market rose."), "长江铜价上涨，市场中铝库存下降。"],
  ];
  for (const [input, summaryZh] of everyday) assert.equal(enforceIdentity(input, { titleZh: "", summaryZh }).summaryZh, summaryZh, summaryZh);
  // A real mention the input does not support is still caught.
  assert.equal(enforceIdentity(rss("Aluminium output rises", "Aluminium output rose."), { titleZh: "", summaryZh: "据中铝消息，铝产量上升。" }).summaryZh, "");
  // The input's own rendering of a company supports the common Chinese name the summary uses.
  const codelco = { title: "智利国营铜业公司上调产量指引", text: "智利国营铜业公司上调了全年铜产量指引。", sourceKind: "web_list" };
  const copy = { titleZh: "智利国家铜业公司上调产量指引", summaryZh: "智利国家铜业公司上调全年铜产量指引。" };
  assert.equal(enforceIdentity(codelco, copy).identityGuard.outcome, "pass");
  assert.equal(
    enforceIdentity(rss("Rio-Tinto and Anglo-American", "Rio-Tinto and Anglo-American agreed terms."), { titleZh: "力拓与英美资源达成协议", summaryZh: "" })
      .identityGuard.outcome,
    "pass",
  );
  // Common other spellings map to a vocabulary tag instead of being dropped.
  const vocabulary = new Set<string>([...TOPIC_TAGS, ...ENTITY_TAGS]);
  for (const [spelling, tag] of [
    ["黄金", "金"],
    ["刚果(金)", "刚果（金）"],
    ["澳洲", "澳大利亚"],
    ["钯", "铂族金属"],
    ["rio tinto", "力拓"],
  ]) {
    assert.equal(TAG_SYNONYMS[spelling!], tag, spelling);
    assert.ok(vocabulary.has(tag!), tag);
  }
  assert.ok(
    Object.values(TAG_SYNONYMS).every((tag) => vocabulary.has(tag) || (CATEGORY_TAGS as readonly string[]).includes(tag)),
    "every synonym lands on a vocabulary tag",
  );
});

test("analysing the same revision again reuses every paid answer", async () => {
  scoreAnswers.CLEAR = [80, 70];
  const id = await article("CLEAR", { url: `https://example.com/CLEAR-again-${T}`, title: `CLEAR model release again ${T}` });
  const first = await analyzeArticle(id);
  assert.equal(first!.reused, false);
  const hits = provider.hits();
  const again = await analyzeArticle(id);
  assert.equal(provider.hits(), hits, "no new requests");
  assert.deepEqual([again!.reused, again!.receiptIds], [true, first!.receiptIds]);
  const complete = await row(id);
  await sql`UPDATE receipts SET status = 'unknown' WHERE id = ${again!.receiptIds[1]!}`;
  await assert.rejects(analyzeArticle(id), /unknown outcome/);
  assert.deepEqual(await row(id), complete, "a same-receipt checkpoint must not hide complete analysis when scoring stops");
  assert.equal(provider.hits(), hits, "unknown score is not resent and prefilter evidence is reused");
});

const projection = async (id: string) =>
  (await sql`SELECT visibility, eligible, selected, score, summary, source_excerpt FROM publications WHERE article_id = ${id}`)[0]!;

test("mining labels control public admission independently of source tier, keywords or manual visibility", async () => {
  for (const [marker, title, label] of mining) {
    const id = await article(marker, { title, language: "zh", bodyText: `${marker}：${title}，附原始条件与数据，供核对。`.repeat(4) });
    await analyzeArticle(id);
    await publishArticle(id);
    const p = await projection(id);
    assert.deepEqual([p.visibility, p.eligible, p.selected], label === "PASS" ? ["public", true, false] : ["withdrawn", false, false], marker);
    assert.equal((await publicApp.inject(`/api/site/items/${id}`)).statusCode, label === "PASS" ? 200 : 404, marker);
    if (label !== "PASS") {
      await setVisibility(id, { visibility: "public", reason: "synthetic override", version: 0 }, "test");
      assert.equal((await projection(id)).visibility, "withdrawn", "a visibility override cannot manufacture admission");
    }
  }
});

test("confirmed Chinese scope survives score failure; missing, stale or unlicensed evidence does not", async () => {
  const body = "铜矿扩大产能的原始公告，附产量、地点和建设条件，供读者核对。".repeat(8);
  await sql`UPDATE sources SET site_fulltext = true WHERE id = ${SOURCE}`;
  const id = await article("SCFAIL", { title: "铜矿扩产公告", language: "zh", bodyText: `SCFAIL：${body} (${T})` });
  await assert.rejects(processArticle(id), /synthetic score outage/);
  const p = await projection(id);
  assert.deepEqual([p.visibility, p.eligible, p.selected, p.score], ["public", true, false, null]);
  assert.ok(p.source_excerpt.startsWith("来源摘录：SCFAIL：") && p.source_excerpt.includes("根据来源正文整理"));
  assert.equal(p.summary, null, "source text is not an authored or machine-exported summary");
  const detail = await publicApp.inject(`/api/site/items/${id}`);
  assert.equal(detail.statusCode, 200);
  assert.equal(JSON.parse(detail.body).summary, p.source_excerpt);
  for (const url of ["/feed/all.xml", "/api/v1/items?mode=all"]) {
    const exported = await publicApp.inject(url);
    assert.equal(exported.statusCode, 200);
    assert.ok(!exported.body.includes(body), "the normal failed-score path cannot syndicate its full source text: " + url);
  }
  const [receipt] = await sql`SELECT r.status FROM analyses a JOIN receipts r ON r.id = a.receipt_ids[1] WHERE a.article_id = ${id}`;
  assert.equal(receipt!.status, "completed", "the scope receipt is applied even though scoring failed");
  await sql`UPDATE receipts SET status = 'unknown' WHERE subject = ${`article:${id}@1`} AND purpose = 'score_article'`;
  assert.equal((await processArticle(id)).state, "unknown-receipt");
  assert.equal((await projection(id)).visibility, "public", "unknown billing/score is not unknown scope");
  assert.equal((await sql`SELECT status FROM receipts WHERE subject = ${`article:${id}@1`} AND purpose = 'score_article'`)[0]!.status, "unknown");
  const refused = await article("SCREFUSED", { title: `钼矿公告 ${T}`, language: "zh", bodyText: `SCREFUSED：${body} (${T})` });
  await processArticle(refused);
  const refusal = await projection(refused);
  assert.deepEqual([refusal.visibility, refusal.selected, refusal.score], ["public", false, null], "score refusal does not exclude confirmed scope");
  const titleOnly = await article("TITLEONLY", { title: `TITLEONLY 铁矿许可 ${T}`, language: "zh", bodyText: null, excerpt: null, bodyStatus: "none" });
  await analyzeArticle(titleOnly);
  await publishArticle(titleOnly);
  assert.equal((await projection(titleOnly)).visibility, "withdrawn", "high scores and generated copy cannot publish title-only input");
  const before = provider.hits();
  const wasEnabled = config.modelCallsEnabled;
  config.modelCallsEnabled = false;
  try {
    await assert.rejects(processArticle(id), /disabled/i);
    assert.equal((await projection(id)).visibility, "public", "a current scope cache survives the model stop");
    const unknown = await article("UNKNOWN-NO-MODEL", { title: "铜矿标题", language: "zh", bodyText: body });
    await assert.rejects(processArticle(unknown), /disabled/i);
    assert.equal((await projection(unknown)).visibility, "withdrawn", "Chinese text and plausible terms are not scope evidence");
    assert.equal(provider.hits(), before);
  } finally {
    config.modelCallsEnabled = wasEnabled;
  }
  await sql`UPDATE sources SET site_fulltext = false WHERE id = ${SOURCE}`;
  await publishArticle(id);
  assert.equal((await projection(id)).visibility, "withdrawn", "no unlicensed source-text fallback");
  await sql`UPDATE sources SET site_fulltext = true WHERE id = ${SOURCE}`;
  await sql`UPDATE analyses SET prompt_version = 'prefilter@old-scope' WHERE article_id = ${id}`;
  await publishArticle(id);
  assert.equal((await projection(id)).visibility, "withdrawn", "old scope wording is not reusable");
  const known = await article("CURRENT-REVISION", { title: "锂矿公告", language: "zh", bodyText: body });
  await analyzeArticle(known);
  await publishArticle(known);
  assert.equal((await projection(known)).visibility, "public");
  await sql`UPDATE articles SET body_text = NULL, excerpt = NULL WHERE id = ${known}`;
  await publishArticle(known);
  assert.equal((await projection(known)).visibility, "withdrawn", "a title plus model copy cannot stand in for source material");
  await sql`UPDATE articles SET body_text = ${body}, revision = revision + 1 WHERE id = ${known}`;
  await publishArticle(known);
  assert.equal((await projection(known)).visibility, "withdrawn", "old material evidence cannot admit a new revision");
});

test("empty and punctuation-only source text cannot be replaced by high-score model writing", async () => {
  for (const [i, text] of [null, " \n\t", "。！？……", "产能10万吨"].entries()) {
    const id = await article(`empty-${i}`, { title: `EMPTYCASE 铜矿建设公告 ${T}-${i}`, bodyText: text, excerpt: null, language: "zh", bodyStatus: "none" });
    const analyzed = await analyzeArticle(id);
    assert.equal(analyzed!.output!.score, 80, "the fake scorer still gives both 80s");
    assert.ok(analyzed!.output!.summaryZh, "the fake writer supplied copy");
    await publishArticle(id);
    assert.equal((await publicApp.inject(`/api/site/items/${id}`)).statusCode, i === 3 ? 200 : 404);
  }
});

test("publication requires an applied prefilter receipt bound to the current model input and scope wording", async () => {
  const id = await article("TRIMMED", { title: `TRIMMED 铜矿许可 ${T}`, language: "zh" });
  await analyzeArticle(id);
  const [analysis] = await sql`SELECT id, receipt_ids FROM analyses WHERE article_id = ${id} ORDER BY id DESC LIMIT 1`;
  const receiptId = analysis!.receipt_ids[0];
  const [receipt] = await sql`SELECT request, response FROM receipts WHERE id = ${receiptId}`;
  const status = async () => {
    await publishArticle(id);
    return (await publicApp.inject(`/api/site/items/${id}`)).statusCode;
  };
  const hits = provider.hits();
  assert.equal(await status(), 200, "the real parser and receipt proof both accept a trimmed lowercase PASS");
  for (const ids of [[], analysis!.receipt_ids.slice(1)]) {
    await sql`UPDATE analyses SET receipt_ids = ${ids} WHERE id = ${analysis!.id}`;
    assert.equal(await status(), 404, "missing or non-prefilter receipts are not evidence");
  }
  await sql`UPDATE analyses SET receipt_ids = ${analysis!.receipt_ids} WHERE id = ${analysis!.id}`;
  for (const state of ["pending", "received", "failed", "unknown"]) {
    await sql`UPDATE receipts SET status = ${state} WHERE id = ${receiptId}`;
    assert.equal(await status(), 404, state);
  }
  await sql`UPDATE receipts SET status = 'completed' WHERE id = ${receiptId}`;
  for (const field of ["promptVersion", "systemHash", "userHash"]) {
    await sql`UPDATE receipts SET request = ${sql.json({ ...receipt!.request, [field]: "wrong" })} WHERE id = ${receiptId}`;
    assert.equal(await status(), 404, field);
  }
  await sql`UPDATE receipts SET request = ${sql.json(receipt!.request)} WHERE id = ${receiptId}`;
  for (const label of ["BLOCK", "UNKNOWN"]) {
    await sql`UPDATE receipts SET response = ${sql.json({ choices: [{ message: { content: JSON.stringify({ label }) } }] })} WHERE id = ${receiptId}`;
    assert.equal(await status(), 404, label);
  }
  await sql`UPDATE receipts SET response = ${sql.json(receipt!.response)}, subject = 'first-cache-owner' WHERE id = ${receiptId}`;
  assert.equal(await status(), 200, "subject is diagnostic; identical hashed input is reusable");
  assert.equal(provider.hits(), hits, "all validation is read-only and starts no model call");
});

test("current input metadata keeps its new scope receipt after score failure", async () => {
  await sql`UPDATE sources SET site_fulltext = true WHERE id = ${SOURCE}`;
  const id = await article("SCFAIL", {
    url: `https://example.com/SCFAIL-metadata-${T}`,
    title: "铜矿扩产公告",
    language: "zh",
    bodyText: `SCFAIL：铜矿项目扩大产能，公告说明地点、产量和原始条件。${T}`.repeat(4),
  });
  await assert.rejects(processArticle(id), /synthetic score outage/);
  assert.equal((await projection(id)).visibility, "public");
  try {
    await sql`UPDATE sources SET name = '来源名称已核正' WHERE id = ${SOURCE}`;
    await assert.rejects(processArticle(id), /synthetic score outage/);
    const [material] = await sql`SELECT revision FROM articles WHERE id = ${id}`;
    const receipts = await sql`SELECT id, status, request->>'userHash' AS input_hash FROM receipts
      WHERE purpose = 'prefilter_article' AND subject = ${`article:${id}@1`} ORDER BY id`;
    assert.equal(material!.revision, 1);
    assert.equal(receipts.length, 2);
    assert.notEqual(receipts[0]!.input_hash, receipts[1]!.input_hash);
    assert.ok(receipts.every((receipt) => receipt.status === "completed"));
    assert.ok((await row(id)).receipt_ids.includes(receipts[1]!.id));
    const current = await projection(id);
    assert.deepEqual([current.visibility, current.selected, current.score], ["public", false, null]);
  } finally {
    await sql`UPDATE sources SET name = 'Test analyze source' WHERE id = ${SOURCE}`;
  }
});
