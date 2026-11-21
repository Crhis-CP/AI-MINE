// The event shadow's queue, switch and reports (packages/backend/src/pipeline/events/shadow-queue.ts, shadow.ts,
// agreement.ts): off unless switched on; a new live decision, made by the real grouping job, is queued and its row
// replaces an old one; a scheduling failure never reaches the grouping job; the agreement report, its daily line and
// the daily housekeeping. No model call: the grouped reports here have nothing to compare with.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { registerEventJobs } from "@amp/backend/jobs/events";
import { getBoss, QUEUES, stopBoss } from "@amp/backend/jobs/queue";
import { type Reconciliation, reconcileLines } from "@amp/backend/operations/reconcile";
import { dailyRetention } from "@amp/backend/operations/retention";
import { shadowJobsWithFullWindow } from "../packages/backend/src/jobs/module-queues.ts";
import { shadowAgreement, shadowAgreements, shadowHeadline } from "../packages/backend/src/pipeline/events/agreement.ts";
import { eventShadowEnabled, shadowRuleset } from "../packages/backend/src/pipeline/events/shadow.ts";
import { scheduleEventShadow, shadowQueue } from "../packages/backend/src/pipeline/events/shadow-queue.ts";
import { body, fact, hoursAgo, liveDecision, report, shadowSource, unique } from "./event-shadow-fixture.ts";

before(async () => {
  // The live engine's grouping checks the news controls; the shadow itself never does.
  await sql`UPDATE ops.lane_controls SET paused=false,revision=revision+1`;
});
after(async () => {
  await stopBoss();
  await closeDb();
});

type Handler = (jobs: Array<{ id: string; data: unknown }>) => Promise<unknown>;
/** The worker's event queues with their real handlers, called directly instead of by a polling queue. */
async function workers() {
  const handlers = new Map<string, Handler>();
  await registerEventJobs({
    work: async (queue: string, _options: unknown, handler: Handler) => {
      handlers.set(queue, handler);
    },
  } as unknown as Awaited<ReturnType<typeof getBoss>>);
  return handlers;
}
const queued = (id: string) =>
  sql<{ id: string; data: unknown }[]>`SELECT id,data FROM pgboss.job WHERE name='news.events.shadow' AND data->>'articleId'=${id} AND state='created'`;
const shadowRow = async (articleId: string) =>
  (
    await sql<{ verdict: string; rule: string; live_verdict: string | null }[]>`SELECT verdict,rule,live_verdict FROM events.shadow_decisions
    WHERE article_id=${articleId} AND ruleset=${shadowRuleset()}`
  )[0];
async function switchShadow(value: "on" | "off") {
  await sql`INSERT INTO settings(key,value,updated_by) VALUES('events.shadow',${sql.json(value)},'test') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
  assert.equal(await eventShadowEnabled(0), value === "on");
}

test("off unless the switch says on: a re-delivered grouping queues nothing, then only a fill-only job, and queued jobs stop with the switch", async () => {
  const handlers = await workers();
  await sql`DELETE FROM settings WHERE key='events.shadow'`;
  const kept = await report({ source: await shadowSource(), titleZh: unique(), body: body(), publishedAt: hoursAgo(1) });
  const own = await fact("合成已归组报道", [kept]);
  await liveDecision(kept, "new-story", own);

  assert.equal(await eventShadowEnabled(0), false, "no settings row: off");
  const grouped = (await handlers.get(QUEUES.group)!([{ id: "g1", data: { lane: "news", articleId: kept } }])) as { verdict: string };
  assert.equal(grouped.verdict, "kept");
  assert.equal((await queued(kept)).length, 0, "switched off, the grouping queues nothing");

  await switchShadow("on");
  await handlers.get(QUEUES.group)!([{ id: "g2", data: { lane: "news", articleId: kept } }]);
  const jobs = await queued(kept);
  assert.deepEqual(
    jobs.map((j) => j.data),
    [{ lane: "news", articleId: kept, keep: true }],
    "a run that decided nothing new only fills a missing row",
  );
  const [done] = (await handlers.get("news.events.shadow")!(jobs)) as Array<{ output: { state: string; verdict: string } }>;
  // A report like no other: without embeddings recall is complete, so the rules found a new event, as live did.
  assert.deepEqual([done!.output.state, done!.output.verdict], ["decided", "new_event"]);
  assert.ok(await shadowRow(kept));
  assert.equal((await sql`SELECT 1 FROM events.fact_timing WHERE fact_id=${own.factId}`).length, 1, "the fact's timing is observed");
  assert.equal((await sql`SELECT 1 FROM publication.event_rank WHERE article_id=${kept}`).length, 1, "the public report's order is projected");
  const [again] = (await handlers.get("news.events.shadow")!(jobs)) as Array<{ output: { state: string } }>;
  assert.equal(again!.output.state, "kept", "a repeated keep-only job leaves the row as it is");
  assert.equal(await scheduleEventShadow(kept, "signal"), false, "discussion posts are not judged by the rules");
  assert.equal(await scheduleEventShadow(kept, "skipped"), false);

  await switchShadow("off");
  const [stopped] = (await handlers.get("news.events.shadow")!(jobs)) as Array<{ output: { state: string } }>;
  assert.equal(stopped!.output.state, "skipped", "switched off, a job already queued does nothing");
  assert.equal(await scheduleEventShadow(kept, "same-fact"), false);
});

test("a new decision of the real grouping job is queued as a full decision, and its row replaces an older one", async () => {
  const handlers = await workers();
  await switchShadow("on");
  // Not yet grouped and like nothing else: the live engine founds a story without asking any model.
  const fresh = await report({
    source: await shadowSource(),
    titleZh: unique(),
    summaryZh: unique(),
    body: body(),
    publishedAt: hoursAgo(1),
    unconfirmed: true,
  });
  const grouped = (await handlers.get(QUEUES.group)!([{ id: "g-new", data: { lane: "news", articleId: fresh } }])) as { verdict: string };
  assert.equal(grouped.verdict, "new-story");
  const jobs = await queued(fresh);
  assert.deepEqual(
    jobs.map((j) => j.data),
    [{ lane: "news", articleId: fresh }],
    "a new live decision is decided again in full",
  );
  assert.equal(await scheduleEventShadow(fresh, "same-fact"), true);
  assert.equal((await queued(fresh)).length, 1, "one job per report waits in the queue at a time");
  // A row left from an earlier decision of the same revision must not survive the new one.
  await sql`INSERT INTO events.shadow_decisions(article_id,article_revision,ruleset,verdict,rule,candidates)
    VALUES(${fresh},1,${shadowRuleset()},'not_judged','manual','[]'::jsonb)`;
  const [done] = (await handlers.get("news.events.shadow")!(jobs)) as Array<{ output: { state: string } }>;
  assert.equal(done!.output.state, "decided");
  const row = (await shadowRow(fresh))!;
  assert.notEqual(row.rule, "manual");
  assert.equal(row.live_verdict, "new-story", "the live engine's own decision is beside it");
  await switchShadow("off");
});

test("a failure to queue the shadow never reaches the grouping job", async () => {
  const handlers = await workers();
  await switchShadow("on");
  const kept = await report({ source: await shadowSource(), titleZh: unique(), body: body(), publishedAt: hoursAgo(1) });
  await fact("合成排队失败", [kept]);
  const boss = await getBoss();
  await boss.deleteQueue("news.events.shadow");
  try {
    const grouped = (await handlers.get(QUEUES.group)!([{ id: "g-fail", data: { lane: "news", articleId: kept } }])) as { verdict: string };
    assert.equal(grouped.verdict, "kept", "the grouping job finished as if the shadow did not exist");
  } finally {
    await boss.createQueue("news.events.shadow", shadowQueue.options);
  }
  assert.equal(await scheduleEventShadow(kept, "same-fact"), true, "with the queue back, scheduling works again");
  await switchShadow("off");
});

test("shadow jobs whose window reached its bound are counted from the queue's completed jobs", async () => {
  await switchShadow("on");
  const id = await report({ source: await shadowSource(), titleZh: unique(), body: body(), publishedAt: hoursAgo(1) });
  assert.equal(await scheduleEventShadow(id, "new-story"), true);
  await sql`UPDATE pgboss.job SET state='completed',completed_on=now(),output=${sql.json({ state: "decided", recall: { windowFull: true } })}
    WHERE name='news.events.shadow' AND data->>'articleId'=${id}`;
  assert.equal(await shadowJobsWithFullWindow(hoursAgo(1), new Date(Date.now() + 60_000)), 1);
  await switchShadow("off");
});

test("with no shadow row in a window the report reads nothing else and says so in zeros", async () => {
  let queries = 0;
  const counting = ((strings: TemplateStringsArray, ...values: never[]) => {
    queries++;
    return sql(strings, ...values);
  }) as unknown as typeof sql;
  const a = await shadowAgreement(hoursAgo(400), hoursAgo(399), { mode: "lexical" }, counting);
  assert.deepEqual([a.rows, a.judged, a.outside, a.calls.forecast, a.human.pairs, a.human.truncated, a.windowFull], [0, 0, 0, 0, 0, false, 0]);
  assert.equal(queries, 1, "one read of the shadow rows, and no audit log, membership or queue read after it");
  // Without a mode it reads which modes the worker recorded in the window (one query by the decided_at index): none,
  // so nothing else is read.
  queries = 0;
  await shadowAgreement(hoursAgo(400), hoursAgo(399), {}, counting);
  assert.equal(queries, 1);
});

test("agreement: same-fact agreement, the undecided share, the call forecast and both engines against people's corrections", async () => {
  const source = await shadowSource();
  const r = async () => report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(12) });
  const [a1, a2, b1, c1, d1, e1, m1, g1, h1, o1] = [
    await r(),
    await r(),
    await r(),
    await r(),
    await r(),
    await r(),
    await r(),
    await r(),
    await r(),
    await r(),
  ];
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
      VALUES(${article},1,${shadowRuleset()},${verdict},${rule},${target?.factId ?? null},${target?.storyId ?? null},${sql.json(candidates as never)},${wouldCall},
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
  // Outside the rules but the live engine called: it keeps the live path after a switch, so it counts one call.
  await insert(o1, "not_judged", "not_passed", null, [], { verdict: "new-story", fact: null, called: true }, 0);
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
    {
      rows: 9,
      judged: 6,
      decided: 6,
      undecided: 0,
      calls: { wouldCall: 1, outsideCalled: 1, forecast: 2, liveCalled: 4 },
      sameFact: { rows: 5, agree: 1 },
    },
  );
  assert.deepEqual(a.byRule, {
    "same_fact/fingerprint": 4,
    "same_fact/certain_duplicate": 1,
    "undecided/similar_unsure": 1,
    "new_event/no_candidate": 1,
    "not_judged/manual": 1,
    "not_judged/not_passed": 1,
  });
  assert.deepEqual(a.pairs, { total: 5, shadowSame: 5, liveSame: 1, both: 1 });
  assert.deepEqual(a.newEvent, { rows: 1, liveJoinedFact: 1, liveJoinedStory: 0 });
  assert.deepEqual(a.recallHit, { eligible: 3, hit: 1 });
  assert.deepEqual(a.human, { pairs: 3, shadowRight: 1, shadowWrong: 2, liveRight: 2, liveWrong: 1, truncated: false });
  assert.deepEqual([a.outside, a.windowFull], [2, 0]);
  const newest = await shadowAgreement(from, to, { auditLimit: 1 });
  assert.ok(newest.human.truncated && newest.human.pairs < a.human.pairs, "past the bound only the newest corrections are read, and that is said");

  assert.deepEqual(await shadowHeadline(from, to), {
    rows: 8,
    judged: 6,
    sameFact: 5,
    agree: 1,
    undecided: 0,
    forecast: 2,
    liveCalled: 4,
  });

  // An undecided row: one relation call for certain; whatever follows depends on the model and is not added.
  const u1 = await r();
  await sql`INSERT INTO events.shadow_decisions(article_id,article_revision,ruleset,verdict,rule,candidates,would_call,live_verdict,live_called,decided_at)
    VALUES(${u1},1,${shadowRuleset("lexical")},'undecided','similar_unsure',
      ${sql.json([
        { ...cand(a2, shared), confirmIfSame: true },
        { ...cand(b1, other), confirmIfSame: false },
      ] as never)},
      1,'new-story',true,${hoursAgo(20)})`;
  const undecided = await shadowAgreement(hoursAgo(21), hoursAgo(19));
  assert.deepEqual(undecided.calls, { wouldCall: 1, outsideCalled: 0, forecast: 1, liveCalled: 1 });
  assert.equal(undecided.ruleset, shadowRuleset("lexical"), "the window's rows decide the mode, not this process's environment");
  assert.equal((await shadowAgreement(hoursAgo(21), hoursAgo(19), { mode: "vector" })).rows, 0, "an explicit mode reads only its rows");
  // The worker switched to vectors within the window: its newest row decides the default, and both modes are reported
  // apart; the headline counts the other mode's rows without mixing them in.
  await sql`INSERT INTO events.shadow_decisions(article_id,article_revision,ruleset,verdict,rule,candidates,would_call,decided_at)
    VALUES(${u1},1,${shadowRuleset("vector")},'new_event','no_candidate','[]'::jsonb,0,${hoursAgo(19.5)})`;
  assert.equal((await shadowAgreement(hoursAgo(21), hoursAgo(19))).ruleset, shadowRuleset("vector"));
  assert.deepEqual(
    (await shadowAgreements(hoursAgo(21), hoursAgo(19))).map((x) => [x.ruleset, x.rows]),
    [
      [shadowRuleset("vector"), 1],
      [shadowRuleset("lexical"), 1],
    ],
  );
  const mixed = await shadowHeadline(hoursAgo(21), hoursAgo(19));
  assert.deepEqual([mixed.rows, mixed.otherModeRows], [1, 1]);
  // A newer row outside the window does not decide the window's mode.
  assert.equal((await shadowAgreement(hoursAgo(21), hoursAgo(19.75))).ruleset, shadowRuleset("lexical"));
  const day: Reconciliation = {
    day: "2026-11-18",
    sources: { enabled: 0, withNew: 0, silent: { failing: 0, waiting: 0, unstable: 0, overdue: 0, unknown: 0, quiet: 0 } },
    flow: { collected: 0, public: 0, selected: 0, scoredNotPublic: 0 },
    translation: { due: 0, missing: 0 },
    balance: [],
    shadow: { rows: 130, judged: 120, sameFact: 40, agree: 38, undecided: 50, forecast: 70, liveCalled: 100 },
  };
  assert.equal(
    reconcileLines(day).at(-1),
    "事件新规则试运行（读者看不到）：归组 130 篇，其中按规则试判 120 篇；判为同一件事 40 篇，与现在的归组一致 38 篇；仍待模型判断 50 篇（42%）；估计切换后这 130 篇至少调用模型 70 次；另有复核和事件合并的调用，取决于模型回答；现网调用过模型的 100 篇",
  );
  assert.ok(
    reconcileLines({ ...day, shadow: { ...day.shadow!, otherModeRows: 3 } })
      .at(-1)!
      .endsWith("现网调用过模型的 100 篇；另有 3 篇按另一种比较方式记录，未计入"),
  );
  assert.ok(!reconcileLines({ ...day, shadow: null }).some((line) => line.startsWith("事件新规则")), "no line on a day the rules judged nothing");

  await sql`UPDATE events.shadow_decisions SET decided_at=now()-interval '46 days' WHERE article_id=${e1}`;
  assert.equal((await dailyRetention()).deletedShadowDecisions, 1, "the daily housekeeping drops rows past the 45-day retention, the rest stay");
  assert.equal((await shadowAgreement(from, to)).rows, 8);
});
