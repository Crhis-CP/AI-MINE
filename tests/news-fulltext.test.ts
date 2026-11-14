// News full text and its Chinese translation on our own pages (TASK-0569; Owner 2026-11-07, DEC-78补充·新闻原文全文与中文译文).
// Opening is an audited, idempotent ops run that leaves the policy lane, hot-signal sources and off-site redistribution
// alone; a per-source tightening still withdraws full text and survives later runs. Translation covers every admitted
// public item: selected at once, the rest in the same queue at a lower priority, older items only through the backfill.
import { completeMaterialGrouping } from "../packages/backend/src/content/grouping.ts";
import { ensureModelSourceFixture } from "./model-source-fixture.ts";
import { scopeVersion, scopeOutput, scopeReceipt } from "./scope-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { sourcePolicyExample } from "./permission-fixture.ts";
import { tag, stub } from "./setup.ts";
import { runBodyTranslation } from "../packages/backend/src/editorial/translation-runtime.ts";
import { TRANSLATION_MANIFEST_FORMAT } from "../packages/backend/src/editorial/translation-readiness.ts";
import { translationJobOptions, translationTokenEstimate, promptTokenEstimate } from "../packages/backend/src/editorial/translation-schedule.ts";
import { translationBudgetUnits, translationSourceManifest } from "../packages/backend/src/editorial/translation-readiness.ts";
import { promptVersion, promptText } from "@amp/backend/editorial/prompts";
import { translatePending } from "@amp/backend/editorial/translate";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { openNewsFulltext, readCurrentSourcePolicy, saveSourcePolicy, updateSource, NEWS_FULLTEXT_BASIS_ZH } from "@amp/backend/admin/sources";
import { upsertMaterial } from "@amp/backend/content/materials";
import { stopBoss } from "@amp/backend/jobs/queue";
import { publishArticle, republishSource } from "@amp/backend/publication/publish";
import { machineItemDetail } from "@amp/backend/publication/detail";
import { SOURCE_PURPOSES } from "@amp/contracts/source-policy";
import { buildApp } from "./site-app.ts";
import { translationAnswer } from "./translation-stub.ts";

const T = tag();
const ACTOR = "ops:news-fulltext-test";
const provider = await stub((_hit, req) => {
  const content = translationAnswer(req.body, (text) => `${[...text.matchAll(/⟦\d+⟧/g)].map((m) => m[0]).join(" ")} 合成中文译文 ZH-${T}`);
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "synthetic-news-fulltext-fixture";
const app = await buildApp();

const scope = { hosts: ["example.com"], path_prefixes: ["/"], document_types: [], excluded_content: [] };
/** A policy like the one intake writes: every purpose declared by the Owner, full text and translation as given. */
function policy(sourceId: string, fulltext: "allow" | "deny") {
  return {
    ...structuredClone(sourcePolicyExample),
    source_id: sourceId,
    scope,
    evidence: sourcePolicyExample.evidence.map((e) => ({ ...e, scope })),
    permissions: Object.fromEntries(SOURCE_PURPOSES.map((p) => [p, p === "public_original_fulltext" || p === "public_translation" ? fulltext : "allow"])),
  };
}
async function source(id: string, opts: { lane?: "news" | "policy"; mode?: string; fulltext: boolean }) {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at, lane)
    VALUES (${id}, ${`合成来源 ${id}`}, 'rss', 'T1', ${opts.mode ?? "editorial"}, ${opts.fulltext}, false, '2100-01-01', ${opts.lane ?? "news"})`;
  await saveSourcePolicy(id, { policy: policy(id, opts.fulltext ? "allow" : "deny"), expectedVersion: null, reason: "synthetic intake policy" }, "test");
}
const version = async (id: string) => ((await sql<{ updated_at: Date }[]>`SELECT updated_at FROM sources WHERE id=${id}`)[0]!.updated_at as Date).toISOString();

let n = 0;
async function article(sourceId: string, opts: { language?: string; selected?: boolean; daysAgo?: number } = {}) {
  await ensureModelSourceFixture(sourceId, ["https://example.com/source"]);
  n += 1;
  const body = `BODY-${T}-${n} copper project text. `.repeat(20);
  const { articleId } = await upsertMaterial({
    sourceId,
    url: `https://example.com/${T}-${n}`,
    title: `Copper ${n}`,
    bodyText: body,
    bodyHtml: `<p>${body}</p>`,
    language: opts.language ?? "en",
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(Date.now() - (opts.daysAgo ?? 0) * 86_400_000),
  });
  if (opts.daysAgo) await sql`UPDATE articles SET discovered_at = now() - make_interval(days => ${opts.daysAgo}) WHERE id=${articleId}`;
  const selected = opts.selected ?? true;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected, prompt_version, receipt_ids, output)
    VALUES (${articleId}, 1, 'rule', 'pass', 'project_development', ${`铜矿标题${n}-${T}`}, ${`合成导读 GUIDE-${n}-${T}`}, '理由', ${selected ? 90 : 40}, ${selected},
      ${scopeVersion}, ${[await scopeReceipt(articleId)]}, ${sql.json(scopeOutput)})`;
  await completeMaterialGrouping(articleId, 1, { addsValue: selected, reason: "合成归组" }, null);
  return articleId;
}
async function translate(id: string) {
  const v = promptVersion("translate-body");
  const result = await runBodyTranslation(id, {
    id: `${TRANSLATION_MANIFEST_FORMAT}:${v}`,
    model: "deepseek-flash",
    promptVersion: v,
    system: promptText("translate-body"),
  });
  assert.equal(result.status, "translated");
}
const released = () => ({ releasedAt: new Date(Date.now() - 60_000) });
const detail = async (path: string) => {
  const res = await app.inject({ method: "GET", url: path });
  return { status: res.statusCode, json: res.statusCode === 200 ? res.json() : null };
};
const jobs = (id: string) =>
  sql<{ singleton_key: string; priority: number; start_after: Date }[]>`
    SELECT singleton_key, priority, start_after FROM pgboss.job WHERE name='content.translate' AND data->>'articleId'=${id} ORDER BY created_on`;

before(async () => {
  await installUsageFixtureForModel("deepseek-flash");
});
after(async () => {
  await app.close();
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("opening news full text is audited and idempotent; policy lane, hot signal and redistribution stay as they are; tightening still withdraws", async () => {
  const A = `nf-open-${T}`,
    B = `nf-closed-${T}`,
    P = `nf-policy-${T}`,
    H = `nf-signal-${T}`;
  await source(A, { fulltext: false });
  await source(B, { fulltext: true });
  await source(P, { lane: "policy", fulltext: false });
  await source(H, { mode: "hot_signal", fulltext: false });
  // B was closed for itself from the admin page: an owner instruction that later runs must respect.
  await updateSource(B, { patch: { site_fulltext: false }, version: await version(B), reason: "来源方要求只放导读" }, "fixture-owner");

  const item = await article(A);
  await publishArticle(item, released());
  const restricted = (await detail(`/api/site/items/${item}`)).json;
  assert.equal(restricted.readingState, "restricted");
  assert.equal(restricted.body, null);
  assert.match(restricted.summary, /合成导读/, "the AI guide is there either way");

  const dry = await openNewsFulltext(ACTOR);
  const status = (id: string, result = dry) => result.sources.find((s) => s.id === id)?.status;
  assert.equal(status(A), "would_open");
  assert.equal(status(B), "kept_tightened");
  assert.equal(status(P), undefined, "the policy lane is not touched");
  assert.equal(status(H), undefined, "hot-signal sources have no pages and are not touched");
  assert.equal((await sql`SELECT site_fulltext FROM sources WHERE id=${A}`)[0]!.site_fulltext, false, "a dry run writes nothing");

  const applied = await openNewsFulltext(ACTOR, { apply: true });
  assert.equal(status(A, applied), "opened");
  assert.equal(status(B, applied), "kept_tightened");
  const [opened] = await sql<{ site_fulltext: boolean; syndicate_fulltext: boolean }[]>`SELECT site_fulltext,syndicate_fulltext FROM sources WHERE id=${A}`;
  assert.deepEqual(opened, { site_fulltext: true, syndicate_fulltext: false }, "off-site redistribution stays off");
  const permission = (await readCurrentSourcePolicy(A))!;
  assert.equal(permission.permission_version, 2);
  assert.equal(permission.permissions.public_original_fulltext, "allow");
  assert.equal(permission.permissions.public_translation, "allow");
  const evidence = permission.evidence.at(-1)!;
  assert.equal(evidence.kind, "owner_declared");
  assert.equal(evidence.basis_zh, NEWS_FULLTEXT_BASIS_ZH);
  assert.match(evidence.basis_zh, /2026-11-07/);
  assert.deepEqual(evidence.capabilities, ["public_original_fulltext", "public_translation"]);
  const audits = await sql<{ action: string }[]>`SELECT action FROM audit_log WHERE subject=${`source:${A}`} AND actor=${ACTOR} ORDER BY id`;
  assert.deepEqual(
    audits.map((a) => a.action),
    ["source.permission", "source.update"],
  );
  const [queued] = await sql<{ value: { status: string } }[]>`SELECT value FROM settings WHERE key=${`republish.source:${A}`}`;
  assert.equal(queued?.value.status, "queued", "the source's articles are republished, as after an admin edit");
  for (const id of [P, H]) assert.equal((await sql`SELECT site_fulltext FROM sources WHERE id=${id}`)[0]!.site_fulltext, false);
  assert.equal((await readCurrentSourcePolicy(P))!.permissions.public_original_fulltext, "deny");
  assert.equal(status(A, await openNewsFulltext(ACTOR, { apply: true })), "already_open", "a second run changes nothing");
  assert.equal((await readCurrentSourcePolicy(A))!.permission_version, 2);

  // The republication the run queued: the body is now readable on our page, the original while the translation is made.
  await republishSource(A);
  const pending = (await detail(`/api/site/items/${item}`)).json;
  assert.equal(pending.readingState, "pending");
  assert.equal(pending.bodyLanguage, "original");
  assert.equal(pending.hasTranslation, false);
  assert.match(pending.body.original, new RegExp(`BODY-${T}`));
  assert.match(pending.summary, /合成导读/);
  await translate(item);
  await publishArticle(item, released());
  const available = (await detail(`/api/site/items/${item}`)).json;
  assert.equal(available.readingState, "available");
  assert.equal(available.bodyLanguage, "zh");
  assert.equal(available.hasTranslation, true);
  assert.match(available.body.zh, new RegExp(`ZH-${T}`));
  assert.equal(available.body.complete, true);
  const original = (await detail(`/api/site/items/${item}/original`)).json;
  assert.match(original.body.original, new RegExp(`BODY-${T}`));
  // Machine exits still carry no full text: redistribution is a separate, closed permission.
  const machine = (await machineItemDetail(item))!;
  assert.equal(machine.item.body, null);
  assert.equal(machine.reading.redistribution, "restricted");
  const feed = (await app.inject({ method: "GET", url: "/feed/full.xml" })).body;
  assert.ok(!feed.includes(`BODY-${T}`) && !feed.includes(`ZH-${T}`), "the full feed carries neither the original nor the translation");

  // Tightening one source back from the admin page withdraws its full text and translation, and later runs keep it closed.
  await updateSource(A, { patch: { site_fulltext: false }, version: await version(A), reason: "来源方异议" }, "fixture-owner");
  const closed = (await readCurrentSourcePolicy(A))!;
  assert.equal(closed.permissions.public_original_fulltext, "deny");
  assert.equal(closed.permissions.public_translation, "deny");
  await republishSource(A);
  const withdrawn = (await detail(`/api/site/items/${item}`)).json;
  assert.equal(withdrawn.readingState, "restricted");
  assert.equal(withdrawn.body, null);
  assert.equal((await detail(`/api/site/items/${item}/original`)).json.body, null);
  assert.equal(status(A, await openNewsFulltext(ACTOR, { apply: true })), "kept_tightened");
  assert.equal((await sql`SELECT site_fulltext FROM sources WHERE id=${A}`)[0]!.site_fulltext, false);

  // Reopening a source an owner instruction closed takes the explicit flag.
  assert.equal(status(B, await openNewsFulltext(ACTOR, { apply: true, includeOwnerClosed: true })), "opened");
  assert.equal((await sql`SELECT site_fulltext FROM sources WHERE id=${B}`)[0]!.site_fulltext, true);
});

test("translation covers every admitted public item: selected at once, the rest later at a lower priority, older ones only by the backfill", async () => {
  const S = `nf-translate-${T}`;
  await source(S, { fulltext: true });
  const selected = await article(S);
  const later = await article(S, { selected: false });
  const chinese = await article(S, { language: "zh-CN", selected: false });
  const old = await article(S, { selected: false, daysAgo: 10 });
  for (const id of [selected, later, chinese, old]) await publishArticle(id, released());
  const visibility = await sql<{ article_id: string; visibility: string; selected: boolean; eligible: boolean }[]>`
    SELECT article_id,visibility,selected,eligible FROM publications WHERE article_id=ANY(${[selected, later, chinese, old]}::text[])`;
  for (const row of visibility) assert.equal(row.visibility, "public", JSON.stringify(row));
  assert.equal(visibility.find((r) => r.article_id === selected)!.selected, true);
  assert.equal(visibility.find((r) => r.article_id === later)!.selected, false);

  assert.deepEqual(
    (await jobs(selected)).map((j) => [j.singleton_key, j.priority]),
    [[selected, 0]],
    "a selected item is queued at once, as before",
  );
  assert.deepEqual(
    (await jobs(later)).map((j) => [j.singleton_key, j.priority]),
    [[`later:${later}`, -2]],
    "a non-selected item waits in the same queue at a lower priority",
  );
  assert.equal((await jobs(chinese)).length, 0, "a Chinese original is not translated");
  assert.equal((await jobs(old)).length, 0, "republishing an older item does not queue paid work on its own");

  // The non-selected page shows the original with the translation pending; the guide is unchanged.
  const page = (await detail(`/api/site/items/${later}`)).json;
  assert.equal(page.readingState, "pending");
  assert.equal(page.bodyLanguage, "original");
  assert.match(page.summary, /合成导读/);
  const native = (await detail(`/api/site/items/${chinese}`)).json;
  assert.equal(native.readingState, "available");
  assert.equal(native.body.zhKind, "original");
  assert.equal(native.hasTranslation, false);

  // The cron repair leaves the older item alone; the backfill counts it in a dry run and queues it on apply.
  await translatePending({ limit: 1000 });
  assert.equal((await jobs(old)).length, 0);
  const dry = await translatePending({ limit: 1000, backfillDays: 30, enqueue: false, estimateSystemTokens: 1000 });
  assert.ok(dry.due >= 2, JSON.stringify(dry));
  assert.equal(dry.enqueued, 0);
  assert.ok(dry.estimate.calls >= 1 && dry.estimate.input >= dry.estimate.calls * 1030, "the dry run plans the due bodies request by request");
  assert.equal((await translatePending({ limit: 1000, backfillDays: 30, enqueue: false })).estimate.calls, 0, "without the option no body is read");
  assert.equal((await jobs(old)).length, 0, "a dry run queues nothing");
  const run = await translatePending({ limit: 1000, backfillDays: 30 });
  assert.ok(run.done);
  assert.deepEqual(
    (await jobs(old)).map((j) => [j.singleton_key, j.priority]),
    [[`later:${old}`, -2]],
  );
  assert.equal((await jobs(later)).length, 1, "an item already waiting is not queued twice");
  await assert.rejects(() => translatePending({ backfillDays: 365 }), RangeError);
});

test("queue options and the cost-report estimate", () => {
  assert.deepEqual(translationJobOptions("a", true), { singletonKey: "a", priority: 0 });
  // Monday 02:00 UTC is a peak hour: the non-selected job starts at 04:00 UTC, when the off-peak price applies.
  const peak = new Date("2026-11-09T02:00:00Z");
  assert.deepEqual(translationJobOptions("b", false, peak), { singletonKey: "later:b", priority: -2, startAfter: new Date("2026-11-09T04:00:00Z") });
  assert.deepEqual(translationJobOptions("b", false, new Date("2026-11-08T02:00:00Z")), { singletonKey: "later:b", priority: -2 });
  // A fresh item (found within the two-day live window) starts at once even in a peak hour; only backlog waits (TASK-0676).
  assert.deepEqual(translationJobOptions("b", false, peak, true), { singletonKey: "later:b", priority: -2 });
  assert.deepEqual(translationJobOptions("b", false, peak, false), { singletonKey: "later:b", priority: -2, startAfter: new Date("2026-11-09T04:00:00Z") });
  assert.deepEqual(translationJobOptions("a", true, peak, false), { singletonKey: "a", priority: 0 });
  const system = promptTokenEstimate(promptText("translate-body"));
  assert.ok(system > 300 && system < 3000, String(system));
  // Codex review #362: the estimate follows the worker's plan. TASK-0711: consecutive blocks share one request up to
  // 4,000 bytes, so twenty short paragraphs are one request, and every block's text is still counted once.
  const paragraph = (i: number) => `<p>Paragraph ${i} of a mining report with enough words to be a real block of text in the article body.</p>`;
  const short = Array.from({ length: 20 }, (_, i) => paragraph(i)).join("");
  const manifest = translationSourceManifest(short);
  assert.equal(manifest.segments.length, 20);
  const typical = translationTokenEstimate(short, system);
  assert.equal(typical.calls, 1, "twenty short paragraphs fit one request");
  const blockChars = manifest.segments.reduce((sum, seg) => sum + seg.html.length, 0);
  assert.ok(typical.input >= system + 30 + Math.floor(blockChars / 3.5), "the request carries the system prompt and every block");
  assert.ok(typical.output >= Math.ceil(blockChars * 0.3) + 20 * 10, "every block's answer is counted");
  assert.equal(typical.cachedPrefix, 0);
  assert.equal(translationTokenEstimate("", system).calls, 0, "no body, no request");
  const long = Array.from({ length: 900 }, (_, i) => paragraph(i)).join("");
  const capped = translationTokenEstimate(long, system);
  const chosen = translationSourceManifest(long).segments.filter((seg) => translationBudgetUnits(long).has(seg.unitIndex));
  const bytes = chosen.reduce((sum, seg) => sum + Buffer.byteLength(seg.html), 0);
  assert.ok(capped.calls >= Math.ceil(bytes / 4000) && capped.calls <= Math.ceil(bytes / 4000) + Math.ceil(chosen.length / 30), String(capped.calls));
  assert.equal(capped.cachedPrefix, (capped.calls - 1) * system);
  assert.ok(capped.calls < 900, "text beyond the 60,000-character budget is not translated");
});
