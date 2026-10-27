import { recentGroupingCandidateIds } from "../packages/backend/src/publication/groups.ts";
import { claimPendingGrouping, beginMaterialGrouping, completeMaterialGrouping } from "../packages/backend/src/content/grouping.ts";
import { tag, stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { sha256 } from "@amp/backend/lib/ids";
import { EMBEDDING_MODEL } from "@amp/backend/providers/embeddings";
import { FACT_CONVERGENCE_VERSION, reportText } from "../packages/backend/src/events/relate.ts";
import { upsertMaterial } from "@amp/backend/content/materials";
import { groupArticle, GroupingSupersededError } from "@amp/backend/events/group";
import { publishArticle } from "@amp/backend/publication/publish";
import { recoverPendingGroupings } from "@amp/backend/events/group";
import { groupingAnalysisHash } from "../packages/backend/src/enrichment/records.ts";
import { type getBoss, QUEUES, stopBoss } from "@amp/backend/jobs/queue";
import { registerEventJobs } from "@amp/backend/jobs/events";
import { rerun, detachFromFact } from "@amp/backend/admin/content";
import { grantDateFixture } from "./source-date-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { scopeVersion, scopeOutput, scopeReceipt } from "./scope-fixture.ts";

let addsValue = true;
let missingValue = false;
let scopeAnswer: "single" | "composite" | "unknown" = "single";
let lastInput = "";
let beforeAnswer: (() => Promise<void>) | null = null;
let relationAnswer: "SAME_STORY" | "SAME_OCCURRENCE" = "SAME_STORY";
let preferredCandidateTitle = "";
let rejectedReviewTitle = "";
let embeddingCalls = 0;
const provider = await stub(async (_hit, request) => {
  const body = JSON.parse(request.body);
  if (request.url.endsWith("/embeddings")) {
    embeddingCalls++;
    return { data: body.input.map((_text: string, index: number) => ({ index, embedding: [1, 0] })), usage: { prompt_tokens: 10 } };
  }
  lastInput = body.messages[1].content;
  await beforeAnswer?.();
  if (lastInput.startsWith('{"left":')) {
    return {
      choices: [
        { message: { content: JSON.stringify({ relation: "insufficient", evidence: null, reason: "This fixture only judges existing fact selection" }) } },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 30 },
    };
  }
  const ids = [...lastInput.matchAll(/【候选 (C\d+)】/g)].map((match) => match[1]);
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            query: "项目进展",
            queryScope: scopeAnswer,
            decisions: ids.map((id) => ({
              id,
              relation: relationAnswer,
              confidence: preferredCandidateTitle
                ? lastInput.split(`【候选 ${id}】`)[1]?.split("【")[0]?.includes(preferredCandidateTitle)
                  ? 0.97
                  : 0.95
                : 0.96,
              note: "合成关系判断",
              evidence: null,
            })),
            a: "合成公告",
            b: "合成配套说明",
            relation: rejectedReviewTitle && lastInput.split("【报道 B】")[1]?.includes(rejectedReviewTitle) ? "SAME_STORY" : relationAnswer,
            confidence: 0.96,
            difference: "按合成原文核对具体发生",
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
  relationAnswer = "SAME_STORY";
  preferredCandidateTitle = rejectedReviewTitle = "";
  embeddingCalls = 0;
  process.env.EMBEDDINGS_ENABLED = "false";
  await sql`UPDATE publications SET selected=false,visibility='withdrawn'`;
  await sql`DELETE FROM fact_articles`;
  await sql`DELETE FROM story_signals`;
  await installUsageFixtureForModel("deepseek-flash");
});
async function article(title: string, scope: "single" | "composite" | null = "single", daysAgo = 0, lateDiscovery = false) {
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
    publishedAt: new Date(Date.now() - 60000 - daysAgo * 86400000),
    ...(daysAgo && !lateDiscovery ? { discoveredAt: new Date(Date.now() - daysAgo * 86400000) } : {}),
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

test("the normal group consumer repairs an announcement, interpretation and duplicate archive into one seat without rescoring", async () => {
  const interpretation = await article("甲矿项目分类目录正式公布：负责人配套解读");
  await groupArticle(interpretation);
  const announcement = await article("甲矿项目分类目录正式公布", "single", 1);
  assert.equal((await groupArticle(announcement)).verdict, "new-fact-in-story");
  const archive = await article("甲矿项目分类目录正式公布：分类数量说明", "single", 8, true);
  await completeMaterialGrouping(archive, 1, { addsValue: true, reason: "历史资料按原文时间归档" }, null);
  await sql`INSERT INTO grouping_decisions(article_id,verdict,input_revision) VALUES(${archive},'historical',1)`;
  await publishArticle(archive);
  const archiveBefore = await publication(archive);
  const ids = [announcement, interpretation, archive];
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=ANY(${ids})`;
  const { grouping_receipt_id: receiptId } = await grouping(announcement);
  // Seed the successful saved answer as belonging to the earlier recipe, with a distinct old cache key.
  await sql`UPDATE receipts SET logical_key=logical_key||':previous',request=jsonb_set(request,'{promptVersion}','"group-batch+group-value@previous"') WHERE id=${receiptId}`;
  const evidence = (await sql`SELECT * FROM receipts WHERE id=${receiptId}`)[0];
  const attempts = await sql`SELECT * FROM receipt_attempts WHERE receipt_id=${receiptId} ORDER BY attempt`;
  const scores = await sql`SELECT * FROM analyses WHERE article_id=ANY(${ids}) ORDER BY id`;
  assert.equal((await sql`SELECT count(*)::int AS n FROM publications WHERE article_id=ANY(${ids}) AND seat`)[0].n, 3);
  assert.equal((await recoverPendingGroupings(2)).enqueued, 2);
  assert.equal((await grouping(announcement)).grouping_status, "pending");
  assert.equal((await grouping(archive)).grouping_status, "pending");
  assert.equal((await recoverPendingGroupings(2)).enqueued, 0);
  const jobs = await sql`SELECT data FROM pgboss.job WHERE name=${QUEUES.group} AND data->>'articleId'=ANY(${ids}) AND state='created'`;
  const handlers = new Map<string, (jobs: { data: unknown }[]) => Promise<unknown>>();
  await registerEventJobs({
    work: async (name: string, _options: unknown, handler: (jobs: { data: unknown }[]) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  } as unknown as Awaited<ReturnType<typeof getBoss>>);
  relationAnswer = "SAME_OCCURRENCE";
  addsValue = false;
  for (const [id, verdict] of [
    [announcement, "same-fact"],
    [archive, "historical"],
  ]) {
    const job = jobs.find((row) => row.data.articleId === id);
    assert.ok(job);
    assert.equal(((await handlers.get(QUEUES.group)!([{ data: job.data }])) as { verdict: string }).verdict, verdict);
  }
  const rows = await sql`SELECT article_id,fact_id,seat,selected FROM publications WHERE article_id=ANY(${ids})`;
  assert.equal(new Set(rows.filter((row) => row.article_id !== archive).map((row) => row.fact_id)).size, 1);
  assert.equal(rows.filter((row) => row.seat).length, 1);
  const archived = await publication(archive);
  assert.deepEqual([archived.visibility, archived.eligible, archived.selected, archived.fact_id, archived.story_id], ["public", true, false, null, null]);
  assert.equal(archived.timeline_at.getTime(), archiveBefore.timeline_at.getTime());
  assert.equal(archived.published_at.getTime(), archiveBefore.published_at.getTime());
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id=${archive}`).length, 0);
  assert.equal((await sql`SELECT 1 FROM story_signals WHERE article_id=${archive}`).length, 0, "archive reading coverage adds no heat");
  assert.equal((await grouping(announcement)).grouping_status, "complete");
  assert.equal((await sql`SELECT 1 FROM regroup_pending WHERE article_id=${announcement}`).length, 0);
  await sql`DELETE FROM pgboss.job WHERE name=${QUEUES.group} AND data->>'articleId'=ANY(${ids})`;
  assert.equal((await recoverPendingGroupings(1)).enqueued, 0, "the completed new recipe is not reviewed again");
  assert.deepEqual((await sql`SELECT * FROM receipts WHERE id=${receiptId}`)[0], evidence);
  assert.deepEqual(await sql`SELECT * FROM receipt_attempts WHERE receipt_id=${receiptId} ORDER BY attempt`, attempts);
  assert.deepEqual(await sql`SELECT * FROM analyses WHERE article_id=ANY(${ids}) ORDER BY id`, scores);
});

test("multi-member duplicate facts converge despite higher self-match confidence, and review rejection cannot authorize peer repair", async () => {
  const interpretation = await article("甲矿项目分类目录：负责人配套解读");
  const canonical = await groupArticle(interpretation);
  const announcement = await article("甲矿项目分类目录：两部门发布完整公告");
  const split = await groupArticle(announcement);
  assert.equal(split.verdict, "new-fact-in-story");
  const peers: string[] = [];
  for (const [title, factId] of [
    ["甲矿项目分类目录：负责人配套解读转载", canonical.factId!],
    ["甲矿项目分类目录：旧公告转载一", split.factId!],
    ["甲矿项目分类目录：旧公告转载二", split.factId!],
  ] as const) {
    const id = await article(title);
    await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${factId},${id},'report',1)`;
    await completeMaterialGrouping(id, 1, { addsValue: true, reason: "合成既有同事实报道" }, null);
    await publishArticle(id);
    peers.push(id);
  }
  const ids = [interpretation, announcement, ...peers];
  const dates = () => sql`SELECT article_id,timeline_at,published_at FROM publications WHERE article_id=ANY(${ids}) ORDER BY article_id`;
  const before = await dates();
  const latest = async (id: string) =>
    (await sql`SELECT candidates,input_manifest FROM grouping_decisions WHERE article_id=${id} ORDER BY id DESC LIMIT 1`)[0]!;
  relationAnswer = "SAME_OCCURRENCE";
  preferredCandidateTitle = rejectedReviewTitle = "旧公告";
  assert.equal((await groupArticle(announcement, { force: true })).factId, canonical.factId);
  const rejected = await latest(announcement);
  assert.equal(rejected.candidates.find((c: { id: number }) => c.id === split.factId).relation, "SAME_STORY");
  assert.equal(rejected.input_manifest.factConvergence, null, "the second model rejected the other fact, so its members cannot be recovered from this answer");
  assert.equal(
    (await sql`SELECT count(*)::int AS n FROM publications WHERE article_id=ANY(${ids}) AND seat`)[0].n,
    2,
    "the old fact still has other selected members",
  );
  rejectedReviewTitle = "";
  assert.equal((await groupArticle(peers[1]!, { force: true })).factId, canonical.factId);
  const accepted = await latest(peers[1]!);
  assert.deepEqual(accepted.input_manifest.factConvergence, {
    version: FACT_CONVERGENCE_VERSION,
    storyId: canonical.storyId,
    canonicalFactId: canonical.factId,
    factIds: [canonical.factId, split.factId],
  });
  assert.equal(accepted.input_manifest.factConvergenceVersion, FACT_CONVERGENCE_VERSION);
  assert.equal((await groupArticle(peers[2]!, { force: true })).factId, canonical.factId);
  assert.equal((await sql`SELECT count(*)::int AS n FROM publications WHERE article_id=ANY(${ids}) AND seat`)[0].n, 1);
  assert.equal(
    (await sql`SELECT count(*)::int AS n FROM publications WHERE article_id=ANY(${ids}) AND visibility='public' AND fact_id=${canonical.factId!}`)[0].n,
    ids.length,
  );
  assert.deepEqual(await dates(), before);
});

test("an uncovered archive keeps its old date and does not loop when the review needs no model receipt", async () => {
  const id = await article("独立的合成矿产调查结果发布", "single", 8, true);
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${id}`;
  const hits = provider.hits();
  assert.equal((await groupArticle(id)).verdict, "historical");
  const p = await publication(id);
  assert.equal(p.selected, true);
  assert.equal(p.fact_id, null);
  assert.equal(p.story_id, null);
  assert.equal(p.backfill, true);
  assert.equal(p.timeline_at.getTime(), p.published_at.getTime());
  assert.equal(provider.hits(), hits);
  assert.equal((await recoverPendingGroupings(1)).enqueued, 0, "the saved current recipe confirms the no-coverage decision without inventing a receipt");
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

test("a preferred member waiting for a new date judgement cannot hide another confirmed member of its fact", async () => {
  const primary = await article("甲矿项目原始公告主稿"),
    secondary = await article("甲矿项目第二来源的确认报道");
  await groupArticle(primary);
  const [member] = await sql`SELECT fact_id FROM fact_articles WHERE article_id=${primary}`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${member!.fact_id},${secondary},'report',1)`;
  await completeMaterialGrouping(secondary, 1, { addsValue: true, reason: "合成同事实确认" }, null);
  await publishArticle(secondary);
  await beginMaterialGrouping(primary, 1, true);
  const next = await article("甲矿项目新阶段继续建设");
  await groupArticle(next);
  assert.ok(lastInput.includes("甲矿项目第二来源的确认报道"));
  assert.ok(!lastInput.includes("甲矿项目原始公告主稿"));
});

test("invalid high matches cannot fill the recall limit or hide the current representative and story root", async () => {
  const title = "甲矿项目建设进展正式公布";
  const valid = await article(`${title}：有效来源`);
  const result = await groupArticle(valid);
  const [root] = await sql`SELECT story_id FROM facts WHERE id=${result.factId!}`;
  for (let i = 0; i < 10; i++) {
    const id = await article(title, "single", 1);
    const [story] = await sql`INSERT INTO stories(public_id,title) VALUES(gen_random_uuid(),${title}) RETURNING id`;
    const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${tag()},${i === 0 ? root!.story_id : story!.id},${title}) RETURNING id`;
    await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${fact!.id},${id},'primary',1)`;
    await completeMaterialGrouping(id, 1, { addsValue: true, reason: "合成旧归属" }, null);
    await publishArticle(id);
    if (i % 3 === 0) await sql`UPDATE articles SET revision=2,grouping_input_revision=2 WHERE id=${id}`;
    else if (i % 3 === 1) await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${id}`;
    else await sql`UPDATE analyses SET output=jsonb_set(output,'{scope}','"composite"') WHERE article_id=${id}`;
  }
  const withdrawn = await article("甲矿项目已撤回的较早主稿", "single", 1);
  await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${result.factId!},${withdrawn},'primary',1)`;
  await completeMaterialGrouping(withdrawn, 1, { addsValue: true, reason: "合成旧主稿" }, null);
  await publishArticle(withdrawn);
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${withdrawn}`;
  const query = await article(title);
  assert.equal((await groupArticle(query)).verdict, "new-fact-in-story");
  assert.equal((await sql`SELECT story_id FROM facts WHERE id=(SELECT fact_id FROM fact_articles WHERE article_id=${query})`)[0].story_id, root!.story_id);
  assert.equal([...lastInput.matchAll(/【候选 C\d+】/g)].length, 1);
  assert.ok(lastInput.includes(`${title}：有效来源`));
  assert.ok(!lastInput.includes("甲矿项目已撤回的较早主稿"));
});

test("a warm recall cache follows publication revisions and reuses the same stored text without another embedding request", async (t) => {
  process.env.EMBEDDINGS_ENABLED = "true";
  process.env.DASHSCOPE_API_KEY = process.env.EMBEDDING_API_KEY = "synthetic-only";
  process.env.DASHSCOPE_BASE_URL = process.env.EMBEDDING_BASE_URL = provider.url;
  t.after(() => {
    for (const key of ["DASHSCOPE_API_KEY", "EMBEDDING_API_KEY", "DASHSCOPE_BASE_URL", "EMBEDDING_BASE_URL"]) delete process.env[key];
  });
  const stored = async (id: string, vector: number[]) => {
    const p = await publication(id);
    await sql`INSERT INTO embeddings(kind,ref_id,model,text_hash,vector) VALUES('article',${id},${EMBEDDING_MODEL},${sha256(reportText(p.title, p.summary))},${vector})
      ON CONFLICT(kind,ref_id,model) DO UPDATE SET text_hash=EXCLUDED.text_hash,vector=EXCLUDED.vector`;
  };
  const target = await article("甲矿项目旧版公开标题");
  await stored(target, [0, 1]);
  const original = await groupArticle(target);
  const coldQuery = await article("甲矿项目当前施工安排");
  await stored(coldQuery, [1, 0]);
  assert.equal((await groupArticle(coldQuery)).verdict, "new-story", "an existing low cosine is not a missing-vector lexical fallback");
  await sql`DELETE FROM fact_articles WHERE article_id=${coldQuery}`;
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${coldQuery}`;
  await sql`UPDATE publications SET title='甲矿项目当前施工安排',revision=revision+1 WHERE article_id=${target}`;
  await stored(target, [1, 0]);
  const changedQuery = await article("甲矿项目当前施工安排及范围");
  await stored(changedQuery, [1, 0]);
  assert.equal((await groupArticle(changedQuery)).verdict, "new-fact-in-story", "the corrected publication must replace the process's old vector");
  assert.equal(
    (await sql`SELECT story_id FROM facts WHERE id=(SELECT fact_id FROM fact_articles WHERE article_id=${changedQuery})`)[0].story_id,
    (await sql`SELECT story_id FROM facts WHERE id=${original.factId!}`)[0].story_id,
  );
  await sql`DELETE FROM fact_articles WHERE article_id=${changedQuery}`;
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${changedQuery}`;
  await sql`UPDATE publications SET revision=revision+1 WHERE article_id=${target}`;
  const unchangedQuery = await article("甲矿项目当前施工安排的确认");
  await stored(unchangedQuery, [1, 0]);
  assert.equal((await groupArticle(unchangedQuery)).verdict, "new-fact-in-story");
  assert.equal(embeddingCalls, 0, "publication metadata changes reuse existing text-hash vectors");
});

test("selected facts older than the identity window remain one reading context and prevent repeated selection", async () => {
  const first = await article("甲矿项目建设进展正式公布", "single", 30);
  await groupArticle(first);
  const [{ fact_id }] = await sql`SELECT fact_id FROM fact_articles WHERE article_id=${first}`;
  const peer = await article("甲矿项目建设进展再次披露", "single", 30);
  await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${fact_id},${peer},'report',1)`;
  await completeMaterialGrouping(peer, 1, { addsValue: true, reason: "合成既有公开报道" }, null);
  await publishArticle(peer);
  const repeat = await article("甲矿项目建设进展再次介绍");
  addsValue = false;
  await groupArticle(repeat);
  assert.match(lastInput, /已公开精选阅读背景 R1/);
  assert.doesNotMatch(
    lastInput,
    /已公开精选阅读背景 R2|【候选 C1】/,
    "one fact supplies one background and never becomes identity evidence outside its window",
  );
  assert.equal((await publication(repeat)).selected, false);
});

test("scheduled grouping recovery is bounded, durable and respects paused sources, lanes and unknown receipts", async () => {
  const a = await article("甲矿项目自动归组恢复甲");
  const b = await article("甲矿项目自动归组恢复乙");
  const unknown = await article("甲矿项目未知回执等待");
  const pausedSource = await article("甲矿项目人工停用来源");
  const failed = await article("甲矿项目输出错误待处理");
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=ANY(${[a, b, unknown, pausedSource, failed]})`;
  await sql`UPDATE articles SET grouping_status='failed' WHERE id=${failed}`;
  await sql`UPDATE articles SET backfill=true,published_at=now()-interval '90 days' WHERE id=${b}`;
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
    { article_id: string; priority: number }[]
  >`SELECT data->>'articleId' AS article_id, priority FROM pgboss.job WHERE name='events.group' AND data->>'articleId'=ANY(${[a, b, unknown, pausedSource, failed]})`;
  assert.deepEqual(new Set(queued.map((r) => r.article_id)), new Set([a, b]));
  assert.equal(queued.find((row) => row.article_id === a)?.priority, 0);
  assert.equal(queued.find((row) => row.article_id === b)?.priority, -2, "historical repair cannot jump ahead of live material");
  const [stored] = await sql`SELECT status FROM receipts WHERE id=${receipt}`;
  assert.equal(stored!.status, "unknown");
  assert.equal(provider.hits(), hits, "scheduling never calls a model or rescores");
  await sql`UPDATE articles SET grouping_retry_at=NULL WHERE id=${a}`;
  assert.equal((await recoverPendingGroupings(100)).examined, 0, "a durable future job prevents the repair sweep from bypassing its wait");
  await sql`UPDATE ops.lane_controls SET paused=true,reason='test owner pause',actor='synthetic owner',expires_at=now()+interval '1 hour' WHERE lane='news' AND switch='processing' AND holder='owner'`;
  try {
    assert.equal((await recoverPendingGroupings()).paused, true);
    const [row] = await sql`SELECT grouping_retry_at FROM articles WHERE id=${a}`;
    assert.equal(row!.grouping_retry_at, null, "pause does not consume the pending work");
  } finally {
    await sql`UPDATE ops.lane_controls SET paused=false WHERE lane='news' AND switch='processing' AND holder='owner'`;
  }
});

test("grouping repair restores recent skipped signals, without reviving historical signals or paying for scoring", async () => {
  await sql`UPDATE sources SET enabled=false`;
  const live = await article("甲矿项目近期讨论"),
    old = await article("甲矿项目历史讨论"),
    unknown = await article("甲矿项目无日期讨论");
  const ids = [live, old, unknown];
  await sql`UPDATE sources SET participation_mode='hot_signal' WHERE id IN (SELECT source_id FROM articles WHERE id=ANY(${ids}::text[]))`;
  await sql`UPDATE articles SET processing_state='skipped',grouping_status='pending',grouping_retry_at=NULL WHERE id=ANY(${ids}::text[])`;
  await sql`UPDATE articles SET backfill=true,published_at=now()-interval '90 days' WHERE id=${old}`;
  await sql`UPDATE articles SET backfill=true,published_at=NULL WHERE id=${unknown}`;
  const hits = provider.hits();
  assert.equal((await recoverPendingGroupings(100)).enqueued, 1);
  const rows = await sql`SELECT data,priority FROM pgboss.job WHERE name='events.group' AND data->>'articleId'=ANY(${ids}::text[])`;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].data, { lane: "news", articleId: live, signalOnly: true });
  assert.equal(rows[0].priority, -1, "live signals remain ahead of historical repair and behind editorial work");
  assert.equal((await recoverPendingGroupings(100)).examined, 0, "a persisted job prevents repeated repair");
  assert.equal(provider.hits(), hits);
});

test("bounded recovery admits recent public nominations while reserving old work under a fresh backlog", async () => {
  const old: string[] = [],
    recent: string[] = [];
  for (let i = 0; i < 12; i++) old.push(await article(`历史候选恢复${i}`, "single", 30));
  for (let i = 0; i < 6; i++) recent.push(await article(`近期候选恢复${i}`));
  const withdrawn = await article("人工撤回的近期候选");
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${withdrawn}`;
  const ids = [...old, ...recent, withdrawn];
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=ANY(${ids}::text[])`;
  await sql`UPDATE articles SET created_at=created_at-interval '30 days' WHERE id=ANY(${old}::text[])`;
  const sources = (await sql<{ source_id: string }[]>`SELECT source_id FROM articles WHERE id=ANY(${ids}::text[])`).map((row) => row.source_id);
  const priority = await recentGroupingCandidateIds(sources);
  assert.deepEqual(new Set(priority), new Set(recent), "only current public nominations receive the recent priority");
  const scores = await sql`SELECT article_id,score,selected FROM analyses WHERE article_id=ANY(${ids}::text[]) ORDER BY article_id`;
  const hits = provider.hits();
  const first = await sql.begin((tx) => claimPendingGrouping(sources, 5, tx, [], [], priority));
  assert.equal(first.length, 5);
  assert.equal(first.filter((row) => recent.includes(row.id)).length, 4, "old rows cannot consume the entire batch before recent candidates");
  assert.equal(first.filter((row) => old.includes(row.id)).length, 1, "one fifth still advances the oldest backlog");
  const second = await sql.begin((tx) => claimPendingGrouping(sources, 5, tx, [], [], priority));
  assert.equal(second.length, 5);
  assert.ok(second.some((row) => old.includes(row.id)));
  assert.ok(
    second.every((row) => !first.some((claimed) => claimed.id === row.id)),
    "the durable lease prevents duplicate admission",
  );
  assert.deepEqual(await sql`SELECT article_id,score,selected FROM analyses WHERE article_id=ANY(${ids}::text[]) ORDER BY article_id`, scores);
  assert.equal(provider.hits(), hits, "recovery admission does not rescore or invoke a model");
});
