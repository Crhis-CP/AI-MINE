import { tag, gate, stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { stopBoss } from "@amp/backend/jobs/queue";
import { translateArticle } from "@amp/backend/editorial/translate";
import { translatePostQuote, quoteTranslationRecipe } from "../packages/backend/src/editorial/post-translation.ts";
import { ensureModelSourceFixture } from "./model-source-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";

const T = tag(),
  source = `quote-translation-${T}`;
let mode = "good",
  hits = 0,
  hold: { asked: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | null = null;
const provider = await stub(async () => {
  hits++;
  const captured = hold,
    current = mode;
  captured?.asked.open();
  if (captured) await captured.release.promise;
  return {
    choices: [
      {
        message: { content: JSON.stringify(current === "bad" ? { t: ["原帖合成译文"], complete: true } : { t: ["原帖合成译文，保留原作者的项目说明。"] }) },
        finish_reason: current === "length" ? "length" : "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
before(async () => {
  await installUsageFixtureForModel("deepseek-flash");
  await sql`INSERT INTO sources(id,name,kind,tier,site_fulltext,participation_mode) VALUES(${source},'Self-authored quote fixture','rss','T1',true,'editorial')`;
  await ensureModelSourceFixture(source, ["https://example.com/source"]);
});
after(async () => {
  hold?.release.open();
  await provider.close();
  await stopBoss();
  await closeDb();
});
async function material(name: string, text: string, language = "zh") {
  const xPost = {
    tweetId: name,
    authorName: "Author",
    handle: "author",
    text: "铜矿项目进展。",
    quoted: { authorName: "Quoted author", handle: "quoted", text, url: `https://example.com/status/${T}` },
  };
  const articleId = (
    await upsertMaterial({
      sourceId: source,
      url: `https://example.com/${T}/${name}`,
      title: "合成原帖",
      language,
      bodyText: "铜矿项目进展。",
      bodyHtml: "<p>铜矿项目进展。</p>",
      bodyStatus: "ok",
      via: "fetch",
      xPost,
    })
  ).articleId;
  // Seed only this consumer's synthetic persisted input; never replace a migration or production producer.
  await sql`UPDATE articles SET revision=CASE WHEN x_post IS NULL THEN revision ELSE revision+1 END,x_post=${sql.json(xPost)}
    WHERE id=${articleId} AND x_post IS DISTINCT FROM ${sql.json(xPost)}`;
  return articleId;
}

test("quote-only translation has a real completed receipt and never creates a whole-body manifest; cross-item reuse keeps original billing attribution", async () => {
  const text = "Copper mining project starts construction with a new production schedule.",
    first = await material("first", text);
  const start = hits;
  assert.deepEqual(await translateArticle(first, 1), { articleId: first, revision: 1, status: "translated", reason: "quoted_post" });
  assert.equal(hits - start, 1);
  assert.equal((await sql`SELECT count(*)::int AS n FROM translations WHERE article_id=${first}`)[0].n, 0);
  const [saved] = await sql`SELECT * FROM enrichment.quote_translations WHERE source_id=${source}`;
  assert.equal(saved.input_article_id, first);
  assert.ok(saved.receipt_id && saved.attempt_id);
  const [receipt] = await sql`SELECT status,response_attempt_id,request FROM receipts WHERE id=${saved.receipt_id}`;
  assert.equal(receipt.status, "completed");
  assert.equal(String(receipt.response_attempt_id), String(saved.attempt_id));
  assert.deepEqual(receipt.request.sourceIds, [source]);
  const second = await material("second", text);
  assert.equal(await translatePostQuote(second, 1), "ready");
  assert.equal(hits - start, 1);
  assert.deepEqual([...(await sql`SELECT * FROM enrichment.quote_translations WHERE source_id=${source}`)], [saved]);
  await sql`UPDATE enrichment.quote_translations SET recipe=recipe||'-old',text_zh='过期配方的错误占位译文' WHERE source_id=${source}`;
  assert.equal(await translatePostQuote(second, 1), "ready");
  assert.equal(hits - start, 1, "the obsolete stored recipe is rebuilt from the actual current gateway receipt without repurchase");
  assert.equal(
    (await sql`SELECT count(*)::int AS n FROM enrichment.quote_translations WHERE source_id=${source} AND recipe=${quoteTranslationRecipe()}`)[0].n,
    1,
  );
  const [current] = await sql`SELECT receipt_id,text_zh FROM enrichment.quote_translations WHERE source_id=${source} AND recipe=${quoteTranslationRecipe()}`;
  assert.equal(current.text_zh, saved.text_zh);
  assert.equal(current.receipt_id, saved.receipt_id);
  await sql`DELETE FROM enrichment.quote_translations WHERE source_id=${source} AND recipe=${quoteTranslationRecipe()}`;
  await sql`UPDATE receipts SET response_attempt_id=NULL WHERE id=${current.receipt_id}`;
  assert.equal(await translatePostQuote(second, 1), "partial");
  assert.equal(hits - start, 1, "an unbound historical receipt is neither guessed nor repurchased");
  assert.equal(
    (await sql`SELECT count(*)::int AS n FROM enrichment.quote_translations WHERE source_id=${source} AND recipe=${quoteTranslationRecipe()}`)[0].n,
    0,
  );
});

test("Chinese and link-only quotations have no paid call or synthetic cache; malformed/truncated answers never become complete", async () => {
  const start = hits;
  for (const [name, text] of [
    ["chinese", "铜矿项目公布产能调整。"],
    ["link", "https://example.com/only"],
  ])
    assert.equal(await translatePostQuote(await material(name!, text!), 1), "none");
  assert.equal(hits, start);
  for (const failure of ["bad", "length"]) {
    mode = failure;
    const id = await material(failure, `Foreign quote material ${failure} about mining output and project costs.`);
    assert.equal(await translatePostQuote(id, 1), "partial");
    assert.equal((await sql`SELECT count(*)::int AS n FROM enrichment.quote_translations WHERE input_article_id=${id}`)[0].n, 0);
    assert.equal((await sql`SELECT status FROM receipts WHERE subject LIKE ${`article:${id}@1#quote:%`}`)[0].status, "failed");
    assert.equal((await sql`SELECT count(*)::int AS n FROM translations WHERE article_id=${id}`)[0].n, 0);
  }
  mode = "good";
  const fullBody = await material("body-boundary", "Separate foreign quote concerning mining operations.", "en");
  const result = await translateArticle(fullBody, 1);
  assert.equal(result.status, "partial", "a valid t-array quote cannot satisfy the body's strict text contract");
  assert.equal((await sql`SELECT complete FROM translations WHERE article_id=${fullBody}`)[0].complete, false);
});

test("a revised quote rejects the in-flight old answer and a later attempt uses the new quote", async () => {
  const id = await material("revision", "A mining project announced its initial planned investment and production.");
  hold = { asked: gate(), release: gate() };
  const running = translatePostQuote(id, 1);
  await Promise.race([hold.asked.promise, running.then(() => assert.fail("model was not called"))]);
  await material("revision", "The revised mining announcement changes the investment and production target.");
  hold.release.open();
  hold = null;
  assert.equal(await running, "stale");
  assert.equal((await sql`SELECT count(*)::int AS n FROM enrichment.quote_translations WHERE input_article_id=${id}`)[0].n, 0);
  assert.equal((await sql`SELECT status FROM receipts WHERE subject LIKE ${`article:${id}@1#quote:%`}`)[0].status, "received");
  assert.equal(await translatePostQuote(id, 2), "ready");
  assert.equal((await sql`SELECT input_revision FROM enrichment.quote_translations WHERE input_article_id=${id}`)[0].input_revision, 2);
});
