// The shared analysis prompt layout (editorial/analysis-layout.ts, ANALYSIS_PROMPT_LAYOUT): every per-article step
// sends one constant system prompt, the article material and a constant acknowledgement before its own short step
// instruction, so a provider's prefix cache covers the body after the first step. The score's material stays blind to
// the publisher, structure's geography is still validated against the numbered segments, receipts stay reusable, and
// the separate layout keeps the earlier requests and versions. The stub stands in for every step's provider.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { READER_WORDING } from "@amp/industry/wording";
import { closeDb, sql } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import {
  analysisVersionOf,
  analyzeArticle,
  buildScoreInput,
  loadAnalyzeInput,
  MEND_SYSTEM,
  PROMPT_VERSIONS,
  promptVersionsFor,
  SCORE_SYSTEM,
  scoreConfirmationVersion,
  scoringConfirmed,
  type AnalyzeInputArticle,
} from "@amp/backend/editorial/analyze";
import { buildArticlePrompt, PREFILTER_SYSTEM, prefilterUser, translateInputOf, UNDERSTAND_SYSTEM, understandUser } from "@amp/backend/editorial/writing";
import { MATERIAL_ACKNOWLEDGEMENT, SHARED_ANALYSIS_SYSTEM, sharedMaterial } from "../packages/backend/src/editorial/analysis-layout.ts";
import { promptText } from "@amp/backend/editorial/prompts";
import { UNDERSTAND_BODY_CHARS } from "@amp/backend/editorial/writing";
import { ensureModelSourceFixture } from "./model-source-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { scoreAxes } from "./score-axes.ts";

type Step = "prefilter" | "score" | "structure" | "understand" | "summarize" | "wording";
type Message = { role: string; content: unknown };
interface Req {
  step: Step;
  marker: string;
  messages: Message[];
}
const T = tag();
const SOURCE_NAME = `Shared Prefix Wire ${T}`;
const requests: Req[] = [];
const MARKERS = ["HIGHSHARE", "LOWSHARE", "HIGHSEP", "LOWSEP", "REUSESHARE"];
const SHARED_STEPS: Array<[string, Step]> = [
  ["执行第一节", "prefilter"],
  ["执行第二节", "score"],
  ["执行第三节", "structure"],
  ["执行第四节", "understand"],
  ["执行第五节", "summarize"],
  ["执行第六节", "wording"],
];
const text = (content: unknown) => (typeof content === "string" ? content : JSON.stringify(content));
const stepOf = (messages: Message[]): Step => {
  const system = messages[0]!.role === "system" ? text(messages[0]!.content) : "";
  const last = text(messages.at(-1)!.content);
  if (system === SHARED_ANALYSIS_SYSTEM) return SHARED_STEPS.find(([cue]) => last.includes(cue))![1];
  if (system === PREFILTER_SYSTEM) return "prefilter";
  if (system === SCORE_SYSTEM) return "score";
  if (system === UNDERSTAND_SYSTEM) return "understand";
  if (system === MEND_SYSTEM) return "wording";
  if (system.includes("资料结构化助手")) return "structure";
  if (!system && last.includes("title_zh")) return "summarize";
  throw new Error("unknown request");
};

const provider = await stub(async (_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Message[] };
  const step = stepOf(body.messages);
  const all = body.messages.map((m) => text(m.content)).join("\n");
  const marker = MARKERS.find((m) => all.includes(m)) ?? "";
  requests.push({ step, marker, messages: body.messages });
  const answer = (content: unknown) => ({
    id: `stub-${requests.length}`,
    model: "stub",
    choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  if (step === "prefilter") return answer({ label: "PASS", reason: "合成涉矿材料" });
  if (step === "score") return answer(scoreAxes(marker.startsWith("HIGH") || marker === "REUSESHARE" ? 80 : 10));
  if (step === "structure")
    return answer({
      scope: "single",
      category: "project_development",
      tags: ["项目建设"],
      subjects: [],
      fact: { title: `事实 ${marker}`, subject: "合成矿企", action: "扩建", object: "铜矿", occurredAt: null },
      geography: {
        status: "identified",
        primary: "CL",
        assignments: [{ code: "CL", role: "event_location", mention: "Chile", segment: "body_head", quote: "expands a copper mine in Chile" }],
        reason: "合成事件地",
      },
      company_context: [],
    });
  if (step === "understand")
    return answer({
      itemType: "project_development",
      authorRole: "relayer",
      tags: ["项目建设"],
      editorialJudgment: `合成理由 ${marker}`,
      titleZh: `理解标题 ${marker}`,
      summaryZh: `理解摘要 ${marker}。`,
    });
  if (step === "wording") {
    const draft = text(body.messages.at(-1)!.content);
    const copy = JSON.parse(draft.split("中文稿：\n")[1]!.split("\n\n问题：")[0]!);
    return answer({ ...copy, titleZh: copy.titleZh.replaceAll("翻译", "整理"), summaryZh: copy.summaryZh.replaceAll("翻译", "整理") });
  }
  return answer(`title_zh: 翻译标题 ${marker}\nsummary_zh: 翻译摘要 ${marker}，合成矿企扩建智利铜矿。`);
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
// One model for every step, as production runs (the cache is per model).
for (const name of ["PREFILTER_MODEL", "SCORE_MODEL", "UNDERSTAND_MODEL", "SUMMARIZE_MODEL", "WORDING_MODEL", "STRUCTURE_MODEL"])
  process.env[name] = "deepseek-flash";

let source = "";
before(async () => {
  await installUsageFixtureForModel("deepseek-flash");
  (READER_WORDING as Array<readonly [RegExp, string]>).push([/翻译/u, "改为整理"]);
});
beforeEach(async () => {
  source = `test-shared-prefix-${T}-${tag()}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, next_fetch_at)
    VALUES (${source}, ${SOURCE_NAME}, 'rss', 'T1', 'editorial', true, '2100-01-01')`;
  await ensureModelSourceFixture(source, ["https://example.com/source"]);
});
after(async () => {
  (READER_WORDING as Array<readonly [RegExp, string]>).length = 0;
  process.env.ANALYSIS_PROMPT_LAYOUT = "separate";
  await provider.close();
  await closeDb();
});

const BODY = "Synthetic Miner expands a copper mine in Chile, adding 40 kt of annual copper output after a permit. ".repeat(6);
const article = async (marker: string) =>
  (
    await upsertMaterial({
      sourceId: source,
      url: `https://example.com/source/wire-${marker}-${T}`,
      title: `${marker} copper expansion ${T}`,
      language: "en",
      bodyText: `${marker}: ${BODY}(${T})`,
      bodyStatus: "ok",
      via: "fetch",
      publishedAt: new Date("2026-10-28T01:02:03Z"),
    } as never)
  ).articleId;
const of = (marker: string) => requests.filter((r) => r.marker === marker);
const ids = new Map<string, string>();
const latest = async (id: string) =>
  (
    await sql<
      { prompt_version: string; selected: boolean; title_zh: string; output: { geography: { state: string; primary: string | null; codes: string[] } } }[]
    >`
      SELECT prompt_version, selected, title_zh, output FROM analyses WHERE article_id=${id} ORDER BY id DESC LIMIT 1`
  )[0]!;

test("shared layout: every request of one article starts with the same system prompt, material and acknowledgement", async () => {
  process.env.ANALYSIS_PROMPT_LAYOUT = "shared";
  for (const marker of ["HIGHSHARE", "LOWSHARE"]) {
    const id = await article(marker);
    ids.set(marker, id);
    await analyzeArticle(id);
    const input = (await loadAnalyzeInput(id))!;
    const sent = of(marker);
    assert.deepEqual(
      sent.map((r) => r.step).sort(),
      marker === "HIGHSHARE"
        ? ["prefilter", "score", "score", "structure", "understand"]
        : ["prefilter", "score", "score", "structure", "summarize", "wording"],
      "the X-post-free article steps, the mend included, all go through the shared layout",
    );
    const lead = JSON.stringify(sent[0]!.messages.slice(0, 3));
    for (const r of sent) {
      assert.deepEqual(
        r.messages.map((m) => m.role),
        ["system", "user", "assistant", "user"],
      );
      assert.equal(JSON.stringify(r.messages.slice(0, 3)), lead, `${r.step} shares the leading bytes`);
    }
    assert.equal(sent[0]!.step, "prefilter", "the prefilter pays the material's first, uncached read");
    assert.equal(text(sent[0]!.messages[0]!.content), SHARED_ANALYSIS_SYSTEM);
    assert.equal(text(sent[0]!.messages[1]!.content), sharedMaterial(input).text);
    assert.equal(text(sent[0]!.messages[2]!.content), MATERIAL_ACKNOWLEDGEMENT);
    // Every step's own rules are in the one system prompt, under its heading.
    for (const heading of ["# 第一节 预筛", "# 第二节 评分", "# 第三节 结构抽取", "# 第四节 内容理解", "# 第五节 标题摘要", "# 第六节 用词修订"])
      assert.ok(SHARED_ANALYSIS_SYSTEM.includes(heading), heading);
    assert.ok(SHARED_ANALYSIS_SYSTEM.includes(PREFILTER_SYSTEM) && SHARED_ANALYSIS_SYSTEM.includes(SCORE_SYSTEM));
    assert.ok(SHARED_ANALYSIS_SYSTEM.includes(UNDERSTAND_SYSTEM) && SHARED_ANALYSIS_SYSTEM.includes(MEND_SYSTEM));
    assert.ok(SHARED_ANALYSIS_SYSTEM.includes(promptText("rules-domain-names")), "the bilingual company names are included by reference");
    const row = await latest(id);
    assert.equal(row.prompt_version, analysisVersionOf(input, "shared"));
    assert.equal(row.selected, marker === "HIGHSHARE");
    assert.equal(row.title_zh, marker === "HIGHSHARE" ? `理解标题 ${marker}` : `整理标题 ${marker}`, "the mend in the shared layout is applied");
    // Structure's geography is validated against the segments the shared material numbers.
    assert.deepEqual([row.output.geography.state, row.output.geography.primary, row.output.geography.codes], ["identified", "CL", ["CL"]]);
    const structure = sent.find((r) => r.step === "structure")!;
    const context = text(structure.messages[3]!.content);
    assert.ok(context.includes('"complete_material":true') && context.includes(input.url), "metadata goes with the step instruction");
  }
});

test("shared layout: the score sees neither the source name nor its tier, first-party flag or link", async () => {
  process.env.ANALYSIS_PROMPT_LAYOUT = "shared";
  const sent = of("HIGHSHARE");
  assert.ok(sent.length, "runs after the shared-layout scenario");
  const score = sent.find((r) => r.step === "score")!;
  const blind = [text(score.messages[1]!.content), text(score.messages[3]!.content)].join("\n");
  for (const hint of [SOURCE_NAME, "tier=", "firstParty", "first_party", "example.com/source/wire", "【来源】", "【作者】"])
    assert.ok(!blind.includes(hint), hint);
  assert.ok(!SHARED_ANALYSIS_SYSTEM.includes(SOURCE_NAME));
  // The steps that read the publisher get it in their own step instruction, never in the shared material.
  const prefilter = text(sent.find((r) => r.step === "prefilter")!.messages[3]!.content);
  const understand = text(sent.find((r) => r.step === "understand")!.messages[3]!.content);
  for (const step of [prefilter, understand]) assert.ok(step.includes(`【来源】${SOURCE_NAME}（rss，tier=T1）`) && step.includes("example.com/source/wire"));
  const input = (await loadAnalyzeInput(ids.get("HIGHSHARE")!))!;
  assert.equal(buildScoreInput(input, "shared"), `${sharedMaterial(input).text}\n\n${MATERIAL_ACKNOWLEDGEMENT}\n\n${text(score.messages[3]!.content)}`);
  assert.ok(!buildScoreInput(input, "shared").includes(SOURCE_NAME));
});

test("shared layout: a repeated analysis reuses every receipt, and the material identity tells two articles apart", async () => {
  process.env.ANALYSIS_PROMPT_LAYOUT = "shared";
  const id = await article("REUSESHARE");
  const first = (await analyzeArticle(id))!;
  const score = of("REUSESHARE").filter((r) => r.step === "score");
  // The score instruction is the same text for every article; only the material differs, and it is in the identity.
  assert.equal(text(score[0]!.messages[3]!.content), text(of("HIGHSHARE").find((r) => r.step === "score")!.messages[3]!.content));
  assert.equal(score.length, 2, "a new material is a new paid score, not another article's receipt");
  const hits = provider.hits();
  const again = (await analyzeArticle(id))!;
  assert.equal(provider.hits(), hits, "nothing is asked again");
  assert.equal(again.reused, true);
  assert.deepEqual(again.receiptIds, first.receiptIds);
  const [receipt] = await sql<{ request: Record<string, unknown> }[]>`
    SELECT request FROM receipts WHERE subject=${`article:${id}@1`} AND purpose='score_article' LIMIT 1`;
  assert.equal(receipt!.request.promptVersion, promptVersionsFor("shared").score);
  assert.equal(receipt!.request.layout, "prefix-v1");
});

test("separate layout: the earlier per-step requests and versions, unchanged", async () => {
  process.env.ANALYSIS_PROMPT_LAYOUT = "separate";
  for (const marker of ["HIGHSEP", "LOWSEP"]) {
    const id = await article(marker);
    await analyzeArticle(id);
    const input = (await loadAnalyzeInput(id))!;
    for (const r of of(marker)) {
      const system = r.messages[0]!.role === "system" ? text(r.messages[0]!.content) : "";
      const user = text(r.messages.at(-1)!.content);
      assert.equal(r.messages.length, system ? 2 : 1, "no shared material or acknowledgement");
      if (r.step === "prefilter") assert.deepEqual([system, user], [PREFILTER_SYSTEM, prefilterUser(input)]);
      if (r.step === "score") {
        assert.deepEqual([system, user], [SCORE_SYSTEM, buildScoreInput(input, "separate")]);
        assert.ok(user.startsWith("请按系统规则评估以下单篇材料所代表的事件。") && user.includes("【完整正文】"));
      }
      if (r.step === "understand") assert.deepEqual([system, user], [UNDERSTAND_SYSTEM, understandUser(input)]);
      if (r.step === "summarize") assert.deepEqual([system, user], ["", buildArticlePrompt(translateInputOf(input))]);
      if (r.step === "wording") assert.equal(system, MEND_SYSTEM);
      if (r.step === "structure") assert.deepEqual(Object.keys(JSON.parse(user)).sort(), ["complete_material", "segments", "source", "sourceTime", "url"]);
    }
    assert.equal((await latest(id)).prompt_version, analysisVersionOf(input, "separate"));
  }
});

test("the layouts' versions differ, and the score's release gate follows the configured layout", () => {
  const shared = promptVersionsFor("shared"),
    separate = promptVersionsFor("separate");
  for (const step of Object.keys(separate) as Array<keyof typeof separate>) assert.notEqual(shared[step], separate[step], step);
  assert.match(shared.score, /^selection-score-shared@[0-9a-f]{10}\+weights@[0-9a-f]{10}$/);
  assert.equal(separate.score, "selection-score@9881743a29+weights@20542a669a");
  // The gate reads the layout's score standard (TASK-0710); in the separate layout it is the score step's version.
  const sharedStandard = scoreConfirmationVersion("shared");
  assert.match(sharedStandard, /^selection-score-shared-standard@[0-9a-f]{10}\+weights@[0-9a-f]{10}$/);
  assert.equal(scoreConfirmationVersion("separate"), separate.score);
  process.env.ANALYSIS_PROMPT_LAYOUT = "shared";
  assert.equal(PROMPT_VERSIONS.score, shared.score);
  assert.equal(scoringConfirmed(true, sharedStandard), true);
  assert.equal(scoringConfirmed(true, separate.score), false, "a version confirmed for the other layout does not release scoring");
  process.env.ANALYSIS_PROMPT_LAYOUT = "separate";
  assert.equal(PROMPT_VERSIONS.score, separate.score);
  assert.equal(scoringConfirmed(true, sharedStandard), false);
  process.env.ANALYSIS_PROMPT_LAYOUT = "both";
  assert.throws(() => PROMPT_VERSIONS.score, /ANALYSIS_PROMPT_LAYOUT/);
  process.env.ANALYSIS_PROMPT_LAYOUT = "separate";
});

test("the shared material: evidence segments for geography, one body budget, a stated cut and no publisher", () => {
  const base: AnalyzeInputArticle = {
    id: "synthetic",
    revision: 1,
    title: "Synthetic copper title",
    url: "https://secret-publisher.example/a",
    author: "Secret Author",
    publishedAt: new Date("2026-10-01T00:00:00Z"),
    bodyText: null,
    excerpt: null,
    bodyStatus: "ok",
    media: [],
    source: { name: "Secret Publisher", kind: "rss", tier: "T1", firstParty: true, tags: ["secret-tag"] },
  };
  const long = Array.from({ length: 30_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
  const m = sharedMaterial({ ...base, bodyText: long });
  for (const hint of ["Secret Publisher", "Secret Author", "secret-publisher.example", "secret-tag", "T1"]) assert.ok(!m.text.includes(hint), hint);
  const head = m.geography.segments.find((s) => s.id === "body_head")!.text,
    tail = m.geography.segments.find((s) => s.id === "body_tail")!.text;
  assert.ok(m.text.includes(`〔body_head〕\n${head}\n`) && m.text.endsWith(`〔body_tail〕\n${tail}`));
  assert.ok(m.text.includes(`〔正文续〕\n${long.slice(head.length, UNDERSTAND_BODY_CHARS - tail.length)}\n`));
  assert.ok(m.text.includes(`……（正文共 30000 字，此处省略中间 ${30_000 - UNDERSTAND_BODY_CHARS} 字）`));
  assert.equal(m.geography.bodyBudget, 22000, "the full geography budget, recorded with the geography it validates");
  const short = sharedMaterial({ ...base, bodyText: "A short copper body." });
  assert.ok(!short.text.includes("〔正文续〕") && !short.text.includes("〔body_tail〕") && !short.text.includes("省略"));
  // An X post: the post with its quote, but not the author handle.
  const post = sharedMaterial({
    ...base,
    xPost: {
      text: "Copper output rises at the synthetic mine.",
      handle: "secrethandle",
      authorName: "Secret Name",
      quoted: { text: "Quoted copper note", handle: "quoter" },
    },
  } as never);
  assert.ok(post.text.includes("Copper output rises") && post.text.includes("[引用 @quoter]：Quoted copper note"));
  assert.ok(!post.text.includes("secrethandle") && !post.text.includes("Secret Name"));
});
