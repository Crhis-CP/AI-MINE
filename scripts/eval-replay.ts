// Read-only eval replay (TASK-0367, plan 1.10 part 2): scores the old implementation against the labels already stored,
// with zero model calls. It reads, inside ONE read-only transaction as the private_ops role (the API container's role,
// the only one that may read the swipe tables), the stored analyses and SelectBench runs of the Owner's gold cases, the
// swipe decks and answers, people's grouping corrections and the event shadow's agreement report; it writes no row and
// imports no model client. Runbook: docs/runbooks/eval-replay.md.
//   docker compose exec -T api node scripts/eval-replay.ts [--days 14] [--out <dir>]
// Prints counts only; the full report (counts plus gold case numbers) goes to <out>/replay-<time>/, by default under the
// system temp directory: the production image's /app is read-only for the node user, so nothing is written there.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { closeDb, initializeDb, sql, type Sql, type Tx } from "@amp/backend/db";
import { shadowAgreement } from "../packages/backend/src/pipeline/events/agreement.ts";
import {
  benchBaselines,
  globalBaseline,
  goldCases,
  renderReport,
  snapshotBaseline,
  storedBaselines,
  summaryLines,
  swipeReport,
  type BenchRow,
  type CorrectionRow,
  type GoldCandidate,
  type GoldLabels,
  type ReplayReport,
  type StoredJudgement,
  type SwipeCardRow,
} from "./eval-replay-core.ts";
import type { SwipeTallyAnswer } from "../packages/backend/src/admin/swipe.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const GOLD = path.join(ROOT, "industry/selection-gold");
/** The day the Owner labelled the gold cases: evaluation receipts from then on may score them. */
const LABELLED_ON = "2026-11-05T00:00:00+08:00";

/** Runs `read` in a transaction that PostgreSQL itself refuses to write in. */
export function readOnly<T>(db: Sql, read: (tx: Tx) => Promise<T>): Promise<T> {
  return db.begin(async (tx) => {
    await tx`SET TRANSACTION READ ONLY`;
    // Each query at most two minutes and at most two seconds waiting for a lock; a transaction left idle (the script
    // stuck between queries) is ended after a minute. The replay is a fixed list of queries, so these bound the whole.
    await tx`SET LOCAL statement_timeout = '120s'`;
    await tx`SET LOCAL lock_timeout = '2s'`;
    await tx`SET LOCAL idle_in_transaction_session_timeout = '60s'`;
    return read(tx);
  }) as Promise<T>;
}

export function readGold(dir = GOLD): { labels: GoldLabels; candidates: GoldCandidate[] } {
  return {
    labels: JSON.parse(readFileSync(path.join(dir, "owner-20261105-labels.json"), "utf8")) as GoldLabels,
    candidates: JSON.parse(readFileSync(path.join(dir, "owner-20261105-candidates.json"), "utf8")) as GoldCandidate[],
  };
}

export async function runReplay(db: Sql, opts: { days: number; now?: Date; gold?: ReturnType<typeof readGold> }): Promise<ReplayReport> {
  const now = opts.now ?? new Date();
  const from = new Date(now.getTime() - opts.days * 86_400_000);
  const { labels, candidates } = opts.gold ?? readGold();
  const cases = goldCases(labels, candidates);
  const articleIds = cases.map((c) => c.articleId),
    caseIds = cases.map((c) => c.caseId);
  return readOnly(db, async (tx) => {
    const [mode] = await tx<{ transaction_read_only: string }[]>`SHOW transaction_read_only`;
    // Gold vs stored judgements: the newest complete judgement per article and stored prompt version, no text. A row
    // without the score step's result (the prefilter-only row committed ahead of the scores, a stale diagnostic) is no
    // judgement: counted, it would make a rules version of its own and score the case as "not selected".
    const stored = await tx<StoredJudgement[]>`
      SELECT DISTINCT ON (article_id, prompt_version) article_id AS "articleId", prompt_version AS "promptVersion", selected,
             input_revision AS "inputRevision", id::float AS id
      FROM analyses WHERE article_id = ANY(${articleIds}::text[]) AND jsonb_typeof(output) = 'object' AND output ? 'scores'
      ORDER BY article_id, prompt_version, input_revision DESC, id DESC`;
    const bench = await tx<BenchRow[]>`
      SELECT r.id AS "runId", to_char(r.created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS "createdAt", r.prompt_version AS "promptVersion",
             s.model, s.case_id AS "caseId", s.decision
      FROM selectbench_results s JOIN selectbench_runs r ON r.id = s.run_id WHERE s.case_id = ANY(${caseIds}::text[])`;
    const receipts = await tx<{ purpose: string; version: string | null; receipts: number }[]>`
      SELECT purpose, request->>'promptVersion' AS version, count(*)::int AS receipts FROM receipts
      WHERE subject LIKE 'evaluation:%' AND created_at >= ${new Date(LABELLED_ON)} GROUP BY 1, 2 ORDER BY 1, 2`;
    // Swipe: every dealt card with the rules version of its analysis, and the latest answer per card.
    const cards = await tx<SwipeCardRow[]>`
      SELECT c.day::text AS day, c.article_id, c.kind, c.system, a.prompt_version AS "promptVersion"
      FROM ai.swipe_cards c LEFT JOIN analyses a ON a.id = c.analysis_id`;
    const answers = await tx<SwipeTallyAnswer[]>`
      SELECT DISTINCT ON (day, article_id) day::text AS day, article_id, answer FROM ai.swipe_answers ORDER BY day, article_id, revision DESC`;
    // Grouping: people's corrections by action (the counting of scripts/measure/package2/events.sql M9, all time and in
    // the window), the current overrides, the shadow switch and rows, and the agreement report of the window.
    const corrections = await tx<CorrectionRow[]>`
      SELECT action, count(*)::int AS total, count(*) FILTER (WHERE created_at >= ${from})::int AS "inWindow" FROM audit_log
      WHERE action IN ('content.detach', 'content.rerun.group') OR (action = 'story.merge' AND actor <> 'grouping')
      GROUP BY 1 ORDER BY 1`;
    const overrides = await tx<{ mode: string; rows: number }[]>`SELECT mode, count(*)::int AS rows FROM grouping_overrides GROUP BY 1 ORDER BY 1`;
    const [shadowSwitch] = await tx<{ value: unknown }[]>`SELECT value FROM settings WHERE key = 'events.shadow'`;
    const shadowRows = await tx<{ ruleset: string; rows: number }[]>`
      SELECT ruleset, count(*)::int AS rows FROM events.shadow_decisions GROUP BY 1 ORDER BY 1`;
    const agreement = await shadowAgreement(from, now, {}, tx);

    const storedScores = storedBaselines(cases, stored);
    const benchScores = benchBaselines(cases, bench);
    return {
      generatedAt: now.toISOString(),
      readOnly: mode?.transaction_read_only === "on",
      gold: {
        labels: {
          decisive: cases.filter((c) => c.gold !== "either").length,
          select: cases.filter((c) => c.gold === "select").length,
          reject: cases.filter((c) => c.gold === "reject").length,
          either: cases.filter((c) => c.gold === "either").length,
        },
        snapshot: snapshotBaseline(cases, candidates),
        stored: storedScores,
        selectbench: benchScores,
        global: globalBaseline(storedScores, benchScores),
        evaluationReceipts: [...receipts],
      },
      swipe: swipeReport(cards, answers),
      grouping: {
        windowDays: opts.days,
        corrections: [...corrections],
        overrides: [...overrides],
        shadowSwitch: shadowSwitch === undefined ? null : JSON.stringify(shadowSwitch.value),
        shadowRows: [...shadowRows],
        agreement,
      },
    };
  });
}

/** Where the full report goes: `<base>/replay-<time>`, base defaulting to the system temp directory (writable in the image). */
export function reportDir(generatedAt: string, base: string = path.join(tmpdir(), "aimine-eval")): string {
  return path.join(path.resolve(base), `replay-${generatedAt.replace(/[:.]/g, "-")}`);
}

async function main() {
  const { values } = parseArgs({ options: { days: { type: "string", default: "14" }, out: { type: "string" } } });
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 45) {
    console.error("usage: eval-replay.ts [--days 1..45] [--out <dir>]; nothing read");
    process.exit(2);
  }
  // The API process's database role is private_ops: it may read every table above (the worker may not read ai.swipe_*).
  await initializeDb("api");
  try {
    const report = await runReplay(sql, { days });
    const dir = reportDir(report.generatedAt, values.out);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(path.join(dir, "report.md"), renderReport(report));
    console.log([...summaryLines(report), `报告：${dir}/report.{md,json}`].join("\n"));
  } finally {
    await closeDb();
  }
}

if (import.meta.main) await main();
