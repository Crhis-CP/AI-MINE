import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { closeDb, dbOf, type Tx } from "@amp/backend/db";
import { commitBodyResult, readCurrentBody, commitProcessingResult, upsertMaterial } from "@amp/backend/content/materials";
import { analyzeArticle } from "@amp/backend/editorial/analyze";
import { failureGroupSql, requeueFailed } from "@amp/backend/jobs/content";
import { getBoss, QUEUES, stopBoss } from "@amp/backend/jobs/queue";
import { runsOverview } from "@amp/backend/admin/runs";
import { completeReceipt, paidRequest } from "@amp/backend/providers/receipts";

const sql = dbOf("enrichment");
const T = tag();
const SOURCE = `test-content-commit-${T}`;
let paused: { asked: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | undefined;
const provider = await stub(async () => {
  paused?.asked.open();
  if (paused) await paused.release.promise;
  return { choices: [{ message: { content: JSON.stringify({ label: "BLOCK", reason: "synthetic scope result" }) } }] };
});
process.env.DASHSCOPE_BASE_URL = `${provider.url}/v1`;
process.env.DASHSCOPE_API_KEY = "test-key";
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES (${SOURCE},${SOURCE},'rss','T1','editorial','2100-01-01')`;
  await getBoss();
});
after(async () => {
  paused?.release.open();
  await provider.close();
  await stopBoss();
  await closeDb();
});
const material = (name: string, title = name) =>
  upsertMaterial({ sourceId: SOURCE, url: `https://fixture.invalid/${T}/${name}`, title, bodyText: `合成材料正文 ${title}`, bodyStatus: "ok", via: "fetch" });

test("content modules and the fixed failure fragment import without a database or credentials", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    await import('@amp/backend/jobs/content');
    await import('@amp/backend/admin/runs');
    await import('@amp/backend/editorial/analyze');
    await import('./packages/backend/src/editorial/translation-runtime.ts');
  `,
    ],
    { env: { AMP_CREDENTIALS_DIR: "/nonexistent-test-credentials" }, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(child.status, 0, child.stderr);
});

test("fixed failure grouping keeps masking, truncation, aggregation and targeted requeue semantics", async () => {
  const messages = [null, "trace abcdef123456 request 123456", "其他错误".repeat(40), "HTTP 503"];
  for (const message of messages) {
    const [row] = await sql`SELECT ${failureGroupSql} AS grouped FROM (SELECT ${message}::text AS processing_error) input`;
    assert.equal(row!.grouped, (message ?? "(no message)").slice(0, 120).replace(/[0-9a-f]{8,}|[0-9]{4,}/g, "…"));
  }
  const ids = await Promise.all(["one", "two", "old", "other"].map(async (name) => (await material(name)).articleId));
  const prefix = `fixture ${T}: `;
  for (const [i, id] of ids.entries()) {
    await sql`UPDATE articles SET processing_state='failed',processing_attempts=3,processing_retry_at=now(),
      processing_error=${i === 3 ? `${prefix}unrelated` : `${prefix}request ${123456 + i}`},
      discovered_at=${new Date(Date.now() - (i === 2 ? 31 : 0) * 86400_000)} WHERE id=${id}`;
  }
  const [group] = await sql`SELECT ${failureGroupSql} AS label FROM articles WHERE id=${ids[0]!}`;
  const overview = await runsOverview();
  assert.equal(overview.errors.find((row) => row.error === group!.label)?.n, 2);
  assert.equal((await requeueFailed(group!.label)).requeued, 2);
  const rows = await sql`SELECT id,processing_state,processing_attempts,processing_retry_at,processing_error FROM articles WHERE id=ANY(${ids})`;
  for (const row of rows) {
    const changed = ids.slice(0, 2).includes(row.id);
    assert.equal(row.processing_state, changed ? "new" : "failed");
    assert.equal(row.processing_attempts, changed ? 0 : 3);
    if (changed) assert.deepEqual([row.processing_retry_at, row.processing_error], [null, null]);
  }
  const jobs = await sql`SELECT data->>'articleId' AS id FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=ANY(${ids})`;
  assert.deepEqual(jobs.map((row) => row.id).sort(), ids.slice(0, 2).sort());
});

test("content transaction rolls back result and receipt on callback or final-state failure, then releases for retry", async () => {
  const { articleId } = await material("rollback");
  await sql`UPDATE articles SET processing_error='synthetic-content-rollback' WHERE id=${articleId}`;
  const receipt = await paidRequest({ service: "dashscope", purpose: "content_commit_test", identity: { articleId } }, async () => ({
    response: { ok: true },
  }));
  const write = async (tx: Tx) => {
    const insert = sql`INSERT INTO analyses(article_id,input_revision,origin,receipt_ids,relevance,output)
      VALUES(${articleId},1,'model',${[receipt.receiptId]},'block','{}') RETURNING id`;
    const [row] = await tx<{ id: number }[]>`${insert}`;
    await completeReceipt(tx, receipt.receiptId);
    return row!.id;
  };
  const assertRolledBack = async () => {
    const [count] = await sql`SELECT count(*)::int AS n FROM analyses WHERE article_id=${articleId}`;
    const [received] = await sql`SELECT status FROM receipts WHERE id=${receipt.receiptId}`;
    const [article] = await sql`SELECT processing_state,processing_error FROM articles WHERE id=${articleId}`;
    assert.equal(count!.n, 0);
    assert.equal(received!.status, "received");
    assert.deepEqual({ ...article }, { processing_state: "new", processing_error: "synthetic-content-rollback" });
  };
  await assert.rejects(
    commitProcessingResult(articleId, 1, "blocked", async (tx) => {
      await write(tx);
      throw new Error("synthetic callback failure");
    }),
    /synthetic callback failure/,
  );
  await assertRolledBack();
  const trigger = `test_content_rollback_${T}`;
  await sql`CREATE FUNCTION ${sql(trigger)}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
    IF EXISTS (SELECT 1 FROM analyses a JOIN receipts r ON r.id=ANY(a.receipt_ids)
      WHERE a.article_id=NEW.id AND r.status='completed') THEN
      RAISE EXCEPTION 'synthetic state failure after receipt completion';
    END IF;
    RAISE EXCEPTION 'receipt was not completed in this transaction';
  END$$`;
  try {
    await sql`CREATE TRIGGER ${sql(trigger)} BEFORE UPDATE OF processing_state ON articles FOR EACH ROW
      WHEN (OLD.processing_error='synthetic-content-rollback') EXECUTE FUNCTION ${sql(trigger)}()`;
    await assert.rejects(commitProcessingResult(articleId, 1, "blocked", write), /synthetic state failure after receipt completion/);
    await assertRolledBack();
  } finally {
    await sql`DROP TRIGGER IF EXISTS ${sql(trigger)} ON articles`;
    await sql`DROP FUNCTION ${sql(trigger)}()`;
  }
  const result = await commitProcessingResult(articleId, 1, "blocked", write);
  assert.equal(result.stale, false);
  const [committed] = await sql`SELECT a.processing_state,a.processing_error,r.status FROM articles a
    JOIN analyses n ON n.id=${result.value} JOIN receipts r ON r.id=ANY(n.receipt_ids) WHERE a.id=${articleId}`;
  assert.deepEqual({ ...committed }, { processing_state: "blocked", processing_error: null, status: "completed" });
});

test("real analysis retains stale evidence and receipts without overwriting a newer material state", async () => {
  const { articleId } = await material("stale");
  paused = { asked: gate<void>(), release: gate<void>() };
  const pending = analyzeArticle(articleId);
  await paused.asked.promise;
  try {
    assert.equal((await material("stale", "new revision")).revised, true);
    await sql`UPDATE articles SET processing_error='new revision waiting' WHERE id=${articleId}`;
  } finally {
    paused.release.open();
  }
  const result = await pending;
  paused = undefined;
  assert.equal(result!.stale, true);
  assert.ok(result!.analysisId);
  const [article] = await sql`SELECT revision,processing_state,processing_error FROM articles WHERE id=${articleId}`;
  assert.deepEqual({ ...article }, { revision: 2, processing_state: "new", processing_error: "new revision waiting" });
  const [analysis] = await sql`SELECT input_revision FROM analyses WHERE id=${result!.analysisId}`;
  assert.equal(analysis!.input_revision, 1);
  const receipts = await sql`SELECT status FROM receipts WHERE id=ANY(${result!.receiptIds})`;
  assert.ok(receipts.length > 0 && receipts.every((row) => row.status === "completed"));
  const current = await analyzeArticle(articleId);
  assert.equal(current!.stale, false);
  const [updated] = await sql`SELECT processing_state,processing_error FROM articles WHERE id=${articleId}`;
  assert.deepEqual({ ...updated }, { processing_state: "blocked", processing_error: null });
});

test("derived-body transactions preserve analysis state and refuse changed revisions or HTML before callbacks", async () => {
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://fixture.invalid/${T}/body-lock`,
    title: "Body lock",
    bodyText: "First body.",
    bodyHtml: "<p>First body.</p>",
    bodyStatus: "ok",
    language: "en",
    via: "fetch",
  });
  await sql`UPDATE articles SET processing_state='failed',processing_error='kept',processing_attempts=2,
    processing_retry_at='2100-01-01' WHERE id=${articleId}`;
  const current = (await readCurrentBody(articleId))!;
  const state = async () => ({
    ...(await sql`SELECT processing_state,processing_error,processing_attempts,processing_retry_at FROM articles WHERE id=${articleId}`)[0],
  });
  const before = await state();
  const receipt = await paidRequest({ service: "dashscope", purpose: "body_commit_test", identity: { articleId } }, async () => ({
    response: { text: "合成译文" },
  }));
  const write = async (tx: Tx) => {
    await tx`INSERT INTO translations(article_id,revision,body_html,complete) VALUES(${articleId},1,'合成译文',false)`;
    await completeReceipt(tx, receipt.receiptId);
    return "committed";
  };
  await assert.rejects(
    commitBodyResult(current, async (tx) => {
      await write(tx);
      throw new Error("body rollback");
    }),
    /body rollback/,
  );
  assert.equal((await sql`SELECT count(*) AS n FROM translations WHERE article_id=${articleId}`)[0].n, 0);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${receipt.receiptId}`)[0].status, "received");
  assert.deepEqual(await state(), before);
  assert.equal(await commitBodyResult(current, write), "committed");
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${receipt.receiptId}`)[0].status, "completed");
  assert.deepEqual(await state(), before);
  const forbidden = async () => {
    assert.fail("stale body must not invoke the writer");
  };
  await sql`UPDATE articles SET body_html='<p>Changed HTML with the same revision.</p>' WHERE id=${articleId}`;
  assert.equal(await commitBodyResult(current, forbidden), null);
  await sql`UPDATE articles SET body_html=${current.body_html},revision=2 WHERE id=${articleId}`;
  assert.equal(await commitBodyResult(current, forbidden), null);
  assert.equal(await readCurrentBody(`${articleId}-missing`), null);
  assert.deepEqual(await state(), before);
});
