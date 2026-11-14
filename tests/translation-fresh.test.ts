// A new article's Chinese translation is not held back (TASK-0676, Owner 2026-11-13: 每次新上新的翻译都不能马上跟上
// 中文翻译). An item found within the two-day live window, selected or not, is translated at once: it neither waits for
// the provider's off-peak price nor yields the model quota to core steps. Older items are backlog: they still wait for
// the off-peak start and yield once three quarters of the hour or day are used. Freshness is judged when the job is
// taken and before every paid segment, so a long body that ages out of the window mid-way continues as backlog. Every
// deferral records why it waited. A local stub stands in for the provider; every clock here is explicit.
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
import { QUOTA_RECHECK_MS } from "../packages/backend/src/editorial/translation-quota.ts";
import { modelFor } from "../packages/backend/src/editorial/models.ts";
import { modelService } from "../packages/backend/src/providers/model-fallback-admission.ts";
import { changeOwnerLaneControls, listLaneControls } from "../packages/backend/src/operations/lane-controls.ts";

const T = tag();
let hits = 0;
/** Runs after each provider response is prepared; the mid-body test ages its item here. */
let afterHit: () => Promise<void> = async () => {};
const provider = await stub(async (_hit, req) => {
  hits += 1;
  await afterHit();
  const { text } = JSON.parse(JSON.parse(req.body).messages[1].content) as { text: string };
  const marks = [...text.matchAll(/⟦\d+⟧/g)].map((m) => m[0]).join(" ");
  return {
    choices: [{ message: { content: JSON.stringify({ text: `${marks} 合成中文译文 FRESH-${T}` }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "synthetic-translation-fresh-fixture";

// Monday 2030-01-07 (UTC): 00:59 is off-peak, 01:01 is in a peak window that ends at 04:00. Far ahead of the wall
// clock, so no delayed job is due. Freshness is judged by the database clock, against each item's discovery time.
const OFF_PEAK = new Date("2030-01-07T00:59:00Z");
const PEAK = new Date("2030-01-07T01:01:00Z");
const MORNING_START = new Date("2030-01-07T04:00:00Z");
const at = (time: Date) => ({ now: () => time });

const scope = { hosts: ["example.com"], path_prefixes: ["/"], document_types: [], excluded_content: [] };
const SOURCE = `translation-fresh-${T}`;
let n = 0;
/** A public item that is not selected (unless asked), found `hoursAgo` hours ago. */
async function article(opts: { hoursAgo: number; selected?: boolean; paragraphs?: number }) {
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
    publishedAt: new Date(Date.now() - 60_000),
  });
  const selected = opts.selected ?? false;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected, prompt_version, receipt_ids, output)
    VALUES (${articleId}, 1, 'rule', 'pass', 'project_development', ${`铜矿标题${n}-${T}`}, ${`合成导读 GUIDE-${n}-${T}`}, '理由', ${selected ? 90 : 40}, ${selected},
      ${scopeVersion}, ${[await scopeReceipt(articleId)]}, ${sql.json(scopeOutput)})`;
  await completeMaterialGrouping(articleId, 1, { addsValue: selected, reason: "合成归组" }, null);
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  await age(articleId, opts.hoursAgo);
  return articleId;
}
const age = (id: string, hoursAgo: number) => sql`UPDATE articles SET discovered_at = now() - make_interval(hours => ${hoursAgo}) WHERE id=${id}`;
const translation = async (id: string) =>
  (await sql<{ complete: boolean }[]>`SELECT complete FROM translations WHERE article_id=${id} AND lang='zh'`)[0]?.complete ?? null;
const checkpoints = async (id: string) =>
  (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM enrichment.translation_segments WHERE article_id=${id} AND state='complete'`)[0]!.n;
const status = (result: unknown) => (result as { status?: string }).status;

// The quota translation draws on, set to a known share of an hourly limit of 100 requests: earlier requests are moved
// out of the hour (the day window is set far above them) and synthetic attempts fill the hour to `percent`.
let service = "";
let pads = 0;
async function useHour(percent: number) {
  await sql`UPDATE receipt_attempts SET started_at = started_at - interval '2 hours'
    WHERE coalesce(quota_service, service) = ${service} AND started_at > now() - interval '1 hour'`;
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 100, per_day = 100000 WHERE service = ${service}`;
  if (percent === 0) return;
  pads += 1;
  const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,model,purpose,subject,status,request,response,attempts)
    VALUES(${`fresh-pad-${T}-${pads}`},${service},'pad-model','translate_body',${`article:pad-${T}-${pads}@1`},'received',${sql.json({})},${sql.json({ ok: true })},${percent}) RETURNING id`;
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status)
    SELECT ${receipt!.id}, g, ${service}, 'pad-model', 'received' FROM generate_series(1, ${percent}::int) g`;
}

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
  const resolved = await modelService(await modelFor("translate"), sql);
  assert.ok(resolved, "the translation route draws on a known quota");
  service = resolved;
  await useHour(0);
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("an item found 47 hours ago is translated at once in a peak hour; one found 49 hours ago waits for the off-peak start", async () => {
  const fresh = await article({ hoursAgo: 47 });
  const before = hits;
  assert.equal(status(await runTranslationJob({ articleId: fresh }, at(PEAK))), "translated");
  assert.ok(hits > before, "the fresh item paid the peak price");
  assert.equal(await translation(fresh), true);

  const backlog = await article({ hoursAgo: 49 });
  const paid = hits;
  assert.deepEqual(await runTranslationJob({ articleId: backlog }, at(PEAK)), { state: "deferred_peak", reason: "peak", until: MORNING_START.toISOString() });
  assert.equal(hits, paid, "no paid request for backlog in the peak hour");
  assert.equal(await translation(backlog), null);
  assert.equal(status(await runTranslationJob({ articleId: backlog }, at(MORNING_START))), "translated");
});

test("past three quarters of the hourly quota an item found 47 hours ago is still translated; one found 49 hours ago yields", async () => {
  await useHour(80);
  const fresh = await article({ hoursAgo: 47 });
  const before = hits;
  assert.equal(status(await runTranslationJob({ articleId: fresh }, at(OFF_PEAK))), "translated");
  assert.ok(hits > before, "the fresh item is not held for quota");

  const backlog = await article({ hoursAgo: 49 });
  const paid = hits;
  const until = new Date(OFF_PEAK.getTime() + QUOTA_RECHECK_MS).toISOString();
  assert.deepEqual(await runTranslationJob({ articleId: backlog }, at(OFF_PEAK)), { state: "deferred_peak", reason: "quota", until });
  assert.equal(hits, paid, "no paid request for backlog past three quarters of the quota");
});

test("backlog goes ahead at 60% of the hourly quota and waits at 80%", async () => {
  await useHour(60);
  const first = await article({ hoursAgo: 72 });
  assert.equal(status(await runTranslationJob({ articleId: first }, at(OFF_PEAK))), "translated", "60% leaves backlog its share");

  await useHour(80);
  const second = await article({ hoursAgo: 72 });
  const before = hits;
  const waited = await runTranslationJob({ articleId: second }, at(OFF_PEAK));
  assert.equal((waited as { state?: string }).state, "deferred_peak", JSON.stringify(waited));
  assert.equal((waited as { reason?: string }).reason, "quota");
  assert.equal(hits, before);

  // Back below three quarters, it is translated.
  await useHour(60);
  assert.equal(status(await runTranslationJob({ articleId: second }, at(OFF_PEAK))), "translated");
  await useHour(0);
});

test("a long body that crosses the 48-hour line mid-way is judged as backlog before its next paid segment", async () => {
  const long = await article({ hoursAgo: 47, paragraphs: 4 });
  const before = hits;
  // The first segment is bought while the item is fresh; by the time it is answered the item is 49 hours old.
  afterHit = async () => {
    await age(long, 49);
  };
  try {
    const stopped = await runTranslationJob({ articleId: long }, at(PEAK));
    assert.deepEqual(stopped, { state: "deferred_peak", reason: "peak", until: MORNING_START.toISOString() });
  } finally {
    afterHit = async () => {};
  }
  assert.equal(hits - before, 1, "only the segment begun while fresh was bought in the peak hour");
  assert.equal(await checkpoints(long), 1, "the bought segment is kept");
  assert.equal(await translation(long), false);

  const resumed = await runTranslationJob({ articleId: long }, at(MORNING_START));
  assert.equal(status(resumed), "translated", JSON.stringify(resumed));
  assert.equal(hits - before, 4, "four segments, four requests: the first is not bought again");
});

test("a paused lane postpones even a fresh item, and the deferral says it was paused", async () => {
  const id = await article({ hoursAgo: 1 });
  const control = async (action: "pause" | "resume") =>
    changeOwnerLaneControls(
      {
        lane: "news",
        mode: "processing",
        action,
        reason: "Synthetic pause for a fresh translation",
        ...(action === "pause" ? { expires_at: new Date(Date.now() + 3600_000).toISOString() } : {}),
        expected_revisions: { processing: (await listLaneControls()).owner_revisions.find((r) => r.lane === "news" && r.switch === "processing")!.revision },
        confirm_all: true,
      },
      "test-owner",
    );
  await control("pause");
  try {
    const paid = hits;
    const result = await runTranslationJob({ articleId: id }, at(OFF_PEAK));
    assert.deepEqual(result, { state: "deferred_peak", reason: "paused", until: new Date(OFF_PEAK.getTime() + 30 * 60_000).toISOString() });
    assert.equal(hits, paid, "nothing is paid while paused");
  } finally {
    await control("resume");
  }
});
