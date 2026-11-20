// Free back-fill of the per-article shadow (design L PR-F): the checks of packages/backend/src/pipeline/understand on
// the latest judgement of each article judged since a date, stored exactly as the worker stores them after a new
// judgement (company links in entities.article_links, figures, names and dateline in enrichment.analysis_checks).
// No model call; analyses, articles and publications are only read, so nothing readers see changes. Re-running is
// safe: a judgement keeps its first check row, and the links of its revision are replaced with what the library finds now.
//   node scripts/entity-links-backfill.ts --since 2026-10-01            dry run (default): runs the checks, writes nothing
//   node scripts/entity-links-backfill.ts --since 2026-10-01 --apply [--until 2026-11-01] [--batch 200] [--limit N] [--after ID]
// Dates are Beijing days; --until is exclusive and defaults to now. Judgements are read in pages of --batch by id and
// checked one at a time; with --limit it stops after N judgements and prints the --after value to continue from.
// Runs with the worker's login, e.g. `docker compose exec -T worker node scripts/entity-links-backfill.ts --since …`;
// seed the library first (scripts/entities-seed.ts), or no links are stored.
import { closeDb, initializeDb, sql } from "@amp/backend/db";
import { observableAnalyses, observeAnalysis, type SkipReason } from "../packages/backend/src/pipeline/understand/observe.ts";
import { normalizeSourceLanguage } from "../packages/backend/src/sources/config-keys.ts";

const MAX_BATCH = 1000;
const args = process.argv.slice(2);
const FLAGS = ["--since", "--until", "--batch", "--limit", "--after"];
const value = (flag: string) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const apply = args.includes("--apply");
/** A calendar day as written, or null; 2026-13-01 and 2026-02-30 are no days. */
const day = (text: string | undefined) => {
  if (text === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text) ? text : null;
};
/** The start of a Beijing day (UTC+8 all year). */
const beijingMidnight = (text: string) => new Date(`${text}T00:00:00+08:00`);
const count = (text: string | undefined, min: number, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(text);
  return text !== undefined && Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
};
const since = day(value("--since"));
const until = value("--until") === undefined ? undefined : day(value("--until"));
const batch = value("--batch") === undefined ? 200 : count(value("--batch"), 1, MAX_BATCH);
const limit = value("--limit") === undefined ? undefined : count(value("--limit"), 1);
const after = value("--after") === undefined ? 0 : count(value("--after"), 0);
const unknown = args.filter((arg, i) => arg !== "--apply" && !FLAGS.includes(arg) && !FLAGS.includes(args[i - 1] ?? ""));
if (unknown.length || since === null || until === null || batch === null || limit === null || after === null) {
  console.error(
    `usage: entity-links-backfill.ts --since YYYY-MM-DD [--until YYYY-MM-DD] [--batch 1-${MAX_BATCH}] [--limit N] [--after ID] [--apply]; nothing written`,
  );
  process.exit(2);
}

await initializeDb("worker");
try {
  const range = { since: beijingMidnight(since), until: until ? beijingMidnight(until) : new Date() };
  const totals = {
    examined: 0,
    observed: 0,
    skipped: { missing: 0, not_judged: 0, superseded: 0, stale: 0 } satisfies Record<SkipReason, number>,
    articlesWithLinks: 0,
    links: {} as Record<string, number>,
    stored: { checks: 0, links: 0 },
    verdicts: { ok: 0, soft: 0, hard: 0 },
    datelines: { release_wire: 0, news_agency: 0, unmarked: 0 },
    demotedCountries: 0,
    nameRewrites: 0,
    library: null as string | null,
  };
  let cursor = after,
    stopped = false;
  pages: for (;;) {
    const page = await observableAnalyses({ ...range, afterId: cursor, limit: batch });
    if (!page.length) break;
    // A script may read the article table directly; the worker's queue job carries the language instead.
    const languages = new Map(
      (await sql<{ id: string; language: string | null }[]>`SELECT id, language FROM articles WHERE id = ANY(${page.map((p) => p.articleId)}::text[])`).map(
        (row) => [row.id, normalizeSourceLanguage(row.language)],
      ),
    );
    for (const item of page) {
      if (limit !== undefined && totals.examined >= limit) {
        stopped = true;
        break pages;
      }
      totals.examined++;
      const outcome = await observeAnalysis({ ...item, language: languages.get(item.articleId) ?? null }, { write: apply });
      cursor = item.analysisId;
      if (outcome.state === "skipped") {
        totals.skipped[outcome.reason]++;
        continue;
      }
      totals.observed++;
      totals.library = outcome.library;
      const { check } = outcome;
      if (check.links.length) totals.articlesWithLinks++;
      for (const link of check.links) totals.links[link.method] = (totals.links[link.method] ?? 0) + 1;
      if (outcome.stored) {
        totals.stored.checks += outcome.stored.check ? 1 : 0;
        totals.stored.links += outcome.stored.links;
      }
      totals.verdicts[check.verdict]++;
      for (const note of check.geography) {
        if (note.kind === "dateline") totals.datelines[note.dateline]++;
        if (note.kind === "demoted") totals.demotedCountries++;
      }
      totals.nameRewrites += check.names.filter((note) => note.kind === "rewrite").length;
    }
  }
  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        since: range.since.toISOString(),
        until: range.until.toISOString(),
        ...totals,
        next: stopped ? `--after ${cursor}` : null,
      },
      null,
      2,
    ),
  );
} finally {
  await closeDb();
}
