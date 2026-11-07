// Background translation leaves half of the shared model quota to the steps readers wait on (TASK-0580, Owner
// 2026-11-07): a translation that is not selected pays only while the hour and the day each have at least half of
// their limit unused, judged when the job is taken and before every paid segment; otherwise it waits in a new job and
// judges again. A selected item is never held back. Every time here is off-peak and explicit.
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
import { runTranslationJob } from "@amp/backend/jobs/content";
import { stopBoss } from "@amp/backend/jobs/queue";
import { publishArticle } from "@amp/backend/publication/publish";
import { SOURCE_PURPOSES } from "@amp/contracts/source-policy";
import { QUOTA_RECHECK_MS, translationQuotaWait } from "../packages/backend/src/editorial/translation-quota.ts";

const T = tag();
let hits = 0;
const provider = await stub((_hit, req) => {
  hits += 1;
  const { text } = JSON.parse(JSON.parse(req.body).messages[1].content) as { text: string };
  const marks = [...text.matchAll(/⟦\d+⟧/g)].map((m) => m[0]).join(" ");
  return {
    choices: [{ message: { content: JSON.stringify({ text: `${marks} 合成中文译文 QUOTA-${T}` }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "synthetic-quota-yield-fixture";

// Monday 2030-01-07 00:59 UTC: off-peak. Far ahead of the wall clock, so no delayed job is due.
const OFF_PEAK = new Date("2030-01-07T00:59:00Z");
const at = (time: Date) => ({ now: () => time });

const scope = { hosts: ["example.com"], path_prefixes: ["/"], document_types: [], excluded_content: [] };
const SOURCE = `quota-yield-${T}`;
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

// The provider quota translation draws on, its live use in the last hour, and a setter for its hourly limit.
const quota = async () =>
  (
    await sql<{ service: string }[]>`SELECT DISTINCT coalesce(a.quota_service,a.service) AS service FROM receipt_attempts a
    JOIN receipts r ON r.id=a.receipt_id WHERE r.purpose='translate_body'`
  )[0]!.service;
const usedHour = async (service: string) =>
  (
    await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts WHERE coalesce(quota_service,service)=${service}
    AND origin='live' AND started_at > now() - interval '1 hour'`
  )[0]!.n;
const perHour = (service: string, limit: number) =>
  sql`UPDATE budgets SET per_hour=${limit}, per_day=GREATEST(per_day, ${limit * 10}) WHERE service=${service}`;

test("background translation waits once half of the hour is used; a selected item goes at once; it resumes with room", async () => {
  // Nothing has drawn on the quota yet: a first translation goes ahead and records its requests.
  const first = await article();
  assert.equal(((await runTranslationJob({ articleId: first }, at(OFF_PEAK))) as { status?: string }).status, "translated");
  const service = await quota();
  const used = await usedHour(service);
  assert.ok(used >= 1);

  // Exactly half of the hourly limit is used: the next background translation waits without a model call.
  await perHour(service, used * 2);
  const held = await article();
  const before = hits;
  const waited = await runTranslationJob({ articleId: held }, at(OFF_PEAK));
  const until = new Date(OFF_PEAK.getTime() + QUOTA_RECHECK_MS).toISOString();
  assert.deepEqual(waited, { state: "deferred_peak", until });
  assert.equal(hits, before, "no paid request while the quota is half used");
  assert.ok((await jobs(held)).some((j) => j.singleton_key === `later:${held}:off-peak:${until}` && j.state === "created"));
  assert.equal(await translation(held), null);
  assert.equal(await translationQuotaWait(true, OFF_PEAK), null, "a selected item is never held for quota");

  // A selected item is translated at once in the same state of the quota.
  const chosen = await article({ selected: true });
  assert.equal(((await runTranslationJob({ articleId: chosen }, at(OFF_PEAK))) as { status?: string }).status, "translated");
  assert.ok(hits > before);

  // With room again the waiting item is translated.
  await perHour(service, (await usedHour(service)) * 10);
  assert.equal(((await runTranslationJob({ articleId: held }, at(OFF_PEAK))) as { status?: string }).status, "translated");
  assert.equal(await translation(held), true);
});

test("a long background body stops between segments when it reaches half of the hour and resumes without paying twice", async () => {
  const service = await quota();
  const long = await article({ paragraphs: 4 });
  // Room for exactly one more request below half of the limit.
  const used = await usedHour(service);
  await perHour(service, (used + 1) * 2);
  const before = hits;
  const stopped = await runTranslationJob({ articleId: long }, at(OFF_PEAK));
  assert.equal((stopped as { state?: string }).state, "deferred_peak", JSON.stringify(stopped));
  assert.equal(hits - before, 1, "one segment was bought, then the quota share was reached");
  assert.equal(await checkpoints(long), 1);
  assert.equal(await translation(long), false);
  await perHour(service, (await usedHour(service)) * 10);
  assert.equal(((await runTranslationJob({ articleId: long }, at(OFF_PEAK))) as { status?: string }).status, "translated");
  assert.equal(hits - before, 4, "four segments, four requests");
});

test("the daily window counts too, and a stopped quota holds background translation", async () => {
  const service = await quota();
  const usedDay = (
    await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts WHERE coalesce(quota_service,service)=${service}
    AND origin='live' AND started_at > now() - interval '1 day'`
  )[0]!.n;
  await sql`UPDATE budgets SET per_hour=100000, per_day=${usedDay * 2} WHERE service=${service}`;
  assert.ok(await translationQuotaWait(false, OFF_PEAK), "half of the day used holds background translation");
  await sql`UPDATE budgets SET per_day=${usedDay * 10} WHERE service=${service}`;
  assert.equal(await translationQuotaWait(false, OFF_PEAK), null);
  await sql`UPDATE budgets SET per_hour=0 WHERE service=${service}`;
  assert.ok(await translationQuotaWait(false, OFF_PEAK), "a stopped quota holds it");
  await sql`UPDATE budgets SET per_hour=100000 WHERE service=${service}`;
});

test("an old selected item reached by a republication is backlog: it waits for quota like background work", async () => {
  const service = await quota();
  await perHour(service, Math.max(1, await usedHour(service)) * 2);
  const old = await article({ selected: true });
  await sql`UPDATE articles SET discovered_at = now() - interval '30 days' WHERE id=${old}`;
  const before = hits;
  const waited = await runTranslationJob({ articleId: old }, at(OFF_PEAK));
  assert.equal((waited as { state?: string }).state, "deferred_peak", JSON.stringify(waited));
  assert.equal(hits, before, "no paid request for old selected backlog while the quota is half used");
  // A fresh selected item in the same state still goes at once.
  const fresh = await article({ selected: true });
  assert.equal(((await runTranslationJob({ articleId: fresh }, at(OFF_PEAK))) as { status?: string }).status, "translated");
  await perHour(service, (await usedHour(service)) * 10);
  assert.equal(((await runTranslationJob({ articleId: old }, at(OFF_PEAK))) as { status?: string }).status, "translated");
});

test("only the quota of the current translation route is judged: a former provider over its share does not hold translation", async () => {
  // A provider translation used before (Codex review #372): stopped, and with a translate_body attempt in the last day.
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day,note) VALUES('former-provider',100,0,0,'test') ON CONFLICT(service) DO UPDATE SET per_hour=0, per_day=0`;
  const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,model,purpose,subject,status,request,response,attempts)
    VALUES(${`former-${T}`},'former-provider','former-model','translate_body',${`article:former-${T}@1`},'received',${sql.json({})},${sql.json({ ok: true })},1) RETURNING id`;
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,response) VALUES(${receipt!.id},1,'former-provider','former-model','received',${sql.json({ ok: true })})`;
  const service = await quota();
  assert.notEqual(service, "former-provider");
  await perHour(service, (await usedHour(service)) * 10);
  assert.equal(await translationQuotaWait(false, OFF_PEAK), null, "the current route has room; the former provider is not judged");
  const item = await article();
  assert.equal(((await runTranslationJob({ articleId: item }, at(OFF_PEAK))) as { status?: string }).status, "translated");
});
