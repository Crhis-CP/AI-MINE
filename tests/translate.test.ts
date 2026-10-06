import { scopeVersion, scopeOutput, scopeReceipt } from "./scope-fixture.ts";
// Full-text translations follow the text: an article corrected while the model was translating the old
// wording is translated again, and a translation of an older revision is never shown as the current one.
// Links and images inside a paragraph survive the model.
import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { promptText } from "@amp/backend/editorial/prompts";
import { TRANSLATE_PROMPT_VERSION, translateArticle, translatePending } from "@amp/backend/editorial/translate";
import { latestSuccessfulRunResult } from "@amp/backend/admin/runs";
import { getBoss, QUEUES, recordRun, stopBoss } from "@amp/backend/jobs/queue";
import { publishArticle, prepareTranslation } from "@amp/backend/publication/publish";
import { buildApp } from "../apps/api/src/app.ts";

const sql = dbOf("enrichment");

const T = tag();
const SOURCE = `test-translate-${T}`;
const URL_ = `https://example.com/translate-${T}`;

// The model: one Chinese sentence per segment. `hold` keeps an answer back while the test revises the text.
let hold: ReturnType<typeof gate<void>> | null = null;
const asked = gate();
const asks = new Map<string, number>();
const provider = await stub(async (_hit, req) => {
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
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${SOURCE}, 'Test translate', 'rss', 'T1', 'editorial', true, false, '2100-01-01')`;
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
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });
  assert.equal((await translateOne(id)).status, "translated", "this item was genuinely complete and publicly readable before reprocessing");
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
  await running;

  const [attempt] = await sql<{ revision: number; outcome: string }[]>`SELECT revision, outcome FROM translation_attempts WHERE article_id = ${id}`;
  assert.deepEqual({ ...attempt }, { revision: 2, outcome: "partial" }, "a superseded response is not promoted or booked against the new revision");
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

test("links and images survive in checkpoints, while a bad paragraph prevents whole-body assembly and has only three paid attempts", async () => {
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
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });
  for (let n = 0; n < 4; n++) {
    await sql`UPDATE receipt_attempts SET finished_at=now()-interval '6 minutes'
      WHERE output_rejected_at IS NOT NULL AND receipt_id IN (SELECT id FROM receipts WHERE subject LIKE ${`article:${id}@1#%`})`;
    await translateOne(id);
  }
  const [tr] = await sql<{ body_html: string | null; complete: boolean }[]>`SELECT body_html, complete FROM translations WHERE article_id = ${id}`;
  assert.equal(tr!.body_html, null, "bad segments and original English are never assembled into a partial translation");
  assert.equal(tr!.complete, false);
  const parts = await sql`SELECT state,restored_html,failed_attempts FROM enrichment.translation_segments WHERE article_id=${id} ORDER BY segment_index`;
  assert.equal(parts[0]!.state, "complete");
  assert.ok(parts[0]!.restored_html.includes('<a href="https://neuroglancer.dev/docs">Neuroglancer</a>'));
  assert.ok(parts[0]!.restored_html.includes(`chart-${T}.png`), "the chart survives in the verified checkpoint");
  assert.equal(parts[1]!.state, "failed");
  assert.equal(parts[1]!.restored_html, null);
  assert.equal(parts[1]!.failed_attempts, 3);
  assert.deepEqual([...asks.values()].sort(), [2, 3], "good checkpoints are reused and bad output is bounded per actual attempt");
  assert.equal((await app.inject(`/api/site/items/${id}`)).statusCode, 404, "new material with a bad segment never gets a public page");
});

test("the active adapter covers a body beyond the old cap and then makes no repeat model request", async () => {
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
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });
  const start = provider.hits();
  const result = await translateOne(id);
  assert.equal(result.status, "translated");
  assert.equal(provider.hits() - start, 30);
  const [tr] = await sql`SELECT complete,body_html,manifest FROM translations WHERE article_id=${id}`;
  assert.equal(tr!.complete, true);
  assert.equal(tr!.manifest.segments.length, 30);
  assert.ok(tr!.body_html.endsWith("最后一段完整译文。</p>"), "the final source paragraph is included");
  assert.equal((await sql`SELECT count(*)::int AS n FROM enrichment.translation_segments WHERE article_id=${id} AND state='complete'`)[0]!.n, 30);
  await translateOne(id);
  assert.equal(provider.hits() - start, 30, "a complete current result and older exhausted bad segments cause no new request");
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
