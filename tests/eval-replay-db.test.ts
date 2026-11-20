// The read-only eval replay (scripts/eval-replay.ts) on synthetic rows in the throwaway test database: what it reads and
// counts, that PostgreSQL refuses a write inside its transaction, that it writes nothing, and that it runs as a role that
// may read only the tables it lists. Pure tallies: tests/eval-replay.test.ts.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import postgres from "postgres";
import { closeDb, sql, type Sql } from "@amp/backend/db";
import { getBoss, stopBoss } from "@amp/backend/jobs/queue";
import { REPLAY_TABLES, type GoldCandidate, type GoldLabels } from "../scripts/eval-replay-core.ts";
import { readOnly, runReplay } from "../scripts/eval-replay.ts";
import { installTestConnections } from "./direct-db-fixture.ts";
import { tag } from "./setup.ts";

after(async () => {
  await stopBoss();
  await closeDb();
});

const CLASSIC = "prefilter-shared@aa4cb4ab1b+selection-score-shared@a195d5bf17+weights@20542a669a+understand-shared@0000000001";
const GLOBAL = "prefilter-four-layers-shared@4cbc95fcc9+selection-score-global-shared@d3b4cb6ac0+weights@20542a669a+understand-shared@0000000001";
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
/** Rows of every table the replay reads, plus the receipt attempts, to show it wrote nothing. */
const census = async () => {
  const out: Record<string, number> = {};
  for (const table of [...REPLAY_TABLES, "receipt_attempts"]) {
    const [schema, name] = table.includes(".") ? table.split(".") : ["public", table];
    out[table] = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(schema!)}.${sql(name!)}`)[0]!.n;
  }
  return out;
};

test("the replay counts the stored judgements, SelectBench runs, swipe answers and grouping corrections, read-only, as a role limited to its tables", async () => {
  await getBoss(); // installs the queue schema the shadow report reads (pgboss.job)
  const T = tag(),
    source = `eval-replay-${T}`,
    at = new Date(Date.now() - 86_400_000);
  await sql`INSERT INTO sources(id,name,kind,tier,config) VALUES(${source},'回放合成来源','rss','T1','{}')`;
  const ids = ["a1", "a2", "a3", "a4", "a5", "x1", "a7"].map((n) => `${source}-${n}`);
  for (const id of ids)
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,language,body_text,raw)
      VALUES(${id},${source},${id},${`https://example.invalid/${id}`},'合成标题',${at},${at},'zh','合成正文','{}'::jsonb)`;
  const [a1, a2, a3, a4, a5, x1, a7] = ids as [string, string, string, string, string, string, string];
  // Gold: 1 and 2 select, 3 and 4 reject, 5 either; the snapshot selected 1 and 3.
  const gold: { labels: GoldLabels; candidates: GoldCandidate[] } = {
    labels: { select: [1, 2], reject: [3, 4], either: [5] },
    candidates: [
      { n: 1, id: a1, selected: true },
      { n: 2, id: a2, selected: false },
      { n: 3, id: a3, selected: true },
      { n: 4, id: a4, selected: false },
      { n: 5, id: a5, selected: false },
      { n: 6, id: x1, selected: true },
    ],
  };
  const analysis = async (article: string, revision: number, version: string, selected: boolean | null) =>
    (
      await sql<{ id: string }[]>`INSERT INTO analyses(article_id,input_revision,origin,prompt_version,relevance,selected,output,created_at)
        VALUES(${article},${revision},'model',${version},'pass',${selected},${sql.json({ prefilter: { label: "PASS" }, scores: [70, 70] })},${at})
        RETURNING id`
    )[0]!.id;
  // Classic judged all four decisive cases; global judged 2 (and 3 twice: the later revision counts).
  await analysis(a1, 1, CLASSIC, true);
  await analysis(a2, 1, CLASSIC, false);
  await analysis(a3, 1, CLASSIC, false);
  await analysis(a4, 1, CLASSIC, null);
  const g2 = await analysis(a2, 2, GLOBAL, true);
  await analysis(a3, 2, GLOBAL, true);
  await analysis(a3, 3, GLOBAL, false);
  const gx = await analysis(x1, 1, GLOBAL, true);
  // Rows that are no judgement (editorial/analyze-article.ts): the prefilter-only row committed ahead of the scores,
  // under the prefilter version alone, and a stale diagnostic under the full version on a newer revision. Counted,
  // the first would make a rules version "prefilter-… | ?" and the second would turn case 2 into "not selected".
  const incomplete = async (article: string, revision: number, version: string, output: Record<string, unknown>, selected: boolean | null) =>
    sql`INSERT INTO analyses(article_id,input_revision,origin,prompt_version,relevance,selected,output,created_at)
      VALUES(${article},${revision},'model',${version},'pass',${selected},${sql.json(output as never)},${at})`;
  const PREFILTER_ONLY = "prefilter-four-layers-shared@4cbc95fcc9";
  await incomplete(a4, 2, PREFILTER_ONLY, { prefilter: { label: "PASS", reason: "合成" } }, false);
  await incomplete(a2, 3, GLOBAL, { stale_after_response: true, output_applied: false }, null);
  // Case 7 (a second label set below): judged completely only under classic; under global only the two non-judgements.
  await analysis(a7, 1, CLASSIC, false);
  await incomplete(a7, 2, PREFILTER_ONLY, { prefilter: { label: "PASS", reason: "合成" } }, false);
  await incomplete(a7, 3, GLOBAL, { stale_after_response: true, output_applied: false }, null);

  const run = `sb-eval-replay-${T}`;
  await sql`INSERT INTO selectbench_runs(id,label,sample_size,prompt_version,models,summary) VALUES(${run},'合成',4,${GLOBAL},'{m1}','{}'::jsonb)`;
  for (const [n, decision] of [
    [1, "select"],
    [2, "select"],
    [3, null],
    [4, "reject"],
  ] as const)
    await sql`INSERT INTO selectbench_results(run_id,model,case_id,title,gold,decision) VALUES(${run},'m1',${`owner-20261105-00${n}`},'合成','select',${decision})`;
  await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status,request)
    VALUES(${`eval-replay-${T}`},'fixture','score_article','evaluation:synthetic','completed',${sql.json({ promptVersion: "selection-score-global-shared@d3b4cb6ac0" })})`;
  // Before the gold was labelled (2026-11-05 Beijing time): not counted. A production receipt is not counted either.
  await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status,request,created_at)
    VALUES(${`eval-replay-old-${T}`},'fixture','score_article','evaluation:synthetic','completed',${sql.json({ promptVersion: "selection-score-global-shared@d3b4cb6ac0" })},
      '2026-11-04T23:59:00+08:00')`;
  await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status,request)
    VALUES(${`eval-replay-live-${T}`},'fixture','score_article',${`content:${a1}`},'completed',${sql.json({ promptVersion: "selection-score-global-shared@d3b4cb6ac0" })})`;

  // Swipe: two cards of a deck dealt from global analyses; one starred but kept (missed), one answered then taken back.
  const day = "2026-11-12";
  for (const [position, article, analysisId, kind, system] of [
    [0, a2, g2, "near_miss", "kept"],
    [1, x1, gx, "near_pass", "selected"],
  ] as const)
    await sql`INSERT INTO ai.swipe_cards(day,position,article_id,analysis_id,kind,system,title,preview,source_name,actor)
      VALUES(${day}::date,${position},${article},${analysisId},${kind},${system},'合成','合成','合成','account:1')`;
  await sql`INSERT INTO ai.swipe_answers(day,article_id,revision,answer,actor) VALUES(${day}::date,${a2},1,'star','account:1')`;
  await sql`INSERT INTO ai.swipe_answers(day,article_id,revision,answer,actor) VALUES(${day}::date,${x1},1,'yes','account:1'),(${day}::date,${x1},2,NULL,'account:1')`;

  // Grouping: a person's detach now, a person's merge 90 days ago, and the engine's own merge (not a correction).
  await sql`INSERT INTO audit_log(actor,action,subject,before) VALUES('admin:test','content.detach',${`content:${a4}`},${sql.json({ facts: [1] })})`;
  await sql`INSERT INTO audit_log(actor,action,subject,after,created_at) VALUES('admin:test','story.merge','story:1',${sql.json({ into: 2 })},${hoursAgo(24 * 90)})`;
  await sql`INSERT INTO audit_log(actor,action,subject,after) VALUES('grouping','story.merge','story:3',${sql.json({ into: 4 })})`;
  await sql`INSERT INTO settings(key,value,updated_by) VALUES('events.shadow',${sql.json("on")},'test') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
  // Shadow: the rules tied a1 to another report's fact; a person then kept a1 standalone. The live engine left it apart.
  const candidate = {
    factId: 9_000_001,
    storyId: 9_000_002,
    articleId: a5,
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
  };
  const { SHADOW_RULESET } = await import("../packages/backend/src/pipeline/events/shadow.ts");
  await sql`INSERT INTO events.shadow_decisions(article_id,article_revision,ruleset,verdict,rule,target_fact_id,target_story_id,candidates,would_call,
      live_verdict,live_fact_id,live_story_id,live_called,decided_at)
    VALUES(${a1},1,${SHADOW_RULESET},'same_fact','fingerprint',9000001,9000002,${sql.json([candidate])},0,'new-story',9000003,9000004,true,${hoursAgo(10)})`;
  await sql`INSERT INTO grouping_overrides(article_id,reason,actor) VALUES(${a1},'合成人工独立','admin:test')`;

  const now = new Date();
  const before = await census();
  const report = await runReplay(sql, { days: 14, now, gold });
  assert.deepEqual(await census(), before, "nothing was written");
  assert.equal(report.readOnly, true, "the queries ran inside a read-only transaction");

  assert.deepEqual(report.gold.labels, { decisive: 4, select: 2, reject: 2, either: 1 });
  assert.deepEqual([report.gold.snapshot.tp, report.gold.snapshot.fp, report.gold.snapshot.fn, report.gold.snapshot.tn], [1, 1, 1, 1]);
  assert.deepEqual(
    report.gold.stored.map((s) => [s.ruleset, s.key]),
    [
      ["global", "prefilter-four-layers-shared@4cbc95fcc9 | selection-score-global-shared@d3b4cb6ac0+weights@20542a669a"],
      ["classic", "prefilter-shared@aa4cb4ab1b | selection-score-shared@a195d5bf17+weights@20542a669a"],
    ],
    "the prefilter-only row makes no rules version of its own",
  );
  const stored = Object.fromEntries(report.gold.stored.map((s) => [s.ruleset, s]));
  assert.deepEqual([stored.classic!.scored, stored.classic!.tp, stored.classic!.fn, stored.classic!.tn, stored.classic!.fp], [4, 1, 1, 2, 0]);
  assert.deepEqual(
    [stored.global!.scored, stored.global!.tp, stored.global!.tn, stored.global!.missing],
    [2, 1, 1, 2],
    "case 3's later global revision (not selected) counts",
  );
  assert.deepEqual(
    report.gold.selectbench.map((b) => [b.runId, b.model, b.ruleset, b.scored, b.failed, b.tp, b.tn, b.missing]),
    [[run, "m1", "global", 3, 1, 2, 1, 1]],
  );
  assert.deepEqual(report.gold.global, { status: "available", from: ["analyses", "selectbench"], scored: 3 });
  assert.deepEqual(report.gold.evaluationReceipts, [{ purpose: "score_article", version: "selection-score-global-shared@d3b4cb6ac0", receipts: 1 }]);

  assert.deepEqual(report.swipe.total, { cards: 2, unanswered: 1, days: 1, answered: 1, no: 0, yes: 0, star: 1, missed: 1, extra: 0, widened: 0 });
  assert.deepEqual(
    report.swipe.byRuleset.map((g) => [g.ruleset, g.cards, g.missed]),
    [["global", 2, 1]],
  );
  assert.deepEqual(
    report.swipe.byKind.map((k) => [k.kind, k.cards, k.answered]),
    [
      ["near_miss", 1, 1],
      ["near_pass", 1, 0],
    ],
  );

  assert.deepEqual(report.grouping.corrections, [
    { action: "content.detach", total: 1, inWindow: 1 },
    { action: "story.merge", total: 1, inWindow: 0 },
  ]);
  assert.deepEqual(report.grouping.overrides, [{ mode: "standalone", rows: 1 }]);
  assert.equal(report.grouping.shadowSwitch, '"on"');
  assert.deepEqual(report.grouping.shadowRows, [{ ruleset: SHADOW_RULESET, rows: 1 }]);
  assert.deepEqual(report.grouping.agreement.human, { pairs: 1, shadowRight: 0, shadowWrong: 1, liveRight: 1, liveWrong: 0, truncated: false });

  // Only non-judgements under global: no global baseline, the answer stays "needs budget".
  const only = await runReplay(sql, { days: 14, now, gold: { labels: { select: [7], reject: [] }, candidates: [{ n: 7, id: a7, selected: false }] } });
  assert.deepEqual(
    only.gold.stored.map((s) => [s.ruleset, s.scored, s.fn]),
    [["classic", 1, 1]],
  );
  assert.deepEqual(only.gold.selectbench, []);
  assert.deepEqual(only.gold.global, { status: "not available, needs budget", scored: 0 });

  // The same replay as a role that may read only the listed tables gives the same report: it reads nothing else.
  // A fixed name, removed first, so a run killed half way leaves the role behind only until the next run.
  const role = "eval_replay_probe";
  const dropRole = async () => {
    if ((await sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`).length) await sql`DROP OWNED BY ${sql(role)}`;
    await sql`DROP ROLE IF EXISTS ${sql(role)}`;
  };
  await dropRole();
  await sql`CREATE ROLE ${sql(role)} NOLOGIN`;
  // Parsed as the application's connections parse (process-config.ts): bigint and numeric as numbers.
  const numberType = (oid: number) => ({ to: oid, from: [oid], serialize: (value: unknown) => String(value), parse: (value: string) => Number(value) });
  const limited = postgres(process.env.DATABASE_URL!, {
    max: 1,
    onnotice: () => {},
    connection: { jit: "off", role },
    types: { int8: numberType(20), numeric: numberType(1700) },
  });
  try {
    for (const schema of new Set(REPLAY_TABLES.filter((t) => t.includes(".")).map((t) => t.split(".")[0]!)))
      await sql`GRANT USAGE ON SCHEMA ${sql(schema)} TO ${sql(role)}`;
    for (const table of REPLAY_TABLES) {
      const [schema, name] = table.includes(".") ? table.split(".") : ["public", table];
      await sql`GRANT SELECT ON ${sql(schema!)}.${sql(name!)} TO ${sql(role)}`;
    }
    const [who] = await limited<{ current_user: string }[]>`SELECT current_user`;
    assert.equal(who!.current_user, role);
    assert.deepEqual(await runReplay(limited as unknown as Sql, { days: 14, now, gold }), report);
    // The limit is real: without one listed table the replay fails instead of skipping it.
    await sql`REVOKE SELECT ON ai.swipe_answers FROM ${sql(role)}`;
    await assert.rejects(runReplay(limited as unknown as Sql, { days: 14, now, gold }), /permission denied/);
  } finally {
    await limited.end();
    await dropRole();
  }
});

test("PostgreSQL refuses a write inside the replay's transaction", async () => {
  const key = `eval-replay-write-${tag()}`;
  await assert.rejects(
    readOnly(sql, (tx) => tx`INSERT INTO settings(key,value,updated_by) VALUES(${key},${sql.json(1)},'test')`),
    (error: { code?: string; message: string }) => error.code === "25006" && /read-only transaction/.test(error.message),
  );
  await assert.rejects(
    readOnly(sql, (tx) => tx`UPDATE analyses SET selected = NOT coalesce(selected, false)`),
    /read-only transaction/,
  );
  assert.equal((await sql`SELECT 1 FROM settings WHERE key = ${key}`).length, 0);
  // Outside it the same write succeeds, so the refusal is the transaction's, not the table's.
  await sql`INSERT INTO settings(key,value,updated_by) VALUES(${key},${sql.json(1)},'test')`;
  await sql`DELETE FROM settings WHERE key = ${key}`;
});

test("every query of the replay runs inside its transaction: none goes through the process's shared handles", async () => {
  // Runs last: it takes the process's handles away. The replay gets its own pool, as the script passes its handle; the
  // shared handles (which a module function falls back to when it is not given the transaction) throw instead.
  await stopBoss();
  await closeDb();
  const numberType = (oid: number) => ({ to: oid, from: [oid], serialize: (value: unknown) => String(value), parse: (value: string) => Number(value) });
  const own = postgres(process.env.DATABASE_URL!, {
    max: 1,
    onnotice: () => {},
    connection: { jit: "off" },
    types: { int8: numberType(20), numeric: numberType(1700) },
  });
  const outside: string[] = [];
  const shared = ((strings: TemplateStringsArray) => {
    outside.push(strings.join("?").replace(/\s+/g, " ").slice(0, 80));
    throw new Error("a query outside the replay's transaction");
  }) as unknown as Sql;
  const restore = installTestConnections(shared, shared, shared);
  try {
    const report = await runReplay(own as unknown as Sql, { days: 14 });
    assert.deepEqual(outside, [], "no query used the shared handles");
    assert.equal(report.readOnly, true);
    assert.ok(
      report.grouping.shadowRows.length > 0 && report.grouping.agreement.rows > 0,
      "the shadow report read its rows (and then the audit log, overrides, facts and queue)",
    );
    assert.ok(report.grouping.corrections.length > 0, "the corrections were read");
  } finally {
    restore();
    await own.end();
  }
});
