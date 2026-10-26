import { gate } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { config } from "@amp/backend/config";
import { closeDb, sql } from "@amp/backend/db";
import { commitProcessingResult, upsertMaterial } from "@amp/backend/content/materials";
import { queueProcessing, registerExtractionJobs, sweepUnprocessed } from "@amp/backend/jobs/content";
import { getBoss, QUEUES, stopBoss } from "@amp/backend/jobs/queue";
import { saveRobots } from "../packages/backend/src/acquisition/pacing.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
import { installModules, serverModules } from "@amp/backend/modules";
import { textPdf } from "./pdf-fixture.ts";
import { bodyReadingKey } from "../packages/backend/src/content/body-reading-key.ts";
import { audit } from "../packages/backend/src/admin/auth.ts";
import { readSourceDateContext, readCurrentSourcePolicy } from "@amp/backend/admin/sources";

const sourceId = "extract-oversize-source",
  hits = new Map<string, number>(),
  held = new Map<string, ReturnType<typeof gate<void>>>(),
  oversized = Buffer.alloc(6 * 1024 * 1024 + 1, "x"),
  body = "The mining company reported copper production and explained the changes at its processing plant. ".repeat(12),
  html = `<html><head><title>Mine production update</title></head><body><article><h1>Mine production update</h1><p>${body}</p></article></body></html>`;
const server = http.createServer((req, res) => {
  const path = req.url!;
  hits.set(path, (hits.get(path) ?? 0) + 1);
  const reply = () => {
    const pdf = path.startsWith("/pdf");
    res.writeHead(200, { "content-type": pdf ? "application/pdf" : "text/html; charset=utf-8" });
    res.end(pdf ? textPdf(path === "/pdf-empty" ? "" : body + "<script>not executable</script>") : path === "/normal" ? html : oversized);
  };
  const pending = held.get(path);
  if (pending) void pending.promise.then(reply);
  else reply();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  priorPrivate = config.allowPrivateNetworkFetch,
  priorJina = process.env.JINA_BODY_FALLBACK;
config.allowPrivateNetworkFetch = true;
Object.assign(process.env, { COLLECT_ENABLED: "true", COLLECT_NEWS_ENABLED: "true", JINA_BODY_FALLBACK: "false" });

before(async () => {
  await sql`INSERT INTO sources(id,name,kind,lane,enabled,participation_mode,config)
    VALUES(${sourceId},'Synthetic body extraction','web_list','news',true,'editorial',${sql.json({ url: `${base}/list`, language: "en" })})`;
  await grantDateFixture(sourceId, [base]);
  // Robots behavior has its own regressions; here every body still takes the real durable host slot.
  await saveRobots(base, 404, "", new Date(), null, null);
  // Deliberately register no analysis or provider consumer: these tests may only enqueue analysis.
  await registerExtractionJobs(await getBoss());
});

after(async () => {
  for (const pending of held.values()) pending.open();
  await stopBoss();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  config.allowPrivateNetworkFetch = priorPrivate;
  if (priorJina === undefined) delete process.env.JINA_BODY_FALLBACK;
  else process.env.JINA_BODY_FALLBACK = priorJina;
  await closeDb();
});

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, message: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    assert.ok(Date.now() < deadline, message);
    await delay(50);
  }
}

const material = (path: string) => ({
  sourceId,
  url: `${base}${path}`,
  title: `Synthetic mining update ${path}`,
  excerpt: "The source announced an update on its copper project.",
  bodyStatus: "pending" as const,
  language: "en",
  via: "fetch" as const,
});
const state = async (id: string) =>
  (
    await sql`SELECT revision,title,excerpt,body_text,body_html,body_status,processing_state,processing_attempts,
      processing_error,processing_retry_at,processing_queued_at FROM articles WHERE id=${id}`
  )[0]!;
const analysis = (id: string) => sql`SELECT state,data FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=${id}`;
const completed = async (id: string) =>
  (
    await until(
      () => sql`SELECT output FROM pgboss.job WHERE name=${QUEUES.extractBody} AND data->>'articleId'=${id}
        AND state='completed' AND output->>'state'<>'deferred'`,
      (rows) => rows.length > 0,
      `Extraction must finish without waiting for a ten-minute retry: ${id}`,
    )
  )[0]!.output;

test("PDF text uses the same extraction job, creates a partial revision and continues analysis without a reader purchase", async () => {
  const item = await upsertMaterial(material("/pdf"));
  assert.ok(await queueProcessing(item.articleId));
  assert.equal((await completed(item.articleId)).state, "partial");
  const row = await state(item.articleId);
  assert.equal(row.revision, 2);
  assert.equal(row.body_status, "unconfirmed");
  assert.match(row.body_text, /copper production/);
  assert.match(row.body_html, /&lt;script&gt;/);
  assert.ok(!row.body_html.includes("<script>"));
  assert.equal(row.processing_error, null);
  assert.equal(hits.get("/pdf"), 1);
  assert.deepEqual(
    (await analysis(item.articleId)).map((job) => [job.state, job.data.lane]),
    [["created", "news"]],
  );
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0].n, 0);
});

test("pausing a source while its PDF is in flight prevents material writes and analysis", async () => {
  const path = "/pdf-paused",
    release = gate();
  held.set(path, release);
  const item = await upsertMaterial(material(path));
  const before = await state(item.articleId);
  assert.ok(await queueProcessing(item.articleId));
  try {
    await until(
      async () => hits.get(path) ?? 0,
      (n) => n === 1,
      "PDF fetch must be in flight",
    );
    const [active] = await sql`SELECT id FROM pgboss.job WHERE name=${QUEUES.extractBody} AND data->>'articleId'=${item.articleId} AND state='active'`;
    assert.ok(active, "capture the exact attempt holding this response");
    await sql`UPDATE sources SET enabled=false WHERE id=${sourceId}`;
    release.open();
    const rows = await until(
      () => sql`SELECT output FROM pgboss.job WHERE id=${active.id} AND state='completed'`,
      (rows) => rows.length > 0,
      "The paused extraction must settle",
    );
    assert.equal(rows[0].output.state, "deferred");
    const after = await state(item.articleId);
    assert.deepEqual(
      [after.revision, after.body_text, after.body_html, after.body_status, after.processing_attempts],
      [before.revision, before.body_text, before.body_html, before.body_status, before.processing_attempts],
    );
    assert.equal((await analysis(item.articleId)).length, 0);
  } finally {
    release.open();
    await sql`DELETE FROM pgboss.job WHERE name=${QUEUES.extractBody} AND data->>'articleId'=${item.articleId} AND state IN ('created','retry')`;
    await sql`UPDATE sources SET enabled=true WHERE id=${sourceId}`;
  }
});

test("a real oversized response settles once, retains its reason and lets another page on the same source proceed", async (t) => {
  const prior = serverModules(),
    changed: string[] = [];
  t.after(() => installModules(prior));
  installModules([
    ...prior,
    {
      name: "fixture-extraction-event",
      on: {
        articleChanged: async (change, tx) => {
          assert.equal(change.reason, "body extraction");
          assert.equal((await tx`SELECT revision FROM articles WHERE id=${change.id}`)[0].revision, 2);
          changed.push(change.id);
        },
      },
    },
  ]);
  const big = await upsertMaterial(material("/oversized")),
    original = await state(big.articleId);
  assert.ok(await queueProcessing(big.articleId));
  assert.equal((await completed(big.articleId)).state, "unconfirmed");
  const rejected = await state(big.articleId);
  assert.equal(hits.get("/oversized"), 1, "the actual response exceeds the 6 MiB cap; it is not downloaded three times");
  assert.deepEqual(
    [rejected.revision, rejected.title, rejected.excerpt, rejected.body_text, rejected.body_html],
    [original.revision, original.title, original.excerpt, original.body_text, original.body_html],
    "oversize bytes never become a truncated or replacement body",
  );
  assert.equal(rejected.body_status, "unconfirmed");
  assert.deepEqual(changed, [], "rejected bytes never announce a material revision");
  assert.equal(rejected.processing_state, "new");
  assert.equal(rejected.processing_attempts, 0);
  assert.equal(rejected.processing_retry_at, null);
  assert.equal(rejected.processing_error, "extract: Response too large from 127.0.0.1");
  assert.deepEqual(
    (await analysis(big.articleId)).map((job) => [job.state, job.data.lane]),
    [["created", "news"]],
  );

  const normal = await upsertMaterial(material("/normal"));
  await sql`UPDATE articles SET processing_retry_at=now()+interval '10 minutes' WHERE id=${normal.articleId}`;
  assert.ok(await queueProcessing(normal.articleId));
  assert.equal((await completed(normal.articleId)).state, "ok");
  const readable = await state(normal.articleId);
  assert.equal(hits.get("/normal"), 1, "the same host continues after its ordinary spacing, without a host-wide cooldown");
  assert.equal(readable.body_status, "ok");
  assert.deepEqual(changed, [normal.articleId]);
  assert.ok(readable.body_text.includes("copper production"));
  assert.equal(readable.processing_error, null);
  assert.equal(readable.processing_retry_at, null, "a successful extraction clears the earlier deferral before analysis");
  assert.deepEqual(
    (await analysis(normal.articleId)).map((job) => [job.state, job.data.lane]),
    [["created", "news"]],
  );
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0].n, 0, "no reader or model request is made");
});

test("an oversized response arriving after a new revision cannot overwrite the new material or queue its analysis", async () => {
  const path = "/revised",
    release = gate();
  held.set(path, release);
  const old = await upsertMaterial(material(path));
  assert.ok(await queueProcessing(old.articleId));
  try {
    await until(
      async () => hits.get(path) ?? 0,
      (count) => count === 1,
      "The original revision must be in flight",
    );
    const next = await upsertMaterial({ ...material(path), title: "Revised mining update", bodyText: body, bodyHtml: `<p>${body}</p>`, bodyStatus: "ok" });
    assert.equal(next.articleId, old.articleId);
    assert.equal(next.revised, true);
    const revised = await state(old.articleId);
    release.open();
    assert.equal((await completed(old.articleId)).state, "stale");
    assert.deepEqual(await state(old.articleId), revised);
    assert.equal((await analysis(old.articleId)).length, 0);
    assert.equal(hits.get(path), 1);
  } finally {
    release.open();
  }
});

test("an oversized response cannot change a settled article on the same revision", async () => {
  const path = "/settled",
    release = gate();
  held.set(path, release);
  const article = await upsertMaterial(material(path));
  assert.ok(await queueProcessing(article.articleId));
  try {
    await until(
      async () => hits.get(path) ?? 0,
      (count) => count === 1,
      "The response must be in flight before the article is settled",
    );
    const revision = (await state(article.articleId)).revision;
    await commitProcessingResult(article.articleId, revision, "blocked", async () => undefined);
    const settled = await state(article.articleId);
    release.open();
    assert.equal((await completed(article.articleId)).state, "stale");
    assert.deepEqual(await state(article.articleId), settled);
    assert.equal((await analysis(article.articleId)).length, 0);
    assert.equal(hits.get(path), 1);
    assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0].n, 0);
  } finally {
    release.open();
  }
});

test("the existing server sweep resumes a material wait once and respects source pause and later configuration changes", async () => {
  const item = await upsertMaterial({ ...material("/pdf-empty"), excerpt: null, bodyStatus: "unconfirmed" });
  const waiting = async () => {
    await sql`UPDATE articles SET processing_state='analyzed',processing_queued_at=NULL WHERE id=${item.articleId}`;
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,selected,receipt_ids,output)
      VALUES(${item.articleId},1,'model','unknown',false,'{}'::bigint[],'{"prefilter":null,"scores":null}'::jsonb)`;
  };
  const reads = () => sql`SELECT id FROM pgboss.job WHERE name=${QUEUES.extractBody} AND data->>'articleId'=${item.articleId}`;
  await waiting();
  const source = (await readSourceDateContext(sourceId))!,
    permission = (await readCurrentSourcePolicy(sourceId))!;
  const requestId = bodyReadingKey({ id: item.articleId, revision: 1, url: `${base}/pdf-empty` }, source.config, permission.permission_version);
  // A queued intent left by an earlier deployment is not proof its reader actually ran.
  await audit("worker", "content.body-resume", `content:${item.articleId}`, "Synthetic interrupted dispatch", null, { jobId: null }, requestId);
  await sql`UPDATE sources SET enabled=false WHERE id=${sourceId}`;
  try {
    await sweepUnprocessed();
    assert.equal((await reads()).length, 0);
  } finally {
    await sql`UPDATE sources SET enabled=true WHERE id=${sourceId}`;
  }
  await sweepUnprocessed();
  assert.equal((await completed(item.articleId)).state, "unconfirmed");
  await waiting(); // The normal no-material analysis remains a wait, without a model call.
  const attempted = (await reads()).length;
  await sweepUnprocessed();
  assert.equal((await reads()).length, attempted, "unchanged failed input is not endlessly retried");
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='content.body-resume' AND subject=${`content:${item.articleId}`}`)[0].n, 1);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='content.body-read' AND subject=${`content:${item.articleId}`}`)[0].n, 1);
  await sql`UPDATE sources SET config=config || '{"acceptLanguage":"en-GB"}'::jsonb WHERE id=${sourceId}`;
  await sweepUnprocessed();
  assert.ok((await reads()).length > attempted, "a changed reading configuration can resume automatically");
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0].n, 0);
});
