import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { after, before, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { sanitizeBody } from "@amp/backend/content/sanitize";
import { readCurrentBody, upsertMaterial } from "@amp/backend/content/materials";
import { stopBoss } from "@amp/backend/jobs/queue";
import { runBodyTranslation, type TranslationRecipe } from "../packages/backend/src/editorial/translation-runtime.ts";
import { beginTranslation } from "../packages/backend/src/editorial/translation-store.ts";

const sql = dbOf("enrichment"),
  T = tag(),
  SOURCE = `checkpoints-${T}`;
const recipe: TranslationRecipe = { id: `strict-${T}`, model: "deepseek-flash", promptVersion: `fixture-${T}`, system: "SELF_AUTHORED strict text fixture" };
let mode = "stop",
  hits = 0;
let hold: { asked: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | null = null;
const children = new Set<ChildProcess>();
const provider = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    hits++;
    const selectedMode = mode,
      pending = hold;
    const input = JSON.parse(JSON.parse(Buffer.concat(chunks).toString()).messages[1].content) as { text: string };
    pending?.asked.open();
    if (pending) await pending.release.promise;
    if (selectedMode === "reset") return res.destroy();
    const bad = (selectedMode === "bad" && !input.text.includes("GOOD")) || selectedMode === "no-usage-bad";
    const text = selectedMode === "encoded" ? "中文 &#65533;" : input.text.includes("<strong>") ? "合成<strong>未</strong>获准。" : "合成中文正文。";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { content: JSON.stringify(bad ? { text, extra: true } : { text }) },
            ...(selectedMode === "empty" ? {} : { finish_reason: selectedMode === "length" ? "length" : "stop" }),
          },
        ],
        ...(selectedMode === "no-usage-bad" ? {} : { usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }),
      }),
    );
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,site_fulltext) VALUES(${SOURCE},'Self-authored checkpoint fixture','rss',true)`;
});
after(async () => {
  hold?.release.open();
  for (const child of children) child.kill("SIGKILL");
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await stopBoss();
  await closeDb();
  console.log(`LOCAL_MODEL_FIXTURE_CALLS=${hits}`);
});
const material = (name: string, html = `<p>${name} ${T}</p>`) =>
  upsertMaterial({
    sourceId: SOURCE,
    url: `https://fixture.invalid/${T}/${name}`,
    title: name,
    language: "en",
    bodyHtml: sanitizeBody(html),
    bodyText: html.replace(/<[^>]+>/g, " "),
    bodyStatus: "ok",
    via: "fetch",
  });
const translation = async (id: string) => (await sql`SELECT revision,recipe,body_html,complete,manifest FROM translations WHERE article_id=${id}`)[0];

test("real strict calls assemble all ordered blocks, reuse receipts across recipe assembly and keep analysis state", async () => {
  mode = "stop";
  const { articleId } = await material("ordered", `<div>Project <strong>not</strong> permitted ${T}.<p>Tail condition ${T}.</p></div>`);
  await sql`UPDATE articles SET processing_state='failed',processing_error='kept' WHERE id=${articleId}`;
  const start = hits;
  assert.equal((await runBodyTranslation(articleId, recipe)).status, "translated");
  const first = await translation(articleId);
  assert.equal(first.body_html, "<p>合成<strong>未</strong>获准。</p><p>合成中文正文。</p>");
  assert.equal(first.manifest.segments.length, 2);
  assert.equal(hits - start, 2);
  assert.equal((await runBodyTranslation(articleId, { ...recipe, id: recipe.id + "-reassembled" })).status, "translated");
  assert.equal(hits - start, 2, "same request inputs reuse actual gateway receipts; recipe labels never manufacture an attemptTag");
  const records = await sql`SELECT recipe,receipt_id FROM enrichment.translation_segments WHERE article_id=${articleId} ORDER BY recipe,segment_index`;
  assert.equal(records.length, 4);
  assert.equal(new Set(records.map((row) => row.receipt_id)).size, 2);
  await sql`UPDATE receipts SET response_attempt_id=NULL WHERE id=ANY(${records.map((row) => row.receipt_id)}::bigint[])`;
  const historical = await runBodyTranslation(articleId, { ...recipe, id: recipe.id + "-unbound" });
  assert.equal(historical.status, "partial");
  assert.equal(historical.reason, "unbound historical response");
  assert.equal(hits - start, 2, "unprovable cached identity is neither guessed nor repurchased");
  assert.equal((await translation(articleId)).complete, false);
  assert.ok((await sql`SELECT status FROM receipts WHERE id=ANY(${records.map((row) => row.receipt_id)}::bigint[])`).every((r) => r.status === "completed"));
  assert.deepEqual(
    { ...(await sql`SELECT processing_state,processing_error FROM articles WHERE id=${articleId}`)[0] },
    { processing_state: "failed", processing_error: "kept" },
  );
});

test("model wait holds no material lock and neither late revision nor superseded recipe may promote", async () => {
  for (const change of ["revision", "recipe"] as const) {
    mode = change === "recipe" ? "bad" : "stop";
    const { articleId } = await material(`late-${change}`, `<p>First late ${change} ${T}.</p><p>Second late ${change} ${T}.</p>`);
    const before = hits;
    hold = { asked: gate(), release: gate() };
    const running = runBodyTranslation(articleId, recipe);
    await Promise.race([hold.asked.promise, running.then(() => assert.fail("model was not called"))]);
    try {
      if (change === "revision") {
        await assert.rejects(runBodyTranslation(articleId, recipe), /in flight/);
        const update = material(`late-${change}`, `<p>Changed material ${T}.</p>`);
        const timer = AbortSignal.timeout(2000);
        await Promise.race([
          update,
          new Promise((_, reject) => timer.addEventListener("abort", () => reject(new Error("network held material transaction")), { once: true })),
        ]);
      } else await beginTranslation((await readCurrentBody(articleId))!, recipe.id + "-new");
    } finally {
      hold.release.open();
      hold = null;
    }
    const result = await running;
    assert.equal(hits - before, 1, "late valid or invalid output must not start later fragments");
    assert.equal(result.status, "stale");
    assert.equal((await translation(articleId)).complete, false);
    assert.equal((await sql`SELECT count(*) AS n FROM enrichment.translation_segments WHERE article_id=${articleId}`)[0].n, 0);
    assert.equal((await sql`SELECT status FROM receipts WHERE subject LIKE ${`article:${articleId}@1#%`}`)[0].status, "received");
  }
});

test("unknown, explicit truncation and invalid text without usage never purchase an automatic retry", async () => {
  for (const selected of ["reset", "length", "no-usage-bad"]) {
    mode = selected;
    const { articleId } = await material(selected);
    const start = hits;
    for (let i = 0; i < 2; i++) {
      if (selected === "reset") await assert.rejects(runBodyTranslation(articleId, recipe));
      else {
        const result = await runBodyTranslation(articleId, recipe);
        assert.equal(result.status, "partial");
        if (selected === "length") assert.equal(result.reason, "truncated", "cached response also retains its finish reason");
      }
    }
    assert.equal(hits - start, 1, selected);
    if (selected === "no-usage-bad")
      assert.equal((await sql`SELECT failed_attempts FROM enrichment.translation_segments WHERE article_id=${articleId}`)[0].failed_attempts, 1);
    assert.equal((await translation(articleId)).complete, false);
    assert.equal((await translation(articleId)).body_html, null);
    assert.equal(
      (await sql`SELECT status FROM receipts WHERE subject LIKE ${`article:${articleId}@1#%`}`)[0].status,
      selected === "reset" ? "unknown" : "received",
    );
  }
});

test("known-usage bad text can retry only that segment; empty finish reason stays compatible", async () => {
  mode = "bad";
  const { articleId } = await material("bad-retry", `<p>GOOD ${T}.</p><p>BAD ${T}.</p>`);
  const start = hits;
  assert.equal((await runBodyTranslation(articleId, recipe)).status, "partial");
  assert.deepEqual(
    (await sql`SELECT status FROM receipts WHERE subject LIKE ${`article:${articleId}@1#%`} ORDER BY status`).map((row) => row.status),
    ["completed", "failed"],
  );
  mode = "empty";
  assert.equal((await runBodyTranslation(articleId, recipe)).status, "translated");
  assert.equal((await runBodyTranslation(articleId, { ...recipe, id: recipe.id + "-empty-cache" })).status, "translated");
  assert.equal(hits - start, 3, "only the bad segment is retried; empty finishReason survives paid-result reuse");
  mode = "bad";
  const limited = await material("bad-limit"),
    before = hits;
  for (let i = 0; i < 4; i++) assert.equal((await runBodyTranslation(limited.articleId, recipe)).status, "partial");
  assert.equal(hits - before, 3, "known-usage bad segments allow at most two additional paid attempts");
  mode = "encoded";
  const encoded = await material("encoded-bad");
  assert.equal((await runBodyTranslation(encoded.articleId, recipe)).status, "partial");
  assert.equal((await translation(encoded.articleId)).complete, false);
});

test("manifest write failure rolls back promotion, then finishes from completed checkpoints without new payment", async () => {
  mode = "stop";
  const { articleId } = await material("promotion-rollback");
  const name = `translation_rollback_${T}`,
    start = hits;
  await sql`CREATE FUNCTION ${sql(name)}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture promotion rollback'; END$$`;
  await sql`CREATE TRIGGER ${sql(name)} BEFORE UPDATE OF manifest ON translations FOR EACH ROW EXECUTE FUNCTION ${sql(name)}()`;
  try {
    await assert.rejects(runBodyTranslation(articleId, recipe), /fixture promotion rollback/);
    assert.equal((await translation(articleId)).complete, false);
    assert.equal((await translation(articleId)).manifest, null);
    assert.equal((await sql`SELECT state FROM enrichment.translation_segments WHERE article_id=${articleId}`)[0].state, "complete");
  } finally {
    await sql`DROP TRIGGER ${sql(name)} ON translations`;
    await sql`DROP FUNCTION ${sql(name)}()`;
  }
  assert.equal((await runBodyTranslation(articleId, recipe)).status, "translated");
  assert.equal(hits - start, 1);
});

test("actual process stop retains the received answer and a new process resumes without rebuying it", async () => {
  mode = "stop";
  const { articleId } = await material("shutdown", `<p>First shutdown ${T}.</p><p>Second shutdown ${T}.</p>`);
  const launch = () => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {initializeDb,closeDb} from '@amp/backend/db';
      import {shutdownSignal} from '@amp/backend/jobs/queue';
      import {runBodyTranslation,TranslationInterruptedError} from './packages/backend/src/editorial/translation-runtime.ts';
      await initializeDb('test');
      process.on('SIGTERM',()=>{shutdownSignal.abort();process.send({stopped:true})});
      try {process.send({result:await runBodyTranslation(process.argv[1],JSON.parse(process.argv[2]))})}
      catch(error) {if(!(error instanceof TranslationInterruptedError))throw error;process.send({interrupted:true})}
      finally {await closeDb();process.disconnect()}
    `,
        articleId,
        JSON.stringify(recipe),
      ],
      { env: process.env, stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    children.add(child);
    const stopped = gate();
    let result: unknown,
      stderr = "";
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    child.on("message", (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const message = value as { stopped?: boolean; result?: unknown; interrupted?: boolean };
      if (message.stopped) stopped.open();
      if (message.result) result = message.result;
      if (message.interrupted) result = "interrupted";
    });
    const done = new Promise<unknown>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        children.delete(child);
        code === 0 ? resolve(result) : reject(new Error(stderr));
      });
    });
    return { child, stopped: stopped.promise, done };
  };
  hold = { asked: gate(), release: gate() };
  const start = hits,
    first = launch();
  await Promise.race([hold.asked.promise, first.done.then(() => assert.fail("child never called provider"))]);
  first.child.kill("SIGTERM");
  await first.stopped;
  hold.release.open();
  hold = null;
  assert.equal(await first.done, "interrupted");
  assert.equal(hits - start, 1);
  assert.equal((await sql`SELECT status FROM receipts WHERE subject LIKE ${`article:${articleId}@1#%`}`)[0].status, "received");
  assert.equal((await translation(articleId)).complete, false);
  assert.equal(((await launch().done) as { status: string }).status, "translated");
  assert.equal(hits - start, 2);
});
