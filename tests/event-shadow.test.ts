// The event rules in shadow (packages/backend/src/pipeline/events): after the live engine grouped a report, the rules
// decide it again from the live graph and stored vectors only, and the answer is stored next to the live one. Asserts
// the rows, the call forecast, that no receipt, publication or analysis changes, the switch and queue, and the
// agreement report with people's corrections.
import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { lexicalSimilarity } from "@amp/backend/events/relate";
import * as live from "@amp/backend/events/group";
import { registerEventJobs } from "@amp/backend/jobs/events";
import { QUEUES, stopBoss, type getBoss } from "@amp/backend/jobs/queue";
import { type Reconciliation, reconcileLines } from "@amp/backend/operations/reconcile";
import { shadowAgreement, shadowHeadline } from "../packages/backend/src/pipeline/events/agreement.ts";
import * as recall from "../packages/backend/src/pipeline/events/recall.ts";
import { EVENT_RULESET } from "../packages/backend/src/pipeline/events/rules.ts";
import { eventShadowEnabled, pruneShadowDecisions, shadowDecide } from "../packages/backend/src/pipeline/events/shadow.ts";
import { scheduleEventShadow } from "../packages/backend/src/pipeline/events/shadow-queue.ts";
import { body, fact, hoursAgo, join, liveDecision, report, shadowSource, unique, vector, yesterdayAt } from "./event-shadow-fixture.ts";

before(async () => {
  // The live engine's "kept" path checks the news controls; the shadow itself never does.
  await sql`UPDATE ops.lane_controls SET paused=false,revision=revision+1`;
});
after(async () => {
  await stopBoss();
  await closeDb();
});

interface ShadowRow {
  verdict: string;
  rule: string;
  target_fact_id: number | null;
  similarity: number | null;
  candidates: Array<{ articleId: string; factId: number; cosine: number | null }>;
  would_call: number;
  live_verdict: string | null;
  live_fact_id: number | null;
  live_called: boolean | null;
}
const shadowRow = async (articleId: string) =>
  (await sql<ShadowRow[]>`SELECT * FROM events.shadow_decisions WHERE article_id=${articleId} AND ruleset=${EVENT_RULESET}`)[0];
/** Everything a reader or the ledger could see, and the paid-call records. */
const visible = async () => ({
  publications: JSON.stringify(await sql`SELECT * FROM publications ORDER BY article_id`),
  ledger: JSON.stringify(await sql`SELECT * FROM selected_ledger ORDER BY seq`),
  analyses: JSON.stringify(await sql`SELECT id,article_id,output FROM analyses ORDER BY id`),
  memberships: JSON.stringify(await sql`SELECT * FROM fact_articles ORDER BY fact_id,article_id`),
  receipts: (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipts`)[0]!.n,
  embeddings: (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM embeddings`)[0]!.n,
});

test("the shadow's recall values are the live engine's", () => {
  assert.equal(recall.DOCUMENT_RECALL_MONTHS, live.DOCUMENT_RECALL_MONTHS);
  assert.equal(recall.DOCUMENT_RECALL_TOP_FACTS, live.DOCUMENT_RECALL_TOP_FACTS);
  assert.equal(recall.KEY_FACT_RECALL_HOURS, live.KEY_FACT_RECALL_HOURS);
  assert.equal(recall.KEY_FACT_TOP_FACTS, live.KEY_FACT_TOP_FACTS);
  const source = readFileSync(new URL("../packages/backend/src/events/group.ts", import.meta.url), "utf8");
  for (const [name, value] of [
    ["RECALL_DAYS", recall.RECALL_DAYS],
    ["RECALL_MIN_COSINE", recall.RECALL_MIN_COSINE],
    ["DOCUMENT_RECALL_ROWS", recall.DOCUMENT_RECALL_ROWS],
  ] as const)
    assert.ok(source.includes(`const ${name} = ${value};`), name);
});

test("the prefilter keeps the best lexical scores, the scorer is the live overlap, and the vector cache stays within its bytes", () => {
  for (const [a, b] of [
    ["紫金矿业卡莫阿铜矿", "卡莫阿铜矿三期试车"],
    ["Rio Tinto approves", "rio tinto  approves US$144m"],
    ["\u{20000}\u{20001}铜矿", "\u{20001}铜矿项目"],
    ["", "铜矿"],
    ["铜", ""],
  ])
    assert.equal(recall.lexicalScorer(a)(b), lexicalSimilarity(a, b), `${a} / ${b}`);
  const scored = [
    { id: "b", score: 0.5 },
    { id: "a", score: 0.5 },
    { id: "c", score: 0.9 },
    { id: "d", score: 0.1 },
  ];
  assert.deepEqual(
    recall.topByScore(scored, 3).map((x) => x.id),
    ["c", "a", "b"],
  );
  const cache = new recall.VectorCache(64);
  cache.set("x", "h", new Float32Array(8));
  cache.set("y", "h", new Float32Array(8));
  assert.ok(cache.get("x", "h"), "a hit counts as a use");
  cache.set("z", "h", new Float32Array(8));
  assert.equal(cache.bytes, 64);
  assert.equal(cache.get("y", "h"), undefined, "the least recently used vector went first");
  assert.ok(cache.get("x", "h") && cache.get("z", "h"));
  assert.equal(cache.get("x", "other text"), undefined, "a vector of another text is never reused");
  cache.set("huge", "h", new Float32Array(32));
  assert.equal(cache.get("huge", "h"), undefined, "a vector larger than the whole bound is not kept");
  assert.equal(cache.bytes, 64);
});

test("a wire copy carried by another site is the same fact by its fingerprint; nothing a reader sees and no receipt changes", async () => {
  const words = unique(10),
    text = body();
  const original = await report({ source: await shadowSource(), titleZh: `${words}三期选厂完成带料试车`, body: text, publishedAt: hoursAgo(5) });
  const first = await fact("合成试车", [original], hoursAgo(5));
  await liveDecision(original, "new-story", first, hoursAgo(5));
  const copy = await report({
    source: await shadowSource(),
    titleZh: `紫金矿业${words}三期选厂带料试车`,
    body: `【来源：某财经网】${text}（本文转载自公司公告）`,
    publishedAt: hoursAgo(2),
  });
  await join(first.factId, copy);
  await liveDecision(copy, "same-fact", first, new Date(), 990001);
  const before = await visible();

  const outcome = await shadowDecide(copy);
  assert.equal(outcome.state, "decided");
  const row = (await shadowRow(copy))!;
  assert.deepEqual(
    { verdict: row.verdict, rule: row.rule, target: row.target_fact_id, calls: row.would_call },
    { verdict: "same_fact", rule: "fingerprint", target: first.factId, calls: 0 },
    "the rules tie the copy without a call: no selected coverage, a single event",
  );
  assert.deepEqual(
    row.candidates.map((c) => c.articleId),
    [original],
  );
  assert.deepEqual(
    { verdict: row.live_verdict, fact: row.live_fact_id, called: row.live_called },
    { verdict: "same-fact", fact: first.factId, called: true },
    "the live engine's decision is recorded beside it",
  );
  assert.deepEqual(await visible(), before, "no publication, ledger, analysis, membership, receipt or vector changed");
});

test("a page the same source collected again under a new address is the same fact by its stored hash", async () => {
  const source = await shadowSource(),
    title = `${unique(10)}扩建冶炼厂项目获批`,
    text = body();
  const first = await report({ source, titleZh: title, body: text, publishedAt: hoursAgo(30) });
  const earlier = await fact(title, [first], hoursAgo(30));
  await liveDecision(first, "new-story", earlier, hoursAgo(30));
  const again = await report({ source, titleZh: title, body: text, publishedAt: hoursAgo(30), discoveredAt: hoursAgo(1) });
  const own = await fact(title, [again]);
  await liveDecision(again, "new-story", own);
  await shadowDecide(again);
  const row = (await shadowRow(again))!;
  assert.deepEqual([row.verdict, row.rule, row.target_fact_id], ["same_fact", "content_hash", earlier.factId]);
  assert.equal(row.live_verdict, "new-story", "the live engine founded a story for it: the agreement report counts that pair as a disagreement");
});

test("a report like nothing else is a new event only when its stored vector shows recall had its full reach", async () => {
  const lone = await report({ source: await shadowSource(), titleZh: unique(), summaryZh: unique(), body: body(), publishedAt: hoursAgo(1) });
  const own = await fact("合成孤立报道", [lone]);
  await liveDecision(lone, "new-story", own);
  await shadowDecide(lone);
  let row = (await shadowRow(lone))!;
  assert.deepEqual([row.verdict, row.rule, row.would_call], ["undecided", "vector_missing", 1]);
  // Three dimensions: no other test stores vectors of this size, so nothing else is comparable with it.
  await vector(lone, "query", [0.2, 0.9, 0.1]);
  await shadowDecide(lone);
  row = (await shadowRow(lone))!;
  assert.deepEqual([row.verdict, row.rule, row.would_call, row.candidates.length], ["new_event", "no_candidate", 0, 0], "the second run replaces the first");
});

test("two near-identical reports with the same title on the same day are certain duplicates by their stored vectors", async () => {
  const title = `${unique(6)}完成铜矿项目收购交易`;
  const first = await report({ source: await shadowSource(), titleZh: title, body: "短讯。", publishedAt: yesterdayAt(2) });
  const earlier = await fact(title, [first], yesterdayAt(2));
  await liveDecision(first, "new-story", earlier, yesterdayAt(2));
  const second = await report({ source: await shadowSource(), titleZh: title, body: "另一条短讯。", publishedAt: yesterdayAt(3) });
  await join(earlier.factId, second);
  await liveDecision(second, "same-fact", earlier);
  await vector(first, "candidate", [1, 0, 0, 0, 0]);
  await vector(second, "query", [0.99, 0.05, 0, 0, 0]);
  await shadowDecide(second);
  const row = (await shadowRow(second))!;
  assert.deepEqual([row.verdict, row.rule, row.target_fact_id], ["same_fact", "certain_duplicate", earlier.factId]);
  assert.ok(row.similarity! > 0.99 && row.candidates[0]!.cosine! > 0.99, "the cosine of the stored vectors is the evidence");
});

test("a person's placement, a discussion post and a roundup are outside the rules and recall nothing", async () => {
  const placed = await report({ source: await shadowSource(), titleZh: unique(), body: body(), publishedAt: hoursAgo(1) });
  await sql`INSERT INTO grouping_overrides(article_id,reason,actor) VALUES(${placed},'合成人工独立','admin:test')`;
  const post = await report({ source: await shadowSource("hot_signal"), titleZh: unique(), body: body(), publishedAt: hoursAgo(1) });
  const roundup = await report({ source: await shadowSource(), titleZh: unique(), body: body(), publishedAt: hoursAgo(1), scope: "composite" });
  for (const [id, rule] of [
    [placed, "manual"],
    [post, "not_passed"],
    [roundup, "composite"],
  ] as const) {
    const outcome = await shadowDecide(id);
    assert.ok(outcome.state === "decided" && outcome.recall === null, `${rule}: no recall`);
    const row = (await shadowRow(id))!;
    assert.deepEqual([row.verdict, row.rule, row.would_call, row.candidates], ["not_judged", rule, 0, []]);
  }
});

test("a report grouped after the live decision is not a candidate: it cannot answer for what the live engine could see", async () => {
  const words = unique(10),
    text = body();
  const query = await report({ source: await shadowSource(), titleZh: `${words}签署锂矿包销协议`, body: text, publishedAt: hoursAgo(4) });
  const own = await fact("合成包销协议", [query]);
  await liveDecision(query, "new-story", own, new Date(Date.now() - 1000));
  const later = await report({ source: await shadowSource(), titleZh: `某公司${words}签署锂矿包销协议`, body: `据报道，${text}`, publishedAt: hoursAgo(3) });
  const theirs = await fact("合成包销协议转载", [later]);
  await shadowDecide(query);
  assert.deepEqual((await shadowRow(query))!.candidates, [], "grouped after the decision");
  await sql`UPDATE grouping_decisions SET created_at=now() WHERE article_id=${query}`;
  await shadowDecide(query);
  const row = (await shadowRow(query))!;
  assert.deepEqual([row.verdict, row.rule, row.target_fact_id], ["same_fact", "fingerprint", theirs.factId], "grouped before a later decision");
});

test("off unless the switch says on: nothing is queued, then one job per grouped report that writes its row, timing and order", async () => {
  const handlers = new Map<string, (jobs: Array<{ id: string; data: unknown }>) => Promise<unknown>>();
  await registerEventJobs({
    work: async (queue: string, _options: unknown, handler: (jobs: Array<{ id: string; data: unknown }>) => Promise<unknown>) => {
      handlers.set(queue, handler);
    },
  } as unknown as Awaited<ReturnType<typeof getBoss>>);
  const queued = (id: string) =>
    sql<{ id: string; data: unknown }[]>`SELECT id,data FROM pgboss.job WHERE name='news.events.shadow' AND data->>'articleId'=${id} AND state='created'`;
  const kept = await report({ source: await shadowSource(), titleZh: unique(), body: body(), publishedAt: hoursAgo(1) });
  const own = await fact("合成已归组报道", [kept]);
  await liveDecision(kept, "new-story", own);

  assert.equal(await eventShadowEnabled(0), false, "no settings row: off");
  const grouped = (await handlers.get(QUEUES.group)!([{ id: "g1", data: { lane: "news", articleId: kept } }])) as { verdict: string };
  assert.equal(grouped.verdict, "kept");
  assert.equal((await queued(kept)).length, 0, "switched off, the grouping queues nothing");

  await sql`INSERT INTO settings(key,value,updated_by) VALUES('events.shadow',${sql.json("on")},'test')`;
  assert.equal(await eventShadowEnabled(0), true);
  await handlers.get(QUEUES.group)!([{ id: "g2", data: { lane: "news", articleId: kept } }]);
  const jobs = await queued(kept);
  assert.deepEqual(
    jobs.map((j) => j.data),
    [{ lane: "news", articleId: kept, keep: true }],
    "a run that decided nothing new only fills a missing row",
  );
  const [done] = (await handlers.get("news.events.shadow")!(jobs)) as Array<{ output: { state: string; verdict: string } }>;
  assert.deepEqual([done!.output.state, done!.output.verdict], ["decided", "undecided"]);
  assert.ok(await shadowRow(kept));
  assert.equal((await sql`SELECT 1 FROM events.fact_timing WHERE fact_id=${own.factId}`).length, 1, "the fact's timing is observed");
  assert.equal((await sql`SELECT 1 FROM publication.event_rank WHERE article_id=${kept}`).length, 1, "the public report's order is projected");
  const [again] = (await handlers.get("news.events.shadow")!(jobs)) as Array<{ output: { state: string } }>;
  assert.equal(again!.output.state, "kept", "a repeated keep-only job leaves the row as it is");
  assert.equal(await scheduleEventShadow(kept, "signal"), false, "discussion posts are not judged by the rules");
  assert.equal(await scheduleEventShadow(kept, "skipped"), false);

  await sql`UPDATE settings SET value=${sql.json("off")} WHERE key='events.shadow'`;
  assert.equal(await eventShadowEnabled(0), false);
  const [stopped] = (await handlers.get("news.events.shadow")!(jobs)) as Array<{ output: { state: string } }>;
  assert.equal(stopped!.output.state, "skipped", "switched off, a job already queued does nothing");
  assert.equal(await scheduleEventShadow(kept, "same-fact"), false);
});

test("agreement: same-fact agreement, the undecided share, the call forecast and both engines against people's corrections", async () => {
  const source = await shadowSource();
  const r = async () => report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(12) });
  const [a1, a2, b1, c1, d1, e1, m1, g1, h1] = [await r(), await r(), await r(), await r(), await r(), await r(), await r(), await r(), await r()];
  const shared = await fact("合成共同事实", [a1, a2]);
  const other = await fact("合成另一事实", [b1]);
  const merged = await fact("合成后来合并的事件", [m1]);
  const decided = hoursAgo(10);
  const cand = (articleId: string, f: { factId: number; storyId: number }) => ({
    factId: f.factId,
    storyId: f.storyId,
    articleId,
    cosine: null,
    lexical: 0.5,
    sameUrl: false,
    sameHash: false,
    titleKeyEqual: false,
    documentKey: false,
    fingerprint: null,
    countryConflict: false,
    sameDay: true,
    occurredGapDays: null,
  });
  const insert = async (
    article: string,
    verdict: string,
    rule: string,
    target: { factId: number; storyId: number } | null,
    candidates: unknown[],
    liveRow: { verdict: string; fact: { factId: number; storyId: number } | null; called: boolean },
    wouldCall: number,
  ) =>
    sql`INSERT INTO events.shadow_decisions(article_id,article_revision,ruleset,verdict,rule,target_fact_id,target_story_id,candidates,would_call,
        live_verdict,live_fact_id,live_story_id,live_called,decided_at)
      VALUES(${article},1,${EVENT_RULESET},${verdict},${rule},${target?.factId ?? null},${target?.storyId ?? null},${sql.json(candidates as never)},${wouldCall},
        ${liveRow.verdict},${liveRow.fact?.factId ?? null},${liveRow.fact?.storyId ?? null},${liveRow.called},${decided})`;
  // Agrees: a1 is in the fact the rules named.
  await insert(a1, "same_fact", "fingerprint", shared, [cand(a2, shared)], { verdict: "same-fact", fact: shared, called: true }, 0);
  // Disagrees, and a person later kept b1 standalone: the rules were wrong, the live engine (which left it apart) right.
  await insert(b1, "same_fact", "certain_duplicate", shared, [cand(a2, shared)], { verdict: "new-story", fact: other, called: true }, 1);
  await sql`INSERT INTO grouping_overrides(article_id,reason,actor) VALUES(${b1},'合成人工独立','admin:test')`;
  // Superseded: an editor asked for a regroup after it.
  await insert(c1, "undecided", "similar_unsure", null, [cand(a2, shared)], { verdict: "new-story", fact: null, called: true }, 2);
  await sql`INSERT INTO audit_log(actor,action,subject,after) VALUES('admin:test','content.rerun.group',${`content:${c1}`},${sql.json({} as never)})`;
  // A new event the live engine put into an existing fact.
  await insert(d1, "new_event", "no_candidate", null, [], { verdict: "same-fact", fact: shared, called: true }, 0);
  await insert(e1, "not_judged", "manual", null, [], { verdict: "manual", fact: null, called: false }, 0);
  // A person merged m1's story into b1's: the rules, which tied m1 to b1's fact, were right; the live engine had split them.
  await insert(m1, "same_fact", "fingerprint", other, [cand(b1, other)], { verdict: "new-story", fact: merged, called: false }, 0);
  await sql`INSERT INTO audit_log(actor,action,subject,after) VALUES('admin:test','story.merge',${`story:${merged.storyId}`},${sql.json({ into: other.storyId })})`;
  // Both labels on one pair: a person took h1 out of b1's fact, and h1's story was merged into b1's. The pair stays
  // "different": the live engine, which kept h1 out of that fact, was right; the rules, which tied it there, were not.
  await insert(h1, "same_fact", "fingerprint", other, [cand(b1, other)], { verdict: "same-fact", fact: merged, called: false }, 0);
  await sql`INSERT INTO audit_log(actor,action,subject,before) VALUES('admin:test','content.detach',${`content:${h1}`},${sql.json({ facts: [other.factId], stories: [other.storyId] })})`;
  // The grouping engine's own merges are its answers, not labels: g1's pair would otherwise be labelled by this one.
  await insert(g1, "same_fact", "fingerprint", shared, [cand(a2, shared)], { verdict: "new-story", fact: other, called: false }, 0);
  await sql`INSERT INTO audit_log(actor,action,subject,after) VALUES('grouping','story.merge',${`story:${shared.storyId}`},${sql.json({ into: other.storyId })})`;

  // The rows above were decided ten hours ago; the other tests' rows of this file are decided now and stay outside.
  const from = hoursAgo(11),
    to = hoursAgo(9);
  const a = await shadowAgreement(from, to);
  assert.deepEqual(
    { rows: a.rows, judged: a.judged, decided: a.decided, undecided: a.undecided, calls: a.calls, sameFact: a.sameFact },
    { rows: 8, judged: 6, decided: 6, undecided: 0, calls: { wouldCall: 1, liveCalled: 3 }, sameFact: { rows: 5, agree: 1 } },
  );
  assert.deepEqual(a.byRule, {
    "same_fact/fingerprint": 4,
    "same_fact/certain_duplicate": 1,
    "undecided/similar_unsure": 1,
    "new_event/no_candidate": 1,
    "not_judged/manual": 1,
  });
  assert.deepEqual(a.pairs, { total: 5, shadowSame: 5, liveSame: 1, both: 1 });
  assert.deepEqual(a.newEvent, { rows: 1, liveJoinedFact: 1, liveJoinedStory: 0 });
  assert.deepEqual(a.recallHit, { eligible: 3, hit: 1 });
  assert.deepEqual(a.human, { pairs: 3, shadowRight: 1, shadowWrong: 2, liveRight: 2, liveWrong: 1 });

  assert.deepEqual(await shadowHeadline(from, to), { judged: 6, sameFact: 5, agree: 1, undecided: 0 });
  const day: Reconciliation = {
    day: "2026-11-18",
    sources: { enabled: 0, withNew: 0, silent: { failing: 0, waiting: 0, unstable: 0, overdue: 0, unknown: 0, quiet: 0 } },
    flow: { collected: 0, public: 0, selected: 0, scoredNotPublic: 0 },
    translation: { due: 0, missing: 0 },
    balance: [],
    shadow: { judged: 120, sameFact: 40, agree: 38, undecided: 50 },
  };
  assert.equal(
    reconcileLines(day).at(-1),
    "事件新规则试运行（读者看不到）：试判 120 篇；判为同一件事 40 篇，与现在的归组一致 38 篇；仍需模型判断 50 篇（42%）",
  );
  assert.ok(!reconcileLines({ ...day, shadow: null }).some((line) => line.startsWith("事件新规则")), "no line on a day the rules judged nothing");

  await sql`UPDATE events.shadow_decisions SET decided_at=now()-interval '46 days' WHERE article_id=${e1}`;
  assert.equal(await pruneShadowDecisions(), 1, "rows past the 45-day retention go, the rest stay");
  assert.equal((await shadowAgreement(from, to)).rows, 7);
});
