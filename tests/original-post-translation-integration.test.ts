import { tag, gate, stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial, type XPostData } from "@amp/backend/content/materials";
import { analysisVersionOf, loadAnalyzeInput, tierThreshold } from "@amp/backend/editorial/analyze";
import { translateArticle, translatePending } from "@amp/backend/editorial/translate";
import { translatePostQuote, quoteTranslationRecipe } from "../packages/backend/src/editorial/post-translation.ts";
import { prepareTranslation, publishArticle } from "@amp/backend/publication/publish";
import { readCurrentSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";
import { QUEUES, stopBoss, recordRun } from "@amp/backend/jobs/queue";
import { grantDateFixture } from "./source-date-fixture.ts";
import { confirmGroupingFixture } from "./grouping-fixture.ts";
import { scopeOutput, scopeReceipt } from "./scope-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";

const T = tag(),
  host = `https://quote-integration-${T}.invalid`;
let serial = 0,
  bodyCalls = 0,
  quoteCalls = 0;
let hold: { asked: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | null = null;
const provider = await stub(async (_n, req) => {
  const value = JSON.parse(JSON.parse(req.body).messages.at(-1).content);
  const quote = Array.isArray(value.segments);
  if (quote) quoteCalls++;
  else bodyCalls++;
  const captured = hold;
  captured?.asked.open();
  if (captured) await captured.release.promise;
  return {
    choices: [
      {
        message: { content: JSON.stringify(quote ? { t: ["合成引用译文：铜矿项目按计划建设。"] } : { text: "已取得长文的合成完整译文。" }) },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.TRANSLATE_MODEL = "deepseek-flash";
before(() => installUsageFixtureForModel("deepseek-flash"));
after(async () => {
  hold?.release.open();
  await provider.close();
  await stopBoss();
  await closeDb();
});
async function source() {
  const id = `quote-integration-${T}-${++serial}`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext) VALUES(${id},'合成引用整合来源','rss','T1','editorial',true)`;
  await grantDateFixture(id, [host]);
  return id;
}
const quote = (suffix: string): NonNullable<XPostData["quoted"]> => ({
  authorName: "Quoted",
  handle: "quoted",
  text: `Copper mining project ${suffix} starts construction on schedule.`,
  url: `${host}/quote/${suffix}`,
});
async function material(sourceId: string, text: string, quoted?: XPostData["quoted"], language = "zh") {
  const name = `post-${++serial}`;
  return (
    await upsertMaterial({
      sourceId,
      url: `${host}/post/${name}`,
      title: text || name,
      language,
      publishedAt: new Date(Date.now() - 60_000),
      via: "fetch",
      xPost: { tweetId: name, authorName: "Author", handle: "author", text, quoted },
    })
  ).articleId;
}
async function publish(id: string) {
  const input = (await loadAnalyzeInput(id))!;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected,prompt_version,receipt_ids,output)
    VALUES(${id},${input.revision},'model','pass','合成铜矿项目',${input.xPost!.text},80,true,${analysisVersionOf(input)},${[await scopeReceipt(id)]},
      ${sql.json({ ...scopeOutput, writer: "verbatim", scores: [80, 80], threshold: tierThreshold("T1") })})`;
  await confirmGroupingFixture(id);
  await publishArticle(id);
}
async function previouslyPermittedQuote(sourceId: string, text: string, quoted: NonNullable<XPostData["quoted"]>) {
  const prior = (await readCurrentSourcePolicy(sourceId))!,
    scope = { ...prior.scope, hosts: [...prior.scope.hosts, new URL(quoted.url).hostname] };
  await saveSourcePolicy(
    sourceId,
    {
      policy: { ...prior, scope, evidence: prior.evidence.map((e) => ({ ...e, scope })) },
      expectedVersion: prior.permission_version,
      reason: "Synthetic historical quote grant",
    },
    "test",
  );
  const id = await material(sourceId, text, quoted),
    current = (await readCurrentSourcePolicy(sourceId))!;
  await saveSourcePolicy(sourceId, { policy: prior, expectedVersion: current.permission_version, reason: "Withdraw synthetic quote scope" }, "test");
  return id;
}
const queued = async (id: string) =>
  (await sql`SELECT id FROM pgboss.job WHERE name=${QUEUES.translate} AND data->>'articleId'=${id} AND state='created'`).length;
const clearJobs = async (ids: string[]) => {
  await sql`DELETE FROM pgboss.job WHERE name=${QUEUES.translate} AND data->>'articleId'=ANY(${ids}::text[])`;
};

test("empty/link posts skip strict body work; acquired long text remains translatable and cached quotes survive paid-work pause", async () => {
  const id = await source(),
    q = quote("body-guard"),
    first = await material(id, "中文主帖。", q);
  await translateArticle(first, 1);
  const calls = quoteCalls,
    bodies = bodyCalls;
  const [control] = await sql`SELECT paused,reason,actor,expires_at FROM ops.lane_controls WHERE lane='news' AND switch='processing' AND holder='owner'`;
  await sql`UPDATE ops.lane_controls SET paused=true,reason='Synthetic new-work pause',actor='test',expires_at=now()+interval '1 day' WHERE lane='news' AND switch='processing' AND holder='owner'`;
  try {
    for (const [text, language] of [
      ["", "en"],
      [`${host}/linked`, "en"],
      ["中文主帖。", "zh"],
    ]) {
      const item = await material(id, text!, q, language);
      assert.equal((await translateArticle(item, 1)).reason, "quoted_post");
      assert.equal((await sql`SELECT count(*)::int AS n FROM translations WHERE article_id=${item}`)[0].n, 0);
      assert.equal((await sql`SELECT count(*)::int AS n FROM translation_attempts WHERE article_id=${item}`)[0].n, 0);
    }
  } finally {
    await sql`UPDATE ops.lane_controls SET paused=${control.paused},reason=${control.reason},actor=${control.actor},expires_at=${control.expires_at} WHERE lane='news' AND switch='processing' AND holder='owner'`;
  }
  assert.equal(quoteCalls, calls);
  assert.equal(bodyCalls, bodies);
  const long = await material(id, `${host}/long`, undefined, "en");
  await sql`UPDATE articles SET revision=revision+1,x_article=${sql.json({ title: "Acquired title", text: "Actual acquired mining article text." })},
    body_text='Actual acquired mining article text.',body_html='<p>Actual acquired mining article text.</p>' WHERE id=${long}`;
  assert.equal((await translateArticle(long, 2)).status, "translated");
  assert.equal(bodyCalls, bodies + 1, "a real acquired long article is not a bare link");
});

test("bounded repair reprojects shared current quote cache and changed recipes without extra model calls or denied-quote loops", async () => {
  const id = await source(),
    q = quote("shared-projection");
  const first = await material(id, "第一个铜矿原帖。", q),
    second = await material(id, "第二个铜矿原帖。", q);
  const denied = await previouslyPermittedQuote(id, "第三个铜矿原帖。", { ...q, url: "https://unapproved-quote.invalid/post" });
  for (const item of [first, second, denied]) await publish(item);
  await clearJobs([first, second, denied]);
  assert.equal((await sql`SELECT x_post#>>'{view,quoted,translation}' AS translation FROM publications WHERE article_id=${second}`)[0].translation, null);
  await translateArticle(first, 1);
  await publishArticle(first);
  const calls = quoteCalls;
  for (const stale of ["missing", "recipe", "revision"]) {
    if (stale === "recipe") await sql`UPDATE publications SET x_post=jsonb_set(x_post,'{quoteRecipe}','"retired-recipe"'::jsonb) WHERE article_id=${second}`;
    if (stale === "revision") await sql`UPDATE publications SET x_post_revision=2 WHERE article_id=${second}`;
    await recordRun("content.translate", () => translatePending({ limit: 1000 }));
    assert.equal(await queued(second), 1, stale);
    assert.equal(await queued(denied), 0, "a missing permission marker never enters the quote repair loop");
    assert.equal(await prepareTranslation(second), null, "the existing worker preparation repairs the projection for free");
    const [projected] = await sql`SELECT x_post,x_post_revision FROM publications WHERE article_id=${second}`;
    assert.equal(projected.x_post_revision, 1);
    assert.equal(projected.x_post.quoteRecipe, quoteTranslationRecipe());
    assert.match(projected.x_post.view.quoted.translation, /合成引用译文/);
    await clearJobs([second]);
    await recordRun("content.translate", () => translatePending({ limit: 1000 }));
    assert.equal(await queued(second), 0, "an already current projection does not keep queuing");
  }
  assert.equal(quoteCalls, calls);
});

test("quote URL must be independently permitted before sending and remains fenced while the paid answer returns", async () => {
  const id = await source(),
    q = quote("permission");
  const outside = await previouslyPermittedQuote(id, "中文主帖。", { ...q, url: "https://unapproved-quote.invalid/post" });
  const calls = quoteCalls;
  await assert.rejects(translatePostQuote(outside, 1), /引用 URL/);
  assert.equal(quoteCalls, calls);
  const item = await material(id, "中文主帖。", q),
    original = (await readCurrentSourcePolicy(id))!;
  const evidence = original.evidence[0]!;
  await saveSourcePolicy(
    id,
    {
      policy: {
        ...original,
        evidence: [
          { ...evidence, capabilities: evidence.capabilities.filter((c) => c !== "external_model") },
          { ...evidence, capabilities: ["external_model"], scope: { ...evidence.scope!, path_prefixes: ["/post/"] } },
        ],
      },
      expectedVersion: original.permission_version,
      reason: "Synthetic URL-scoped external grant",
    },
    "test",
  );
  await assert.rejects(translatePostQuote(item, 1));
  assert.equal(quoteCalls, calls, "a parent URL grant cannot authorize the quoted URL");
  const restricted = (await readCurrentSourcePolicy(id))!;
  await saveSourcePolicy(id, { policy: original, expectedVersion: restricted.permission_version, reason: "Restore synthetic scope" }, "test");
  hold = { asked: gate(), release: gate() };
  const running = translatePostQuote(item, 1);
  await Promise.race([hold.asked.promise, running.then(() => assert.fail("model was not called"))]);
  const current = (await readCurrentSourcePolicy(id))!;
  await saveSourcePolicy(
    id,
    {
      policy: { ...current, permissions: { ...current.permissions, store_fulltext: "deny" } },
      expectedVersion: current.permission_version,
      reason: "Synthetic in-flight storage withdrawal",
    },
    "test",
  );
  hold.release.open();
  hold = null;
  await assert.rejects(running);
  assert.equal(quoteCalls, calls + 1);
  assert.equal((await sql`SELECT count(*)::int AS n FROM enrichment.quote_translations WHERE input_article_id=${item}`)[0].n, 0);
});
