// The event shadow in the mode production runs in (TASK-0367): no embeddings, so live grouping recalls by the
// character-pair overlap and so does the shadow. Each fixture is grouped by the live engine itself (events/group.ts
// groupArticle, against a local model stub that counts every call), then decided by the shadow; the shadow's verdict
// must make sense and its call forecast (would_call) must never exceed the calls the live engine made for that report.
// Also: embeddings are an explicit opt-in (EMBEDDINGS_ENABLED=true); a key alone, as the qwen presets need, never
// switches live grouping to paid vector recall.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@amp/backend/config";
import { closeDb, sql } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { groupArticle } from "@amp/backend/events/group";
import { getBoss, stopBoss } from "@amp/backend/jobs/queue";
import { EMBEDDING_MODEL, embeddingsAvailable } from "@amp/backend/providers/embeddings";
import { publishArticle } from "@amp/backend/publication/publish";
import { recallMode } from "../packages/backend/src/pipeline/events/recall.ts";
import { type CandidateEvidence, CONFIRM_BELOW_LEXICAL } from "../packages/backend/src/pipeline/events/rules.ts";
import { shadowAgreement } from "../packages/backend/src/pipeline/events/agreement.ts";
import { shadowDecide, shadowRuleset } from "../packages/backend/src/pipeline/events/shadow.ts";
import { body, shadowSource, unique, WIRE } from "./event-shadow-fixture.ts";
import { stub, tag } from "./setup.ts";
import { installUsageFixtureForEmbedding, installUsageFixtureForModel } from "./usage-protection-fixture.ts";

let embeddingCalls = 0;
/** The judge's relation for a candidate, by the text of its block; the review call answers SAME_OCCURRENCE. */
let judge: (block: string) => string = () => "SAME_OCCURRENCE";
const provider = await stub(async (_hit, request) => {
  const payload = JSON.parse(request.body);
  if (request.url.endsWith("/embeddings")) {
    embeddingCalls++;
    return { data: payload.input.map((_text: string, index: number) => ({ index, embedding: [1, 0] })), usage: { prompt_tokens: 10 } };
  }
  const input: string = payload.messages[1].content;
  // By default every judged candidate is the same occurrence, so a merge under the confirm bar also takes the review
  // call; the multi-fact fixtures set other answers.
  const ids = [...input.matchAll(/【候选 (C\d+)】/g)].map((match) => match[1]!);
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            query: "合成",
            queryScope: "single",
            decisions: ids.map((id) => ({
              id,
              relation: judge(input.split(`【候选 ${id}】`)[1]?.split("【候选")[0] ?? ""),
              confidence: 0.96,
              note: "合成关系判断",
              evidence: null,
            })),
            a: "合成报道甲",
            b: "合成报道乙",
            relation: "SAME_OCCURRENCE",
            confidence: 0.96,
            difference: "按合成原文核对具体发生",
            selection: { addsValue: true, reason: "合成新增事实" },
          }),
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 100 },
  };
});
process.env.DEEPSEEK_BASE_URL = provider.url;
process.env.DEEPSEEK_API_KEY = "synthetic-only";
process.env.GROUP_REVIEW_MODEL = "deepseek-flash";
// A DashScope key is present, as it is wherever a qwen preset is configured; EMBEDDINGS_ENABLED is not set.
process.env.DASHSCOPE_API_KEY = "synthetic-only";
process.env.DASHSCOPE_BASE_URL = provider.url;
delete process.env.EMBEDDINGS_ENABLED;
config.modelCallsEnabled = true;
await installUsageFixtureForModel("deepseek-flash");
await installUsageFixtureForEmbedding(EMBEDDING_MODEL);
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

interface Input {
  source: string;
  title: string;
  summary: string;
  body: string;
  url?: string;
  /** Published this many hours before it is collected (over 48 makes it archive history). */
  hoursOld?: number;
  /** Nominated for selection (archive history that is no nomination only ever attaches to near-identical copies). */
  selected?: boolean;
}
/** A collected report with its analysis, published, waiting for the live engine to group it. */
async function report(i: Input): Promise<string> {
  const { articleId } = await upsertMaterial({
    sourceId: i.source,
    url: i.url ?? `https://example.com/${i.source}/${tag()}`,
    title: i.title,
    bodyText: i.body,
    bodyHtml: `<p>${i.body}</p>`,
    via: "fetch",
    language: "zh",
    publishedAt: new Date(Date.now() - (i.hoursOld ?? 1) * 3_600_000),
  });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,model,prompt_version,relevance,category,title_zh,summary_zh,selected,output)
    VALUES(${articleId},1,'rule','synthetic','synthetic-shadow','pass','project_development',${i.title},${i.summary},${i.selected ?? false},
      ${sql.json({ scope: "single", fact: { title: i.title, subject: "合成矿企", action: "推进", object: "合成项目", occurredAt: null } })})`;
  await publishArticle(articleId);
  return articleId;
}

/** Group by the live engine, counting its model calls; then decide by the shadow. */
async function both(articleId: string) {
  const hits = provider.hits(),
    embeddings = embeddingCalls;
  const live = await groupArticle(articleId);
  const liveCalls = provider.hits() - hits - (embeddingCalls - embeddings);
  const outcome = await shadowDecide(articleId);
  assert.equal(outcome.state, "decided");
  const [row] = await sql<
    {
      verdict: string;
      rule: string;
      would_call: number;
      similarity: number | null;
      target_fact_id: number | null;
      live_called: boolean;
      candidates: CandidateEvidence[];
    }[]
  >`
    SELECT verdict,rule,would_call,similarity,target_fact_id,live_called,candidates FROM events.shadow_decisions
    WHERE article_id=${articleId} AND ruleset=${shadowRuleset("lexical")}`;
  assert.ok(row, "the row is stored under the lexical ruleset");
  // The certain part never exceeds the live engine's calls. Nothing bounds it from above: reviews and story
  // consolidation depend on the model's answers.
  assert.ok(row.would_call <= liveCalls, `${row.verdict}/${row.rule}: certain calls ${row.would_call} never exceed the live engine's ${liveCalls}`);
  return { live, liveCalls, row, recall: outcome.state === "decided" ? outcome.recall : null };
}

test("embeddings are an explicit opt-in: a DashScope key alone leaves live grouping and the shadow lexical", () => {
  assert.equal(embeddingsAvailable(), false, "a key, no EMBEDDINGS_ENABLED");
  assert.equal(recallMode(), "lexical");
  for (const value of ["false", "1", "TRUE", "on", "yes", ""]) {
    process.env.EMBEDDINGS_ENABLED = value;
    assert.equal(embeddingsAvailable(), false, `EMBEDDINGS_ENABLED=${JSON.stringify(value)} is not the exact literal true`);
  }
  process.env.EMBEDDINGS_ENABLED = "true";
  try {
    assert.equal(embeddingsAvailable(), true, "the exact literal true and a key");
    assert.equal(recallMode(), "vector");
    config.modelCallsEnabled = false;
    assert.equal(embeddingsAvailable(), false, "MODEL_CALLS_ENABLED=false still switches them off");
    config.modelCallsEnabled = true;
    const key = process.env.DASHSCOPE_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    assert.equal(embeddingsAvailable(), false, "opted in without a key");
    process.env.DASHSCOPE_API_KEY = key;
  } finally {
    config.modelCallsEnabled = true;
    delete process.env.EMBEDDINGS_ENABLED;
  }
});

test("same address, same hash, near-duplicate body, unrelated and a lexical near-match: sensible verdicts, never more calls than live", async () => {
  // Unrelated: nothing shares its characters. Live finds no candidate and calls nothing; the shadow founds a new event.
  const lone = await both(await report({ source: await shadowSource(), title: unique(18), summary: unique(60), body: body() }));
  assert.deepEqual([lone.live.verdict, lone.liveCalls], ["new-story", 0]);
  assert.deepEqual([lone.row.verdict, lone.row.rule, lone.row.would_call], ["new_event", "no_candidate", 0]);
  assert.ok(lone.recall && lone.recall.vectorsRead === 0, "no vector read");

  // Same address from a second source.
  const words = unique(8);
  const url = `https://example.com/shared/${tag()}`;
  const first = await report({
    source: await shadowSource(),
    title: `${words}铜矿扩建获批`,
    summary: `${words}铜矿扩建获批，${unique(40)}`,
    body: body(),
    url,
  });
  const firstGrouped = await both(first);
  assert.equal(firstGrouped.live.verdict, "new-story");
  const sameUrl = await both(await report({ source: await shadowSource(), title: `转载：${words}铜矿`, summary: unique(50), body: body(), url }));
  assert.deepEqual([sameUrl.live.verdict, sameUrl.live.factId, sameUrl.liveCalls], ["same-url", firstGrouped.live.factId, 0]);
  assert.deepEqual(
    [sameUrl.row.verdict, sameUrl.row.rule, sameUrl.row.target_fact_id, sameUrl.row.would_call],
    ["same_fact", "same_url", firstGrouped.live.factId, 0],
  );

  // The same page collected again by its source under a new address: the same stored hash. Live judges it (one call).
  const source = await shadowSource();
  const page = { source, title: `${unique(10)}冶炼厂项目环评公示`, summary: `${unique(30)}，环评公示期十个工作日。`, body: body() };
  const original = await both(await report(page));
  const again = await both(await report(page));
  assert.deepEqual([again.live.verdict, again.live.factId, again.liveCalls], ["same-fact", original.live.factId, 1]);
  assert.deepEqual([again.row.verdict, again.row.rule, again.row.target_fact_id, again.row.would_call], ["same_fact", "content_hash", original.live.factId, 0]);

  // A wire story carried by another site with page chrome and a new headline: a near-duplicate body.
  const wireWords = unique(6);
  const wire = await both(await report({ source: await shadowSource(), title: `${wireWords}三期选厂完成带料试车`, summary: WIRE.slice(0, 120), body: WIRE }));
  const copy = await both(
    await report({
      source: await shadowSource(),
      title: `紫金矿业${wireWords}三期选厂带料试车`,
      summary: WIRE.slice(40, 160),
      body: `【来源：某财经网】${WIRE}（本文转载自公司公告）`,
    }),
  );
  assert.equal(copy.live.factId, wire.live.factId, "live joined the copy to the original's fact");
  assert.ok(copy.liveCalls >= 1);
  assert.deepEqual([copy.row.verdict, copy.row.rule, copy.row.target_fact_id, copy.row.would_call], ["same_fact", "fingerprint", wire.live.factId, 0]);

  // A lexical near-match: alike wording, different bodies, other sources. Neither engine ties it without the judge;
  // under the lexical confirm bar the live engine also asks the review call, which depends on the judge's answer.
  const nearWords = unique(10);
  const baseSummary = `${nearWords}锂矿项目签约，${unique(30)}`;
  const base = await both(await report({ source: await shadowSource(), title: `${nearWords}锂矿项目签约`, summary: baseSummary, body: body() }));
  const near = await both(
    await report({ source: await shadowSource(), title: `${nearWords}锂矿项目正式签约仪式`, summary: `${nearWords}锂矿项目签约，${unique(30)}`, body: body() }),
  );
  assert.equal(near.live.factId, base.live.factId);
  assert.ok(
    near.row.similarity! >= 0.25 && near.row.similarity! < CONFIRM_BELOW_LEXICAL,
    `overlap ${near.row.similarity} between the floor and the confirm bar`,
  );
  assert.deepEqual(
    [near.liveCalls, near.row.verdict, near.row.rule, near.row.would_call, near.row.candidates[0]!.confirmIfSame],
    [2, "undecided", "similar_unsure", 1, true],
    "judge and review",
  );
  // The same wording on another body from another site: above the confirm bar, one call each, and no certain duplicate
  // (that rule's 0.92 is a cosine).
  const close = await both(await report({ source: await shadowSource(), title: `${nearWords}锂矿项目签约`, summary: baseSummary, body: body() }));
  assert.ok(close.row.similarity! >= CONFIRM_BELOW_LEXICAL);
  assert.deepEqual([close.liveCalls, close.row.verdict, close.row.rule, close.row.would_call], [1, "undecided", "similar_unsure", 1]);
  assert.ok(
    close.recall && close.recall.vectorsRead === 0 && close.recall.scored === 9 && close.recall.pool === 9,
    `the nine reports grouped before it all compared by their overlap, no vector read: ${JSON.stringify(close.recall)}`,
  );

  assert.equal(embeddingCalls, 0, "with a key but no opt-in, live grouping asked for no embedding");
  assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM embeddings`)[0]!.n, 0, "and stored none");
});

test("several weak facts: the relation call is certain; reviews and story consolidation depend on the model and are not bounded", async (t) => {
  t.after(() => {
    judge = () => "SAME_OCCURRENCE";
  });
  /** Three earlier facts in three stories whose reports share a core of wording with the query (overlap about 0.3). */
  const seed = async (core: string, marker: string) => {
    judge = () => "UNRELATED";
    const facts: number[] = [];
    for (const tagWord of ["", marker, ""]) {
      const grouped = await both(await report({ source: await shadowSource(), title: `${core}${tagWord}${unique(6)}`, summary: unique(14), body: body() }));
      assert.equal(grouped.live.verdict, "new-story");
      facts.push(grouped.live.factId!);
    }
    assert.equal(new Set(facts).size, 3);
    return facts;
  };

  // The judge calls every candidate unrelated: the live engine makes its relation call and nothing else.
  const coreA = unique(10);
  await seed(coreA, unique(4));
  const unrelated = await both(await report({ source: await shadowSource(), title: `${coreA}${unique(6)}`, summary: unique(14), body: body() }));
  assert.ok(unrelated.row.similarity! >= 0.25 && unrelated.row.similarity! < CONFIRM_BELOW_LEXICAL, `overlap ${unrelated.row.similarity}`);
  assert.equal(unrelated.row.candidates.length, 3, "three judged facts");
  assert.deepEqual([unrelated.liveCalls, unrelated.row.verdict, unrelated.row.would_call], [1, "undecided", 1], "certain 1 = live 1");

  // The judge calls only the second fact the same occurrence: one review confirms it.
  const coreB = unique(10),
    marker = unique(4);
  const facts = await seed(coreB, marker);
  judge = (block) => (block.includes(marker) ? "SAME_OCCURRENCE" : "UNRELATED");
  const second = await both(await report({ source: await shadowSource(), title: `${coreB}${unique(6)}`, summary: unique(14), body: body() }));
  assert.deepEqual([second.live.verdict, second.live.factId], ["same-fact", facts[1]], "live joined the second fact after its review");
  assert.deepEqual([second.liveCalls, second.row.verdict, second.row.would_call], [2, "undecided", 1], "certain 1 <= live 2");

  // The judge calls all three the same occurrence, in three stories: the live engine joins one and then consolidates the
  // stories the report ties together, judging each pair of stories (events/group.ts consolidate). The certain part stays
  // 1 and nothing caps the rest.
  const coreC = unique(10);
  await seed(coreC, unique(4));
  judge = () => "SAME_OCCURRENCE";
  const three = await both(await report({ source: await shadowSource(), title: `${coreC}${unique(6)}`, summary: unique(14), body: body() }));
  t.diagnostic(`three stories, all judged the same occurrence: live ${three.liveCalls} calls, certain ${three.row.would_call}`);
  assert.equal(three.row.would_call, 1);
  assert.ok(three.liveCalls >= 4, `live ${three.liveCalls}: relation call, review and story-consolidation calls`);
});

test("no output claims an upper bound on the calls", async () => {
  const { shadowForecastLine } = await import("../packages/backend/src/pipeline/events/agreement.ts");
  const { reconcileLines } = await import("@amp/backend/operations/reconcile");
  const line = shadowForecastLine({ wouldCall: 3, outsideCalled: 2, forecast: 5, liveCalled: 4 });
  const day = reconcileLines({
    day: "2026-11-18",
    sources: { enabled: 0, withNew: 0, silent: { failing: 0, waiting: 0, unstable: 0, overdue: 0, unknown: 0, quiet: 0 } },
    flow: { collected: 0, public: 0, selected: 0, scoredNotPublic: 0 },
    translation: { due: 0, missing: 0 },
    balance: [],
    shadow: { rows: 9, judged: 8, sameFact: 2, agree: 1, undecided: 5, forecast: 5, liveCalled: 4 },
  }).at(-1)!;
  for (const text of [line, day]) {
    assert.match(text, /至少 ?(调用模型 )?5 次/);
    assert.doesNotMatch(text, /至多|上限|最多|at most|upper/i, "a lower bound only");
    assert.match(text, /取决于模型回答/, "and it says the rest depends on the model");
  }
});

test("a report outside the rules can cost the live engine more than one call: the report counts it only as at least one", async (t) => {
  t.after(() => {
    judge = () => "SAME_OCCURRENCE";
  });
  const core = unique(10);
  judge = () => "UNRELATED";
  const earlier = await both(await report({ source: await shadowSource(), title: `${core}${unique(6)}`, summary: unique(14), body: body() }));
  judge = () => "SAME_OCCURRENCE";
  // Archive history (published five days before it was collected), nominated: live judges it against its candidates and,
  // the pick being under the confirm bar, reviews it before attaching it.
  const oldId = await report({ source: await shadowSource(), title: `${core}${unique(6)}`, summary: unique(14), body: body(), hoursOld: 120, selected: true });
  const old = await both(oldId);
  assert.deepEqual([old.live.verdict, old.live.factId, old.liveCalls], ["historical-attached", earlier.live.factId, 2], "relation call and review");
  assert.deepEqual([old.row.verdict, old.row.rule, old.row.would_call, old.row.live_called], ["not_judged", "historical", 0, true]);
  await getBoss(); // the report also counts the queue's jobs whose window was full
  // Exactly this row's moment (stored to the microsecond), so no row of the other fixtures falls in the window.
  const [at] = await sql<
    { from: Date; to: Date }[]
  >`SELECT date_trunc('milliseconds',decided_at) AS from,date_trunc('milliseconds',decided_at)+interval '1 millisecond' AS to
    FROM events.shadow_decisions WHERE article_id=${oldId} AND ruleset=${shadowRuleset("lexical")}`;
  const a = await shadowAgreement(at!.from, at!.to, { mode: "lexical" });
  assert.equal(a.rows, 1);
  assert.deepEqual([a.calls.outsideCalled, a.calls.forecast], [1, 1], "the two live calls enter as at least one");
});

test("opted in, live grouping does embed: the switch is what decides, not the key", async () => {
  process.env.EMBEDDINGS_ENABLED = "true";
  try {
    const words = unique(10);
    await groupArticle(
      await report({ source: await shadowSource(), title: `${words}钾盐项目投产`, summary: `${words}钾盐项目投产，${unique(30)}`, body: body() }),
    );
    assert.ok(embeddingCalls > 0, "the paid vector recall runs only with EMBEDDINGS_ENABLED=true");
  } finally {
    delete process.env.EMBEDDINGS_ENABLED;
  }
});
