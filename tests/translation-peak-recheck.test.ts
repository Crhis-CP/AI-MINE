// A non-selected item's translation never buys a model response in the provider's peak hours (TASK-0579, Codex review
// #362): the worker judges again when it takes the job and before every paid segment, from the publication as it is
// then, and waits in a new job for the next off-peak start; saved segments are not paid for twice. History analysis
// judges again when its job is taken, too. Every time here is explicit (tests/setup.ts turns the wall clock off).
import { completeMaterialGrouping } from "../packages/backend/src/content/grouping.ts";
import { ensureModelSourceFixture } from "./model-source-fixture.ts";
import { scopeVersion, scopeOutput, scopeReceipt } from "./scope-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { sourcePolicyExample } from "./permission-fixture.ts";
import { tag, stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { saveSourcePolicy } from "@amp/backend/admin/sources";
import { upsertMaterial } from "@amp/backend/content/materials";
import { translatePending } from "@amp/backend/editorial/translate";
import { runAnalysisJob, runTranslationJob, sweepUnprocessed } from "@amp/backend/jobs/content";
import { stopBoss } from "@amp/backend/jobs/queue";
import { publishArticle } from "@amp/backend/publication/publish";
import { OFF_PEAK_WAIT } from "@amp/backend/providers/llm";
import { SOURCE_PURPOSES } from "@amp/contracts/source-policy";
import { translationDeferralOptions, translationPeakWait } from "../packages/backend/src/editorial/translation-schedule.ts";
import { changeOwnerLaneControls, listLaneControls } from "../packages/backend/src/operations/lane-controls.ts";

const T = tag();
let hits = 0;
const provider = await stub((_hit, req) => {
  hits += 1;
  const { text } = JSON.parse(JSON.parse(req.body).messages[1].content) as { text: string };
  const marks = [...text.matchAll(/⟦\d+⟧/g)].map((m) => m[0]).join(" ");
  return {
    choices: [{ message: { content: JSON.stringify({ text: `${marks} 合成中文译文 PEAK-${T}` }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "synthetic-peak-recheck-fixture";

// Monday 2030-01-07 (UTC): peak 01:00–04:00 and 06:00–10:00. Far ahead of the wall clock, so no delayed job is due.
const OFF_PEAK = new Date("2030-01-07T00:59:00Z");
const PEAK = new Date("2030-01-07T01:01:00Z");
const MORNING_START = new Date("2030-01-07T04:00:00Z");
const SECOND_PEAK = new Date("2030-01-07T06:30:00Z");
const SECOND_START = new Date("2030-01-07T10:00:00Z");
const at = (time: Date) => ({ now: () => time });

const scope = { hosts: ["example.com"], path_prefixes: ["/"], document_types: [], excluded_content: [] };
const SOURCE = `peak-recheck-${T}`;
let n = 0;
async function article(opts: { selected?: boolean; paragraphs?: number; historical?: boolean } = {}) {
  n += 1;
  const paragraphs = Array.from({ length: opts.paragraphs ?? 1 }, (_, i) => `PARA-${T}-${n}-${i} copper project text with enough words. `.repeat(6));
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.com/${T}-${n}`,
    title: `Copper ${n}`,
    bodyText: paragraphs.join("\n"),
    bodyHtml: paragraphs.map((p) => `<p>${p}</p>`).join(""),
    language: "en",
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(Date.now() - (opts.historical ? 40 : 0) * 86_400_000),
  });
  if (opts.historical) {
    await sql`UPDATE articles SET backfill=true, processing_state='new', processing_retry_at=NULL, processing_queued_at=NULL WHERE id=${articleId}`;
    return articleId;
  }
  const selected = opts.selected ?? false;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected, prompt_version, receipt_ids, output)
    VALUES (${articleId}, 1, 'rule', 'pass', 'project_development', ${`铜矿标题${n}-${T}`}, ${`合成导读 GUIDE-${n}-${T}`}, '理由', ${selected ? 90 : 40}, ${selected},
      ${scopeVersion}, ${[await scopeReceipt(articleId)]}, ${sql.json(scopeOutput)})`;
  await completeMaterialGrouping(articleId, 1, { addsValue: selected, reason: "合成归组" }, null);
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  return articleId;
}
const jobs = (id: string) =>
  sql<{ singleton_key: string; priority: number; start_after: Date; state: string }[]>`
    SELECT singleton_key, priority, start_after, state FROM pgboss.job WHERE name='content.translate' AND data->>'articleId'=${id} ORDER BY created_on, id`;
const checkpoints = async (id: string) =>
  (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM enrichment.translation_segments WHERE article_id=${id} AND state='complete'`)[0]!.n;
const translation = async (id: string) =>
  (await sql<{ complete: boolean }[]>`SELECT complete FROM translations WHERE article_id=${id} AND lang='zh'`)[0]?.complete ?? null;

before(async () => {
  await installUsageFixtureForModel("deepseek-flash");
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at, lane)
    VALUES (${SOURCE}, ${`合成来源 ${SOURCE}`}, 'rss', 'T1', 'editorial', true, false, '2100-01-01', 'news')`;
  await saveSourcePolicy(
    SOURCE,
    {
      policy: {
        ...structuredClone(sourcePolicyExample),
        source_id: SOURCE,
        scope,
        evidence: sourcePolicyExample.evidence.map((e) => ({ ...e, scope })),
        permissions: Object.fromEntries(SOURCE_PURPOSES.map((p) => [p, "allow"])),
      },
      expectedVersion: null,
      reason: "synthetic intake policy",
    },
    "test",
  );
  await ensureModelSourceFixture(SOURCE, ["https://example.com/source"]);
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("the wait is judged from selection at that moment; the follow-up key never equals the running job's", () => {
  assert.equal(translationPeakWait(true, PEAK), null, "a selected item pays the peak price, as before");
  assert.deepEqual(translationPeakWait(false, PEAK), MORNING_START);
  assert.equal(translationPeakWait(false, OFF_PEAK), null);
  const first = translationDeferralOptions("a", MORNING_START);
  assert.deepEqual(first, { singletonKey: "later:a:off-peak:2030-01-07T04:00:00.000Z", priority: -2, startAfter: MORNING_START });
  // The job that took over at 04:00 and is picked up late, in the next peak window, waits under a different key.
  assert.notEqual(translationDeferralOptions("a", translationPeakWait(false, SECOND_PEAK)!).singletonKey, first.singletonKey);
});

test("a later job taken in a peak hour waits for the off-peak start without a model call; selected now goes at once", async () => {
  const later = await article();
  assert.deepEqual(
    (await jobs(later)).map((j) => j.singleton_key),
    [`later:${later}`],
  );
  const before = hits;
  // Queued off-peak (00:59, no start delay), taken at 01:01 because of a backlog.
  const result = await runTranslationJob({ articleId: later }, at(PEAK));
  assert.deepEqual(result, { state: "deferred_peak", until: MORNING_START.toISOString() });
  assert.equal(hits, before, "no paid request in the peak hour");
  const queued = (await jobs(later)).find((j) => j.singleton_key.includes(":off-peak:"))!;
  assert.equal(queued.singleton_key, `later:${later}:off-peak:${MORNING_START.toISOString()}`);
  assert.equal(queued.start_after.toISOString(), MORNING_START.toISOString());
  assert.equal(queued.priority, -2);
  assert.equal(queued.state, "created");
  assert.equal(await translation(later), null, "nothing was claimed or paid for");
  assert.equal((await sql`SELECT 1 FROM translation_attempts WHERE article_id=${later}`).length, 0, "waiting is not an attempt");

  // Selected while it waited (an editor marks it): the same peak hour now translates it at once.
  await sql`INSERT INTO editorial_overrides(article_id,fields,updated_by) VALUES(${later},'{"selected":true}','test')`;
  const now = await runTranslationJob({ articleId: later }, at(PEAK));
  assert.equal((now as { status?: string }).status, "translated", JSON.stringify(now));
  assert.ok(hits > before);
  assert.equal(await translation(later), true);
});

test("a long body stops between segments when a peak window starts and resumes off-peak without paying twice", async () => {
  const long = await article({ paragraphs: 4 });
  const before = hits;
  // Off-peak for the first segment; the clock reaches 01:01 once one response has been bought.
  const clock = { now: () => (hits > before ? PEAK : OFF_PEAK) };
  const stopped = await runTranslationJob({ articleId: long }, clock);
  assert.deepEqual(stopped, { state: "deferred_peak", until: MORNING_START.toISOString() });
  assert.equal(hits - before, 1, "only the segment begun off-peak was bought");
  assert.equal(await checkpoints(long), 1, "the bought segment is a saved checkpoint");
  assert.equal(await translation(long), false);
  assert.equal((await sql`SELECT 1 FROM translation_attempts WHERE article_id=${long}`).length, 0, "stopping to wait is not an attempt");
  assert.ok((await jobs(long)).some((j) => j.singleton_key === `later:${long}:off-peak:${MORNING_START.toISOString()}`));

  const resumed = await runTranslationJob({ articleId: long }, at(MORNING_START));
  assert.equal((resumed as { status?: string }).status, "translated", JSON.stringify(resumed));
  assert.equal(hits - before, 4, "four segments, four requests: the first is not bought again");
  assert.equal(await translation(long), true);

  // The cron repair's duplicate (and any other copy) finds the translation complete and makes no model call.
  const done = hits;
  assert.deepEqual(await runTranslationJob({ articleId: long }, at(MORNING_START)), { state: "not-needed-or-not-permitted" });
  assert.deepEqual(await runTranslationJob({ articleId: long }, at(PEAK)), { state: "not-needed-or-not-permitted" });
  assert.equal(hits, done);
});

test("repeated waits keep a job queued: past the off-peak window into the next peak, and beside a cron duplicate", async () => {
  const item = await article();
  const before = hits;
  assert.deepEqual(await runTranslationJob({ articleId: item }, at(PEAK)), { state: "deferred_peak", until: MORNING_START.toISOString() });
  // The cron repair runs during the wait: the item still needs translating, its `later:` job is already queued.
  await translatePending({ limit: 1000, now: PEAK });
  const morningKey = `later:${item}:off-peak:${MORNING_START.toISOString()}`;
  // The 04:00 job is taken (active) but only at 06:30, in the next peak window, because of a backlog.
  await sql`UPDATE pgboss.job SET state='active', started_on=now() WHERE name='content.translate' AND singleton_key=${morningKey}`;
  assert.deepEqual(await runTranslationJob({ articleId: item }, at(SECOND_PEAK)), { state: "deferred_peak", until: SECOND_START.toISOString() });
  // A second copy taken in the same window collapses into the job already waiting for 10:00; nothing is dropped.
  assert.deepEqual(await runTranslationJob({ articleId: item }, at(SECOND_PEAK)), { state: "deferred_peak", until: SECOND_START.toISOString() });
  const rows = await jobs(item);
  assert.deepEqual(
    rows.map((j) => [j.singleton_key, j.state]),
    [
      [`later:${item}`, "created"],
      [morningKey, "active"],
      [`later:${item}:off-peak:${SECOND_START.toISOString()}`, "created"],
    ],
  );
  assert.equal(hits, before, "no request in either peak window");
  // At 10:00 the waiting job translates; the cron duplicate that runs after it makes no model call.
  assert.equal(((await runTranslationJob({ articleId: item }, at(SECOND_START))) as { status?: string }).status, "translated");
  const paid = hits;
  assert.deepEqual(await runTranslationJob({ articleId: item }, at(SECOND_START)), { state: "not-needed-or-not-permitted" });
  assert.equal(hits, paid);
});

test("history analysis taken in a peak hour waits through its retry time and the safety net", async () => {
  const history = await article({ historical: true });
  const before = hits;
  assert.deepEqual(await runAnalysisJob({ articleId: history }, at(PEAK)), { state: "deferred_peak", until: MORNING_START.toISOString() });
  assert.equal(hits, before, "no analysis call in the peak hour");
  const [row] = await sql<{ processing_state: string; processing_retry_at: Date; processing_error: string; processing_queued_at: Date | null }[]>`
    SELECT processing_state, processing_retry_at, processing_error, processing_queued_at FROM articles WHERE id=${history}`;
  assert.equal(row!.processing_state, "new");
  assert.equal(row!.processing_retry_at.toISOString(), MORNING_START.toISOString());
  assert.equal(row!.processing_error, OFF_PEAK_WAIT, "the stuck-content alert does not count it");
  assert.equal(row!.processing_queued_at, null);
  // The safety net leaves it alone until the off-peak start (here still years away), then queues it like any other.
  await sweepUnprocessed();
  const queued = await sql`SELECT 1 FROM articles WHERE id=${history} AND processing_queued_at IS NOT NULL`;
  assert.equal(queued.length, 0);
});

test("a paused lane postpones the translation and leaves the analysed article as it is (TASK-0608)", async () => {
  const id = await article({ selected: true });
  const state = async () => (await sql<{ processing_state: string }[]>`SELECT processing_state FROM articles WHERE id=${id}`)[0]!.processing_state;
  const before = await state();
  const control = async (action: "pause" | "resume") =>
    changeOwnerLaneControls(
      {
        lane: "news",
        mode: "processing",
        action,
        reason: "Synthetic pause for a translation",
        ...(action === "pause" ? { expires_at: new Date(Date.now() + 3600_000).toISOString() } : {}),
        expected_revisions: { processing: (await listLaneControls()).owner_revisions.find((r) => r.lane === "news" && r.switch === "processing")!.revision },
        confirm_all: true,
      },
      "test-owner",
    );
  await control("pause");
  try {
    const paid = hits;
    const now = new Date("2030-01-07T05:00:00Z");
    const result = await runTranslationJob({ articleId: id }, at(now));
    assert.deepEqual(result, { state: "deferred_peak", until: new Date(now.getTime() + 30 * 60_000).toISOString() });
    assert.equal(hits, paid, "nothing is paid while paused");
    assert.equal(await state(), before, "the article is not sent back for a second analysis");
  } finally {
    await control("resume");
  }
});
