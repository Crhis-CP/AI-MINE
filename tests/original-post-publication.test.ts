import { config } from "@amp/backend/config";
import { tag, stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { upsertMaterial, type XPostData } from "@amp/backend/content/materials";
import { analysisVersionOf, loadAnalyzeInput, tierThreshold } from "@amp/backend/editorial/analyze";
import { publishArticle, prepareTranslation } from "@amp/backend/publication/publish";
import { loadItemDetail, siteItemDetail, machineItemDetail, publicItemMetadata } from "@amp/backend/publication/detail";
import { validateGeography } from "../packages/backend/src/editorial/geography.ts";
import { loadTimeline } from "@amp/backend/publication/timeline";
import { readCurrentSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";
import { overrideFields, setVisibility } from "@amp/backend/admin/content";
import { translateArticle, translatePending } from "@amp/backend/editorial/translate";
import { stopBoss, QUEUES } from "@amp/backend/jobs/queue";
import { buildApp } from "./site-app.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
import { confirmGroupingFixture } from "./grouping-fixture.ts";
import { scopeOutput, scopeReceipt } from "./scope-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";

const stamp = tag(),
  host = `https://post-${stamp}.invalid`;
let serial = 0;
const app = await buildApp();
const provider = await stub(() => ({
  choices: [{ message: { content: JSON.stringify({ t: ["引用译文：矿业项目按原文计划建设。"] }) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
}));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "synthetic-post-publication";
process.env.TRANSLATE_MODEL = "deepseek-flash";
before(() => {
  config.originalPostAdmissionEnabled = true;
  return installUsageFixtureForModel("deepseek-flash");
});
after(async () => {
  config.originalPostAdmissionEnabled = false;
  await app.close();
  await provider.close();
  await stopBoss();
  await closeDb();
});

async function source() {
  const id = `post-public-${stamp}-${++serial}`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext,syndicate_fulltext)
    VALUES(${id},'合成原帖来源','rss','T1','editorial',true,true)`;
  await grantDateFixture(id, [host]);
  return id;
}
async function article(sourceId: string, text: string, quoted?: XPostData["quoted"], ordinary = false) {
  const name = `post-${++serial}`;
  const post: XPostData = {
    tweetId: name,
    authorName: "合成作者",
    handle: "author",
    text,
    quoted,
    avatarUrl: `${host}/private-avatar.jpg`,
    media: [{ kind: "image", url: `${host}/source-image.jpg` }],
  };
  const { articleId } = await upsertMaterial({
    sourceId,
    url: `${host}/${name}`,
    title: ordinary ? "普通矿业标题" : text || `${host}/${name}`,
    language: "zh",
    publishedAt: new Date(Date.now() - 60_000),
    via: "fetch",
    ...(ordinary ? { bodyText: text, bodyHtml: `<p>${text}</p>`, bodyStatus: "ok" as const } : { xPost: post }),
  });
  const input = (await loadAnalyzeInput(articleId))!;
  const receipt = await scopeReceipt(articleId);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected,prompt_version,receipt_ids,output)
    VALUES(${articleId},${input.revision},'model','pass',${ordinary ? "普通矿业标题" : text || input.url},${ordinary ? "普通矿业导读保持不变。" : text},80,true,
      ${analysisVersionOf(input)},${[receipt]},${sql.json({ ...scopeOutput, writer: ordinary ? "summarize" : "verbatim", scores: [80, 80], threshold: tierThreshold("T1") })})`;
  await confirmGroupingFixture(articleId);
  await publishArticle(articleId);
  return articleId;
}
const found = async (id: string) => {
  const result = await loadItemDetail(id);
  assert.equal(result.kind, "found");
  if (result.kind !== "found") throw new Error("missing synthetic publication");
  return result;
};
const response = async (path: string) => {
  const result = await app.inject(path);
  assert.equal(result.statusCode, 200, `${path}: ${result.body.slice(0, 200)}`);
  return result;
};

test("ordinary output remains unchanged while explicit empty, link and short posts use safe metadata and no image proxy", async () => {
  const id = await source();
  const ordinary = await article(id, "普通矿业原文及生产计划。", undefined, true);
  assert.equal((await found(ordinary)).detail.summary, "普通矿业导读保持不变。");
  assert.ok(!("x" in (await found(ordinary)).detail));
  const ordinaryOriginal = (await machineItemDetail(ordinary, "original"))!.item.body!;
  assert.match(ordinaryOriginal.zh!, /普通矿业原文/);
  assert.equal(ordinaryOriginal.original, null, "ordinary Chinese articles retain their existing single-language response");
  for (const text of ["", `${host}/linked-article`, "铜矿今日投产。"]) {
    const item = await article(id, text);
    const detail = (await found(item)).detail;
    assert.equal(detail.selected, true);
    assert.equal(detail.originalTitle, null);
    assert.equal(detail.title, "合成作者的原帖");
    assert.equal(detail.summary, null);
    assert.deepEqual(detail.x?.media, []);
    assert.equal(detail.x?.avatarUrl, null);
    assert.ok(!JSON.stringify(detail.x).includes("source-image"));
    assert.ok(!detail.body?.zh?.includes("<img"));
    const card = (await loadTimeline({ channel: "all", category: null, tag: null, now: new Date() })).cards.find((c) => c.item.id === item);
    assert.ok(card?.item.x);
    assert.equal(card.item.summary, null);
  }
});

test("current full-text permission fences post and quote copies across site, RSS, machine and search outputs", async () => {
  const id = await source(),
    text = "当前许可保护的合成原帖全文。",
    quote = "Confidential fixture quotation about a copper project.";
  const item = await article(id, text, { authorName: "Quote", handle: "quote", text: quote, url: `${host}/quote` });
  assert.match((await found(item)).detail.body!.zh!, /合成原帖全文/);
  assert.equal((await found(item)).detail.x?.quoted?.text, quote);
  // A previously permitted historical quote remains stored when its source scope is later withdrawn.
  const prior = (await readCurrentSourcePolicy(id))!;
  const expandedScope = { ...prior.scope, hosts: [...prior.scope.hosts, "unlicensed-quote.invalid"] };
  await saveSourcePolicy(
    id,
    {
      policy: { ...prior, scope: expandedScope, evidence: prior.evidence.map((e) => ({ ...e, scope: expandedScope })) },
      expectedVersion: prior.permission_version,
      reason: "Synthetic historical quote grant",
    },
    "test",
  );
  const outside = await article(id, "主帖仍属于获准来源。", {
    authorName: "Third party",
    handle: "third",
    text: quote,
    url: "https://unlicensed-quote.invalid/post",
  });
  const expanded = (await readCurrentSourcePolicy(id))!;
  await saveSourcePolicy(id, { policy: prior, expectedVersion: expanded.permission_version, reason: "Withdraw synthetic quote scope" }, "test");
  assert.equal((await found(outside)).detail.x?.quoted, null, "the parent source does not grant rights to a third-party URL");
  assert.equal(await prepareTranslation(outside), null);
  const policy = (await readCurrentSourcePolicy(id))!;
  policy.permissions.public_original_fulltext = "deny";
  policy.permissions.public_translation = "deny";
  await saveSourcePolicy(id, { policy, expectedVersion: policy.permission_version, reason: "Synthetic immediate restriction" }, "test");
  // Do not republish: a current permission change must fence the old projection immediately.
  const detail = (await found(item)).detail;
  assert.equal(detail.body, null);
  assert.equal(detail.x, null);
  for (const path of [`/api/site/items/${item}`, "/feed/full.xml", "/api/v1/items?mode=selected&limit=100", "/api/v1/agent/latest?limit=30"]) {
    const body = (await response(path)).body;
    assert.ok(!body.includes(text), path);
    assert.ok(!body.includes(quote), path);
  }
  const machine = await machineItemDetail(item);
  assert.equal(machine?.item.body, null);
  assert.equal(machine?.item.x, null);
  assert.ok(!(await response(`/api/site/pool?q=${encodeURIComponent("当前许可保护")}`)).body.includes(item));
});

test("quote-only preparation uses the original translation path and same-source reuse without marking a body complete", async () => {
  const id = await source(),
    quote = { authorName: "Quote", handle: "quote", text: "Copper production is scheduled after the construction milestone.", url: `${host}/shared-quote` };
  const first = await article(id, "铜矿进展。", quote),
    hits = provider.hits();
  assert.equal(await prepareTranslation(first), 1);
  assert.equal((await translateArticle(first, 1)).reason, "quoted_post");
  await publishArticle(first);
  assert.equal(provider.hits(), hits + 1);
  const second = await article(id, "另一个铜矿进展。", quote);
  assert.equal(await prepareTranslation(second), null);
  assert.equal(provider.hits(), hits + 1);
  assert.equal((await sql`SELECT count(*)::int AS n FROM translations WHERE article_id=ANY(${[first, second]}::text[])`)[0].n, 0);
  const detail = (await found(second)).detail;
  assert.match(detail.x!.quoted!.translation!, /引用译文/);
  const original = siteItemDetail(detail, true);
  assert.equal(original.hasTranslation, true);
  assert.equal(original.bodyLanguage, "original");
  assert.match(original.body!.original!, /另一个铜矿进展/);
  assert.match(original.x!.quoted!.translation!, /引用译文/, "the original view still offers the Chinese quote");
  assert.match((await machineItemDetail(second))!.item.body!.zh!, /引用译文/);
  assert.match((await response("/feed/full.xml")).body, /引用译文/);
  await sql`UPDATE publications SET x_post=jsonb_set(x_post,'{quoteRecipe}','"retired-quote-recipe"'::jsonb) WHERE article_id=${second}`;
  assert.equal((await found(second)).detail.x?.quoted?.translation, null, "an old projection recipe never authorizes the cached translation");
  await publishArticle(second);
  assert.match((await found(second)).detail.x!.quoted!.translation!, /引用译文/);
  assert.equal(provider.hits(), hits + 1, "projection repair reuses the accepted quote without another model call");
});

test("denied new model work suppresses uncached quote scheduling but preserves permitted cached translations", async () => {
  const denyNewCalls = async (id: string) => {
    const policy = (await readCurrentSourcePolicy(id))!;
    policy.permissions.external_model = "deny";
    await saveSourcePolicy(id, { policy, expectedVersion: policy.permission_version, reason: "Synthetic new-call restriction" }, "test");
  };
  const marker = async (id: string) => (await sql`SELECT x_post->>'quoteRecipe' AS recipe FROM publications WHERE article_id=${id}`)[0].recipe;
  const queued = async (id: string) =>
    (await sql`SELECT id FROM pgboss.job WHERE name=${QUEUES.translate} AND data->>'articleId'=${id} ORDER BY id`).map((row) => row.id);
  const withoutCache = await source();
  await denyNewCalls(withoutCache);
  const blocked = await article(withoutCache, "主帖无需翻译。", {
    authorName: "Uncached quote",
    handle: "uncached",
    text: `Uncached mining quotation ${stamp} requires a new translation.`,
    url: `${host}/uncached-quote`,
  });
  const hitsBefore = provider.hits();
  assert.equal(await marker(blocked), null);
  assert.equal(await prepareTranslation(blocked), null);
  await translatePending({ limit: 100 });
  await translatePending({ limit: 100 });
  assert.deepEqual(await queued(blocked), [], "an absent cache and denied new calls cannot repeatedly enqueue quote work");
  assert.equal(provider.hits(), hitsBefore);

  const withCache = await source();
  const cached = await article(withCache, "另一个中文主帖。", {
    authorName: "Cached quote",
    handle: "cached",
    text: `Cached mining quotation ${stamp} has already been translated.`,
    url: `${host}/cached-quote`,
  });
  assert.equal((await translateArticle(cached, 1)).status, "translated");
  await publishArticle(cached);
  const cachedMarker = await marker(cached),
    calls = provider.hits(),
    jobs = await queued(cached);
  assert.equal(typeof cachedMarker, "string");
  const cacheBefore = await sql`SELECT * FROM enrichment.quote_translations WHERE source_id=${withCache}`;
  assert.equal(cacheBefore.length, 1);
  await denyNewCalls(withCache);
  await publishArticle(cached);
  assert.equal(await marker(cached), cachedMarker, "a private new-call restriction does not erase an already accepted public translation");
  assert.equal((await found(cached)).detail.x?.quoted?.translation, cacheBefore[0].text_zh);
  assert.equal(await prepareTranslation(cached), null);
  await translatePending({ limit: 100 });
  await translatePending({ limit: 100 });
  assert.deepEqual(await queued(cached), jobs);
  assert.deepEqual(await sql`SELECT * FROM enrichment.quote_translations WHERE source_id=${withCache}`, cacheBefore);
  assert.equal(provider.hits(), calls, "cache publication never purchases another translation");
});

test("manual body and withdrawal remain authoritative after post republication", async () => {
  const id = await source(),
    text = "铜矿建设的原帖证据以及实施日期。";
  const item = await article(id, text);
  await overrideFields(
    item,
    {
      fields: { body: "<p>人工核对后的正文。</p>" },
      command: "publish",
      reason: "Synthetic correction",
      version: 0,
      source_revision: 1,
      source_checked: true,
      facts_checked: true,
      evidence_quote: text,
    },
    "test",
  );
  await publishArticle(item);
  assert.match((await found(item)).detail.body!.zh!, /人工核对后的正文/);
  const [override] = await sql`SELECT version FROM editorial_overrides WHERE article_id=${item}`;
  await setVisibility(item, { visibility: "withdrawn", version: override.version, reason: "Synthetic withdrawal" }, "test");
  await publishArticle(item);
  assert.deepEqual(await loadItemDetail(item), { kind: "not_found" });
});

test("publication rechecks post geography against the same acquired long article as the model input", async () => {
  const id = await source(),
    item = await article(id, "矿业项目资料更新。"),
    quote = "The copper mine in Argentina started construction.";
  await sql`UPDATE articles SET x_article=${sql.json({ title: "矿业长文", text: quote })},revision=revision+1 WHERE id=${item}`;
  const input = (await loadAnalyzeInput(item))!;
  const geography = validateGeography(
    {
      status: "identified",
      primary: "AR",
      assignments: [{ code: "AR", role: "event_location", mention: "Argentina", segment: "body_head", quote }],
      reason: "Synthetic long article states the project location",
    },
    input,
  );
  assert.deepEqual(geography.codes, ["AR"]);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected,prompt_version,receipt_ids,output)
    SELECT article_id,${input.revision},origin,relevance,title_zh,summary_zh,score,selected,${analysisVersionOf(input)},receipt_ids,
      output || ${sql.json({ geography })}::jsonb FROM analyses WHERE article_id=${item} ORDER BY id DESC LIMIT 1`;
  await confirmGroupingFixture(item);
  await publishArticle(item);
  assert.deepEqual((await publicItemMetadata(item))?.jurisdictions, ["AR"]);
});
