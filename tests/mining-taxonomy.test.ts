import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { CATEGORY_KEYS } from "@amp/contracts/taxonomy";
import { MCP_TOOL_NAMES } from "@amp/contracts/mcp";
import { CATEGORY_LABELS } from "@amp/industry/taxonomy";
import { closeDb, dbOf } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { analyzeArticle, PROMPT_VERSIONS } from "@amp/backend/editorial/analyze";
import { configuredPromptVersion, promptVersion } from "@amp/backend/editorial/prompts";
import { UNDERSTAND_CONFIG } from "@amp/backend/editorial/writing";
import { normalizeTags } from "../packages/backend/src/editorial/vocabulary.ts";
import { publishArticle } from "@amp/backend/publication/publish";
import { overrideFields } from "@amp/backend/admin/content";
import { stopBoss } from "@amp/backend/jobs/queue";
import { buildApp } from "../apps/api/src/app.ts";

const sql = dbOf("enrichment"),
  source = `mining-category-${tag()}`;
const app = await buildApp("public-api");
const provider = await stub((_hit, req) => {
  const { messages } = JSON.parse(req.body);
  const system = String(messages[0].content),
    user = String(messages.at(-1).content);
  const category = /CATEGORY=([a-z_-]+)/.exec(user)?.[1] ?? "invalid";
  const output = system.includes("范围预筛")
    ? { label: "PASS", reason: "合成矿业范围" }
    : system.includes("事件注意力评分器")
      ? { attentionScore: 80 }
      : system.includes("资料结构化助手")
        ? { category: category === "null" ? null : category, tags: [], subjects: [], fact: null }
        : {
            itemType: "model_release",
            authorRole: "principal",
            tags: ["法规政策"],
            editorialJudgment: "原文说明了铜矿扩建工程的建设进度。",
            titleZh: `铜矿扩建 ${category}`,
            summaryZh: "合成矿业材料：项目公布扩建工程进度与设计产能，说明了施工范围。",
          };
  return { choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
});
for (const name of ["DASHSCOPE", "ZHIPU", "DEEPSEEK"]) {
  process.env[`${name}_BASE_URL`] = `${provider.url}/v1`;
  process.env[`${name}_API_KEY`] = "synthetic-test-key";
}
after(async () => {
  await app.close();
  await provider.close();
  await stopBoss();
  await closeDb();
});
const get = async (url: string) => {
  const res = await app.inject({ method: "GET", url });
  assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
  return res;
};

test("actual classification, publication and public exits agree on nine keys and nullable unknowns", async () => {
  assert.equal(PROMPT_VERSIONS.prefilter, "prefilter@e86693e15b");
  assert.equal(PROMPT_VERSIONS.score, "selection-score@e55fa3b5de");
  assert.equal(PROMPT_VERSIONS.understand, configuredPromptVersion("understand", UNDERSTAND_CONFIG));
  assert.notEqual(PROMPT_VERSIONS.structure, promptVersion("structure"));
  assert.deepEqual(normalizeTags([]), []);
  assert.deepEqual(normalizeTags(["模型发布", "其他", "invalid"]), []);
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,site_fulltext,syndicate_fulltext,next_fetch_at)
    VALUES (${source},'Synthetic mining','rss','T1','editorial',true,true,'2100-01-01')`;
  const cursors = new Map<string, string>();
  for (const fields of ["default", "minimal"]) cursors.set(fields, (await get(`/api/v1/selected/snapshot?fields=${fields}`)).json().cursor);
  const ids = new Map<string, string>();
  for (const value of [...CATEGORY_KEYS, "ai-models", "invalid", "null"]) {
    const category = CATEGORY_KEYS.find((key) => key === value) ?? null;
    const { articleId: id } = await upsertMaterial({
      sourceId: source,
      url: `https://example.com/${source}/${value}`,
      title: `铜矿扩建 CATEGORY=${value}`,
      bodyText: `CATEGORY=${value} 铜矿扩建工程公布建设进展、设计产能与施工范围。`.repeat(10),
      bodyStatus: "ok",
      language: "zh",
      via: "fetch",
      publishedAt: new Date(),
    });
    ids.set(value, id);
    const analysed = await analyzeArticle(id);
    assert.equal(analysed!.output!.category, category);
    assert.deepEqual(analysed!.output!.tags, category ? [CATEGORY_LABELS[category]] : [], "writing tags cannot overwrite structure");
    await publishArticle(id, { releasedAt: new Date(Date.now() - 1000) });
    assert.equal((await get(`/api/site/items/${id}`)).json().category, category);
    assert.equal((await get("/api/v1/items?mode=all&limit=100")).json().items.find((item: { id: string }) => item.id === id).category, category);
    if (category) {
      assert.ok((await get(`/api/site/pool?category=${category}`)).body.includes(id));
      const feed = await get(`/feed/category/${category}.xml`);
      assert.ok(feed.body.includes(id) && feed.body.includes(CATEGORY_LABELS[category]));
      const res = await app.inject({
        method: "POST",
        url: "/api/mcp",
        headers: { accept: "application/json, text/event-stream" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: MCP_TOOL_NAMES.latest, arguments: { category, mode: "all" } } },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes(id) && res.body.includes(category));
    }
  }
  // The raw legacy analysis/ledger are immutable historical evidence; normalize only the exit.
  const id = ids.get("ai-models")!;
  await sql`UPDATE publications SET category='ai-models' WHERE article_id=${id}`;
  await sql`UPDATE selected_ledger SET payload=jsonb_set(payload,'{category}','"ai-models"'::jsonb) WHERE article_id=${id} AND op='upsert'`;
  for (const fields of ["default", "minimal"]) {
    const snapshot = (await get(`/api/v1/selected/snapshot?fields=${fields}&limit=1000`)).json();
    assert.equal(snapshot.items.find((item: { id: string }) => item.id === id).category, null);
    const changes = (await get(`/api/v1/selected/changes?cursor=${cursors.get(fields)}&limit=100`)).json();
    assert.equal(changes.changes.find((entry: { item?: { id: string } }) => entry.item?.id === id).item.category, null);
  }
  assert.equal((await get(`/api/site/items/${id}`)).json().category, null);
  assert.equal((await sql`SELECT payload->>'category' AS category FROM selected_ledger WHERE article_id=${id} AND op='upsert'`)[0].category, "ai-models");
  const chosen = ids.get(CATEGORY_KEYS[0])!;
  await overrideFields(chosen, { fields: { category: null }, reason: "证据不足", version: 0 }, "synthetic");
  assert.equal((await get(`/api/site/items/${chosen}`)).json().category, null);
  await assert.rejects(overrideFields(chosen, { fields: { category: "tip" }, reason: "旧键", version: 1 }, "synthetic"));
  for (const url of ["/api/site/pool?category=tip", "/api/v1/items?category=tip", "/feed/category/tip.xml"])
    assert.ok([400, 404].includes((await app.inject({ method: "GET", url })).statusCode));
});
