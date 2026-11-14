// TASK-0711 (audit M2, M3): full-text translation sends consecutive blocks together, up to 4,000 bytes per request,
// and still checks and saves every block on its own; a block that fails inside a batch is bought again alone, and a
// batch whose answer cannot be used is split in two. What a reader sees is bound to the source text, its revision and
// the manifest format, not to the translation prompt: a prompt change keeps published translations visible and does
// not queue them again. A local stub stands in for the model; no network or real model is used.
import { confirmGroupingFixture } from "./grouping-fixture.ts";
import { ensureModelSourceFixture } from "./model-source-fixture.ts";
import { scopeVersion, scopeOutput, scopeReceipt } from "./scope-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { stub, tag } from "./setup.ts";
import { isTranslationBatch, translationAnswer, translationBlocks } from "./translation-stub.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { TRANSLATE_PROMPT_VERSION, translateArticle, translatePending } from "@amp/backend/editorial/translate";
import { QUEUES, stopBoss } from "@amp/backend/jobs/queue";
import { publishArticle, prepareTranslation } from "@amp/backend/publication/publish";
import {
  assembleTranslation,
  shield,
  TRANSLATION_MANIFEST_FORMAT,
  translationSourceManifest,
} from "../packages/backend/src/editorial/translation-readiness.ts";
import { translationTokenEstimate } from "../packages/backend/src/editorial/translation-schedule.ts";
import { buildApp } from "./site-app.ts";

const T = tag();
const SOURCE = `test-translation-pack-${T}`;
const CURRENT_RECIPE = `${TRANSLATION_MANIFEST_FORMAT}:${TRANSLATE_PROMPT_VERSION}`;

/** The stubbed model's answer for one block, the same whether the block came alone or in a batch. */
const answer = (block: string) => `第${/Paragraph (\d+)/.exec(block)?.[1] ?? "?"}段译文：${block.includes("BAD_IN_BATCH") ? "需单独重译" : "铜矿项目进展"}。`;
let badInBatch = false;
let malformedBatches = 0;
const requests: { blocks: string[]; batch: boolean }[] = [];
const provider = await stub((_hit, req) => {
  const blocks = translationBlocks(req.body);
  const batch = isTranslationBatch(req.body);
  requests.push({ blocks, batch });
  let content = translationAnswer(req.body, answer);
  // A batch answer missing one entry: none of its blocks can be placed, so the whole batch is rejected.
  if (batch && malformedBatches > 0) {
    malformedBatches--;
    content = JSON.stringify({ texts: blocks.slice(1).map(answer) });
  }
  // One block of a batch comes back without Chinese; the same block sent alone is answered properly.
  if (batch && badInBatch) content = JSON.stringify({ texts: blocks.map((b) => (b.includes("BAD_IN_BATCH") ? "English only" : answer(b))) });
  return { id: "stub", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
const app = await buildApp();

let n = 0;
async function article(paragraphs: string[], opts: { judge?: boolean } = {}) {
  n += 1;
  const html = paragraphs.map((p) => `<p>${p}</p>`).join("");
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.com/pack-${T}-${n}`,
    title: `Copper pack ${n} ${T}`,
    language: "en",
    bodyText: paragraphs.join("\n"),
    bodyHtml: html,
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(),
  });
  if (opts.judge !== false) {
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected,prompt_version,receipt_ids,output)
      VALUES(${articleId},1,'rule','pass','project_development',${`铜矿成批翻译-${n}-${T}`},'摘要','理由',90,true,${scopeVersion},${[await scopeReceipt(articleId)]},${sql.json(scopeOutput)})`;
    await confirmGroupingFixture(articleId);
    await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  }
  return { articleId, html };
}
async function translate(id: string) {
  const revision = await prepareTranslation(id);
  assert.notEqual(revision, null);
  const result = await translateArticle(id, revision!);
  if (result.status === "translated") await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });
  return result;
}
const shortParagraphs = (count: number, mark = "") =>
  Array.from({ length: count }, (_, i) => `Paragraph ${i} ${mark}${i === 7 && mark === "B " ? "BAD_IN_BATCH " : ""}of the copper project update ${T}.`);
async function detailZh(id: string) {
  const res = await app.inject({ method: "GET", url: `/api/site/items/${id}` });
  assert.equal(res.statusCode, 200, res.body);
  return (JSON.parse(res.body) as { body: { zh: string | null; complete: boolean } | null }).body;
}
async function fullFeedItem(id: string) {
  const res = await app.inject("/feed/full.xml");
  assert.equal(res.statusCode, 200);
  return res.body.split("<item>").find((item) => item.includes(id)) ?? "";
}

before(async () => {
  await installUsageFixtureForModel("deepseek-flash");
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext,syndicate_fulltext,next_fetch_at)
    VALUES(${SOURCE},'Translation pack fixture','rss','T1','editorial',true,true,'2100-01-01')`;
  await ensureModelSourceFixture(SOURCE, ["https://example.com/source"]);
});
after(async () => {
  await app.close();
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("twenty short paragraphs take at most five requests, and every block equals its one-block translation", async () => {
  const { articleId, html } = await article(shortParagraphs(20));
  const plan = translationSourceManifest(html);
  assert.equal(plan.segments.length, 20, "before TASK-0711 this body was twenty requests, one per block");
  const start = requests.length;
  assert.equal((await translate(articleId)).status, "translated");
  const sent = requests.slice(start);
  assert.ok(sent.length <= 5, `${sent.length} requests`);
  assert.equal(sent.length, 1, "the whole body fits one 4,000-byte batch");
  assert.deepEqual(
    sent.flatMap((r) => r.blocks),
    plan.segments.map((s) => shield(s.html).html),
    "every block is asked once, in order",
  );
  // The unbatched result: each block answered on its own by the same stub, assembled the way the worker assembles it.
  const unbatched = assembleTranslation(
    html,
    { revision: 1, recipe: CURRENT_RECIPE },
    plan.segments.map((s) => ({
      index: s.index,
      sourceHash: s.sourceHash,
      revision: 1,
      recipe: CURRENT_RECIPE,
      state: "complete" as const,
      text: answer(shield(s.html).html),
    })),
  )!;
  const [stored] = await sql`SELECT body_html,complete,recipe,manifest FROM translations WHERE article_id=${articleId}`;
  assert.equal(stored!.complete, true);
  assert.equal(stored!.recipe, CURRENT_RECIPE);
  assert.equal(stored!.body_html, unbatched.html);
  assert.equal(stored!.manifest.segments.length, 20, "the manifest still proves every block");
  const checkpoints =
    await sql`SELECT segment_index,response_text,receipt_id FROM enrichment.translation_segments WHERE article_id=${articleId} ORDER BY segment_index`;
  assert.deepEqual(
    checkpoints.map((row) => row.response_text),
    plan.segments.map((s) => answer(shield(s.html).html)),
  );
  assert.equal(new Set(checkpoints.map((row) => String(row.receipt_id))).size, 1, "all twenty blocks hold the one batch receipt");
  assert.equal((await detailZh(articleId))?.zh?.includes("第19段译文"), true);
  // The worker asked again (a repair duplicate) finds every block saved.
  assert.equal((await translateArticle(articleId, 1)).status, "translated");
  assert.equal(requests.length - start, 1, "a finished translation asks nothing again");
  // The sample for the delivery record: the cost report's plan for the same body and for typical news paragraphs.
  const typical = Array.from({ length: 20 }, (_, i) => `<p>${`Paragraph ${i}: the copper miner reported quarterly output and guidance. `.repeat(6)}</p>`).join(
    "",
  );
  console.log(
    `TRANSLATION_PACK_SAMPLE=${JSON.stringify({
      shortBlocks: plan.segments.length,
      shortRequests: translationTokenEstimate(html, 1000).calls,
      typicalBlocks: translationSourceManifest(typical).segments.length,
      typicalRequests: translationTokenEstimate(typical, 1000).calls,
    })}`,
  );
});

test("one bad block in a batch is bought again alone; the others keep the batch answer", async () => {
  const { articleId, html } = await article(shortParagraphs(12, "B "));
  const plan = translationSourceManifest(html);
  const bad = plan.segments.find((s) => s.html.includes("BAD_IN_BATCH"))!;
  badInBatch = true;
  const start = requests.length;
  try {
    assert.equal((await translate(articleId)).status, "translated");
  } finally {
    badInBatch = false;
  }
  const sent = requests.slice(start);
  assert.equal(sent.length, 2, "one batch, then the failed block alone");
  assert.equal(sent[0]!.blocks.length, 12);
  assert.deepEqual(sent[1], { blocks: [shield(bad.html).html], batch: false }, "only the failed block is asked again");
  const rows = await sql`SELECT s.segment_index,s.state,s.receipt_id::text AS receipt_id,r.status FROM enrichment.translation_segments s
    JOIN receipts r ON r.id=s.receipt_id WHERE s.article_id=${articleId} ORDER BY s.segment_index`;
  assert.ok(rows.every((row) => row.state === "complete"));
  const batchReceipt = rows.find((row) => row.segment_index !== bad.index)!.receipt_id;
  assert.ok(rows.filter((row) => row.segment_index !== bad.index).every((row) => row.receipt_id === batchReceipt && row.status === "completed"));
  assert.notEqual(rows.find((row) => row.segment_index === bad.index)!.receipt_id, batchReceipt, "the failed block has its own receipt");
  // The worker asked again (a repair duplicate) finds every block saved.
  assert.equal((await translateArticle(articleId, 1)).status, "translated");
  assert.equal(requests.length - start, 2, "nothing is bought twice");
});

test("a batch whose answer cannot be used is rejected once and split in two; it is never bought again", async () => {
  const { articleId, html } = await article(shortParagraphs(8, "S "));
  const plan = translationSourceManifest(html);
  malformedBatches = 1;
  const start = requests.length;
  assert.equal((await translate(articleId)).status, "translated");
  assert.equal(malformedBatches, 0);
  const sent = requests.slice(start);
  assert.deepEqual(
    sent.map((r) => r.blocks.length),
    [8, 4, 4],
    "the rejected batch, then its two halves",
  );
  assert.deepEqual(
    sent.slice(1).flatMap((r) => r.blocks),
    plan.segments.map((s) => shield(s.html).html),
  );
  const [rejected] = await sql`SELECT status FROM receipts WHERE subject=${`article:${articleId}@1#0`} ORDER BY id LIMIT 1`;
  assert.equal(rejected!.status, "failed", "the unusable batch answer is recorded as rejected");
  // The worker asked again (a repair duplicate) finds every block saved.
  assert.equal((await translateArticle(articleId, 1)).status, "translated");
  assert.equal(requests.length - start, 3);
});

test("a prompt change keeps a published translation visible and queues nothing; a different source hash hides it", async () => {
  const { articleId } = await article(shortParagraphs(4, "P "));
  assert.equal((await translate(articleId)).status, "translated");
  assert.match((await detailZh(articleId))!.zh!, /第3段译文/);
  assert.match(await fullFeedItem(articleId), /第3段译文/);

  // The translation was made under an earlier version of the prompt (or the shared names list): its recipe, its
  // manifest and its checkpoints all name that version, which is not the current one.
  const earlier = `${TRANSLATION_MANIFEST_FORMAT}:translate-body@0000000000`;
  assert.notEqual(earlier, CURRENT_RECIPE);
  await sql`UPDATE translations SET recipe=${earlier},manifest=jsonb_set(manifest,'{recipe}',to_jsonb(${earlier}::text)) WHERE article_id=${articleId}`;
  await sql`UPDATE enrichment.translation_segments SET recipe=${earlier} WHERE article_id=${articleId}`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  const shown = await detailZh(articleId);
  assert.equal(shown?.complete, true, "the detail page still reads the stored translation");
  assert.match(shown!.zh!, /第3段译文/);
  assert.match(await fullFeedItem(articleId), /第3段译文/, "the full feed still carries it");

  // Neither the repair sweep nor the worker buys it again for the new prompt.
  const fresh = await article(["Paragraph 0 an untranslated control item for the repair sweep."]);
  await sql`DELETE FROM pgboss.job WHERE name=${QUEUES.translate} AND data->>'articleId' IN ${sql([articleId, fresh.articleId])}`;
  await translatePending({ limit: 1000 });
  const queued =
    await sql`SELECT data->>'articleId' AS id FROM pgboss.job WHERE name=${QUEUES.translate} AND data->>'articleId' IN ${sql([articleId, fresh.articleId])}`;
  assert.deepEqual(
    queued.map((row) => row.id),
    [fresh.articleId],
    "the sweep queues the untranslated control item only",
  );
  const start = requests.length;
  assert.equal((await translateArticle(articleId, 1)).status, "translated");
  assert.equal(requests.length, start, "no model request");
  assert.equal((await sql`SELECT recipe FROM translations WHERE article_id=${articleId}`)[0]!.recipe, earlier, "the translation keeps its own recipe");
  assert.match((await detailZh(articleId))!.zh!, /第3段译文/);

  // A stored translation of other source text is never shown, whatever its prompt.
  await sql`UPDATE translations SET source_hash=${"0".repeat(64)},manifest=jsonb_set(manifest,'{sourceHash}',to_jsonb(${"0".repeat(64)}::text)) WHERE article_id=${articleId}`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  assert.equal((await detailZh(articleId))?.zh ?? null, null, "a translation of other source text is not shown");
  assert.doesNotMatch(await fullFeedItem(articleId), /第3段译文/);
});
