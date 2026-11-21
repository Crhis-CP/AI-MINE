// The read-only eval replay (TASK-0367, scripts/eval-replay.ts): its pure tallies on fixtures and on the public gold
// files, that the role it connects as may read every table it reads, and that it imports no model client.
// The seeded database run is tests/eval-replay-db.test.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { closeDb, initializeDb, sql } from "@amp/backend/db";
import { tallySwipe } from "../packages/backend/src/admin/swipe.ts";
import { planRoleGrants, quoteRelation, relationIdentity, SEQUENCES, TABLE_GRANTS, type Catalog } from "../scripts/db-roles/grants.ts";
import {
  benchBaselines,
  globalBaseline,
  goldCases,
  renderReport,
  REPLAY_TABLES,
  scoreGold,
  snapshotBaseline,
  storedBaselines,
  summaryLines,
  swipeReport,
  type GoldCase,
  type ReplayReport,
  type SwipeCardRow,
} from "../scripts/eval-replay-core.ts";
import { readGold, reportDir } from "../scripts/eval-replay.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLASSIC = "prefilter-shared@aa4cb4ab1b+selection-score-shared@a195d5bf17+weights@20542a669a+understand-shared@0000000001";
const CLASSIC_POST = `${CLASSIC}+summarize-short-post`;
const GLOBAL = "prefilter-four-layers-shared@4cbc95fcc9+selection-score-global-shared@d3b4cb6ac0+weights@20542a669a+understand-shared@0000000001";

/** Five synthetic cases: 1 and 2 select, 3 and 4 reject, 5 either. */
const CASES: GoldCase[] = [
  { n: 1, articleId: "a1", caseId: "owner-20261105-001", gold: "select" },
  { n: 2, articleId: "a2", caseId: "owner-20261105-002", gold: "select" },
  { n: 3, articleId: "a3", caseId: "owner-20261105-003", gold: "reject" },
  { n: 4, articleId: "a4", caseId: "owner-20261105-004", gold: "reject" },
  { n: 5, articleId: "a5", caseId: "owner-20261105-005", gold: "either" },
];

test("the frozen 11-05 snapshot on the public gold files: 116 decisive cases, 63% agreement and the red list", () => {
  const { labels, candidates } = readGold();
  const cases = goldCases(labels, candidates);
  assert.deepEqual(
    [
      cases.length,
      cases.filter((c) => c.gold === "select").length,
      cases.filter((c) => c.gold === "reject").length,
      cases.filter((c) => c.gold === "either").length,
    ],
    [119, 32, 84, 3],
    "case #80 is unlabelled and left out",
  );
  assert.equal(cases.find((c) => c.n === 7)!.caseId, "owner-20261105-007", "the ids eval-selection.ts and SelectBench use");
  const s = snapshotBaseline(cases, candidates);
  assert.deepEqual([s.decisive, s.scored, s.missing, s.tp, s.fp, s.fn, s.tn], [116, 116, 0, 8, 19, 24, 65]);
  assert.deepEqual([s.agreement, s.precision, s.recall], [62.9, 29.6, 25]);
  assert.deepEqual(s.missed, [7, 9, 17, 19, 20, 21, 22, 24, 32, 39, 40, 41, 66, 69, 73, 76, 81, 105, 108, 109, 112, 117, 118, 120]);
  assert.deepEqual(s.wronglySelected, [11, 27, 29, 36, 50, 52, 55, 58, 64, 65, 71, 75, 77, 78, 86, 87, 91, 92, 103]);
});

test("a label set must be consistent with its candidates", () => {
  assert.throws(() => goldCases({ select: [1], reject: [1] }, [{ n: 1, id: "a1" }]), /two labels/);
  assert.throws(() => goldCases({ select: [2], reject: [] }, [{ n: 1, id: "a1" }]), /no candidate/);
});

test("gold scoring: either cases never count, an undecided case is missing rather than wrong", () => {
  const s = scoreGold(
    CASES,
    new Map([
      [1, true],
      [3, true],
      [4, false],
      [5, true],
    ]),
  );
  assert.deepEqual([s.decisive, s.scored, s.missing, s.tp, s.fp, s.fn, s.tn], [4, 3, 1, 1, 1, 0, 1]);
  assert.deepEqual([s.agreement, s.precision, s.recall], [66.7, 50, 100]);
  assert.deepEqual([s.missed, s.wronglySelected], [[], [3]]);
  const none = scoreGold(CASES, new Map());
  assert.deepEqual([none.scored, none.agreement, none.precision, none.recall], [0, null, null, null], "nothing to divide by is not 0%");
});

test("stored judgements: one baseline per rules version, never mixed; within a version the newest judgement counts", () => {
  const rows = [
    // Classic: case 1 under two stored versions of the same rules. The newer input revision counts even though its
    // row id is lower (the order of the SQL and the live code: input_revision DESC, id DESC).
    { articleId: "a1", promptVersion: CLASSIC_POST, selected: false, inputRevision: 1, id: 30 },
    { articleId: "a1", promptVersion: CLASSIC, selected: true, inputRevision: 2, id: 10 },
    { articleId: "a3", promptVersion: CLASSIC, selected: null, inputRevision: 1, id: 12 },
    // Global judged cases 2 and 3 only; on one input revision the newer row counts.
    { articleId: "a2", promptVersion: GLOBAL, selected: false, inputRevision: 1, id: 20 },
    { articleId: "a3", promptVersion: GLOBAL, selected: false, inputRevision: 1, id: 21 },
    { articleId: "a3", promptVersion: `${GLOBAL}+summarize-short-post`, selected: true, inputRevision: 1, id: 23 },
    // Not a gold case.
    { articleId: "other", promptVersion: GLOBAL, selected: true, inputRevision: 1, id: 22 },
  ];
  const out = storedBaselines(CASES, rows);
  assert.deepEqual(
    out.map((s) => [s.ruleset, s.scored, s.tp, s.fp, s.fn, s.tn, s.missed, s.wronglySelected]),
    [
      ["global", 2, 0, 1, 1, 0, [2], [3]],
      ["classic", 2, 1, 0, 0, 1, [], []],
    ],
  );
  assert.equal(out[1]!.key, "prefilter-shared@aa4cb4ab1b | selection-score-shared@a195d5bf17+weights@20542a669a");
  assert.equal(globalBaseline(out, []).status, "available");
  assert.deepEqual(
    globalBaseline(
      out.filter((s) => s.ruleset === "classic"),
      [],
    ),
    { status: "not available, needs budget", scored: 0 },
    "classic alone is no global baseline",
  );
});

test("SelectBench runs: per run and model, scored against today's labels; a failed case is counted apart", () => {
  const row = (runId: string, model: string, caseId: string, decision: string | null) => ({
    runId,
    createdAt: "2026-11-06T10:00:00+08",
    promptVersion: GLOBAL,
    model,
    caseId,
    decision,
  });
  const out = benchBaselines(CASES, [
    row("sb-1", "m1", "owner-20261105-001", "select"),
    row("sb-1", "m1", "owner-20261105-002", "reject"),
    row("sb-1", "m1", "owner-20261105-003", null),
    row("sb-1", "m2", "owner-20261105-004", "select"),
    row("sb-1", "m1", "someone-else-001", "select"),
  ]);
  assert.deepEqual(
    out.map((b) => [b.runId, b.model, b.ruleset, b.scored, b.failed, b.tp, b.fn, b.fp]),
    [
      ["sb-1", "m1", "global", 2, 1, 1, 1, 0],
      ["sb-1", "m2", "global", 1, 0, 0, 0, 1],
    ],
  );
  assert.deepEqual(globalBaseline([], out), { status: "available", from: ["selectbench"], scored: 2 });
  assert.deepEqual(globalBaseline([], []), { status: "not available, needs budget", scored: 0 });
});

test("swipe: the desk's own tally per card kind and per rules version; an answer is only counted with its own card", () => {
  const card = (day: string, id: string, kind: string, system: SwipeCardRow["system"], promptVersion: string | null): SwipeCardRow => ({
    day,
    article_id: id,
    kind,
    system,
    promptVersion,
  });
  const cards = [
    card("2026-11-12", "s1", "near_miss", "kept", GLOBAL),
    card("2026-11-12", "s2", "near_pass", "selected", GLOBAL),
    card("2026-11-12", "s3", "blocked", "blocked", CLASSIC),
    card("2026-11-12", "s4", "near_miss", "kept", CLASSIC),
    card("2026-11-19", "s2", "recheck", "selected", GLOBAL),
  ];
  const answers = [
    { day: "2026-11-12", article_id: "s1", answer: "star" },
    { day: "2026-11-12", article_id: "s2", answer: "yes" },
    { day: "2026-11-12", article_id: "s3", answer: "yes" },
    { day: "2026-11-12", article_id: "s4", answer: null },
    { day: "2026-11-19", article_id: "s2", answer: "star" },
  ];
  const r = swipeReport(cards, answers);
  assert.equal(r.decks, 2);
  assert.deepEqual(r.total, { cards: 5, unanswered: 1, ...tallySwipe(cards, answers) }, "the total is the desk's tally over every deck");
  assert.deepEqual(r.total, { cards: 5, unanswered: 1, days: 2, answered: 4, no: 0, yes: 2, star: 2, missed: 1, extra: 1, widened: 1 });
  const kind = Object.fromEntries(r.byKind.map(({ kind, ...c }) => [kind, c]));
  assert.deepEqual(Object.keys(kind), ["blocked", "near_miss", "near_pass", "recheck"]);
  assert.deepEqual(kind.near_miss, { cards: 2, unanswered: 1, days: 1, answered: 1, no: 0, yes: 0, star: 1, missed: 1, extra: 0, widened: 0 });
  // s2's re-check answer (star) belongs to the re-check card only: the near_pass card stays "selected but not starred".
  assert.deepEqual(kind.near_pass, { cards: 1, unanswered: 0, days: 1, answered: 1, no: 0, yes: 1, star: 0, missed: 0, extra: 1, widened: 0 });
  assert.deepEqual(kind.recheck, { cards: 1, unanswered: 0, days: 1, answered: 1, no: 0, yes: 0, star: 1, missed: 0, extra: 0, widened: 0 });
  assert.deepEqual(kind.blocked!.widened, 1);
  assert.deepEqual(
    r.byRuleset.map((g) => [g.ruleset, g.cards, g.answered, g.missed, g.extra, g.widened]),
    [
      ["global", 3, 3, 1, 1, 0],
      ["classic", 2, 1, 0, 0, 1],
    ],
  );
});

test("the printed lines and the report carry counts and gold case numbers only: no article id, title or actor", () => {
  const { labels, candidates } = readGold();
  const cases = goldCases(labels, candidates);
  const cards: SwipeCardRow[] = [{ day: "2026-11-12", article_id: "SECRET-ARTICLE-ID", kind: "near_miss", system: "kept", promptVersion: GLOBAL }];
  const answers = [{ day: "2026-11-12", article_id: "SECRET-ARTICLE-ID", answer: "star" }];
  const stored = storedBaselines(cases, [{ articleId: cases[0]!.articleId, promptVersion: GLOBAL, selected: true, inputRevision: 1, id: 1 }]);
  const report: ReplayReport = {
    generatedAt: "2026-11-20T00:00:00.000Z",
    readOnly: true,
    gold: {
      labels: { decisive: 116, select: 32, reject: 84, either: 3 },
      snapshot: snapshotBaseline(cases, candidates),
      stored,
      selectbench: [],
      global: globalBaseline(stored, []),
      evaluationReceipts: [{ purpose: "score_article", version: "selection-score-global-shared@d3b4cb6ac0", receipts: 4 }],
    },
    swipe: swipeReport(cards, answers),
    grouping: {
      windowDays: 14,
      corrections: [{ action: "content.detach", total: 3, inWindow: 1 }],
      overrides: [{ mode: "standalone", rows: 2 }],
      shadowSwitch: '"off"',
      shadowRows: [],
      agreement: {
        from: "",
        to: "",
        ruleset: "r",
        rows: 0,
        judged: 0,
        outside: 0,
        decided: 0,
        undecided: 0,
        byRule: {},
        calls: { wouldCall: 0, outsideCalled: 0, forecast: 0, liveCalled: 0 },
        sameFact: { rows: 0, agree: 0 },
        pairs: { total: 0, shadowSame: 0, liveSame: 0, both: 0 },
        newEvent: { rows: 0, liveJoinedFact: 0, liveJoinedStory: 0 },
        recallHit: { eligible: 0, hit: 0 },
        human: { pairs: 0, shadowRight: 0, shadowWrong: 0, liveRight: 0, liveWrong: 0, truncated: false },
        windowFull: 0,
      },
    },
  };
  const printed = summaryLines(report).join("\n"),
    markdown = renderReport(report),
    json = JSON.stringify(report);
  for (const text of [printed, markdown, json]) {
    assert.doesNotMatch(text, /SECRET-ARTICLE-ID/);
    for (const c of candidates) {
      assert.ok(!text.includes(c.id), `no article id (${c.id})`);
      assert.ok(!text.includes((c as unknown as { title: string }).title), "no title");
    }
  }
  assert.match(printed, /只读事务：是/);
  assert.match(printed, /\(a\) 11-05 冻结快照：判定 116\/116，一致 62\.9%，准确 29\.6%（8\/27），召回 25%（8\/32）/);
  assert.match(printed, /现行 global 规则：已有库存数据/);
  assert.doesNotMatch(printed, /漏选 7, 9/, "case numbers stay in the report file, stdout has counts only");
  assert.match(markdown, /\(a\) 11-05 冻结快照：漏选 7, 9, 17/);
  report.gold.stored = [];
  report.gold.global = globalBaseline([], []);
  assert.match(summaryLines(report).join("\n"), /现行 global 规则：not available, needs budget/);
});

/** A catalogue with every registered table, as tests/db-role-plan.test.ts builds it, for the real grant planner. */
function catalogue(): Catalog {
  const schemas = Object.fromEntries(
    [...new Set(Object.keys(TABLE_GRANTS).map((name) => relationIdentity(name).schema))].map((s) => [s, s === "public" ? "pg_database_owner" : "bootstrap"]),
  );
  const special: Record<string, string[]> = {
    "feedback.submission_state": ["source_hash", "attempts", "submissions", "paused_until", "expires_at"],
    "feedback.quota_buckets": ["scope", "bucket_key", "window_start", "used"],
    "feedback.submissions": ["key_hash", "payload_hash", "feedback_id", "created_at"],
    "identity.account_access": ["user_id", "role", "models_manage", "active", "revision", "must_change_password"],
  };
  return {
    database: "fixture_test",
    actor: "bootstrap",
    superuser: true,
    databaseOwner: "bootstrap",
    schemas,
    tables: Object.entries(TABLE_GRANTS).map(([name, grant]) => ({
      name,
      owner: "bootstrap",
      columns: special[name] ?? (grant.publicColumns[0] === "*" || !grant.publicColumns.length ? ["id"] : grant.publicColumns),
      rls: false,
    })),
    sequences: Object.entries(SEQUENCES).map(([name, table]) => ({ name, table, owner: "bootstrap" })),
    policies: [],
    roles: [],
    memberships: [],
    queueOwners: [],
    unsupportedObjects: [],
    grants: [],
    defaults: [],
  };
}

test("the API process's role, private_ops, may read every table the replay reads; the worker may not read the swipe tables", () => {
  const plan = planRoleGrants(catalogue(), "fixture", 2).statements;
  const reads = (role: string, table: string) =>
    table.startsWith("pgboss.")
      ? plan.some((s) => /^GRANT [^;]*SELECT[^;]* ON ALL TABLES IN SCHEMA pgboss TO /.test(s) && s.endsWith(`TO "fixture_${role}"`))
      : plan.some(
          (s) =>
            s.startsWith("GRANT ") &&
            /\bSELECT\b/.test(s.split(" ON TABLE ")[0]!) &&
            s.includes(` ON TABLE ${quoteRelation(relationIdentity(table).name)} TO "fixture_${role}"`),
        );
  for (const table of REPLAY_TABLES) assert.ok(reads("private_ops", table), `private_ops reads ${table}`);
  for (const schema of new Set(REPLAY_TABLES.filter((t) => t.includes(".")).map((t) => t.split(".")[0]!)))
    assert.ok(
      plan.some(
        (s) =>
          s.startsWith("GRANT USAGE ON SCHEMA ") &&
          s.split(" TO ")[0]!.replaceAll('"', "").endsWith(` ${schema}`) &&
          s.split(" TO ")[1]!.includes('"fixture_private_ops"'),
      ),
      `private_ops may use schema ${schema}`,
    );
  for (const table of ["ai.swipe_cards", "ai.swipe_answers"]) assert.ok(!reads("worker", table), `worker cannot read ${table}`);
  // The test is not vacuous: a role without a grant is told apart.
  assert.ok(!reads("public_read", "audit_log"));
  // The settings row is behind row security; private_ops has an all-rows policy.
  assert.ok(plan.some((s) => s.startsWith('CREATE POLICY "fixture_private_ops" ON public."settings"') && s.includes("USING (true)")));
});

test("with split logins, the script's database process (api) queries as the private_ops login", async () => {
  assert.match(readFileSync(path.join(ROOT, "scripts/eval-replay.ts"), "utf8"), /await initializeDb\("api"\);/);
  // db-bootstrap's own mapping: initialize the api process with one distinct login per role and read which login the
  // query handle uses. postgres.js connects lazily, so nothing is opened.
  await initializeDb("api", {
    DATABASE_URL_PRIVATE_OPS: "postgres://fixture_private_ops@127.0.0.1:9/fixture",
    DATABASE_URL_AUTH: "postgres://fixture_auth@127.0.0.1:9/fixture",
  });
  try {
    assert.equal((sql as unknown as { options: { user: string } }).options.user, "fixture_private_ops");
  } finally {
    await closeDb();
  }
});

const MODEL_MODULE = /(?:^|\/)providers\/|editorial\/(?:analyze|models|translate|writing)|\bllm\b|openai|anthropic|@google|chatJson/;
const imports = (file: string) => {
  const text = readFileSync(path.join(ROOT, file), "utf8");
  return { text, specifiers: [...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gms)].map((m) => m[1]!) };
};

test("the replay imports no model client: none directly, and none reachable except through the two owner files it reuses", () => {
  for (const file of ["scripts/eval-replay.ts", "scripts/eval-replay-core.ts"]) {
    const { text, specifiers } = imports(file);
    assert.ok(specifiers.length >= 3, `${file}: imports were found`);
    for (const s of specifiers) assert.doesNotMatch(s, MODEL_MODULE, `${file} imports ${s}`);
    assert.doesNotMatch(text, /\bimport\s*\(/, `${file}: no dynamic import`);
    assert.doesNotMatch(text, /chatJson|guardedFetch|\bfetch\s*\(/, `${file}: no model or network call`);
  }
  // The full module graph Node loads for the script, recorded by a resolve hook in a child process (main() does not run
  // on import). Only admin/swipe.ts (the desk also deals decks from analysis rows) and pipeline/events/agreement.ts (the
  // queue module) reach the providers; walking the graph without leaving those two files, no provider module is reached.
  const probe = `
    import { registerHooks } from "node:module";
    const edges = [];
    registerHooks({ resolve(specifier, context, next) { const r = next(specifier, context); edges.push([context.parentURL ?? "", r.url]); return r; } });
    await import(${JSON.stringify(new URL("../scripts/eval-replay.ts", import.meta.url).href)});
    console.log(JSON.stringify(edges));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: ROOT, env: process.env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const local = (url: string) => (url.startsWith("file:") ? path.relative(ROOT, new URL(url).pathname) : url);
  const edges = (JSON.parse(run.stdout.trim().split("\n").at(-1)!) as [string, string][]).map(([from, to]) => [local(from), local(to)] as const);
  const reached = (stopAt: ReadonlySet<string>) => {
    const seen = new Set(["scripts/eval-replay.ts"]),
      queue = ["scripts/eval-replay.ts"];
    while (queue.length) {
      const from = queue.shift()!;
      if (stopAt.has(from)) continue;
      for (const [parent, child] of edges)
        if (parent === from && !seen.has(child)) {
          seen.add(child);
          queue.push(child);
        }
    }
    return seen;
  };
  const providers = (files: Set<string>) => [...files].filter((f) => f.startsWith("packages/backend/src/providers/"));
  const reused = new Set(["packages/backend/src/admin/swipe.ts", "packages/backend/src/pipeline/events/agreement.ts"]);
  const all = reached(new Set());
  assert.ok(all.has("packages/backend/src/db.ts") && all.has("scripts/eval-replay-core.ts"), "the graph was recorded");
  assert.ok(providers(all).includes("packages/backend/src/providers/llm.ts"), "the check can see a provider module (it is loaded through the reused files)");
  for (const file of reused) assert.ok(all.has(file));
  assert.deepEqual(providers(reached(reused)), [], "no provider module is reached except through the two reused owner files");
});

test("the report goes under the system temp directory by default, never into the read-only app directory", () => {
  const dir = reportDir("2026-11-21T18:00:00.000Z");
  assert.ok(dir.startsWith(path.join(tmpdir(), "aimine-eval")), dir);
  assert.ok(!dir.startsWith(ROOT), dir);
  assert.equal(path.basename(dir), "replay-2026-11-21T18-00-00-000Z");
  assert.equal(reportDir("2026-11-21T18:00:00.000Z", "/var/tmp/x"), "/var/tmp/x/replay-2026-11-21T18-00-00-000Z");
});
