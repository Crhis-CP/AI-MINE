import { readCurrentSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";
import { config } from "@amp/backend/config";
import { tag, stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial, type XPostData } from "@amp/backend/content/materials";
import { stopBoss, shutdownSignal } from "@amp/backend/jobs/queue";
import { analyzeArticle, buildScoreInput, normalizeAnalysis, runAnalysis, PROMPT_VERSIONS } from "@amp/backend/editorial/analyze";
import { prepareEvaluationInput, runSelectionPrefilter, runSelectionScores } from "@amp/backend/editorial/analyze";
import { buildMaterial, firstInputImage, loadAnalyzeInput, withXArticle } from "../packages/backend/src/editorial/input.ts";
import { evaluationInputFingerprint } from "../packages/backend/src/editorial/evaluation-input.ts";
import { geographyMaterial } from "../packages/backend/src/editorial/geography.ts";
import { prefilterUser, understandUser, translateInputOf, buildArticlePrompt, parseShortPostOutput } from "@amp/backend/editorial/writing";
import { prepareNewsFallback } from "../packages/backend/src/providers/news-fallback.ts";
import { ensureModelSourceFixture } from "./model-source-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";

const T = tag(),
  source = `original-editorial-${T}`;
const requests: Array<{ step: string; user: string }> = [];
let score = 20;
const provider = await stub((_n, req) => {
  const messages = JSON.parse(req.body).messages as { role: string; content: string }[];
  const system = messages.find((m) => m.role === "system")?.content ?? "",
    user = messages.at(-1)!.content;
  const step = system.includes("宽召回的金属矿业范围预筛")
    ? "prefilter"
    : system.includes("事件注意力评分器")
      ? "score"
      : system.includes("资料结构化助手")
        ? "structure"
        : system.includes("内容理解编辑")
          ? "understand"
          : "summarize";
  requests.push({ step, user });
  const value =
    step === "prefilter"
      ? { label: "PASS", reason: "合成范围" }
      : step === "score"
        ? { attentionScore: score }
        : step === "structure"
          ? { scope: "single", category: "company_project", tags: [], subjects: [], fact: null }
          : step === "understand"
            ? {
                itemType: "policy_regulation",
                authorRole: "principal",
                tags: [],
                editorialJudgment: "",
                titleZh: "合成铜矿投产",
                summaryZh: "合成铜矿投产，原帖保留来源说明。",
              }
            : user.includes("body_zh:")
              ? "title_zh: 合成铜矿项目进展\nbody_zh: 合成主帖中文译文。\nsummary_zh: 合成项目进展摘要。"
              : "title_zh: 合成铜矿项目进展\nsummary_zh: 合成项目进展摘要。";
  return {
    choices: [{ message: { content: typeof value === "string" ? value : JSON.stringify(value) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
});
for (const name of ["DASHSCOPE", "ZHIPU", "DEEPSEEK"]) {
  process.env[`${name}_BASE_URL`] = `${provider.url}/v1`;
  process.env[`${name}_API_KEY`] = "test-key";
}
before(async () => {
  config.originalPostAdmissionEnabled = true;
  for (const model of ["qwen3.7-flash", "glm-5.3-flash-selection", "qwen3.8-flash", "glm-5.3-flash", "deepseek-flash"])
    await installUsageFixtureForModel(model);
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${source},'Self-authored original post fixture','rss','T1','editorial')`;
  await ensureModelSourceFixture(source, ["https://example.com/source"]);
});
after(async () => {
  config.originalPostAdmissionEnabled = false;
  await provider.close();
  await stopBoss();
  await closeDb();
});
const post = (text: string): XPostData => ({ tweetId: `post-${T}`, authorName: "Fixture author", handle: "fixture", text });
async function material(name: string, xPost?: XPostData) {
  const { articleId } = await upsertMaterial({
    sourceId: source,
    url: `https://example.com/${T}/${name}`,
    title: `铜矿材料 ${name}`,
    language: "zh",
    bodyStatus: xPost ? "ok" : "none",
    ...(xPost ? { xPost } : {}),
    via: "fetch",
  });
  // Consumer fixture: the producer/storage integration is verified separately by the integration owner.
  if (xPost) await sql`UPDATE articles SET x_post=${sql.json(xPost as never)} WHERE id=${articleId} AND x_post IS DISTINCT FROM ${sql.json(xPost as never)}`;
  return articleId;
}

test("ordinary missing bodies still wait before payment; optional post never fills old input or changes ordinary request text", async () => {
  // Pinned before original-post fields: a field added to all inputs must not invalidate ordinary caches/evaluations.
  assert.equal(
    evaluationInputFingerprint({
      id: "ordinary-fixed",
      sourceId: "source-fixed",
      revision: 1,
      title: "Copper project",
      url: "https://example.com/article",
      author: null,
      publishedAt: new Date("2026-10-01T00:00:00Z"),
      sourceTime: null,
      discoveredAt: new Date("2026-10-02T00:00:00Z"),
      bodyText: "Copper mine production started.",
      excerpt: null,
      bodyStatus: "ok",
      media: [],
      translationZh: null,
      source: { name: "Fixture", kind: "rss", tier: "T1", firstParty: true },
    }),
    "7237ad907593f3c02107065d49887eefbaae367d1108760804247ea4dead6dcc",
  );
  const id = await material("ordinary"),
    input = (await loadAnalyzeInput(id))!;
  assert.equal(Object.hasOwn(input, "xPost"), false);
  assert.equal(Object.hasOwn(translateInputOf(input), "mainText"), false);
  const start = requests.length;
  assert.equal(normalizeAnalysis(await runAnalysis(input)).relevance, "unknown");
  assert.equal(requests.length, start);
  assert.equal(evaluationInputFingerprint(input), evaluationInputFingerprint({ ...input, xPost: null }));
  assert.equal(prefilterUser(input), prefilterUser({ ...input, xPost: null }));
  assert.equal(buildScoreInput(input), buildScoreInput({ ...input, xPost: null }));
  assert.equal(buildArticlePrompt(translateInputOf(input)), buildArticlePrompt(translateInputOf({ ...input, xPost: null })));
  assert.match(PROMPT_VERSIONS.summarize, /^summarize-article\+summarize-article-empty\+identity-context@/);
});

test("closed admission blocks empty/link cached requests and evaluations but preserves old short-text understand", async () => {
  const id = await material("gate-cache", post("https://example.com/only"));
  await analyzeArticle(id); // Explicitly opted-in by this file's before hook; paid judging receipts exist.
  const input = (await loadAnalyzeInput(id))!,
    start = requests.length;
  config.originalPostAdmissionEnabled = false;
  try {
    const result = (await analyzeArticle(id))!;
    assert.equal(result.output!.relevance, "unknown");
    assert.deepEqual(result.receiptIds, []);
    assert.equal(requests.length, start);
    await assert.rejects(prepareEvaluationInput(input), /准入/);
    await assert.rejects(runSelectionPrefilter(input), /准入/);
    await assert.rejects(runSelectionScores(input), /准入/);
    assert.equal(normalizeAnalysis(await runAnalysis(input, { stages: "selection" })).relevance, "unknown");
    score = 20;
    const low = await material("gate-short-low", post("铜矿投产。"));
    assert.equal((await analyzeArticle(low))!.output!.relevance, "unknown");
    score = 95;
    const high = await material("gate-short-high", post("铜矿投产。"));
    const understood = (await analyzeArticle(high))!;
    assert.equal(understood.output!.relevance, "pass");
    assert.equal((await sql`SELECT output->>'writer' AS writer FROM analyses WHERE id=${understood.analysisId!}`)[0].writer, "understand");
  } finally {
    score = 20;
    config.originalPostAdmissionEnabled = true;
  }
});

test("explicit empty and link-only posts keep four judging receipts and no writer receipts, then reuse them", async () => {
  for (const text of ["", "https://example.com/linked"]) {
    const id = await material(text ? "link" : "empty", post(text)),
      start = requests.length;
    const result = (await analyzeArticle(id))!;
    assert.deepEqual(
      requests
        .slice(start)
        .map((r) => r.step)
        .sort(),
      ["prefilter", "score", "score", "structure"],
    );
    assert.equal(result.output!.relevance, "pass");
    assert.equal(result.output!.summaryZh, text);
    assert.equal(result.receiptIds.length, 4);
    const [stored] = await sql`SELECT output,receipt_ids FROM analyses WHERE id=${result.analysisId!}`;
    assert.equal(stored.output.writer, "verbatim");
    assert.equal(stored.output.writerModel, null);
    assert.deepEqual(stored.receipt_ids, result.receiptIds);
    await analyzeArticle(id);
    assert.equal(requests.length - start, 4);
    assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE id=ANY(${result.receiptIds}::bigint[]) AND status='completed'`)[0].n, 4);
  }
});

test("short Chinese is verbatim only in summarize; high score still understands; mixed language uses the post writer", async () => {
  for (const [name, text, points, writer] of [
    ["short-low", "铜矿今日投产。", 20, "verbatim"],
    ["short-high", "铜矿今日投产。", 95, "understand"],
    ["mixed", "铜矿 project construction starts today", 20, "summarize"],
  ] as const) {
    score = points;
    const id = await material(name, post(text)),
      start = requests.length,
      result = (await analyzeArticle(id))!;
    assert.equal((await sql`SELECT output->>'writer' AS kind FROM analyses WHERE id=${result.analysisId!}`)[0].kind, writer);
    if (writer === "summarize") {
      const [saved] = await sql`SELECT summary_zh,output,receipt_ids FROM analyses WHERE id=${result.analysisId!}`;
      assert.equal(saved.summary_zh, "合成项目进展摘要。");
      assert.equal(saved.output.postSummaryKind, "summary");
      assert.equal(saved.output.postTranslation.textZh, "合成主帖中文译文。");
      assert.equal(saved.output.postTranslation.inputRevision, 1);
      assert.ok(saved.receipt_ids.includes(saved.output.postTranslation.receiptId));
      assert.ok(
        requests
          .slice(start)
          .find((request) => request.step === "summarize")!
          .user.includes("summary_zh: <简洁中文导读>"),
      );
      const prior = (await readCurrentSourcePolicy(source))!;
      await saveSourcePolicy(
        source,
        {
          policy: { ...prior, permissions: { ...prior.permissions, store_fulltext: "deny" } },
          expectedVersion: prior.permission_version,
          reason: "Synthetic private translation storage restriction",
        },
        "test",
      );
      try {
        const requestStart = requests.length;
        const restricted = (await analyzeArticle(id))!;
        const [copy] = await sql`SELECT summary_zh,output FROM analyses WHERE id=${restricted.analysisId!}`;
        assert.equal(copy.summary_zh, "合成项目进展摘要。");
        assert.equal(copy.output.postTranslation, undefined, "a summary grant does not permit saving a full translated copy");
        const requested = requests.slice(requestStart).filter((request) => request.step === "summarize");
        assert.equal(requested.length, 1);
        assert.ok(requested[0]!.user.includes("不是全文翻译"));
        assert.ok(!requested[0]!.user.includes("body_zh:"));
        const [writerReceipt] =
          await sql`SELECT request,response FROM receipts WHERE id=ANY(${restricted.receiptIds}::bigint[]) AND purpose='summarize_article'`;
        assert.ok(writerReceipt);
        assert.ok(!JSON.stringify(writerReceipt.request).includes("body_zh:"));
        assert.ok(!JSON.stringify(writerReceipt.response).includes("合成主帖中文译文"));
      } finally {
        const current = (await readCurrentSourcePolicy(source))!;
        await saveSourcePolicy(source, { policy: prior, expectedVersion: current.permission_version, reason: "Restore synthetic source grant" }, "test");
      }
    }

    assert.equal(
      requests.slice(start).some((r) => r.step === "understand"),
      writer === "understand",
    );
    assert.equal(
      requests.slice(start).some((r) => r.step === "summarize"),
      writer === "summarize",
    );
  }
  score = 20;
  assert.equal(parseShortPostOutput("title_zh: 原帖标题\nbody_zh: 完整译文原样保留。").summaryZh, "");
  assert.equal(parseShortPostOutput("title_zh: 原帖标题\nbody_zh: 完整译文原样保留。\nsummary_zh: 完整译文原样保留。").summaryZh, "");
});

test("all model consumers distinguish quoted authors and acquired long text; versions and evaluation fingerprints follow those inputs", async () => {
  const quoted = {
    authorName: "Quoted author",
    handle: "quoted",
    text: "Copper project in Argentina begins construction.",
    url: "https://example.com/status/quote",
    media: [{ kind: "image" as const, url: "https://example.com/quote.png" }],
  };
  const id = await material("quoted", { ...post("铜矿项目进展。"), quoted }),
    input = (await loadAnalyzeInput(id))!;
  for (const rendered of [
    buildMaterial(input),
    prefilterUser(input),
    understandUser(input),
    buildScoreInput(input),
    JSON.stringify(geographyMaterial(input).segments),
  ]) {
    assert.match(rendered, /quoted/);
    assert.match(rendered, /Argentina/);
  }
  assert.match(understandUser(input), /不是作者本人的产出/);
  assert.equal(firstInputImage(input)?.url, quoted.media[0].url);
  const oldHash = evaluationInputFingerprint(input);
  const displayChanged = {
    ...input,
    xPost: {
      ...input.xPost!,
      avatarUrl: "https://example.com/new-avatar.png",
      quoted: { ...quoted, authorName: "New display name", media: [{ ...quoted.media[0], width: 300, height: 200 }] },
    },
  };
  assert.equal(oldHash, evaluationInputFingerprint(displayChanged), "avatar/quoted display names/dimensions are absent from actual model input");
  assert.notEqual(
    oldHash,
    evaluationInputFingerprint({
      ...displayChanged,
      xPost: { ...displayChanged.xPost, quoted: { ...displayChanged.xPost.quoted, media: [{ kind: "image", url: "https://example.com/new-image.png" }] } },
    }),
  );
  assert.notEqual(oldHash, evaluationInputFingerprint({ ...input, xPost: { ...input.xPost!, quoted: { ...quoted, text: "Revised quoted project text." } } }));
  const linked = post("https://example.com/long"),
    merged = withXArticle(linked, { title: "Acquired title", text: "Actual acquired mining article." })!;
  assert.equal(linked.text, "https://example.com/long");
  assert.match(merged.text, /【X 长文】Acquired title/);
  await sql`UPDATE articles SET x_post=${sql.json(linked as never)},x_article=${sql.json({ title: "Acquired title", text: "Actual acquired mining article." })},revision=revision+1 WHERE id=${id}`;
  const acquired = (await loadAnalyzeInput(id))!;
  assert.deepEqual(acquired.xPost, merged);
  assert.notEqual(oldHash, evaluationInputFingerprint(acquired));
  const start = requests.length;
  await analyzeArticle(id);
  assert.ok(requests.slice(start).some((r) => r.step === "summarize" && r.user.includes("Actual acquired mining article.")));
  const fallbackInput = await prepareNewsFallback({
    root: shutdownSignal.signal,
    expected: acquired,
    current: () => loadAnalyzeInput(id),
    articles: [acquired],
  });
  const selection = await runAnalysis(acquired, { stages: "selection", fallbackInput });
  assert.equal(selection.writing, null);
  assert.equal(selection.structure, null);
  assert.equal(normalizeAnalysis(selection).relevance, "pass", "selection-only evaluation retains its prior score-only normalization");
});
