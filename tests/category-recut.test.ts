// The category re-cut (ADR-0031, Owner 2026-11-05): nine classes cut by article volume replace the ADR-0022 nine.
// Retired keys still work in links, feeds and the public API and are answered with the new classes; an item analysed
// under a retired key is published with its successor (or without a category for 企业与项目, which split in two) and
// leads its tags with the current category name. scripts/reclassify-categories.ts moves the stored judgements:
// a dry run writes nothing, --apply-mapped needs no model, and --apply-model re-runs only the structure step for the
// public items that need it, receipt-recorded and resumable. A category set by a person is never touched.
import { confirmedManualEdit } from "./confirmed-manual-fixture.ts";
import { ensureModelSourceFixture } from "./model-source-fixture.ts";
import { scopeOutput, scopeReceipt, scopeVersion } from "./scope-fixture.ts";
import { stub, tag } from "./setup.ts";
import { buildApp } from "./site-app.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { upsertMaterial } from "@amp/backend/content/materials";
import { closeDb, sql } from "@amp/backend/db";
import { PROMPT_VERSIONS } from "@amp/backend/editorial/analyze";
import { planCategory } from "../packages/backend/src/editorial/reclassify.ts";
import { stopBoss } from "@amp/backend/jobs/queue";
import { loadPool } from "@amp/backend/publication/pool";
import { publishArticle } from "@amp/backend/publication/publish";

const T = tag();
const SOURCE = `test-category-recut-${T}`;
const BODY = "合成的矿业稿件正文，用于检验分类重切以后，旧分类的稿件在网站上显示新分类，内容足够长。".repeat(3);

let structureCalls = 0;
const provider = await stub((_hit, req) => {
  const { messages } = JSON.parse(req.body);
  const system = String(messages[0].content),
    user = String(messages.at(-1).content);
  if (!system.includes("资料结构化助手")) throw new Error("only the structure step may be asked");
  structureCalls += 1;
  const marker = /MARK=([a-z_]+)/.exec(user)?.[1] ?? "none";
  const output = { scope: "single", category: marker === "none" ? null : marker, tags: [], subjects: [], fact: null };
  return { choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
});
for (const name of ["DASHSCOPE", "ZHIPU", "DEEPSEEK"]) {
  process.env[`${name}_BASE_URL`] = `${provider.url}/v1`;
  process.env[`${name}_API_KEY`] = "synthetic-test-key";
}
for (const model of ["qwen3.8-flash", "deepseek-flash"]) await installUsageFixtureForModel(model);
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
    VALUES (${SOURCE}, '分类重切测试', 'rss', 'T1', 'editorial', true, true, '2100-01-01')`;
  await ensureModelSourceFixture(SOURCE, ["https://example.com/source"]);
});
after(async () => {
  await app.close();
  await provider.close();
  await stopBoss();
  await closeDb();
});

let n = 0;
/** A Chinese item with a complete judgement under the given (possibly retired) category, then published. */
async function analysed(category: string | null, tags: string[], mark = "none"): Promise<string> {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.com/${SOURCE}/${n}`,
    title: `合成稿件${n} MARK=${mark} ${T}`,
    bodyText: `MARK=${mark} ${BODY}`,
    bodyHtml: `<p>MARK=${mark} ${BODY}</p>`,
    language: "zh-CN",
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, tags, title_zh, summary_zh, reason_zh, score, selected, prompt_version, receipt_ids, output)
    VALUES (${articleId}, 1, 'rule', 'pass', ${category}, ${tags}, ${`合成标题${n} ${T}`}, ${`合成导读${n}，说明一座矿山的情况。`}, '理由', 40, false,
      ${scopeVersion}, ${[await scopeReceipt(articleId)]}, ${sql.json({ ...scopeOutput, scores: [40], threshold: 62 })})`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 1000) });
  return articleId;
}
const published = async (id: string) =>
  (await sql<{ category: string | null; tags: string[] }[]>`SELECT category, tags FROM publications WHERE article_id = ${id}`)[0]!;
const judgement = async (id: string) =>
  (
    await sql<{ category: string | null; tags: string[]; output: Record<string, unknown> }[]>`
      SELECT category, tags, output FROM analyses WHERE article_id = ${id} ORDER BY id DESC LIMIT 1`
  )[0]!;
const pooled = async (category: string) => (await loadPool({ channel: "all", category, tag: null, topicTags: null } as never)).items.map((i) => i.id);
const get = async (url: string) => {
  const res = await app.inject({ method: "GET", url });
  assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
  return res;
};

test("an item analysed under a retired key is published with its successor and the current category name", async () => {
  const safety = await analysed("safety_incident", ["矿山安全", "铜", "人身与生产安全"]);
  const market = await analysed("commodity_market", ["商品与市场", "锂"]);
  const split = await analysed("company_project", ["企业与项目", "金"]);
  assert.deepEqual(await published(safety), { category: "safety_environment", tags: ["安全环境", "铜"] });
  assert.deepEqual(await published(market), { category: "commodity_market", tags: ["市场价格", "锂"] }, "a kept key shows its new name");
  assert.deepEqual(await published(split), { category: null, tags: ["金"] }, "企业与项目 has no single successor: no category until reclassified");
  assert.equal((await judgement(safety)).category, "safety_incident", "publishing does not rewrite the private judgement");
  assert.ok((await pooled("safety_environment")).includes(safety));

  const manual = await analysed("safety_incident", ["矿山安全"]);
  await confirmedManualEdit(manual, { fields: { tags: ["矿山安全", "人工标签"] }, reason: "合成：人工改标签", version: 0 }, "test");
  assert.deepEqual((await published(manual)).tags, ["矿山安全", "人工标签"], "tags set by hand stay as they are");
});

test("old category links, feeds and API filters keep working and answer with the new classes", async () => {
  const esg = await analysed("safety_environment", ["安全环境"]);
  const ops = await analysed("operations_output", ["生产经营"]);
  const project = await analysed("project_development", ["项目建设"]);
  const pool = (await get("/api/site/pool?category=esg_community_labor")).json();
  assert.equal(pool.filters.category, "safety_environment", "a retired key with one successor becomes it");
  assert.ok(pool.items.some((i: { id: string }) => i.id === esg));
  const both = (await get("/api/site/pool?category=company_project")).json();
  assert.equal(both.filters.category, "company_project", "企业与项目 filters both of its successors");
  const ids = both.items.map((i: { id: string }) => i.id);
  assert.ok(ids.includes(ops) && ids.includes(project) && !ids.includes(esg));
  assert.ok(both.items.every((i: { category: string | null }) => i.category === "operations_output" || i.category === "project_development"));
  const v1 = (await get("/api/v1/items?mode=all&category=safety_incident&limit=100")).json();
  assert.equal(v1.query.category, "safety_environment");
  assert.ok(v1.items.some((i: { id: string; category: string }) => i.id === esg && i.category === "safety_environment"));
  const v3 = (await get("/api/v3/items?category=esg_community_labor")).json();
  assert.ok(v3.items.some((i: { id: string; category: { code: string; label: string } }) => i.id === esg && i.category.code === "safety_environment"));
  assert.ok(v3.items.every((i: { category: { code: string } | null }) => i.category?.code === "safety_environment"));
  const feed = await get("/feed/category/company_project.xml");
  assert.match(feed.body, /生产经营、项目建设/);
  assert.match((await get("/feed/category/events_opinion.xml")).body, /会议观点/);
  for (const url of ["/api/site/pool?category=tip", "/api/v1/items?category=company", "/feed/category/opinion.xml"])
    assert.ok([400, 404].includes((await app.inject({ method: "GET", url })).statusCode), url);
});

test("the plan maps retired keys without a model and asks the model only for 企业与项目 and uncategorized judgements", () => {
  const base = { prompt_version: scopeVersion, complete: true, reclassified_recipe: null };
  assert.deepEqual(planCategory({ ...base, category: "capital_ma" }), { kind: "current" });
  assert.deepEqual(planCategory({ ...base, category: "supply_trade_controls" }), { kind: "mapped", to: "policy_regulation" });
  assert.deepEqual(planCategory({ ...base, category: "esg_community_labor" }), { kind: "mapped", to: "safety_environment" });
  assert.deepEqual(planCategory({ ...base, category: "company_project" }), { kind: "model" });
  assert.deepEqual(planCategory({ ...base, category: null }), { kind: "model" });
  assert.deepEqual(planCategory({ ...base, category: "ai-models" }), { kind: "none" }, "an unknown key is not guessed");
  assert.deepEqual(planCategory({ ...base, category: null, complete: false }), { kind: "none" }, "an unfinished judgement waits for analysis");
  assert.deepEqual(planCategory({ ...base, category: null, reclassified_recipe: PROMPT_VERSIONS.structure }), { kind: "none" }, "asked once per recipe");
  assert.deepEqual(planCategory({ ...base, category: null, prompt_version: `x+${PROMPT_VERSIONS.structure}` }), { kind: "none" }, "already new");
});

test("the script reports, maps without a model, then reclassifies only what needs the model, resumably", async () => {
  const mapped = await analysed("esg_community_labor", ["ESG、社区与劳工", "铜"]);
  const stale = await analysed("technology_processing", ["技术与冶炼", "锂"]);
  const split = await analysed("company_project", ["企业与项目", "金"], "operations_output");
  const untagged = await analysed(null, [], "events_opinion");
  const byHand = await analysed("company_project", ["企业与项目"], "project_development");
  await confirmedManualEdit(byHand, { fields: { category: "capital_ma" }, reason: "合成：人工定分类", version: 0 }, "test");
  // Published before the change: the publication still shows the retired key and names.
  await sql`UPDATE publications SET category='esg_community_labor', tags=${["ESG、社区与劳工", "铜"]} WHERE article_id=${mapped}`;
  await sql`UPDATE publications SET tags=${["技术与冶炼", "锂"]} WHERE article_id=${stale}`;
  const receipts = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipts`)[0]!.n;
  const before = await receipts();
  const script = fileURLToPath(new URL("../scripts/reclassify-categories.ts", import.meta.url));
  // Asynchronous: the child process asks the provider stub served by this process.
  const run = async (...args: string[]) => (await promisify(execFile)(process.execPath, [script, ...args], { env: process.env, encoding: "utf8" })).stdout;

  const dry = await run();
  // The first test's items are still here: two safety_incident judgements and one 企业与项目 without a marker.
  assert.match(dry, /esg_community_labor → safety_environment: 1/);
  assert.match(dry, /safety_incident → safety_environment: 2/);
  assert.match(dry, /need the model: 3 \(public: 3\)/);
  assert.match(dry, /company_project: 2 \(public: 2\)/);
  assert.match(dry, /uncategorized: 1 \(public: 1\)/);
  assert.match(dry, /estimated model calls: 3 structure requests/);
  assert.match(dry, /category set by a person \(left as it is\): 1/);
  assert.equal(await run("--dry-run"), dry, "the default is the dry run");
  assert.equal((await judgement(mapped)).category, "esg_community_labor", "a dry run writes nothing");
  assert.deepEqual((await published(mapped)).tags, ["ESG、社区与劳工", "铜"]);
  await assert.rejects(run("--apply-model"), "the model run needs an explicit limit");
  await assert.rejects(run("--apply-mapped", "--apply-model"), "one mode at a time");
  await assert.rejects(run("--bogus"), "an unknown argument stops the script");

  const applied = await run("--apply-mapped");
  assert.match(applied, /mapped 3 judgements; republished \d+ items; no model call/);
  const moved = await judgement(mapped);
  assert.deepEqual([moved.category, moved.tags], ["safety_environment", ["安全环境", "铜"]]);
  assert.deepEqual(moved.output.categoryReclassification && { ...(moved.output.categoryReclassification as object), at: null }, {
    from: "esg_community_labor",
    to: "safety_environment",
    method: "mapped",
    at: null,
  });
  assert.deepEqual(await published(mapped), { category: "safety_environment", tags: ["安全环境", "铜"] });
  assert.deepEqual(await published(stale), { category: "technology_processing", tags: ["技术装备", "锂"] }, "stale names are republished");
  assert.equal((await judgement(split)).category, "company_project", "no model in the mapped run");
  assert.equal(await receipts(), before);
  assert.equal(structureCalls, 0);

  const first = await run("--apply-model", "--limit", "1");
  assert.match(first, /model: 1 new requests, 0 reused receipts; 1 updated/);
  assert.match(first, /2 left/);
  assert.equal(structureCalls, 1);
  const rest = await run("--apply-model", "--limit", "10");
  assert.match(rest, /model: 2 new requests, 0 reused receipts; 2 updated \(1 still without a category\)/);
  assert.equal(structureCalls, 3);
  assert.deepEqual(await published(split), { category: "operations_output", tags: ["生产经营", "金"] });
  assert.deepEqual(await published(untagged), { category: "events_opinion", tags: ["会议观点"] });
  const note = (await judgement(untagged)).output.categoryReclassification as { method: string; recipe: string; receiptId: number };
  assert.deepEqual([note.method, note.recipe], ["model", PROMPT_VERSIONS.structure]);
  const [receipt] = await sql<{ purpose: string; status: string; prompt_version: string | null }[]>`
    SELECT purpose, status, request->>'promptVersion' AS prompt_version FROM receipts WHERE id=${note.receiptId}`;
  assert.deepEqual([receipt!.purpose, receipt!.status], ["structure_article", "completed"]);

  const again = await run("--apply-model", "--limit", "10");
  assert.match(again, /need the model: 0/);
  assert.match(again, /model: 0 new requests/);
  assert.equal(structureCalls, 3, "nothing is asked twice");
  assert.equal((await judgement(byHand)).category, "company_project", "a category set by a person is never touched");
  assert.equal((await published(byHand)).category, "capital_ma");
});
