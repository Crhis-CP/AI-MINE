import { scopeVersion, scopeOutput, scopeReceipt } from "./scope-fixture.ts";
import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import { dbOf, closeDb } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { upsertMaterial } from "@amp/backend/content/materials";
import { publishArticle } from "@amp/backend/publication/publish";

const sql = dbOf("enrichment");

const T = tag();
const SOURCE = `test-translate-stop-${T}`;
let active: { asked: ReturnType<typeof gate<void>>; hold: ReturnType<typeof gate<void>>; calls: number; misaligned: boolean; truncated: boolean };
const provider = await stub(async (_hit, req) => {
  const { text } = JSON.parse(JSON.parse(req.body).messages[1].content) as { text: string };
  assert.equal(typeof text, "string");
  active.calls++;
  if (active.calls === 1) {
    active.asked.open();
    await active.hold.promise;
  }
  const output = { text: `完整译文${T}`, ...(active.misaligned && active.calls === 1 ? { extra: true } : {}) };
  return {
    id: "stub",
    choices: [{ message: { content: JSON.stringify(output) }, finish_reason: active.truncated && text.includes("\n") ? "length" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
});

function runTranslation(articleId: string) {
  const script = `
    import { translateArticle } from '@amp/backend/editorial/translate';
    import {prepareTranslation} from '@amp/backend/publication/publish';
    import {TranslationInterruptedError} from './packages/backend/src/editorial/translation-runtime.ts';
    import { shutdownSignal } from '@amp/backend/jobs/queue';
    import { closeDb, initializeDb } from '@amp/backend/db';
    await initializeDb('test');
    process.on('SIGTERM', () => { shutdownSignal.abort(); process.send({ stopped: true }); });
    try {
      const revision=await prepareTranslation(process.argv[1]);
      const done=revision===null?[]:[await translateArticle(process.argv[1],revision)];
      process.send({result:{done}});
    } catch(error) {
      if(error instanceof TranslationInterruptedError) process.send({result:{done:[]}});
      else throw error;
    }
    finally { await closeDb(); process.disconnect(); }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, articleId], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MODEL_CALLS_ENABLED: "true",
      TRANSLATE_MODEL: "deepseek-flash",
      DEEPSEEK_BASE_URL: `${provider.url}/v1`,
      DEEPSEEK_API_KEY: "test-key",
      AMP_CREDENTIALS_DIR: "/nonexistent-test-credentials",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let result: any;
  let stderr = "";
  const stopped = gate();
  child.stderr!.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.on("message", (message: any) => {
    if (message.stopped) stopped.open();
    if (message.result) result = message.result;
  });
  const done = new Promise<any>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve(result) : reject(new Error(`translation child exited ${code}: ${stderr}`))));
  });
  return { child, done, stopped: stopped.promise };
}

before(async () => {
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,site_fulltext,next_fetch_at)
    VALUES (${SOURCE},'Translation shutdown','rss','T1','editorial',true,'2100-01-01')`;
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

for (const scenario of ["normal", "extra-field", "truncated"] as const)
  test(`SIGTERM finishes the sent ${scenario} segment and resumes from its receipt`, async () => {
    const misaligned = scenario === "extra-field",
      truncated = scenario === "truncated";
    active = { asked: gate(), hold: gate(), calls: 0, misaligned, truncated };
    const first = truncated
      ? `Truncated left ${T}.\nTruncated right ${T}.`
      : misaligned
        ? `First paragraph ${T}.`
        : `First paragraph ${T}. ${"English text ".repeat(170)}`;
    const second = truncated ? `Truncated follow-up ${T}.` : misaligned ? `Second paragraph ${T}.` : `Second paragraph ${T}. ${"More English ".repeat(170)}`;
    const { articleId } = await upsertMaterial({
      sourceId: SOURCE,
      url: `https://example.org/translation-shutdown-${T}/${scenario}`,
      title: `Shutdown ${T}`,
      bodyHtml: `<p>${first}</p><p>${second}</p>`,
      bodyText: first + second,
      bodyStatus: "ok",
      language: "en",
      via: "fetch",
      publishedAt: new Date(),
      discoveredAt: new Date(Date.now() + 86_400_000),
    });
    await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected, prompt_version, receipt_ids, output)
    VALUES (${articleId},1,'rule','pass','ai-models',${`终止测试${T}`},'摘要','理由',90,true, ${scopeVersion}, ${[await scopeReceipt(articleId)]}, ${sql.json(scopeOutput)})`;
    await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
    const interrupted = runTranslation(articleId);
    await Promise.race([active.asked.promise, interrupted.done.then(() => assert.fail("translation ended before a request"))]);
    interrupted.child.kill("SIGTERM");
    await interrupted.stopped;
    active.hold.open();
    assert.deepEqual(await interrupted.done, { done: [] });
    assert.equal(active.calls, 1, "no later fragment starts after shutdown");
    const receiptRows = await sql`SELECT status,response FROM receipts WHERE purpose='translate_body' AND subject LIKE ${`article:${articleId}@1#%`}`;
    assert.equal(receiptRows.length, 1);
    assert.equal(receiptRows[0]!.status, "received");
    assert.ok(receiptRows[0]!.response, "the paid answer arrived and remains reusable");
    assert.equal(
      (await sql`SELECT 1 FROM translation_attempts WHERE article_id=${articleId}`).length,
      0,
      "interruption does not consume attempts or become terminal",
    );
    const [pending] = await sql`SELECT complete,body_html,manifest FROM translations WHERE article_id=${articleId}`;
    assert.deepEqual(
      { ...pending },
      { complete: false, body_html: null, manifest: null },
      "the durable target remains resumable without publishing partial text",
    );
    const reused = await runTranslation(articleId).done;
    if (misaligned) {
      assert.equal(reused.done[0].status, "partial", "the cached extra-field response is rejected, never silently repaired");
      assert.equal((await runTranslation(articleId).done).done[0].status, "partial", "restart cannot bypass the five-minute bad-output cooldown");
      assert.equal(active.calls, 2, "the bad received answer and the good second segment are reused during cooldown");
      await sql`UPDATE receipt_attempts SET finished_at=now()-interval '6 minutes'
        WHERE output_rejected_at IS NOT NULL AND receipt_id IN (SELECT id FROM receipts WHERE subject LIKE ${`article:${articleId}@1#%`})`;
    }
    const resumed = misaligned ? await runTranslation(articleId).done : reused;
    assert.equal(resumed.done[0].status, "translated");
    assert.equal(
      active.calls,
      truncated ? 4 : misaligned ? 3 : 2,
      "the first receipt is reused, only missing pieces or the two explicit replacement children are requested",
    );
    if (truncated) {
      assert.equal(
        (await sql`SELECT count(*) AS n FROM enrichment.translation_segments WHERE article_id=${articleId} AND replacement_plan IS NOT NULL`)[0]!.n,
        1,
      );
      assert.equal((await sql`SELECT status FROM receipts WHERE purpose='translate_body' AND subject=${`article:${articleId}@1#0`}`)[0]!.status, "received");
    }
    const [translation] = await sql`SELECT complete,revision FROM translations WHERE article_id=${articleId}`;
    assert.deepEqual({ ...translation }, { complete: true, revision: 1 });
  });
