import { ensureModelSourceFixture } from "./model-source-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { autoReleaseUnknownReceipts } from "@amp/backend/admin/runs";
import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { sanitizeBody } from "@amp/backend/content/sanitize";
import { readCurrentBody, upsertMaterial } from "@amp/backend/content/materials";
import { stopBoss } from "@amp/backend/jobs/queue";
import { runBodyTranslation, type TranslationRecipe } from "../packages/backend/src/editorial/translation-runtime.ts";
import { beginTranslation } from "../packages/backend/src/editorial/translation-store.ts";

const T = tag(),
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
    const bad =
      (selectedMode === "presentation-partial" && input.text.includes("BAD")) ||
      (selectedMode === "bad" && !input.text.includes("GOOD")) ||
      selectedMode === "no-usage-bad";
    const text = selectedMode.startsWith("presentation")
      ? input.text.replace(/Mining project/g, "矿业项目").replace(/report/g, "报告")
      : selectedMode === "encoded"
        ? "中文 &#65533;"
        : input.text.includes("<strong>")
          ? "合成<strong>未</strong>获准。"
          : "合成中文正文。";
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
  for (const model of ["deepseek-flash"]) await installUsageFixtureForModel(model);
  await sql`INSERT INTO sources(id,name,kind,site_fulltext) VALUES(${SOURCE},'Self-authored checkpoint fixture','rss',true)`;
  await ensureModelSourceFixture(SOURCE, ["https://fixture.invalid/source"]);
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
const cool = async (id: string) => {
  await sql`UPDATE receipt_attempts SET finished_at=now()-interval '6 minutes'
  WHERE output_rejected_at IS NOT NULL AND receipt_id IN (SELECT id FROM receipts WHERE subject LIKE ${`article:${id}@1#%`})`;
};

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

test("unknown outcomes stay blocked and received invalid output respects its retry window", async () => {
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
      selected === "reset" ? "unknown" : selected === "no-usage-bad" ? "failed" : "received",
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
  await cool(articleId);
  assert.equal((await runBodyTranslation(articleId, recipe)).status, "translated");
  assert.equal((await runBodyTranslation(articleId, { ...recipe, id: recipe.id + "-empty-cache" })).status, "translated");
  assert.equal(hits - start, 3, "only the bad segment is retried; empty finishReason survives paid-result reuse");
  mode = "bad";
  const limited = await material("bad-limit"),
    before = hits;
  for (let i = 0; i < 4; i++) {
    await cool(limited.articleId);
    assert.equal((await runBodyTranslation(limited.articleId, recipe)).status, "partial");
  }
  assert.equal(hits - before, 2, "two identical bad paid outputs stop before buying the same unusable response a third time");
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
  try {
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
  } finally {
    hold?.release.open();
    hold = null;
  }
});

test("one released unknown segment can recover and continue to the next segment without clearing its old charge", async () => {
  const { articleId } = await material("released-segments", `<p>First copper note ${T}.</p><p>Second copper note ${T}.</p>`);
  const start = hits;
  mode = "reset";
  await assert.rejects(runBodyTranslation(articleId, recipe));
  await assert.rejects(runBodyTranslation(articleId, recipe));
  assert.equal(hits - start, 1);
  await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE subject LIKE ${`article:${articleId}@1#%`}`;
  await autoReleaseUnknownReceipts();
  mode = "stop";
  assert.equal((await runBodyTranslation(articleId, recipe)).status, "translated");
  assert.equal(hits - start, 3, "one initial unknown, one exact retry, then the second segment");
  const [original] = await sql`SELECT a.status,u.state,o.known_unbilled FROM receipt_attempts a
    JOIN receipts r ON r.id=a.receipt_id JOIN ai.usage_attempts u ON u.attempt_id=a.id
    JOIN ai.translation_receipt_observations o ON o.attempt_id=a.id::text
    WHERE r.subject LIKE ${`article:${articleId}@1#%`} AND a.status='unknown'`;
  assert.deepEqual({ ...original }, { status: "unknown", state: "unknown", known_unbilled: false });
  assert.equal((await runBodyTranslation(articleId, recipe)).status, "translated");
  assert.equal(hits - start, 3);
});

test("presentation updates reuse bound translations and preserve semantic state without any model request", async () => {
  mode = "presentation";
  const name = "presentation-refresh";
  const oldHtml = `<p>Mining project ${T} <a href="https://fixture.invalid/old">report</a> <img src="https://fixture.invalid/old.png"></p>`;
  const nextHtml = oldHtml.replaceAll("/old", "/new");
  const { articleId } = await material(name, oldHtml);
  assert.equal((await runBodyTranslation(articleId, recipe)).status, "translated");
  await sql`UPDATE articles SET processing_state='failed',processing_error='kept' WHERE id=${articleId}`;
  await sql`INSERT INTO publications(article_id,title,source_id,channel,url,discovered_at,timeline_at,sort_at,visibility,body_mode,eligible,selected)
    VALUES(${articleId},'合成展示版本',${SOURCE},'news',${`https://fixture.invalid/${T}/${name}`},now(),now(),now(),'public','full',true,false)`;
  const [watermark] = await sql`SELECT version,last_public_at FROM publication.read_watermarks WHERE lane='news'`;
  const beforeHits = hits;
  const beforeReceipts = await sql`SELECT id,status,response_attempt_id FROM receipts ORDER BY id`;
  const update = await material(name, nextHtml);
  assert.equal(update.revised, false);
  assert.equal(update.metadataChanged, true);
  assert.equal(update.revision, 1);
  const [nextWatermark] = await sql`SELECT version,last_public_at FROM publication.read_watermarks WHERE lane='news'`;
  assert.ok(Number(nextWatermark.version) > Number(watermark.version), "open readers can detect presentation updates");
  assert.equal(nextWatermark.last_public_at.getTime(), watermark.last_public_at.getTime(), "presentation is not another publication");
  const refreshed = await translation(articleId);
  assert.equal(refreshed.complete, true);
  assert.match(refreshed.body_html, /矿业项目/);
  assert.match(refreshed.body_html, /fixture.invalid\/new.png/);
  assert.match(refreshed.body_html, /href="https:\/\/fixture.invalid\/new"/);
  assert.equal(hits, beforeHits);
  assert.deepEqual(await sql`SELECT id,status,response_attempt_id FROM receipts ORDER BY id`, beforeReceipts);
  assert.equal(
    (await runBodyTranslation(articleId, { ...recipe, model: "not-configured" })).status,
    "translated",
    "retained wording also survives a later model route change",
  );
  assert.equal(hits, beforeHits);
  assert.deepEqual(
    { ...(await sql`SELECT processing_state,processing_error FROM articles WHERE id=${articleId}`)[0] },
    { processing_state: "failed", processing_error: "kept" },
  );
  assert.equal((await material(name, nextHtml)).metadataChanged, false);
  await material(name, oldHtml);
  await material(name, nextHtml);
  assert.equal(hits, beforeHits, "returning to an earlier presentation keeps the same paid attempts");
  await assert.rejects(material(name, nextHtml.replace(" <a", "</p><p><a")), /保留原版本/);
  assert.equal((await sql`SELECT body_html FROM articles WHERE id=${articleId}`)[0].body_html, sanitizeBody(nextHtml));
});

test("presentation updates keep a partial translation partial and retain unfinished attempts", async () => {
  mode = "presentation-partial";
  const name = "presentation-partial";
  const html = `<p>Mining project ${T} <a href="https://fixture.invalid/old">report</a></p><p>BAD Mining project ${T}.</p>`;
  const { articleId } = await material(name, html);
  assert.equal((await runBodyTranslation(articleId, recipe)).status, "partial");
  const before = hits;
  await material(name, html.replace("/old", "/new"));
  const refreshed = await translation(articleId);
  assert.equal(refreshed.complete, false);
  assert.equal(refreshed.manifest.translatedSegments, 1);
  assert.equal(refreshed.manifest.totalSegments, 2);
  assert.match(refreshed.body_html, /BAD Mining project/);
  assert.equal(hits, before);
});
