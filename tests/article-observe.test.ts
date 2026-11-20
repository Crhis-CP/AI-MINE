import "./setup.ts";
// The per-article shadow (pipeline/understand/observe.ts): a committed judgement is checked once, writing only
// entities.article_links and enrichment.analysis_checks; the judgement and the publications are never touched; the
// switch observe.articles stops the queueing and the queued work; queueing never throws, and a failed run leaves
// nothing half-written. Also the reconciliation's summary, the 180-day pruning and the back-fill script.
// The tests run in order on one database.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, test } from "node:test";
import type { PgBoss } from "pg-boss";
import { beijingDate, addDays } from "@amp/contracts/time";
import { closeDb, sql } from "@amp/backend/db";
import { registerContentJobs } from "@amp/backend/jobs/content";
import { stopBoss } from "@amp/backend/jobs/queue";
import { dailyRetention } from "@amp/backend/operations/retention";
import { seedRows } from "../packages/backend/src/pipeline/entities/seed.ts";
import { articleLinkCoverage, seedEntityLibrary } from "../packages/backend/src/pipeline/entities/store.ts";
import {
  articleCheckSummary,
  articleObserveEnabled,
  observeAnalysis,
  observeQueue,
  queueArticleObserve,
} from "../packages/backend/src/pipeline/understand/observe.ts";

after(async () => {
  await stopBoss();
  await closeDb();
});

const SOURCE = "observe-source";
const DATELINE = "VANCOUVER, Canada, Nov. 18, 2026 /PRNewswire/ -- ";
const BODY = `${DATELINE}Teck Resources Limited (NYSE: TECK) and South32 said today they will invest US$2.5 billion in a copper project in San Juan Province, Argentina. Glencore competes with Teck in the region.`;
const GEOGRAPHY = {
  bodyBudget: 22000,
  state: "identified",
  primary: null,
  codes: ["CA", "AR"],
  assignments: [
    { code: "CA", role: "event_location", mention: "Canada", segment: "body_head", quote: "VANCOUVER, Canada" },
    { code: "AR", role: "event_location", mention: "Argentina", segment: "body_head", quote: "San Juan Province, Argentina" },
  ],
};
const COPY = {
  title_zh: "泰克资源与南32将投资25亿美元开发阿根廷铜矿",
  summary_zh: "泰克资源（Teck Resources）和南32表示，将在阿根廷投资2.5亿美元开发铜矿项目，产量将增长12%。",
};

await sql`INSERT INTO sources (id, name, kind, tier, lane, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Observe fixture', 'rss', 'T2', 'news', 'editorial', '2100-01-01')`;

async function article(id: string, body = BODY, title = "Teck and South32 to invest US$2.5 billion in Argentine copper project") {
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, language, revision, body_text, body_status, raw)
    VALUES (${id}, ${SOURCE}, ${id}, ${`https://www.prnewswire.com/news-releases/${id}.html`}, ${title}, now(), now(), 'en', 1, ${body}, 'ok', '{}')`;
  return id;
}
async function judgement(
  articleId: string,
  fields: { relevance?: string; output?: Record<string, unknown>; revision?: number; copy?: { title_zh: string; summary_zh: string } } = {},
) {
  const output = fields.output ?? { scores: [50, 52], writer: "understand", fact: { title: "投资", occurredAt: "2026-11-18" }, geography: GEOGRAPHY };
  const copy = fields.copy ?? COPY;
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO analyses (article_id, input_revision, origin, relevance, selected, score, subjects, title_zh, summary_zh, output)
    VALUES (${articleId}, ${fields.revision ?? 1}, 'model', ${fields.relevance ?? "pass"}, false, 51, ${[] as string[]}::text[], ${copy.title_zh}, ${copy.summary_zh},
      ${sql.json(output as never)}) RETURNING id`;
  return row!.id;
}
const checkRow = async (analysisId: number) =>
  (
    await sql<
      {
        article_id: string;
        input_revision: number;
        lane: string;
        recipe: string;
        mode: string;
        verdict: string;
        figures: unknown;
        names: unknown;
        geography: unknown;
      }[]
    >`
      SELECT article_id, input_revision, lane, recipe, mode, verdict, figures, names, geography FROM enrichment.analysis_checks WHERE analysis_id = ${analysisId}`
  )[0];
const links = async (articleId: string) => [
  ...(await sql<{ entity_id: string; role: string; method: string; segment: string; analysis_id: number }[]>`
    SELECT entity_id, role, method, segment, analysis_id FROM entities.article_links WHERE article_id = ${articleId} ORDER BY entity_id, method`),
];
const observeJobs = async (articleId: string) => [
  ...(await sql<{ id: string; data: Record<string, unknown>; singleton_key: string }[]>`
    SELECT id, data, singleton_key FROM pgboss.job WHERE name = ${observeQueue.name} AND data->>'articleId' = ${articleId} ORDER BY created_on`),
];
async function observeHandler() {
  const handlers = new Map<string, (jobs: Array<{ id: string; data: unknown }>) => Promise<Array<{ output: unknown }>>>();
  await registerContentJobs({ work: async (name: string, _options: unknown, handler: never) => void handlers.set(name, handler) } as unknown as PgBoss, 1);
  return handlers.get(observeQueue.name)!;
}
async function setSwitch(value: unknown) {
  if (value === undefined) await sql`DELETE FROM settings WHERE key = 'observe.articles'`;
  else
    await sql`INSERT INTO settings (key, value, updated_by) VALUES ('observe.articles', ${sql.json(value as never)}, 'test')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  return articleObserveEnabled({ maxAgeMs: 0 });
}

test("before the library is seeded the check is stored and the links are not", async () => {
  const id = await article("observe-unseeded");
  const analysisId = await judgement(id);
  const outcome = await observeAnalysis({ articleId: id, analysisId, language: "en" });
  assert.equal(outcome.state, "observed");
  assert.ok(outcome.state === "observed" && outcome.library === "code_seed");
  assert.deepEqual(outcome.state === "observed" && outcome.stored, { check: true, links: 0 });
  assert.equal(outcome.state === "observed" && outcome.check.links.length, 3, "the code seed still finds the companies");
  assert.equal((await checkRow(analysisId))?.verdict, "hard");
  assert.deepEqual(await links(id), []);
});

test("a committed judgement is checked once: one check row and its links, and the judgement is not touched", async () => {
  await seedEntityLibrary(seedRows(), "test", { apply: true });
  const id = await article("observe-release");
  const analysisId = await judgement(id);
  const judgements = async () => [...(await sql`SELECT * FROM analyses WHERE article_id = ${id} ORDER BY id`)];
  const published = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM publications`)[0]!.n;
  const before = await judgements();
  const publications = await published();

  const outcome = await observeAnalysis({ articleId: id, analysisId, language: "en" });
  assert.deepEqual(outcome.state === "observed" && [outcome.library, outcome.stored], ["database", { check: true, links: 3 }]);
  assert.deepEqual(await checkRow(analysisId), {
    article_id: id,
    input_revision: 1,
    lane: "news",
    recipe: "entity-linker-v1/entity-names-v1/figures-v1/dateline-v1",
    mode: "observed",
    verdict: "hard",
    figures: [
      { field: "summary", token: "2.5亿美元", kind: "amount", problem: "scale_mismatch", class: "hard", nearest: "2.5 billion" },
      // The figure the source has that comes closest, here the day of the dateline's date.
      { field: "summary", token: "12%", kind: "percent", problem: "absent", class: "soft", nearest: "18" },
    ],
    names: [
      { kind: "rewrite", field: "title", entityId: "teck", from: "泰克资源", to: "泰克资源（Teck Resources）" },
      { kind: "rewrite", field: "title", entityId: "south32", from: "南32", to: "南32（South32）" },
      { kind: "rewrite", field: "summary", entityId: "south32", from: "南32", to: "南32（South32）" },
    ],
    geography: [
      { kind: "dateline", dateline: "release_wire", marker: "PRNewswire", end: DATELINE.length },
      { kind: "demoted", code: "CA" },
    ],
  });
  assert.deepEqual(await links(id), [
    { entity_id: "glencore", role: "mention", method: "text", segment: "body", analysis_id: analysisId },
    { entity_id: "south32", role: "mention", method: "text", segment: "title", analysis_id: analysisId },
    { entity_id: "teck", role: "mention", method: "text", segment: "title", analysis_id: analysisId },
  ]);
  assert.deepEqual(await judgements(), before, "the judgement is only read");
  assert.equal(await published(), publications, "nothing is published");

  const again = await observeAnalysis({ articleId: id, analysisId, language: "en" });
  assert.deepEqual(again.state === "observed" && again.stored, { check: false, links: 3 }, "the first check row stays; the links are replaced");
  assert.equal((await sql`SELECT count(*)::int AS n FROM enrichment.analysis_checks WHERE article_id = ${id}`)[0]!.n, 1);
  assert.equal((await links(id)).length, 3);
  const dry = await observeAnalysis({ articleId: id, analysisId, language: "en" }, { write: false });
  assert.deepEqual(dry.state === "observed" && dry.stored, null);
});

test("only the current, complete and relevant judgement of an article is checked", async () => {
  const id = await article("observe-skips");
  const scope = await judgement(id, { relevance: "pass", output: { prefilter: { label: "PASS", reason: "合成" } } });
  const blocked = await judgement(id, { relevance: "block", output: { scores: null, prefilter: { label: "BLOCK", reason: "合成" } } });
  const older = await judgement(id);
  const newer = await judgement(id);
  const run = (analysisId: number, articleId = id) => observeAnalysis({ articleId, analysisId, language: "en" });
  assert.deepEqual(await run(scope), { state: "skipped", reason: "not_judged" });
  assert.deepEqual(await run(blocked), { state: "skipped", reason: "not_judged" });
  assert.deepEqual(await run(older), { state: "skipped", reason: "superseded" });
  assert.deepEqual(await run(newer, "observe-release"), { state: "skipped", reason: "missing" }, "the row must belong to the article");
  assert.deepEqual(await run(987_654_321), { state: "skipped", reason: "missing" });
  await sql`UPDATE articles SET revision = 2 WHERE id = ${id}`;
  assert.deepEqual(await run(newer), { state: "skipped", reason: "stale" });
  assert.equal((await sql`SELECT count(*)::int AS n FROM enrichment.analysis_checks WHERE article_id = ${id}`)[0]!.n, 0);
  assert.deepEqual(await links(id), []);
});

test("the queued job checks the judgement; the switch stops both the queueing and queued work", async () => {
  const handler = await observeHandler();
  assert.equal(await setSwitch(undefined), true, "on unless switched off");
  const id = await article("observe-queued");
  const analysisId = await judgement(id);
  await queueArticleObserve({ articleId: id, analysisId, language: "en" });
  await queueArticleObserve({ articleId: id, analysisId, language: "en" });
  const queued = await observeJobs(id);
  assert.deepEqual(
    queued.map((job) => [job.data, job.singleton_key]),
    [[{ lane: "news", articleId: id, analysisId, language: "en" }, `analysis:${analysisId}`]],
    "one job per judgement",
  );
  const [result] = await handler(queued);
  assert.deepEqual(result!.output, { state: "observed", library: "database", verdict: "hard", links: 3, stored: { check: true, links: 3 } });

  assert.equal(await setSwitch("off"), false);
  const later = await article("observe-switched-off");
  const laterId = await judgement(later);
  await queueArticleObserve({ articleId: later, analysisId: laterId, language: "en" });
  assert.deepEqual(await observeJobs(later), [], "nothing is queued while it is off");
  const [off] = await handler([{ id: "synthetic", data: { lane: "news", articleId: later, analysisId: laterId, language: "en" } }]);
  assert.deepEqual(off!.output, { state: "off" });
  assert.equal(await checkRow(laterId), undefined, "queued work does nothing while it is off");
  assert.equal(await setSwitch(false), false, "false reads as off too");
  assert.equal(await setSwitch("on"), true);
  assert.equal(await setSwitch(undefined), true);
  await assert.rejects(handler([{ id: "bad", data: { lane: "news", articleId: later } }]), "a malformed payload fails the job");
});

test("queueing never throws, and a failed run fails its job without writing anything", async (t) => {
  const handler = await observeHandler();
  const id = await article("observe-failures");
  const analysisId = await judgement(id);
  assert.equal(await articleObserveEnabled({ maxAgeMs: 0 }), true);
  const warned = t.mock.method(console, "warn", () => {});
  const warnings = () => warned.mock.calls.map((call) => JSON.parse(String(call.arguments[0])).msg);
  await sql.unsafe(`CREATE FUNCTION observe_test_refuse() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic refusal'; END$$`);
  try {
    await sql.unsafe(`CREATE TRIGGER observe_test_queue BEFORE INSERT ON pgboss.job FOR EACH ROW
      WHEN (NEW.name = '${observeQueue.name}') EXECUTE FUNCTION observe_test_refuse()`);
    try {
      assert.equal(await queueArticleObserve({ articleId: id, analysisId, language: "en" }), undefined);
      assert.deepEqual(await observeJobs(id), []);
      assert.deepEqual(warnings(), ["article observe not queued"]);
    } finally {
      await sql.unsafe("DROP TRIGGER observe_test_queue ON pgboss.job");
    }
    await sql.unsafe(`CREATE TRIGGER observe_test_checks BEFORE INSERT ON enrichment.analysis_checks FOR EACH ROW EXECUTE FUNCTION observe_test_refuse()`);
    try {
      await assert.rejects(handler([{ id: "failing", data: { lane: "news", articleId: id, analysisId, language: "en" } }]), /synthetic refusal/);
      assert.deepEqual(await links(id), [], "the links share the check's transaction");
      assert.deepEqual(warnings(), ["article observe not queued", "article observe failed"]);
    } finally {
      await sql.unsafe("DROP TRIGGER observe_test_checks ON enrichment.analysis_checks");
    }
  } finally {
    await sql.unsafe("DROP FUNCTION observe_test_refuse()");
  }
});

test("the daily summary takes the latest check of each article judged in the window and sums only the soft figure class", async () => {
  const judged = async (articleId: string, revision: number, at: string) => {
    if (!(await sql`SELECT 1 FROM articles WHERE id = ${articleId}`).length) await article(articleId);
    const [row] = await sql<{ id: number }[]>`INSERT INTO analyses (article_id, input_revision, origin, relevance, selected, output, created_at)
      VALUES (${articleId}, ${revision}, 'model', 'pass', false, '{"scores": []}', ${at}) RETURNING id`;
    return row!.id;
  };
  const check = (analysisId: number, articleId: string, revision: number, at: string, figures: unknown[], geography: unknown[]) =>
    sql`INSERT INTO enrichment.analysis_checks (analysis_id, article_id, input_revision, lane, recipe, mode, verdict, figures, geography, created_at)
      VALUES (${analysisId}, ${articleId}, ${revision}, 'news', 'test', 'observed', 'ok', ${sql.json(figures as never)}, ${sql.json(geography as never)}, ${at})`;
  const soft = { class: "soft" },
    hard = { class: "hard" };
  // The Beijing day 18 November runs from 2026-11-17T16:00Z to 2026-11-18T16:00Z.
  await check(
    await judged("sum-a", 1, "2026-11-17T17:00:00Z"),
    "sum-a",
    1,
    "2026-11-17T17:01:00Z",
    [soft, hard, soft],
    [{ kind: "dateline", dateline: "release_wire" }],
  );
  await check(await judged("sum-a", 1, "2026-11-18T01:00:00Z"), "sum-a", 1, "2026-11-18T01:01:00Z", [soft], []);
  // Judged just before midnight and checked just after it: still that day's.
  await check(
    await judged("sum-b", 3, "2026-11-18T15:59:00Z"),
    "sum-b",
    3,
    "2026-11-18T16:02:00Z",
    [],
    [
      { kind: "dateline", dateline: "news_agency" },
      { kind: "demoted", code: "CA" },
    ],
  );
  // An older judgement the back-fill checked that day is not that day's.
  await check(await judged("sum-c", 1, "2026-11-16T08:00:00Z"), "sum-c", 1, "2026-11-18T08:00:00Z", [soft], [{ kind: "dateline", dateline: "unmarked" }]);
  await check(await judged("sum-d", 2, "2026-11-18T10:00:00Z"), "sum-d", 2, "2026-11-18T10:00:30Z", [hard], [{ kind: "dateline", dateline: "unmarked" }]);
  const summary = await articleCheckSummary(new Date("2026-11-17T16:00:00Z"), new Date("2026-11-18T16:00:00Z"));
  assert.deepEqual(summary, {
    articles: [
      { articleId: "sum-a", revision: 1 },
      { articleId: "sum-b", revision: 3 },
      { articleId: "sum-d", revision: 2 },
    ],
    softFlags: 1,
    softArticles: 1,
    datelines: { release_wire: 0, news_agency: 1, unmarked: 1 },
  });
  await sql`INSERT INTO entities.article_links (article_id, input_revision, entity_id, lane, role, method, alias, segment, linker_version)
    VALUES ('sum-b', 3, 'bhp', 'news', 'mention', 'text', 'BHP', 'body', 'test'), ('sum-d', 1, 'vale', 'news', 'mention', 'text', 'Vale', 'body', 'test')`;
  assert.deepEqual(await articleLinkCoverage(summary.articles), { linked: 1, library: seedRows().entities.length }, "links of another revision do not count");
});

test("check rows older than 180 days are pruned by the daily retention", async () => {
  const day = 86_400_000;
  for (const [analysisId, age] of [
    [9_101, 181],
    [9_102, 179],
  ] as const)
    await sql`INSERT INTO enrichment.analysis_checks (analysis_id, article_id, input_revision, lane, recipe, mode, verdict, created_at)
      VALUES (${analysisId}, 'prune', 1, 'news', 'test', 'observed', 'ok', ${new Date(Date.now() - age * day)})`;
  const result = await dailyRetention();
  assert.ok(result.deletedAnalysisChecks >= 1);
  assert.deepEqual(
    (await sql`SELECT analysis_id FROM enrichment.analysis_checks WHERE article_id = 'prune'`).map((r) => r.analysis_id),
    [9_102],
  );
});

test("the back-fill script checks the latest judgements once, and its dry run writes nothing", async () => {
  const script = fileURLToPath(new URL("../scripts/entity-links-backfill.ts", import.meta.url));
  const run = async (...args: string[]) =>
    JSON.parse((await promisify(execFile)(process.execPath, [script, ...args], { env: process.env, encoding: "utf8" })).stdout);
  const [{ last }] = await sql<{ last: number }[]>`SELECT coalesce(max(id), 0)::int AS last FROM analyses`;
  const first = await article("backfill-a");
  const second = await article("backfill-b", "Glencore said cobalt output rose.", "Glencore cobalt output rises");
  await judgement(first, { output: { scores: [10, 12], writer: "summarize", fact: null, geography: null } });
  const latest = await judgement(first);
  const other = await judgement(second, {
    output: { scores: [10, 12], writer: "summarize", fact: null, geography: null },
    copy: { title_zh: "嘉能可钴产量上升", summary_zh: "嘉能可表示钴产量上升。" },
  });
  const since = addDays(beijingDate(Date.now()), -1);
  const window = ["--since", since, "--after", String(last)];

  const dry = await run(...window);
  assert.equal(dry.mode, "dry-run");
  assert.deepEqual([dry.examined, dry.observed, dry.articlesWithLinks, dry.library], [2, 2, 2, "database"], "the older judgement of an article is left out");
  assert.deepEqual(dry.stored, { checks: 0, links: 0 });
  assert.deepEqual(dry.verdicts, { ok: 1, soft: 0, hard: 1 });
  assert.deepEqual(dry.datelines, { release_wire: 1, news_agency: 0, unmarked: 0 });
  assert.equal(dry.demotedCountries, 1);
  assert.equal(dry.next, null);
  assert.equal(await checkRow(latest), undefined, "a dry run writes nothing");

  const limited = await run(...window, "--apply", "--limit", "1", "--batch", "1");
  assert.deepEqual([limited.examined, limited.stored, limited.next], [1, { checks: 1, links: 3 }, `--after ${latest}`]);
  const rest = await run("--since", since, "--after", String(latest), "--apply");
  assert.deepEqual([rest.examined, rest.stored], [1, { checks: 1, links: 1 }]);
  assert.equal((await checkRow(other))?.verdict, "ok");
  assert.deepEqual(
    (await links(second)).map((l) => l.entity_id),
    ["glencore"],
  );
  const repeat = await run(...window, "--apply");
  assert.deepEqual([repeat.examined, repeat.stored], [2, { checks: 0, links: 4 }], "a repeat keeps the check rows and refreshes the links");
  await assert.rejects(run("--apply"), "--since is required");
  await assert.rejects(run("--since", "2026-13-01"), "an invalid date stops the script");
});
