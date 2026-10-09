import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { dbOf, closeDb } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { upsertMaterial } from "@amp/backend/content/materials";
import { analyzeArticle, ANALYZE_PROMPT_VERSION } from "@amp/backend/editorial/analyze";
import { publishArticle } from "@amp/backend/publication/publish";
import { overrideFields, setVisibility } from "@amp/backend/admin/content";
import { stopBoss } from "@amp/backend/jobs/queue";
import { prepareGeographyBackfill } from "@amp/backend/jobs/content";
import { loadPool } from "@amp/backend/publication/pool";
import { loadTimeline } from "@amp/backend/publication/timeline";
import { currentNewsJurisdictionCounts } from "../packages/backend/src/publication/news-geography.ts";
import { validateGeography, geographyMaterial, geographyRecipe } from "../packages/backend/src/editorial/geography.ts";
import { buildApp } from "../apps/api/src/app.ts";
import { publicRoleFixture } from "./public-role-fixture.ts";

const sql = dbOf("enrichment"),
  app = await buildApp("public-api"),
  requests: { system: string; user: string }[] = [];
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body),
    system = body.messages[0]?.role === "system" ? body.messages[0].content : "",
    user = body.messages.at(-1).content;
  requests.push({ system, user });
  let output: unknown;
  if (system.includes("资料结构化助手")) {
    const input = JSON.parse(user),
      segment = input.segments.find((s: { id: string }) => s.id === "body_head");
    output = {
      category: "mineral-development",
      tags: [],
      subjects: [],
      fact: null,
      geography: {
        status: "identified",
        primary: "AR",
        assignments: [{ code: "AR", role: "event_location", mention: "阿根廷", segment: "body_head", quote: segment.text }],
        reason: "原文明确矿区所在地",
      },
    };
  } else if (system.includes("宽召回")) output = { label: "PASS", reason: "合成矿业消息" };
  else output = "title_zh: 合成矿山项目动态\nsummary_zh: 这是合成测试矿山项目的完整中文导读，仅用于本地验证。\nbody_zh: ";
  return {
    choices: [{ message: { content: typeof output === "string" ? output : JSON.stringify(output) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  };
});
Object.assign(process.env, {
  LLM_BASE_URL: `${provider.url}/v1`,
  LLM_API_KEY: "synthetic-only",
  LLM_MODEL: "unchanged-synthetic-model",
  PREFILTER_MODEL: "default",
  STRUCTURE_MODEL: "default",
  SUMMARIZE_MODEL: "default",
});
config.modelCallsEnabled = true;
after(async () => {
  await app.close();
  await provider.close();
  await stopBoss();
  await closeDb();
});
const material = (body: string) => ({ title: "合成矿业消息", bodyText: body, excerpt: null, bodyStatus: "ok" });
const assignment = (code: string, mention: string, quote: string, role = "event_location") => ({ code, mention, quote, role, segment: "body_head" });
const candidate = (assignments: unknown[], status = "identified") => ({ status, primary: null, assignments, reason: "合成原文作用关系" });
async function fixture(body: string, geo: unknown = undefined) {
  const id = tag(),
    sourceId = `geo-${id}`,
    url = `https://source.invalid/${id}`;
  await sql`INSERT INTO sources(id,name,kind,lane,tier,enabled,participation_mode,site_fulltext) VALUES(${sourceId},${sourceId},'external','news','EXCLUDE_MP',false,'editorial',true)`;
  const input = {
    sourceId,
    url,
    title: `合成矿业消息 ${id}`,
    language: "zh",
    bodyText: body,
    bodyHtml: `<p>${body}</p>`,
    bodyStatus: "ok" as const,
    via: "ingest" as const,
  };
  const result = await upsertMaterial(input),
    articleId = result.articleId;
  if (geo !== undefined) {
    const checked = validateGeography(geo, { ...material(body), title: input.title });
    await sql`INSERT INTO analyses(article_id,input_revision,origin,model,prompt_version,relevance,title_zh,summary_zh,selected,output)
      VALUES(${articleId},1,'model','synthetic-only',${ANALYZE_PROMPT_VERSION},'pass',${input.title},'合成测试导读，说明矿业项目与经营活动，仅供本地工程验证。',false,${sql.json({ scores: null, geography: checked })})`;
  }
  await publishArticle(articleId);
  return { articleId, input };
}
test("geography keeps exact evidence and roles, rejects currency/substrings/HQ shortcuts, and distinguishes unknown from none", () => {
  const body = "公司总部在加拿大，矿山项目位于阿根廷，规则适用于云南省。融资为 US$ 10 million，与 Indian lands 无关。";
  const result = validateGeography(
    candidate([
      assignment("CA", "加拿大", "公司总部在加拿大", "headquarters"),
      assignment("AR", "阿根廷", "矿山项目位于阿根廷"),
      assignment("CN-YN", "云南省", "规则适用于云南省", "rule_scope"),
    ]),
    material(body),
  );
  assert.equal(result.state, "identified");
  assert.deepEqual(result.codes, ["AR", "CN-YN"]);
  assert.equal(result.primary, null);
  for (const value of [
    assignment("US", "US", "融资为 US$ 10 million"),
    assignment("US", "us", "a mine for us"),
    assignment("IN", "Indian", "Indian lands"),
    assignment("MN", "蒙古", "内蒙古矿区"),
    assignment("AR", "加拿大", "公司总部在加拿大"),
    assignment("AR", "阿根廷", "不在输入中的阿根廷"),
  ]) {
    assert.equal(validateGeography(candidate([value]), material(`${body} a mine for us 内蒙古矿区`)).state, "unknown");
  }
  assert.equal(validateGeography(undefined, material(body)).state, "unknown");
  assert.equal(validateGeography(candidate([], "none"), material("全球金属市场综述，未限定具体地区。".repeat(3))).state, "none");
  const long = material("无地名的合成原文。".repeat(3000));
  assert.equal(geographyMaterial(long).complete, false);
  assert.equal(validateGeography(candidate([], "none"), long).state, "unknown");
});
test("the same AI02 call supplies geography and existing receipt reuse does not buy another geography call", async () => {
  const body = "合成铜矿项目位于阿根廷，正在建设一条新的选矿生产线，并按公告推进施工。",
    f = await fixture(body),
    before = requests.length;
  const result = await analyzeArticle(f.articleId);
  assert.equal(result?.output?.geography?.state, "identified");
  assert.deepEqual(result?.output?.geography?.codes, ["AR"]);
  assert.equal(requests.slice(before).filter((r) => r.system.includes("资料结构化助手")).length, 1);
  assert.equal(requests.length - before, 3);
  const count = requests.length;
  await analyzeArticle(f.articleId);
  assert.equal(requests.length, count);
  await publishArticle(f.articleId);
  const pool = await loadPool({ channel: "all", category: null, tag: null, jurisdiction: "AR", now: new Date() });
  assert.ok(pool.items.some((i) => i.id === f.articleId));
});
test("current public counts include child jurisdictions once, never HQ context, hidden releases, withdrawals or old source revisions", async () => {
  const before = await currentNewsJurisdictionCounts(),
    body = "云南省矿山项目适用中国新的规定。",
    f = await fixture(body, candidate([assignment("CN-YN", "云南省", body), assignment("CN", "中国", body, "rule_scope")]));
  let counts = await currentNewsJurisdictionCounts();
  assert.equal(counts.counts.CN, before.counts.CN! + 1);
  assert.equal(counts.counts["CN-YN"], before.counts["CN-YN"]! + 1);
  const filters = { channel: "all" as const, category: null, tag: null, jurisdiction: "CN", now: new Date() };
  assert.ok((await loadPool(filters)).items.some((i) => i.id === f.articleId));
  const response = await app.inject({ method: "GET", url: "/api/site/pool?jurisdiction=CN" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().filters.jurisdiction, "CN");
  assert.equal((await app.inject({ method: "GET", url: "/api/site/pool?jurisdiction=not-country" })).statusCode, 400);
  await sql`UPDATE publications SET selected=true,visible_after=now()+interval '1 day' WHERE article_id=${f.articleId}`;
  assert.equal((await currentNewsJurisdictionCounts()).counts.CN, before.counts.CN);
  await sql`UPDATE publications SET selected=false WHERE article_id=${f.articleId}`;
  await setVisibility(f.articleId, { version: 0, visibility: "withdrawn", reason: "synthetic withdrawal" }, "test");
  assert.equal((await currentNewsJurisdictionCounts()).counts.CN, before.counts.CN);
  await setVisibility(f.articleId, { version: 1, visibility: "public", reason: "synthetic restore" }, "test");
  await upsertMaterial({ ...f.input, bodyText: `${body} 本文修订。`, bodyHtml: `<p>${body} 本文修订。</p>` });
  counts = await currentNewsJurisdictionCounts();
  assert.equal(counts.counts.CN, before.counts.CN);
  assert.ok(counts.unknown > before.unknown);
  assert.ok(!(await loadPool({ ...filters, now: new Date() })).items.some((i) => i.id === f.articleId));
});
test("unknown, explicit none, old cache coverage, low-priority dry-run and manual evidence remain separate", async () => {
  const none = await fixture("全球金属市场供求综述，不限定具体国家。".repeat(2), candidate([], "none")),
    unknown = await fixture("合成矿业项目正在施工，材料未说明具体地点。".repeat(2));
  const query = { channel: "all" as const, category: null, tag: null, now: new Date() };
  assert.ok((await loadPool({ ...query, jurisdiction: "none" })).items.some((i) => i.id === none.articleId));
  assert.ok(!(await loadPool({ ...query, jurisdiction: "unknown" })).items.some((i) => i.id === none.articleId));
  assert.ok((await loadPool({ ...query, jurisdiction: "unknown" })).items.some((i) => i.id === unknown.articleId));
  await sql`UPDATE articles SET processing_state='analyzed',processing_queued_at=NULL WHERE id=${unknown.articleId}`;
  const oldRequests = requests.length,
    backfill = await prepareGeographyBackfill();
  assert.equal(backfill.enqueued, 0);
  assert.ok(backfill.candidates.some((i) => i.id === unknown.articleId));
  assert.equal(requests.length, oldRequests);
  const body = "加拿大公司总部发布消息，阿根廷矿区发生生产变化。",
    f = await fixture(body, candidate([assignment("CA", "加拿大", body, "headquarters")], "none"));
  await overrideFields(
    f.articleId,
    { version: 0, reason: "synthetic geography correction", fields: { geography: { revision: 1, value: candidate([assignment("AR", "阿根廷", body)]) } } },
    "test",
  );
  assert.ok((await loadPool({ ...query, jurisdiction: "AR" })).items.some((i) => i.id === f.articleId));
  assert.ok(!(await loadPool({ ...query, jurisdiction: "CA" })).items.some((i) => i.id === f.articleId));
  const [row] = await sql`SELECT recipe,state FROM publication.news_geography WHERE article_id=${f.articleId}`;
  assert.equal(row.recipe, geographyRecipe());
  assert.equal(row.state, "identified");
});
test("selected timeline country scope binds cursors and never leaks representatives from another country", async () => {
  const body = "合成矿山位于智利。".repeat(3),
    a = await fixture(body, candidate([assignment("CL", "智利", body)])),
    b = await fixture(body, candidate([assignment("CL", "智利", body)]));
  await sql`UPDATE publications SET selected=true,visible_after=now()-interval '1 minute' WHERE article_id IN (${a.articleId},${b.articleId})`;
  const page = await loadTimeline({ channel: "all", category: null, tag: null, jurisdiction: "CL", limit: 1, now: new Date() });
  assert.equal(page.cards.length, 1);
  assert.ok(page.nextCursor);
  await assert.rejects(
    () => loadTimeline({ channel: "all", category: null, tag: null, jurisdiction: "AR", cursor: page.nextCursor, now: new Date() }),
    /cursor/,
  );
});

test("the cross-lane count port executes using only the actual public_read identity", async (t) => {
  const f = await publicRoleFixture(t),
    code = `import {initializeDb,closeDb} from '@amp/backend/db';
    import {currentNewsJurisdictionCounts} from './packages/backend/src/publication/news-geography.ts';
    await initializeDb('public-api');console.log(JSON.stringify(await currentNewsJurisdictionCounts()));await closeDb();`;
  const result = await f.run(process.execPath, ["--input-type=module", "-e", code], {
    API_ROLE: "public-api",
    DATABASE_URL_PUBLIC_READ: f.urlFor("public_read"),
    DATABASE_URL_FEEDBACK_WRITE: f.urlFor("feedback_write"),
  });
  const value = JSON.parse(result.stdout.trim());
  assert.ok(value.unknown > 0);
  assert.equal(value.counts.CN, 0);
});
