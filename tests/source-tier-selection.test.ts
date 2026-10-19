import { tag, stub } from "./setup.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
import { confirmedManualEdit } from "./confirmed-manual-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { config } from "@amp/backend/config";
import { sql, closeDb } from "@amp/backend/db";
import { updateSource } from "@amp/backend/admin/sources";
import { upsertMaterial } from "@amp/backend/content/materials";
import { publishArticle, republishSource } from "@amp/backend/publication/publish";
import { groupArticle, recoverPendingGroupings } from "@amp/backend/events/group";
import { stopBoss, QUEUES } from "@amp/backend/jobs/queue";
import { completeMaterialGrouping } from "../packages/backend/src/content/grouping.ts";
import { recomputeSelection } from "../packages/backend/src/publication/selection-recompute.ts";
import { BATCH_PROMPT_VERSION } from "../packages/backend/src/events/relate.ts";

const provider = await stub((_hit, request) => ({
  choices: [
    {
      message: {
        content: JSON.stringify({
          query: "合成矿业公告",
          queryScope: "single",
          decisions: [...JSON.parse(request.body).messages[1].content.matchAll(/【候选 (C\d+)】/g)].map((match) => ({
            id: match[1],
            relation: "SAME_OCCURRENCE",
            confidence: 0.99,
            note: "合成同次发生",
            evidence: null,
          })),
          selection: { addsValue: false, reason: "公开精选已覆盖同一次发生" },
        }),
      },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 10 },
}));
process.env.DEEPSEEK_BASE_URL = provider.url;
process.env.DEEPSEEK_API_KEY = "synthetic-source-tier";
process.env.GROUP_REVIEW_MODEL = "deepseek-flash";
process.env.EMBEDDINGS_ENABLED = "false";
config.modelCallsEnabled = true;
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

async function fixture(tier: string, selected: boolean | null, output: Record<string, unknown>, daysOld = 0, historical = false, sharedUrl?: string) {
  const source = `tier-${tag()}`,
    url = sharedUrl ?? `https://source.invalid/${source}`;
  const at = new Date(Date.now() - daysOld * 86_400_000);
  await sql`INSERT INTO sources(id,name,kind,tier,first_party,site_fulltext) VALUES(${source},'合成矿业来源','rss',${tier},true,false)`;
  await grantDateFixture(source, [url]);
  const { articleId } = await upsertMaterial({
    sourceId: source,
    url,
    title: "合成铜矿建设审批",
    language: "zh",
    bodyText: "合成铜矿项目已获得建设审批，项目规模与建设条件仅供本地隔离回归。",
    via: "fetch",
    publishedAt: at,
  });
  await sql`UPDATE articles SET timeline_at=${at},published_at=${at},discovered_at=${historical ? new Date() : at},backfill=${historical},processing_state='analyzed' WHERE id=${articleId}`;
  const [analysis] =
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,reason_zh,score,selected,prompt_version,output)
    VALUES(${articleId},1,'model','pass','合成铜矿建设审批','合成铜矿项目获得建设审批，内容仅供离线核验。','合成推荐理由',99,${selected},'analysis@synthetic',
      ${sql.json({ scope: "single", fact: { title: "合成铜矿建设审批", subject: "合成铜矿", action: "建设审批", object: "矿山项目", occurredAt: at.toISOString() }, ...output })}) RETURNING id`;
  await completeMaterialGrouping(articleId, 1, { addsValue: true, reason: historical ? "历史资料按原文时间归档" : "合成已确认信息增量" }, null);
  await publishArticle(articleId);
  return { source, articleId, analysisId: analysis!.id };
}
async function tier(source: string, value: string) {
  const [row] = await sql`SELECT updated_at FROM sources WHERE id=${source}`;
  await updateSource(source, { patch: { tier: value }, version: row!.updated_at.toISOString(), reason: "合成分级调整" }, "test");
}
const projection = async (id: string) => (await sql`SELECT * FROM publications WHERE article_id=${id}`)[0]!;

test("source tier republication uses the saved pair, preserves analysis and release history, and still requires current grouping", async () => {
  const f = await fixture("T1", true, { scores: [65, 66], threshold: 60 });
  const initial = await projection(f.articleId);
  const before = await sql`SELECT * FROM analyses WHERE id=${f.analysisId}`;
  const ledgerBefore = await sql`SELECT seq,op,visible_at FROM selected_ledger WHERE article_id=${f.articleId} ORDER BY seq`;
  await tier(f.source, "T2");
  assert.equal((await republishSource(f.source)).failed, 0);
  assert.equal((await projection(f.articleId)).selected, false, "the raw mean 65.5 fails T2 despite the stored display score 99");
  const [decision] = await sql`SELECT after FROM audit_log WHERE subject=${`article:${f.articleId}`} AND action='selection.recompute' ORDER BY id DESC LIMIT 1`;
  assert.equal(decision!.after.threshold, 76);
  assert.match(decision!.after.thresholdVersion, /^selection-thresholds@/);
  assert.equal(decision!.after.promptVersion, "analysis@synthetic");
  await tier(f.source, "T1_5");
  const later = new Date(Date.now() + 60_000);
  await publishArticle(f.articleId, { now: later });
  const returned = await projection(f.articleId);
  assert.equal(returned.selected, true);
  assert.equal(returned.first_public_at.getTime(), initial.first_public_at.getTime());
  assert.equal(returned.first_selected_at.getTime(), initial.first_selected_at.getTime(), "the current first-selection clock is retained");
  const ledger = await sql`SELECT seq,op,visible_at FROM selected_ledger WHERE article_id=${f.articleId} ORDER BY seq`;
  assert.deepEqual(ledger[0], ledgerBefore[0]);
  assert.deepEqual(
    ledger.map((row) => row.op),
    ["upsert", "remove", "upsert"],
  );
  assert.equal(ledger.at(-1)!.visible_at.getTime(), later.getTime());
  assert.deepEqual(await sql`SELECT * FROM analyses WHERE id=${f.analysisId}`, before);
  assert.equal(provider.hits(), 0, "changing a source tier never purchases another score or grouping answer");
  await sql`UPDATE articles SET revision=2 WHERE id=${f.articleId}`;
  assert.equal((await publishArticle(f.articleId))!.selected, false, "a saved score cannot select a different material revision");
});

test("invalid scores, human choices and the seven-day boundary retain their distinct meanings", async () => {
  const now = new Date(),
    at = new Date(now.getTime() - 7 * 86_400_000);
  const a = { id: 1, selected: false, relevance: "pass", output: { scores: [64, 66], threshold: 76 } };
  assert.equal(recomputeSelection(a, "T1_5", at, now)?.selected, true, "exactly seven days and the raw 130 sum still qualify");
  for (const output of [
    { scores: [80], threshold: 60 },
    { scores: [80, "80"], threshold: 60 },
    { scores: [80, 80.5], threshold: 60 },
    { scores: [101, 80], threshold: 60 },
    { scores: [80, 80], threshold: 60, scoreRefused: true },
    { scores: [80, 80], threshold: 60, scoreRefused: "false" },
    { threshold: 60 },
  ]) {
    assert.equal(recomputeSelection({ ...a, selected: true, output }, "T2", now, now)?.selected, false);
  }
  assert.equal(recomputeSelection({ ...a, output: {} }, "T2", now, now), null, "legacy judgments are not inferred from a display score");
  const f = await fixture("T1", true, { scores: [65, 66], threshold: 60 });
  await tier(f.source, "T2");
  assert.equal((await publishArticle(f.articleId))!.selected, false);
  const old = new Date(Date.now() + 8 * 86_400_000);
  await tier(f.source, "T1");
  assert.equal((await publishArticle(f.articleId, { now: old }))!.selected, false, "aging cannot revive the original tier decision");
  for (const chosen of [true, false]) {
    await confirmedManualEdit(f.articleId, { fields: { selected: chosen }, reason: "合成人工决定", version: chosen ? 0 : 1 }, "test");
    await tier(f.source, "T2");
    assert.equal((await publishArticle(f.articleId))!.selected, chosen);
  }
  assert.equal(
    recomputeSelection(a, "T1", new Date(0), now, { analysis_id: 1, eligible: true, selection_candidate: true })?.selected,
    true,
    "an old nomination waiting for grouping is retained separately from its public seat",
  );
});

test("a newly nominated archive waits for ordinary grouping and duplicate coverage never gains a public seat", async () => {
  await installUsageFixtureForModel("deepseek-flash");
  const url = `https://source.invalid/shared-${tag()}`;
  const live = await fixture("T1", true, { scores: [65, 66], threshold: 60 }, 3, false, url);
  const [story] = await sql`INSERT INTO stories(public_id,title,first_report_at,latest_at) VALUES(${randomUUID()},'合成矿业事件',now(),now()) RETURNING id`;
  const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${`tier-fact-${tag()}`},${story!.id},'合成铜矿建设审批') RETURNING id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${fact!.id},${live.articleId},'primary',1)`;
  await publishArticle(live.articleId);
  const archive = await fixture("T2", null, { scores: [65, 66], threshold: 76 }, 3, true, url);
  await sql`INSERT INTO grouping_decisions(article_id,input_revision,verdict,candidates,input_manifest)
    VALUES(${archive.articleId},1,'historical','[]',${sql.json({ version: 1, recipe: BATCH_PROMPT_VERSION, materialRevision: 1 })})`;
  const analysisBefore = await sql`SELECT * FROM analyses WHERE id=${archive.analysisId}`;
  const timeline = (await projection(archive.articleId)).timeline_at;
  const hits = provider.hits();
  await tier(archive.source, "T1");
  await republishSource(archive.source);
  const nominated = await projection(archive.articleId);
  assert.deepEqual([nominated.selection_candidate, nominated.selected, nominated.seat], [true, false, false]);
  assert.equal((await sql`SELECT grouping_status FROM articles WHERE id=${archive.articleId}`)[0]!.grouping_status, "pending");
  assert.equal(provider.hits(), hits, "republication only schedules the ordinary confirmation");
  await recoverPendingGroupings();
  assert.equal(
    (await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name=${QUEUES.group} AND data->>'articleId'=${archive.articleId} AND state='created'`)[0]!.n,
    1,
  );
  const result = await groupArticle(archive.articleId);
  assert.equal(result.verdict, "historical");
  const completed = await projection(archive.articleId);
  assert.deepEqual(
    [completed.selection_candidate, completed.selected, completed.seat, completed.fact_id, completed.story_id],
    [true, false, false, null, null],
  );
  assert.equal(completed.timeline_at.getTime(), timeline.getTime());
  assert.equal((await sql`SELECT grouping_status FROM articles WHERE id=${archive.articleId}`)[0]!.grouping_status, "complete");
  assert.deepEqual(await sql`SELECT * FROM analyses WHERE id=${archive.analysisId}`, analysisBefore);
  const judgedHits = provider.hits();
  assert.ok(judgedHits > hits, "only the local grouping stub supplies the coverage answer");
  await publishArticle(archive.articleId);
  assert.equal((await sql`SELECT grouping_status FROM articles WHERE id=${archive.articleId}`)[0]!.grouping_status, "complete");
  assert.equal(provider.hits(), judgedHits);

  const unknown = await fixture("T2", false, { scores: [65, 66], threshold: 76, scope: "unknown", fact: null }, 3, true);
  await tier(unknown.source, "T1");
  await publishArticle(unknown.articleId);
  assert.equal((await groupArticle(unknown.articleId)).verdict, "standalone");
  const [negative] = await sql`SELECT grouping_status,selection_adds_value FROM articles WHERE id=${unknown.articleId}`;
  assert.deepEqual(
    [negative!.grouping_status, negative!.selection_adds_value],
    ["complete", false],
    "an explicit insufficient-evidence decision does not restart coverage",
  );
  assert.equal((await projection(unknown.articleId)).selected, false);
  assert.equal(provider.hits(), judgedHits, "unknown scope without a fact cannot fabricate a paid coverage answer");
});
