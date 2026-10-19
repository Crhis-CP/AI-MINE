import { confirmGroupingFixture } from "./grouping-fixture.ts";
import { ensureModelSourceFixture } from "./model-source-fixture.ts";
import { scopeVersion, scopeOutput, scopeReceipt } from "./scope-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
// Full-text translations follow the text: an article corrected while the model was translating the old
// wording is translated again, and a translation of an older revision is never shown as the current one.
// Links and images inside a paragraph survive the model.
import { gate, stub, tag, DROP_RESPONSE } from "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { promptText } from "@amp/backend/editorial/prompts";
import { TRANSLATE_PROMPT_VERSION, translateArticle, translatePending } from "@amp/backend/editorial/translate";
import { latestSuccessfulRunResult, autoReleaseUnknownReceipts, releaseReceipt, receiptObservedVersion } from "@amp/backend/admin/runs";
import { getBoss, QUEUES, recordRun, stopBoss } from "@amp/backend/jobs/queue";
import { publishArticle, prepareTranslation } from "@amp/backend/publication/publish";
import { buildApp } from "./site-app.ts";

const T = tag();
const SOURCE = `test-translate-${T}`;
const URL_ = `https://example.com/translate-${T}`;

// The model: one Chinese sentence per segment. `hold` keeps an answer back while the test revises the text.
let hold: ReturnType<typeof gate<void>> | null = null;
let unknownReply = false;
const asked = gate();
const asks = new Map<string, number>();
const provider = await stub(async (_hit, req) => {
  if (unknownReply) return DROP_RESPONSE;
  const { text: s } = JSON.parse(JSON.parse(req.body).messages[1].content) as { text: string };
  if (hold) {
    asked.open();
    await hold.promise;
  }
  const text = (() => {
    // A block with a link and an image: the first answer drops the link, the second keeps everything.
    if (s.includes("Neuroglancer")) {
      const n = (asks.get(s) ?? 0) + 1;
      asks.set(s, n);
      if (s.includes("legacy cooldown") && (n === 2 || (n === 3 && s.includes("EXHAUST_SEGMENT")))) return `第 ${n} 次回复丢了链接 ⟦0⟧。`;
      return n === 1 ? "解释 Neuroglancer 的文字 ⟦0⟧。" : '解释 <a id="L0">Neuroglancer</a> 的文字 ⟦0⟧。';
    }
    if (s.includes("never keeps")) {
      asks.set(s, (asks.get(s) ?? 0) + 1);
      return "丢了链接。";
    }
    if (s.includes("FINAL_PARAGRAPH")) return "最后一段完整译文。";
    return s.includes("twenty") ? "价格是二十美元。" : s.includes("ten") ? "价格是十美元。" : "译文";
  })();
  return { id: "stub", choices: [{ message: { content: JSON.stringify({ text }) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
const app = await buildApp("public-api");

// Discovered "later" than anything else in the test database, so a one-item run takes this article. The
// tag keeps the text unique: identical input would reuse an earlier run's paid answer.
const material = (price: string) =>
  upsertMaterial({
    sourceId: SOURCE,
    url: URL_,
    title: `Price update ${T}`,
    language: "en",
    bodyText: `The price is ${price} dollars (${T}).`,
    bodyHtml: `<p>The price is ${price} dollars (${T}).</p>`,
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(),
    discoveredAt: new Date(Date.now() + 600_000),
  });

async function detail(id: string, original = false) {
  const res = await app.inject({ method: "GET", url: `/api/site/items/${id}${original ? "/original" : ""}` });
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.body) as { body: { zh: string | null; original: string | null; complete: boolean } };
}

async function translateOne(id: string) {
  const revision = await prepareTranslation(id);
  if (revision === null) return { articleId: id, status: "skipped" as const };
  const result = await translateArticle(id, revision);
  if (result.status === "translated") await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });
  return result;
}

async function currentJudgement(id: string) {
  const [{ revision }] = await sql`SELECT revision FROM articles WHERE id=${id}`;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected,prompt_version,receipt_ids,output)
    VALUES(${id},${revision},'rule','pass','company_project',${`价格更新-${T}`},'摘要','理由',90,true,${scopeVersion},${[await scopeReceipt(id)]},${sql.json(scopeOutput)})`;
  await confirmGroupingFixture(id);
}

before(async () => {
  await installUsageFixtureForModel("deepseek-flash");
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${SOURCE}, 'Test translate', 'rss', 'T1', 'editorial', true, false, '2100-01-01')`;
  await ensureModelSourceFixture(SOURCE, ["https://example.com/source"]);
});
after(async () => {
  await app.close();
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("the translation prompt gives a closed list of Chinese names, and its version is pinned", () => {
  const prompt = promptText("translate-body");
  assert.ok(prompt.includes("必和必拓（BHP）") && prompt.includes("华友钴业"), "the names list is in the prompt");
  for (const open of ["确有通行译名", "例如："]) assert.ok(!prompt.includes(open), `no open wording: ${open}`);
  // The summary rules keep their open example: the list ends with “等” right after the include (the names file has no final newline).
  assert.ok(promptText("rules-domain").includes("华友钴业等"), "the summary rules still read “……华友钴业等”");
  // A change to translate-body.md or rules-domain-names.md (shared with the summary rules) translates every stored
  // foreign body again: change this pin on purpose.
  assert.equal(TRANSLATE_PROMPT_VERSION, "translate-body@5127c40297");
});

test("a text corrected while its translation was running is translated again, and the old translation is not shown", async () => {
  const { articleId: id } = await material("five");
  await currentJudgement(id);
  await confirmGroupingFixture(id);
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });
  assert.equal((await translateOne(id)).status, "translated", "this item was genuinely complete and publicly readable before reprocessing");
  const previousAttempts = await sql`SELECT * FROM translation_attempts WHERE article_id=${id}`;
  await material("ten");
  await currentJudgement(id);

  // The model is asked about revision 2; the source corrects the price before it answers.
  hold = gate();
  const running = translateOne(id);
  await Promise.race([asked.promise, running.then(() => assert.fail("the run ended without asking the model"))]);
  const revised = await material("twenty");
  assert.equal(revised.revised, true);
  hold.open();
  hold = null;
  assert.equal((await running).reason, "input_changed");

  const attempts = await sql`SELECT * FROM translation_attempts WHERE article_id=${id}`;
  assert.deepEqual([...attempts], [...previousAttempts], "a superseded response cannot overwrite or consume revision attempts");
  const stale = await detail(id);
  assert.equal(stale.body.zh, null, "a translation of the old wording is not shown");
  assert.equal(stale.body.original, null, "the default Chinese page stays pending");
  assert.ok((await detail(id, true)).body.original?.includes("twenty"), "the explicit original route retains current permitted source text");

  await currentJudgement(id);
  await translateOne(id);
  const [tr] = await sql<{ revision: number }[]>`SELECT revision FROM translations WHERE article_id = ${id}`;
  assert.equal(tr?.revision, 3, "the corrected text is translated on the next run");
  const current = await detail(id);
  assert.ok(current.body.zh?.includes("二十美元") && current.body.complete, "the page shows the translation of the corrected text");
});

test("links and images survive partial translation while failed blocks keep their original text", async () => {
  // Google's fly-brain post lost its link to the Neuroglancer docs; a GPU price post lost two charts.
  const html =
    `<p>Explaining <a href="https://neuroglancer.dev/docs">Neuroglancer</a> in text ${T} <img src="https://example.com/chart-${T}.png" alt="B200 prices"></p>` +
    `<p>A paragraph the model <a href="https://example.com/kept">never keeps</a> whole ${T}.</p>`;
  const { articleId: id } = await upsertMaterial({
    sourceId: SOURCE,
    url: `${URL_}-links`,
    title: `Links ${T}`,
    language: "en",
    bodyText: `Explaining Neuroglancer. ${T}`,
    bodyHtml: html,
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(),
    discoveredAt: new Date(Date.now() + 1_200_000),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected, prompt_version, receipt_ids, output)
            VALUES (${id}, 1, 'rule', 'pass', 'ai-models', ${`链接-${T}`}, '摘要', '理由', 90, true, ${scopeVersion}, ${[await scopeReceipt(id)]}, ${sql.json(scopeOutput)})`;
  await confirmGroupingFixture(id);
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });
  for (let n = 0; n < 4; n++) {
    await sql`UPDATE receipt_attempts SET finished_at=now()-interval '6 minutes'
      WHERE output_rejected_at IS NOT NULL AND receipt_id IN (SELECT id FROM receipts WHERE subject LIKE ${`article:${id}@1#%`})`;
    await translateOne(id);
  }
  const [tr] = await sql<{ body_html: string | null; complete: boolean }[]>`SELECT body_html, complete FROM translations WHERE article_id = ${id}`;
  assert.match(tr!.body_html!, /解释/);
  assert.match(tr!.body_html!, /never keeps/, "untranslated blocks keep their original text");
  assert.equal(tr!.complete, false);
  const parts = await sql`SELECT state,restored_html,failed_attempts FROM enrichment.translation_segments WHERE article_id=${id} ORDER BY segment_index`;
  assert.equal(parts[0]!.state, "complete");
  assert.ok(parts[0]!.restored_html.includes('<a href="https://neuroglancer.dev/docs">Neuroglancer</a>'));
  assert.ok(parts[0]!.restored_html.includes(`chart-${T}.png`), "the chart survives in the verified checkpoint");
  assert.equal(parts[1]!.state, "failed");
  assert.equal(parts[1]!.restored_html, null);
  assert.equal(parts[1]!.failed_attempts, 2);
  assert.deepEqual([...asks.values()].sort(), [2, 2], "a repaired segment is reused and the same bad answer is not bought again");
  assert.equal((await translateOne(id)).reason, "attempts_exhausted", "two identical rejected outputs also stop the legacy admission gate");
  const incomplete = await app.inject(`/api/site/items/${id}`);
  assert.equal(incomplete.statusCode, 200, "a Chinese title and guide stay public while the body is incomplete");
  const shown = incomplete.json();
  assert.equal(shown.summary, "摘要");
  assert.match(shown.body.zh, /解释/);
  assert.match(shown.body.zh, /never keeps/);
  assert.equal(shown.body?.complete ?? false, false);
  await sql`UPDATE sources SET syndicate_fulltext=true WHERE id=${SOURCE}`;
  await publishArticle(id);
  try {
    const rss = await app.inject("/feed/full.xml");
    assert.equal(rss.statusCode, 200);
    assert.match(rss.body, /中文译文尚不完整/);
    assert.match(rss.body, /never keeps/);
  } finally {
    await sql`UPDATE sources SET syndicate_fulltext=false WHERE id=${SOURCE}`;
  }
});

test("translation stops at the 60000 character boundary and preserves the untranslated tail", async () => {
  const html = Array.from({ length: 30 }, (_, i) => `<p>${i === 29 ? "FINAL_PARAGRAPH" : i} ${T} ${"Copper production update. ".repeat(95)}</p>`).join("");
  assert.ok(html.length > 60_000);
  const { articleId: id } = await upsertMaterial({
    sourceId: SOURCE,
    url: `${URL_}-long`,
    title: `Long report ${T}`,
    language: "en",
    bodyHtml: html,
    bodyText: html,
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(),
    discoveredAt: new Date(Date.now() + 1_800_000),
  });
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected,prompt_version,receipt_ids,output)
    VALUES (${id},1,'rule','pass','ai-models',${`完整长文-${T}`},'摘要','理由',90,true,${scopeVersion},${[await scopeReceipt(id)]},${sql.json(scopeOutput)})`;
  await confirmGroupingFixture(id);
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });
  const start = provider.hits();
  const result = await translateOne(id);
  assert.equal(result.status, "partial");
  const calls = provider.hits() - start;
  assert.ok(calls > 0 && calls < 30);
  const [tr] = await sql`SELECT complete,body_html,manifest FROM translations WHERE article_id=${id}`;
  assert.equal(tr!.complete, false);
  assert.ok(tr!.body_html.includes("FINAL_PARAGRAPH"), "the tail remains original text");
  assert.equal(tr!.manifest.translatedSegments, calls);
  const incomplete = await detail(id);
  assert.equal(incomplete.body.complete, false);
  assert.match(incomplete.body.zh!, /FINAL_PARAGRAPH/);
  await translateOne(id);
  assert.equal(provider.hits() - start, calls, "a partial current result reuses its paid prefix");
});

test("repair rotates past a full blocked batch, includes old material and resumes from successful runs across processes", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 32; i++) {
    const { articleId } = await upsertMaterial({
      sourceId: SOURCE,
      url: `${URL_}-repair-${i}`,
      title: `Old copper report ${i}`,
      language: "en",
      bodyHtml: `<p>Copper report ${i} ${T}.</p>`,
      bodyText: `Copper report ${i} ${T}.`,
      bodyStatus: "ok",
      via: "fetch",
      publishedAt: new Date(Date.now() - 12 * 86400_000),
      discoveredAt: new Date(Date.now() - 12 * 86400_000),
    });
    await currentJudgement(articleId);
    await publishArticle(articleId);
    ids.push(articleId);
  }
  const boss = await getBoss();
  const initial = await sql`SELECT id FROM pgboss.job WHERE name=${QUEUES.translate} AND data->>'articleId' IN ${sql(ids)} AND state='created'`;
  assert.equal(initial.length, 32, "normal per-item dispatch was created first");
  for (const row of initial) await boss.cancel(QUEUES.translate, row.id);
  const calls = provider.hits();
  const paused = await recordRun("content.translate", () => translatePending({ limit: 30, budgetMs: 0 }));
  assert.equal(paused.scanned, 0);
  assert.equal(paused.cursor.afterId, null, "no accepted dispatch means no progress");
  await assert.rejects(
    recordRun("content.translate", async () => {
      assert.equal((await translatePending({ limit: 30 })).scanned, 30);
      throw new Error("synthetic interrupted result commit");
    }),
    /synthetic interrupted/,
  );
  assert.deepEqual(await latestSuccessfulRunResult("content.translate"), paused, "failed scheduler results cannot skip work");
  const first = await recordRun("content.translate", () => translatePending({ limit: 30 }));
  assert.equal(first.scanned, 30);
  assert.equal(first.enqueued, 0, "the durable blocked batch deduplicates but still advances the scan");
  const child = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {initializeDb,closeDb} from '@amp/backend/db';
    import {translatePending} from '@amp/backend/editorial/translate';
    import {recordRun,stopBoss} from '@amp/backend/jobs/queue';
    await initializeDb('test');
    try { console.log('REPAIR_RESULT='+JSON.stringify(await recordRun('content.translate',()=>translatePending({limit:30})))); }
    finally { await stopBoss(); await closeDb(); }
  `,
    ],
    { cwd: process.cwd(), env: process.env, timeout: 30_000 },
  );
  const resumed = JSON.parse(
    child.stdout
      .split("\n")
      .find((line) => line.startsWith("REPAIR_RESULT="))!
      .slice("REPAIR_RESULT=".length),
  );
  assert.ok(resumed.scanned > 0 && resumed.scanned < 30, "a new process resumes after the blocked first batch");
  assert.equal(resumed.cursor.afterId, null, "end of scan wraps so earlier ids can recover later");
  const repaired = await sql`SELECT data->>'articleId' AS id FROM pgboss.job
    WHERE name=${QUEUES.translate} AND data->>'articleId' IN ${sql(ids)} AND state='created'`;
  assert.deepEqual(repaired.map((row) => row.id).sort(), ids.sort(), "all old candidates have durable repair jobs");
  assert.equal(provider.hits(), calls, "scanning and restart never call the model");
  const attempts = await sql`SELECT 1 FROM translation_attempts WHERE article_id IN ${sql(ids)}`;
  assert.equal(attempts.length, 0, "dispatch progress is not stored as a paid or translation attempt");
});

test("a body translation that already failed three times is not bought again", async () => {
  const input = {
    sourceId: SOURCE,
    url: `${URL_}-spent`,
    title: `Spent ${T}`,
    language: "en",
    bodyText: `Spent never keeps copper note ${T}.`,
    bodyHtml: `<p>Spent <a href="https://example.com/kept">never keeps</a> copper note ${T}.</p>`,
    bodyStatus: "ok" as const,
    via: "fetch" as const,
    publishedAt: new Date(),
  };
  const { articleId: id } = await upsertMaterial(input);
  await currentJudgement(id);
  await publishArticle(id);
  assert.equal((await translateOne(id)).status, "partial");
  assert.equal((await sql`SELECT body_html FROM translations WHERE article_id=${id} AND lang='zh'`)[0].body_html, null);
  const [{ revision }] = await sql<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${id}`;
  await sql`INSERT INTO translation_attempts (article_id, revision, attempts, outcome, reason)
            VALUES (${id}, ${revision}, 3, 'failed', 'synthetic exhausted')
            ON CONFLICT(article_id) DO UPDATE SET attempts=3,outcome='failed',reason=EXCLUDED.reason`;
  const before = provider.hits();
  const result = await translateArticle(id, revision);
  assert.deepEqual({ status: result.status, reason: result.reason }, { status: "skipped", reason: "attempts_exhausted" });
  await sql`UPDATE translation_attempts SET outcome='partial',reason=NULL WHERE article_id=${id}`;
  assert.equal((await translateArticle(id, revision)).reason, "attempts_exhausted", "failed receipts without a saved partial grant no retry");
  const changed = await upsertMaterial({ ...input, bodyHtml: input.bodyHtml.replace("copper", "<strong>copper</strong>") });
  assert.equal(changed.revised, false, "zero completed segments allow a same-revision presentation change");
  const [current] = await sql`SELECT revision,body_html FROM articles WHERE id=${id}`;
  assert.equal(current.revision, revision);
  assert.match(current.body_html, /<strong>copper<\/strong>/);
  assert.equal((await translateArticle(id, revision)).reason, "attempts_exhausted", "old zero-completion receipts cannot authorize this new model input");
  assert.equal(provider.hits(), before, "the spent body is not bought again");
});

for (const finalStatus of ["translated", "partial"] as const)
  test(`legacy cooldown recovery keeps the remaining segment budget through another partial: ${finalStatus}`, async () => {
    const { articleId } = await upsertMaterial({
      sourceId: SOURCE,
      url: `${URL_}-legacy-cooldown-${finalStatus}`,
      title: `Legacy cooldown ${T}`,
      language: "en",
      bodyText: `Legacy cooldown copper report ${T}.`,
      bodyHtml:
        `<p>Completed copper paragraph ${T}.</p>` +
        `<p>Explaining <a href="https://neuroglancer.dev/docs">Neuroglancer</a> legacy cooldown ${finalStatus === "partial" ? "EXHAUST_SEGMENT" : ""} ${T} <img src="https://example.com/cooldown-${T}.png" alt="Copper prices"></p>`,
      bodyStatus: "ok",
      via: "fetch",
      publishedAt: new Date(),
    });
    await currentJudgement(articleId);
    await publishArticle(articleId);
    assert.equal((await translateOne(articleId)).status, "partial");
    const completed = await sql`SELECT segment_index,receipt_id,attempt_id,restored_hash FROM enrichment.translation_segments
    WHERE article_id=${articleId} AND state='complete' ORDER BY segment_index`;
    assert.equal(completed.length, 1);
    const calls = provider.hits();
    assert.equal((await translateOne(articleId)).reason, "retry_cooldown");
    assert.equal(
      (await sql`SELECT attempts FROM translation_attempts WHERE article_id=${articleId}`)[0].attempts,
      1,
      "new cooldown-only passes consume no whole-article attempts",
    );

    // Reproduce an old counter which included cooldown passes; do not reset its history during repair.
    await sql`UPDATE translation_attempts SET attempts=3,outcome='partial',reason='retry_cooldown' WHERE article_id=${articleId}`;
    await sql`DELETE FROM pgboss.job WHERE name=${QUEUES.translate} AND data->>'articleId'=${articleId}`;
    for (let i = 0; i < 2; i++) await recordRun("content.translate", () => translatePending({ limit: 1000 }));
    assert.ok((await sql`SELECT id FROM pgboss.job WHERE name=${QUEUES.translate} AND data->>'articleId'=${articleId} AND state='created'`).length > 0);
    assert.equal((await translateOne(articleId)).reason, "retry_cooldown", "the worker reaches the existing segment cooldown guard");
    assert.equal(provider.hits(), calls, "neither repair nor an unexpired cooldown sends another request");
    assert.equal((await sql`SELECT attempts FROM translation_attempts WHERE article_id=${articleId}`)[0].attempts, 3);

    await sql`UPDATE receipt_attempts SET finished_at=now()-interval '6 minutes'
    WHERE output_rejected_at IS NOT NULL AND receipt_id IN (SELECT id FROM receipts WHERE subject LIKE ${`article:${articleId}@1#%`})`;
    assert.equal((await translateOne(articleId)).status, "partial", "a different second bad output leaves one real segment opportunity");
    assert.equal(provider.hits(), calls + 1, "only the unfinished segment is bought again after cooldown");
    assert.deepEqual(
      { ...(await sql`SELECT attempts,outcome,reason FROM translation_attempts WHERE article_id=${articleId}`)[0] },
      { attempts: 4, outcome: "partial", reason: null },
    );
    await sql`DELETE FROM pgboss.job WHERE name=${QUEUES.translate} AND data->>'articleId'=${articleId}`;
    for (let i = 0; i < 2; i++) await recordRun("content.translate", () => translatePending({ limit: 1000 }));
    assert.ok(
      (await sql`SELECT id FROM pgboss.job WHERE name=${QUEUES.translate} AND data->>'articleId'=${articleId} AND state='created'`).length > 0,
      "the remaining physical segment budget passes the repair gate after the legacy reason was replaced",
    );
    assert.equal((await translateOne(articleId)).reason, "retry_cooldown");
    assert.equal(provider.hits(), calls + 1, "the resumed worker still obeys the second output's cooldown");
    await sql`UPDATE receipt_attempts SET finished_at=now()-interval '6 minutes'
    WHERE output_rejected_at IS NOT NULL AND receipt_id IN (SELECT id FROM receipts WHERE subject LIKE ${`article:${articleId}@1#%`})`;
    assert.equal((await translateOne(articleId)).status, finalStatus);
    assert.equal(provider.hits(), calls + 2, "exactly one remaining segment attempt is bought");
    const reused = await sql`SELECT segment_index,receipt_id,attempt_id,restored_hash FROM enrichment.translation_segments
    WHERE article_id=${articleId} AND segment_index=${completed[0].segment_index}`;
    assert.deepEqual([...reused], [...completed], "the completed checkpoint and its paid identity are unchanged");
    const [history] = await sql`SELECT attempts,outcome,reason FROM translation_attempts WHERE article_id=${articleId}`;
    assert.deepEqual({ ...history }, { attempts: 5, outcome: finalStatus, reason: null });
    assert.equal((await detail(articleId)).body.complete, finalStatus === "translated");
    if (finalStatus === "partial") {
      assert.equal((await translateOne(articleId)).reason, "attempts_exhausted", "three different rejected outputs exhaust the actual segment budget");
      await sql`DELETE FROM pgboss.job WHERE name=${QUEUES.translate} AND data->>'articleId'=${articleId}`;
      for (let i = 0; i < 2; i++) await recordRun("content.translate", () => translatePending({ limit: 1000 }));
      assert.equal((await sql`SELECT id FROM pgboss.job WHERE name=${QUEUES.translate} AND data->>'articleId'=${articleId}`).length, 0);
      assert.equal(provider.hits(), calls + 2, "neither repair nor the worker buys a fourth rejected output");
    }
  });

test("unselected foreign articles are public without entering the translation queue", async () => {
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE,
    url: `${URL_}-unselected`,
    title: `Copper note ${T}`,
    language: "en",
    bodyHtml: `<p>Copper note ${T}.</p>`,
    bodyText: `Copper note ${T}.`,
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(),
  });
  await currentJudgement(articleId);
  await sql`UPDATE analyses SET selected=false,score=40 WHERE article_id=${articleId}`;
  const published = await publishArticle(articleId);
  assert.equal(published?.visibility, "public");
  assert.equal(published?.selected, false);
  assert.equal(await prepareTranslation(articleId), null);
  await translatePending();
  assert.equal((await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name=${QUEUES.translate} AND data->>'articleId'=${articleId}`)[0].n, 0);
});

for (const recovery of ["automatic", "manual"] as const)
  test(`${recovery} translation recovery passes both repair and worker gates without resetting prior attempts`, async () => {
    const { articleId } = await upsertMaterial({
      sourceId: SOURCE,
      url: `${URL_}-recovery-${recovery}`,
      title: `Recovery ${recovery} ${T}`,
      language: "en",
      bodyHtml: `<p>Recover ${recovery} first copper note ${T}.</p><p>Recover ${recovery} second copper note ${T}.</p>`,
      bodyText: `Recovery ${recovery} copper text ${T}`,
      bodyStatus: "ok",
      via: "fetch",
      publishedAt: new Date(),
    });
    await currentJudgement(articleId);
    await publishArticle(articleId);
    const before = provider.hits();
    unknownReply = true;
    try {
      await assert.rejects(translateArticle(articleId, 1), /尚未确认|unknown/);
    } finally {
      unknownReply = false;
    }
    await sql`INSERT INTO translation_attempts(article_id,revision,attempts,outcome,reason) VALUES(${articleId},1,3,'failed','previous attempts retained')`;
    assert.equal((await translateArticle(articleId, 1)).reason, "attempts_exhausted");
    await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE subject LIKE ${`article:${articleId}@1#%`}`;
    if (recovery === "automatic") await autoReleaseUnknownReceipts();
    else {
      const [row] = await sql<{ receiptId: string; attempts: number; updatedAtUtc: string }[]>`SELECT id::text AS "receiptId",attempts,
      pg_catalog.to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAtUtc"
      FROM receipts WHERE subject LIKE ${`article:${articleId}@1#%`} ORDER BY id DESC LIMIT 1`;
      await releaseReceipt(
        Number(row.receiptId),
        { billed: false, note: "fixture provider confirmed not charged", version: receiptObservedVersion(row) },
        "test",
      );
    }
    assert.ok((await sql`SELECT id FROM pgboss.job WHERE name=${QUEUES.translate} AND data->>'articleId'=${articleId} AND state='created'`).length > 0);
    // Simulate a lost dispatcher job; the repair scan must recognize the same durable recovery permission.
    await sql`DELETE FROM pgboss.job WHERE name=${QUEUES.translate} AND data->>'articleId'=${articleId}`;
    for (let i = 0; i < 2; i++) await recordRun("content.translate", () => translatePending({ limit: 1000 }));
    assert.ok((await sql`SELECT id FROM pgboss.job WHERE name=${QUEUES.translate} AND data->>'articleId'=${articleId} AND state='created'`).length > 0);
    assert.equal((await translateArticle(articleId, 1)).status, "translated");
    assert.equal(provider.hits() - before, 3);
    const [history] = await sql`SELECT attempts,outcome FROM translation_attempts WHERE article_id=${articleId}`;
    assert.deepEqual({ ...history }, { attempts: 4, outcome: "translated" });
  });
