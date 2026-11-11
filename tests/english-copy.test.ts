// English titles and summaries for the English interface (TASK-0595, Owner 2026-11-08: 英文文章肯定是要用英文标题和摘要).
// One small request per public item through the gateway (the translation route, its quota and receipts), written from
// the published Chinese copy and the original title; an English original keeps its own title. Shown on the website
// only while it matches the current Chinese copy; machine exits never carry it. A local stub stands in for the provider.
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
import { runEnglishCopyJob } from "@amp/backend/jobs/content";
import { stopBoss } from "@amp/backend/jobs/queue";
import { publishArticle } from "@amp/backend/publication/publish";
import { SOURCE_PURPOSES } from "@amp/contracts/source-policy";
import { englishCopyBackfillPage } from "../packages/backend/src/publication/publish.ts";
import { loadItemDetail, machineItemDetail, siteItemDetail } from "../packages/backend/src/publication/detail.ts";
import { fetchItemsByIds, toFeedItemSummary } from "../packages/backend/src/publication/items.ts";

const T = tag();
let hits = 0;
const seen: { system: string; user: Record<string, unknown> }[] = [];
const defaultAnswer = (user: Record<string, unknown>): Record<string, string> =>
  user.keepTitle ? { summary: `English summary ${T}` } : { title: `English title ${T}`, summary: `English summary ${T}` };
let answer = defaultAnswer;
const provider = await stub((_hit, req) => {
  hits += 1;
  const messages = JSON.parse(req.body).messages as { content: string }[];
  const user = JSON.parse(messages[1]!.content) as Record<string, unknown>;
  seen.push({ system: messages[0]!.content, user });
  return { choices: [{ message: { content: JSON.stringify(answer(user)) } }], usage: { prompt_tokens: 300, completion_tokens: 60 } };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "synthetic-english-copy-fixture";
process.env.EN_COPY_ENABLED = "true";

// Monday 2030-01-07 00:59 UTC is off-peak; 02:00 UTC is in a peak window. Far ahead of the wall clock.
const OFF_PEAK = { now: () => new Date("2030-01-07T00:59:00Z") };
const PEAK = { now: () => new Date("2030-01-07T02:00:00Z") };

const scope = { hosts: ["example.com"], path_prefixes: ["/"], document_types: [], excluded_content: [] };
const SOURCE = `english-copy-${T}`;
let n = 0;
async function article(opts: { language?: string; title?: string; selected?: boolean } = {}) {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.com/${T}-${n}`,
    title: opts.title ?? `Proyecto de cobre ${n} ${T}`,
    bodyText: `PARA-${T}-${n} texto del proyecto de cobre con suficientes palabras. `.repeat(8),
    bodyHtml: `<p>${`PARA-${T}-${n} texto del proyecto de cobre con suficientes palabras. `.repeat(8)}</p>`,
    language: opts.language ?? "es",
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(Date.now() - 60_000),
  });
  const selected = opts.selected ?? false;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected, prompt_version, receipt_ids, output)
    VALUES (${articleId}, 1, 'rule', 'pass', 'project_development', ${`铜矿项目标题${n}-${T}`}, ${`合成导读：铜矿项目获批，产能 12 万吨 ${n}-${T}`}, '理由',
      ${selected ? 90 : 40}, ${selected}, ${scopeVersion}, ${[await scopeReceipt(articleId)]}, ${sql.json(scopeOutput)})`;
  await completeMaterialGrouping(articleId, 1, { addsValue: selected, reason: "合成归组" }, null);
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  return articleId;
}
const englishJobs = async (id: string) => [
  ...(await sql<{ singleton_key: string; priority: number }[]>`SELECT singleton_key, priority FROM pgboss.job
    WHERE name='content.translate' AND data->>'articleId'=${id} AND (data->>'english')::boolean IS TRUE ORDER BY created_on, id`),
];
const projected = async (id: string) =>
  (await sql<{ title_en: string | null; summary_en: string | null }[]>`SELECT title_en, summary_en FROM publications WHERE article_id=${id}`)[0]!;
const copies = async (id: string) =>
  sql<{ title_en: string; title_origin: string; receipt_id: number }[]>`SELECT title_en, title_origin, receipt_id FROM enrichment.english_copies
    WHERE article_id=${id} ORDER BY created_at`;

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

test("a public item gets one English title and summary, shown on the website only, and paid for once", async () => {
  const id = await article();
  // Queued at publication, at the background priority (not selected), under its own key.
  assert.deepEqual(await englishJobs(id), [{ singleton_key: `en-later:${id}`, priority: -2 }]);
  assert.deepEqual(await projected(id), { title_en: null, summary_en: null });

  // In a peak hour it waits for the off-peak start without a model call.
  const waited = await runEnglishCopyJob({ articleId: id }, PEAK);
  assert.equal((waited as { state: string }).state, "deferred_peak");
  assert.equal(hits, 0);

  const done = await runEnglishCopyJob({ articleId: id }, OFF_PEAK);
  assert.deepEqual(done, { state: "written" });
  assert.equal(hits, 1);
  // The model read the published Chinese copy and the original title, never the body.
  const request = seen.at(-1)!;
  assert.deepEqual(Object.keys(request.user).sort(), ["originalTitle", "summaryZh", "titleZh"]);
  assert.equal(request.user.titleZh, `铜矿项目标题${n}-${T}`);
  assert.ok(!JSON.stringify(request.user).includes("PARA-"), "no body text is sent");
  assert.deepEqual(await projected(id), { title_en: `English title ${T}`, summary_en: `English summary ${T}` });
  const [copy] = await copies(id);
  assert.equal(copy!.title_origin, "model");
  const [receipt] = await sql<{ purpose: string; status: string }[]>`SELECT purpose, status FROM receipts WHERE id=${copy!.receipt_id}`;
  assert.deepEqual(receipt, { purpose: "english_copy", status: "completed" });

  // The website's card and detail carry it; the machine detail does not.
  const row = (await fetchItemsByIds([id])).get(id)!;
  assert.deepEqual(toFeedItemSummary(row).english, { title: `English title ${T}`, summary: `English summary ${T}` });
  const found = await loadItemDetail(id);
  assert.equal(found.kind, "found");
  if (found.kind === "found") assert.deepEqual(siteItemDetail(found.detail).english, { title: `English title ${T}`, summary: `English summary ${T}` });
  const machine = await machineItemDetail(id);
  assert.ok(machine && !("english" in machine.item), "machine exits stay unchanged");

  // Running again, or publishing again, pays nothing and keeps the copy.
  assert.deepEqual(await runEnglishCopyJob({ articleId: id }, OFF_PEAK), { state: "ready" });
  await publishArticle(id);
  assert.equal(hits, 1);
  assert.deepEqual(await projected(id), { title_en: `English title ${T}`, summary_en: `English summary ${T}` });
  assert.equal((await copies(id)).length, 1);
});

test("an English original keeps its own title; only the summary is written", async () => {
  const id = await article({ language: "en", title: `Copper mine approved ${T}` });
  const before = hits;
  assert.deepEqual(await runEnglishCopyJob({ articleId: id }, OFF_PEAK), { state: "written" });
  assert.equal(hits, before + 1);
  assert.equal(seen.at(-1)!.user.keepTitle, true);
  assert.deepEqual(await projected(id), { title_en: `Copper mine approved ${T}`, summary_en: `English summary ${T}` });
  assert.equal((await copies(id))[0]!.title_origin, "source");
});

test("a changed Chinese copy stops showing the old English copy and is written again", async () => {
  const id = await article();
  await runEnglishCopyJob({ articleId: id }, OFF_PEAK);
  assert.equal((await projected(id)).title_en, `English title ${T}`);
  await sql`UPDATE analyses SET summary_zh=${`合成导读：修订后的导读 ${T}`} WHERE article_id=${id}`;
  answer = () => ({ title: `Revised title ${T}`, summary: `Revised summary ${T}` });
  try {
    await publishArticle(id);
    // The old copy no longer matches: the English page falls back to the Chinese copy until the new one is written.
    assert.deepEqual(await projected(id), { title_en: null, summary_en: null });
    assert.deepEqual(await runEnglishCopyJob({ articleId: id }, OFF_PEAK), { state: "written" });
    assert.deepEqual(await projected(id), { title_en: `Revised title ${T}`, summary_en: `Revised summary ${T}` });
    assert.equal((await copies(id)).length, 2);
  } finally {
    answer = defaultAnswer;
  }
});

test("an answer still in Chinese is not used; the page keeps the Chinese copy", async () => {
  const id = await article();
  answer = () => ({ title: "中文标题", summary: "中文摘要" });
  try {
    assert.deepEqual(await runEnglishCopyJob({ articleId: id }, OFF_PEAK), { state: "rejected" });
    assert.deepEqual(await projected(id), { title_en: null, summary_en: null });
    assert.equal((await copies(id)).length, 0);
  } finally {
    answer = defaultAnswer;
  }
});

test("with EN_COPY_ENABLED off nothing is queued or paid, and a selected item is queued at once when on", async () => {
  process.env.EN_COPY_ENABLED = "false";
  try {
    const id = await article();
    assert.deepEqual(await englishJobs(id), []);
    const before = hits;
    assert.deepEqual(await runEnglishCopyJob({ articleId: id }, OFF_PEAK), { state: "disabled" });
    assert.equal(hits, before);
  } finally {
    process.env.EN_COPY_ENABLED = "true";
  }
  const picked = await article({ selected: true });
  const keys = (await englishJobs(picked)).map((j) => j.singleton_key);
  assert.ok(keys.includes(`en:${picked}`) || keys.includes(`en-later:${picked}`), "queued at publication");
});

test("the backfill lists public items still without an English copy, newest first", async () => {
  const older = await article();
  await sql`UPDATE publications SET discovered_at=now() - interval '3 days' WHERE article_id=${older}`;
  const newer = await article();
  const listed: string[] = [];
  let cursor: { at: Date; id: string } | null = null;
  for (;;) {
    const page = await englishCopyBackfillPage(cursor, 2);
    listed.push(...page.items.map((item) => item.articleId));
    if (!page.next) break;
    cursor = page.next;
  }
  assert.ok(listed.indexOf(newer) >= 0 && listed.indexOf(newer) < listed.indexOf(older), "newest first");
  // Items that already show their English copy are not listed.
  const written = await sql<{ article_id: string }[]>`SELECT article_id FROM publications WHERE title_en IS NOT NULL`;
  assert.ok(written.length > 0);
  for (const row of written) assert.ok(!listed.includes(row.article_id));
});
