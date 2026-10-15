import { tag, stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { dbOf, closeDb } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { upsertMaterial } from "@amp/backend/content/materials";
import { groupArticle, GroupingSupersededError } from "@amp/backend/events/group";
import { publishArticle } from "@amp/backend/publication/publish";
import { recoverPendingGroupings } from "@amp/backend/events/group";
import { groupingAnalysisHash } from "../packages/backend/src/enrichment/records.ts";
import { stopBoss } from "@amp/backend/jobs/queue";
import { rerun, detachFromFact } from "@amp/backend/admin/content";
import { grantDateFixture } from "./source-date-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { scopeVersion, scopeOutput, scopeReceipt } from "./scope-fixture.ts";
const sql = dbOf("events");
let addsValue = true;
let missingValue = false;
let scopeAnswer: "single" | "composite" | "unknown" = "single";
let lastInput = "";
let beforeAnswer: (() => Promise<void>) | null = null;
const provider = await stub(async (_hit, request) => {
  const body = JSON.parse(request.body);
  lastInput = body.messages[1].content;
  await beforeAnswer?.();
  const ids = [...lastInput.matchAll(/【候选 (C\d+)】/g)].map((match) => match[1]);
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            query: "项目进展",
            queryScope: scopeAnswer,
            decisions: ids.map((id) => ({ id, relation: "SAME_STORY", confidence: 0.96, note: "后续报道", evidence: null })),
            ...(missingValue ? {} : { selection: { addsValue, reason: addsValue ? "出现新的可核对事实" : "已公开报道覆盖，没有新增事实" } }),
          }),
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 100 },
  };
});
process.env.DEEPSEEK_BASE_URL = provider.url;
process.env.DEEPSEEK_API_KEY = "synthetic-only";
process.env.GROUP_REVIEW_MODEL = "deepseek-flash";
config.modelCallsEnabled = true;
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});
beforeEach(async () => {
  addsValue = true;
  missingValue = false;
  scopeAnswer = "single";
  lastInput = "";
  beforeAnswer = null;
  await sql`UPDATE publications SET selected=false,visibility='withdrawn'`;
  await sql`DELETE FROM fact_articles`;
  await sql`DELETE FROM story_signals`;
  await installUsageFixtureForModel("deepseek-flash");
});
async function article(title: string, scope: "single" | "composite" | null = "single") {
  const source = `selection-flow-${tag()}`;
  const url = `https://example.com/${source}`;
  await sql`INSERT INTO sources(id,name,kind,tier,first_party,site_fulltext) VALUES(${source},'合成矿业来源','rss','T1',true,true)`;
  await grantDateFixture(source, [url]);
  const material = await upsertMaterial({
    sourceId: source,
    url,
    title,
    bodyText: `${title}。这是一份合成矿业材料，披露具体建设范围、投资和数量。`,
    language: "zh",
    via: "fetch",
    publishedAt: new Date(Date.now() - 60000),
  });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected,prompt_version,receipt_ids,output)
    VALUES(${material.articleId},1,'rule','pass','company_project',${title},${`${title}，披露项目建设范围和数量。`},80,true,${scopeVersion},${[await scopeReceipt(material.articleId)]},
      ${sql.json({ ...scopeOutput, ...(scope ? { scope } : {}), fact: scope !== "composite" ? { title: "甲矿项目", subject: "甲矿企", object: "甲矿项目", action: "建设" } : null })})`;
  await publishArticle(material.articleId);
  return material.articleId;
}
const publication = async (id: string) => (await sql`SELECT * FROM publications WHERE article_id=${id}`)[0]!;
const grouping = async (id: string) => (await sql`SELECT grouping_status,selection_adds_value,grouping_receipt_id FROM articles WHERE id=${id}`)[0]!;

test("scoring nominates; time alone never selects; confirmation stamps the real release", async () => {
  const id = await article("甲矿项目建设进展正式公布");
  let p = await publication(id);
  assert.equal(p.selection_candidate, true);
  assert.equal(p.selected, false);
  assert.equal(p.visibility, "public");
  assert.equal(p.visible_after, null);
  assert.equal((await sql`SELECT * FROM selected_ledger WHERE article_id=${id}`).length, 0);
  await sql`UPDATE publications SET selected_ready_at=now()-interval '2 hours' WHERE article_id=${id}`;
  await publishArticle(id, { now: new Date(Date.now() + 3600000) });
  assert.equal((await publication(id)).selected, false, "the former 180-second timeout cannot admit unfinished work");
  const before = new Date();
  await groupArticle(id);
  p = await publication(id);
  assert.equal(p.selected, true);
  assert.equal((await grouping(id)).selection_adds_value, true);
  assert.ok(p.first_selected_at >= before);
  assert.equal(p.first_selected_at.getTime(), p.visible_after.getTime());
  assert.ok(p.visible_after > p.selected_ready_at);
  const calls = provider.hits();
  await groupArticle(id);
  assert.equal(provider.hits(), calls, "already-confirmed work is reused");
  assert.equal((await publication(id)).first_selected_at.getTime(), p.first_selected_at.getTime());
});

test("a follow-up without new information stays readable but is not selected; real developments can qualify", async () => {
  const first = await article("甲矿项目建设进展正式公布");
  await groupArticle(first);
  addsValue = false;
  const repeat = await article("甲矿项目建设进展正式公布：回顾已有信息");
  const repeated = await groupArticle(repeat);
  assert.equal(repeated.verdict, "new-fact-in-story");
  assert.equal((await grouping(repeat)).grouping_status, "complete");
  assert.equal((await grouping(repeat)).selection_adds_value, false);
  assert.equal((await publication(repeat)).selected, false);
  assert.equal((await publication(repeat)).visibility, "public");
  assert.match(lastInput, /已公开精选/);
  assert.equal((await sql`SELECT * FROM selected_ledger WHERE article_id=${repeat}`).length, 0);
  addsValue = true;
  const progress = await article("甲矿项目建设进展正式公布：新增500万吨产量");
  await groupArticle(progress);
  assert.equal((await publication(progress)).selected, true);
  assert.equal((await grouping(progress)).selection_adds_value, true);
});

test("missing value judgement fails closed and cannot become selected after waiting", async () => {
  await groupArticle(await article("甲矿项目建设进展正式公布"));
  missingValue = true;
  const id = await article("甲矿项目建设进展正式公布：缺失新增信息答案");
  await assert.rejects(groupArticle(id));
  const failed = await grouping(id);
  assert.equal(failed.grouping_status, "failed");
  assert.equal(failed.selection_adds_value, null);
  assert.ok(failed.grouping_receipt_id);
  await publishArticle(id, { now: new Date(Date.now() + 3600000) });
  assert.equal((await publication(id)).selected, false);
});

test("selected composites provide reading context without becoming fact candidates", async () => {
  const composite = await article("甲矿项目建设进展正式公布：多个事项汇总", "composite");
  assert.equal((await groupArticle(composite)).verdict, "roundup");
  assert.equal((await publication(composite)).selected, true);
  assert.equal((await sql`SELECT * FROM fact_articles WHERE article_id=${composite}`).length, 0);
  addsValue = false;
  const repeat = await article("甲矿项目建设进展正式公布：汇总中的既有事项");
  await groupArticle(repeat);
  assert.match(lastInput, /阅读背景 R1/);
  assert.doesNotMatch(lastInput, /【候选 C1】/);
  assert.equal((await publication(repeat)).selected, false);
});

test("regroup requests are durable and replaying a command cannot undo a newer human decision", async () => {
  const id = await article("甲矿项目建设进展正式公布");
  await groupArticle(id);
  const original = await publication(id);
  const queued = await rerun(id, "group", "same-request-12345", "test:owner");
  assert.ok(queued?.jobId);
  assert.equal((await publication(id)).selected, false);
  assert.equal((await grouping(id)).grouping_status, "pending");
  await groupArticle(id, { force: true });
  assert.equal((await publication(id)).first_selected_at.getTime(), original.first_selected_at.getTime(), "repair preserves the old public release");
  await detachFromFact(id, "人工确认保持独立", "test:owner");
  assert.ok((await sql`SELECT 1 FROM grouping_overrides WHERE article_id=${id}`).length);
  assert.deepEqual(await rerun(id, "group", "same-request-12345", "test:owner"), queued);
  assert.ok((await sql`SELECT 1 FROM grouping_overrides WHERE article_id=${id}`).length, "retry does not erase the later human decision");
  assert.equal((await sql`SELECT 1 FROM regroup_pending WHERE article_id=${id}`).length, 0);
});

test("an in-flight answer cannot clear a newer regroup request, and the paid result can be reused", async () => {
  await groupArticle(await article("甲矿项目建设进展正式公布"));
  const id = await article("甲矿项目建设进展正式公布：归组并发请求");
  let requested = false;
  beforeAnswer = async () => {
    if (requested) return;
    requested = true;
    await rerun(id, "group", "newer-request-12345", "test:owner");
  };
  await assert.rejects(groupArticle(id), GroupingSupersededError);
  assert.equal((await grouping(id)).grouping_status, "pending");
  assert.equal((await sql`SELECT 1 FROM regroup_pending WHERE article_id=${id}`).length, 1);
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id=${id}`).length, 0);
  beforeAnswer = null;
  const calls = provider.hits();
  await groupArticle(id, { force: true });
  assert.equal(provider.hits(), calls, "identical paid evidence is reused after the superseding request");
  assert.equal((await grouping(id)).grouping_status, "complete");
  assert.equal((await sql`SELECT 1 FROM regroup_pending WHERE article_id=${id}`).length, 0);
});

test("a changed analysis cannot accept an answer about the old summary on the same material revision", async () => {
  await groupArticle(await article("甲矿项目建设进展正式公布"));
  const id = await article("甲矿项目建设进展正式公布：分析修订竞态");
  beforeAnswer = async () => {
    await sql`UPDATE analyses SET summary_zh='新的分析明确这是一份综合材料',output=jsonb_set(output,'{scope}','"composite"'::jsonb) WHERE article_id=${id}`;
  };
  await assert.rejects(groupArticle(id), GroupingSupersededError);
  assert.equal((await publication(id)).selected, false);
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id=${id}`).length, 0);
  beforeAnswer = null;
  assert.equal((await groupArticle(id)).verdict, "roundup");
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id=${id} AND role IN ('primary','report')`).length, 0);
});

test("a canceled future ledger entry is not historical public selection evidence", async () => {
  const id = await article("甲矿项目建设进展正式公布");
  await sql`UPDATE publications SET selected_ready_at=now()-interval '5 minutes' WHERE article_id=${id}`;
  await sql`INSERT INTO selected_ledger(seq,article_id,op,changed_at,visible_at,payload)
    SELECT coalesce(max(seq),0)+1,${id},'upsert',now()-interval '5 minutes',now()-interval '3 minutes','{}'::jsonb FROM selected_ledger`;
  await sql`INSERT INTO selected_ledger(seq,article_id,op,changed_at,visible_at,payload)
    SELECT coalesce(max(seq),0)+1,${id},'remove',now()-interval '4 minutes',now()-interval '4 minutes',NULL FROM selected_ledger`;
  const before = new Date();
  await groupArticle(id);
  assert.ok((await publication(id)).first_selected_at >= before, "never-public scheduled entries cannot backdate confirmation");
});

test("legacy fact fields do not silently confirm a single report's scope", async () => {
  const id = await article("甲矿项目建设进展正式公布：旧版多主题材料", null);
  scopeAnswer = "composite";
  const [legacy] = await sql`SELECT output FROM analyses WHERE article_id=${id} ORDER BY id DESC LIMIT 1`;
  assert.equal("scope" in legacy!.output, false);
  assert.ok(legacy!.output.fact);
  const before = provider.hits();
  assert.equal((await groupArticle(id)).verdict, "roundup");
  assert.equal(provider.hits(), before + 1, "missing legacy scope receives a real scope judgement, not an inferred pass");
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id=${id} AND role IN ('primary','report')`).length, 0);
});

test("a new nomination invalidates value input even if the article copy did not change", () => {
  const base = { relevance: "pass", selected: false, title_zh: "项目进展", summary_zh: "项目首次披露", output: { scope: "single", score: 50 } };
  assert.notEqual(groupingAnalysisHash(base), groupingAnalysisHash({ ...base, selected: true }));
  assert.equal(groupingAnalysisHash(base), groupingAnalysisHash({ ...base, output: { ...base.output, score: 55 } }));
});

test("scheduled grouping recovery is bounded, durable and respects paused sources, lanes and unknown receipts", async () => {
  const a = await article("甲矿项目自动归组恢复甲");
  const b = await article("甲矿项目自动归组恢复乙");
  const unknown = await article("甲矿项目未知回执等待");
  const pausedSource = await article("甲矿项目人工停用来源");
  const failed = await article("甲矿项目输出错误待处理");
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=ANY(${[a, b, unknown, pausedSource, failed]})`;
  await sql`UPDATE articles SET grouping_status='failed' WHERE id=${failed}`;
  const receipt = await scopeReceipt(unknown);
  await sql`UPDATE receipts SET status='unknown' WHERE id=${receipt}`;
  await sql`UPDATE articles SET grouping_receipt_id=${receipt} WHERE id=${unknown}`;
  await sql`UPDATE sources SET enabled=false WHERE id=(SELECT source_id FROM articles WHERE id=${pausedSource})`;
  const hits = provider.hits();
  const result = await recoverPendingGroupings(1);
  assert.equal(result.examined, 1);
  assert.equal(result.enqueued, 1);
  await stopBoss(); // restart the queue producer; continuation is in PostgreSQL, not a process flag.
  const second = await recoverPendingGroupings(1);
  assert.equal(second.examined, 1);
  assert.equal(second.enqueued, 1);
  const third = await recoverPendingGroupings(1);
  assert.equal(third.examined, 1);
  assert.equal(third.waiting, 1);
  assert.equal(third.enqueued, 0);
  assert.equal((await recoverPendingGroupings(100)).examined, 0);
  const queued = await sql<
    { article_id: string }[]
  >`SELECT data->>'articleId' AS article_id FROM pgboss.job WHERE name='events.group' AND data->>'articleId'=ANY(${[a, b, unknown, pausedSource, failed]})`;
  assert.deepEqual(new Set(queued.map((r) => r.article_id)), new Set([a, b]));
  const [stored] = await sql`SELECT status FROM receipts WHERE id=${receipt}`;
  assert.equal(stored!.status, "unknown");
  assert.equal(provider.hits(), hits, "scheduling never calls a model or rescores");
  await sql`UPDATE articles SET grouping_retry_at=NULL WHERE id=${a}`;
  await sql`UPDATE ops.lane_controls SET paused=true,reason='test owner pause',actor='synthetic owner',expires_at=now()+interval '1 hour' WHERE lane='news' AND switch='processing' AND holder='owner'`;
  try {
    assert.equal((await recoverPendingGroupings()).paused, true);
    const [row] = await sql`SELECT grouping_retry_at FROM articles WHERE id=${a}`;
    assert.equal(row!.grouping_retry_at, null, "pause does not consume the pending work");
  } finally {
    await sql`UPDATE ops.lane_controls SET paused=false WHERE lane='news' AND switch='processing' AND holder='owner'`;
  }
});
