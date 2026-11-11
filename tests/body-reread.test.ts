// News articles with fewer than 20 characters of material (TASK-0598, Owner 2026-11-08 DEC-78补充·只抓到标题的资讯):
// no paid step, the body is read again at +30 min, +3 h and +12 h, and an article still short after the last read fails
// with a reason that names its source (the runs page groups failures by reason) and stays hidden. The one-off backfill
// puts the articles judged on a title before this rule into the same schedule. No model is called anywhere here.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { failureGroupSql, queueProcessing, runAnalysisJob, sweepUnprocessed } from "@amp/backend/jobs/content";
import { QUEUES, stopBoss } from "@amp/backend/jobs/queue";
import { overrideFields, rerun } from "@amp/backend/admin/content";
import { publishArticle } from "@amp/backend/publication/publish";
import { v3Item } from "@amp/backend/publication/v1";
import { itemFeed } from "@amp/backend/publication/feeds";
import { awaitsMaterial, loadAnalyzeInput } from "@amp/backend/editorial/analyze";
import { runsOverview } from "@amp/backend/admin/runs";
import { readCurrentSourcePolicy, readSourceDateContext } from "@amp/backend/admin/sources";
import { audit } from "../packages/backend/src/admin/auth.ts";
import { bodyReadingKey } from "../packages/backend/src/content/body-reading-key.ts";
import { articleMaterialTooShort } from "../packages/backend/src/lib/original-post-admission.ts";
import { OFF_PEAK_WAIT } from "../packages/backend/src/providers/peak-hours.ts";
import {
  BODY_REREAD_DELAYS_MINUTES,
  bodyBackfilled,
  bodyBackfillEstimate,
  bodyUnreadableReason,
  nextBodyReread,
  settleShortBody,
  scheduleBodyBackfill,
} from "../packages/backend/src/jobs/body-reread.ts";
import { grantDateFixture } from "./source-date-fixture.ts";

const T = tag();
const NAME = "Synthetic reread source";
let serial = 0;
Object.assign(process.env, { COLLECT_ENABLED: "true", COLLECT_NEWS_ENABLED: "true", JINA_BODY_FALLBACK: "false" });

before(async () => {
  // No provider is configured: any paid step would fail the test instead of reaching a model.
  for (const env of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) delete process.env[env];
});
after(async () => {
  await stopBoss();
  await closeDb();
});

async function source(extra: { lane?: string; mode?: string; name?: string } = {}) {
  const id = `reread-${T}-${++serial}`;
  await sql`INSERT INTO sources(id,name,kind,tier,lane,participation_mode,enabled,next_fetch_at,config)
    VALUES(${id},${extra.name ?? NAME},'rss','T1',${extra.lane ?? "news"},${extra.mode ?? "editorial"},true,'2100-01-01',${sql.json({ language: "en" })})`;
  await grantDateFixture(id, ["https://example.com/source", "https://mp.weixin.qq.com/s"]);
  return id;
}

/** A discovered article whose first read left `body` (as when its page was read once and gave no usable text). */
async function article(sourceId: string, body: string | null, url = `https://example.com/reread-${T}-${++serial}`) {
  const { articleId } = await upsertMaterial({
    sourceId,
    url,
    title: `Copper mine update ${T} ${serial}`,
    language: "en",
    bodyText: body,
    excerpt: null,
    bodyStatus: "unconfirmed",
    via: "fetch",
    publishedAt: new Date(),
  } as never);
  const src = (await readSourceDateContext(sourceId))!,
    permission = (await readCurrentSourcePolicy(sourceId))!;
  // The first read of this exact configuration is on record, so the configuration-change resume stays out of the way.
  await audit(
    "worker",
    "content.body-read",
    `content:${articleId}`,
    "synthetic first read",
    null,
    { outcome: "unconfirmed" },
    bodyReadingKey({ id: articleId, revision: 1, url }, src.config, permission.permission_version),
  );
  return articleId;
}

const row = async (id: string) =>
  (await sql`SELECT revision,processing_state,processing_error,processing_retry_at,body_status FROM articles WHERE id=${id}`)[0]!;
const audits = async (id: string, action: string) =>
  (await sql`SELECT count(*)::int AS n FROM audit_log WHERE subject=${`content:${id}`} AND action=${action}`)[0]!.n as number;
const receipts = async () => (await sql`SELECT count(*)::int AS n FROM receipts`)[0]!.n as number;
const minutesFromNow = (at: Date) => Math.round((at.getTime() - Date.now()) / 60_000);
const makeDue = (id: string) => sql`UPDATE articles SET processing_retry_at=now() - interval '1 minute' WHERE id=${id}`;
/** What the queued read does when the page still gives no usable text: the body stays unconfirmed and analysis follows. */
async function readFindsNothing(id: string) {
  const jobs = await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=${id} AND name=${QUEUES.extractBody} RETURNING priority`;
  await sql`UPDATE articles SET body_status='unconfirmed' WHERE id=${id}`;
  return jobs;
}

test("the threshold reads the material as the writer does; the schedule and reason are fixed", () => {
  assert.equal(articleMaterialTooShort(null, null), true);
  assert.equal(articleMaterialTooShort("产能10万吨", null), true, "a few characters are still a title-only card");
  assert.equal(articleMaterialTooShort("x".repeat(19), null), true);
  assert.equal(articleMaterialTooShort("x".repeat(20), null), false);
  assert.equal(articleMaterialTooShort(`   ${"x".repeat(19)}\n\n  `, null), true, "trimmed like the writer's text");
  assert.equal(articleMaterialTooShort("。".repeat(30), "y".repeat(25)), false, "a body without letters or digits gives way to the excerpt");
  assert.equal(articleMaterialTooShort("Copper.", "y".repeat(80)), true, "the writer reads a body with letters before the excerpt");
  const now = new Date("2026-11-08T00:00:00Z");
  assert.deepEqual(
    [0, 1, 2, 3].map((n) => nextBodyReread(n, now)?.toISOString() ?? null),
    ["2026-11-08T00:30:00.000Z", "2026-11-08T03:00:00.000Z", "2026-11-08T12:00:00.000Z", null],
  );
  assert.deepEqual(BODY_REREAD_DELAYS_MINUTES, [30, 180, 720]);
  assert.equal(bodyUnreadableReason(3, "福建省住房和城乡建设厅"), "body_unreadable: 正文读取失败（重读 3 次）｜信源：福建省住房和城乡建设厅");
  assert.equal(bodyUnreadableReason(0, "X", "unfetchable"), "body_unreadable: 正文读取失败（来源页面不能重读）｜信源：X");
  const estimate = bodyBackfillEstimate(3, 5).join("\n");
  assert.match(estimate, /预计能读到正文：3 条.*3 × 1–7 = 3–21 次/);
  assert.match(estimate, /上限：全部 5 条都能读到，5 × 1–7 = 5–35 次/);
  assert.match(estimate, /\+3 小时、\+12 小时/);
});

test("a short article waits without a paid step, is read again three times, then fails per source and can be retried", async () => {
  const src = await source();
  const id = await article(src, "Copper update.");
  assert.deepEqual(await runAnalysisJob({ articleId: id }), { state: "awaiting-body" });
  let r = await row(id);
  assert.equal(r.processing_state, "analyzed");
  assert.equal(r.processing_error, "body_retry: 正文不足 20 字，等待第 1 次重读");
  assert.ok(Math.abs(minutesFromNow(r.processing_retry_at) - 30) <= 1, "first read again after 30 minutes");
  const [judgement] = await sql`SELECT relevance,score,receipt_ids,output FROM analyses WHERE article_id=${id} ORDER BY id DESC LIMIT 1`;
  assert.deepEqual([judgement!.relevance, judgement!.score, judgement!.receipt_ids, judgement!.output.scores], ["unknown", null, [], null]);
  assert.equal((await sql`SELECT visibility FROM publications WHERE article_id=${id}`)[0]?.visibility ?? "withdrawn", "withdrawn");

  // Not due yet: the sweep leaves it alone.
  await sweepUnprocessed();
  assert.equal(await audits(id, "content.body-reread"), 0);
  for (const [attempt, next] of [
    [1, 180],
    [2, 720],
  ] as const) {
    await makeDue(id);
    await sweepUnprocessed();
    assert.equal(await audits(id, "content.body-reread"), attempt);
    r = await row(id);
    assert.deepEqual([r.processing_state, r.body_status, r.processing_error], ["new", "pending", null], "an ordinary read is queued");
    const [job] = await readFindsNothing(id);
    assert.equal(job?.priority, -2, "behind live work");
    assert.deepEqual(await runAnalysisJob({ articleId: id }), { state: "awaiting-body" });
    r = await row(id);
    assert.equal(r.processing_error, `body_retry: 正文不足 20 字，等待第 ${attempt + 1} 次重读`);
    assert.ok(Math.abs(minutesFromNow(r.processing_retry_at) - next) <= 1);
  }
  await makeDue(id);
  await sweepUnprocessed();
  assert.equal(await audits(id, "content.body-reread"), 3);
  await readFindsNothing(id);
  assert.deepEqual(await runAnalysisJob({ articleId: id }), { state: "body-unreadable" });
  r = await row(id);
  assert.deepEqual(
    [r.processing_state, r.processing_error, r.processing_retry_at],
    ["failed", `body_unreadable: 正文读取失败（重读 3 次）｜信源：${NAME}`, null],
  );
  assert.equal(await audits(id, "content.body-unreadable"), 1);
  assert.equal((await sql`SELECT visibility FROM publications WHERE article_id=${id}`)[0]?.visibility ?? "withdrawn", "withdrawn");
  assert.equal(await receipts(), 0, "no model request at any point");

  // The runs page lists it under its reason, which names the source, with a link to the article's diagnosis.
  const [group] = await sql`SELECT ${failureGroupSql()} AS label FROM articles WHERE id=${id}`;
  const listed = (await runsOverview()).errors.find((e) => e.error === group!.label);
  assert.ok(listed, "listed among processing failures");
  assert.equal(listed.example, id);
  assert.match(listed.error, /正文读取失败.*Synthetic reread source/);

  // A retry from the diagnosis page reads the page now and starts a new cycle of three reads.
  assert.ok((await rerun(id, "extract", `reread-retry-${T}`, "test-admin", { reason: "check the page again" }))?.jobId);
  await readFindsNothing(id);
  assert.deepEqual(await runAnalysisJob({ articleId: id }), { state: "awaiting-body" });
  assert.equal((await row(id)).processing_error, "body_retry: 正文不足 20 字，等待第 1 次重读");
});

test("material read later gets the normal analysis; pages that cannot be read again fail at once; a paused source waits", async () => {
  const src = await source();
  const readable = await article(src, "Copper.");
  assert.equal((await runAnalysisJob({ articleId: readable })).state, "awaiting-body");
  assert.equal(awaitsMaterial((await loadAnalyzeInput(readable))!), true);
  // What a successful read does: a new material revision, which the analysis judges with its normal (paid) steps.
  await sql`UPDATE articles SET body_text=${"The mine reported copper output and new processing plant figures. ".repeat(4)},
    revision=revision+1,processing_state='new',processing_error=NULL,processing_retry_at=NULL WHERE id=${readable}`;
  assert.equal(awaitsMaterial((await loadAnalyzeInput(readable))!), false);
  assert.equal(await settleShortBody(readable, 2), "stale", "material that arrived ends the schedule");

  const wechat = await article(src, null, `https://mp.weixin.qq.com/s/reread-${T}`);
  assert.equal((await runAnalysisJob({ articleId: wechat })).state, "awaiting-body");
  await makeDue(wechat);
  await sweepUnprocessed();
  assert.deepEqual(
    [(await row(wechat)).processing_state, (await row(wechat)).processing_error],
    ["failed", `body_unreadable: 正文读取失败（来源页面不能重读）｜信源：${NAME}`],
  );

  const paused = await article(src, "Short.");
  assert.equal((await runAnalysisJob({ articleId: paused })).state, "awaiting-body");
  await makeDue(paused);
  await sql`UPDATE sources SET enabled=false WHERE id=${src}`;
  try {
    await sweepUnprocessed();
  } finally {
    await sql`UPDATE sources SET enabled=true WHERE id=${src}`;
  }
  const waiting = await row(paused);
  assert.equal(waiting.processing_state, "analyzed");
  assert.ok(minutesFromNow(waiting.processing_retry_at) >= 59, "a paused source waits an hour, without a read");
  assert.equal(await audits(paused, "content.body-reread"), 0);
});

test("the backfill dry run counts per source with a paid estimate; apply schedules a bounded, resumable batch off-peak", async () => {
  const script = fileURLToPath(new URL("../scripts/body-reread-backfill.ts", import.meta.url));
  const run = async (...args: string[]) => (await promisify(execFile)(process.execPath, [script, ...args], { env: process.env, encoding: "utf8" })).stdout;
  // Judged on a title before the rule: scored, no writing, stuck in "analyzed".
  const stuck = async (sourceId: string, body: string | null) => {
    const id = await article(sourceId, body);
    await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${id}`;
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,selected,score,receipt_ids,output)
      VALUES(${id},1,'model','unknown',false,70,'{1,2,3}'::bigint[],${sql.json({ scores: [70, 70], writer: "none" })})`;
    return id;
  };
  const pdfSource = await source({ name: "Synthetic PDF source" }),
    quietSource = await source({ name: "Synthetic quiet source" }),
    policySource = await source({ lane: "policy", name: "Synthetic policy source" });
  // The PDF source has read bodies recently, so its backlog counts as likely readable.
  await upsertMaterial({
    sourceId: pdfSource,
    url: `https://example.com/readable-${T}`,
    title: `Readable ${T}`,
    language: "en",
    bodyText: "Platinum supply and demand figures for the quarter. ".repeat(6),
    bodyStatus: "unconfirmed",
    via: "fetch",
  } as never);
  const a = await stuck(pdfSource, "Q3 2026"),
    b = await stuck(pdfSource, null),
    c = await stuck(quietSource, "Notice."),
    manual = await stuck(quietSource, null),
    long = await stuck(quietSource, "The quarterly report explains production and costs in detail."),
    policy = await stuck(policySource, null);
  await sql`INSERT INTO editorial_overrides(article_id,fields,visibility,updated_by) VALUES(${manual},'{}','withdrawn','synthetic-owner')`;
  const before = await sql`SELECT id,processing_error,processing_retry_at FROM articles WHERE id=ANY(${[a, b, c, manual, long, policy]}) ORDER BY id`;

  const dry = await run();
  assert.match(dry, /预演，不写入）：候选 3 条，来自 2 个信源；人工控制或已补读过而跳过 1 条/);
  assert.match(dry, new RegExp(`\\n\\s+2  是\\s+${pdfSource}  Synthetic PDF source`));
  assert.match(dry, new RegExp(`\\n\\s+1  否\\s+${quietSource}  Synthetic quiet source`));
  assert.match(dry, /其中读者现在看得到的 0 条/);
  assert.match(dry, /预计能读到正文：2 条.*2 × 1–7 = 2–14 次/);
  assert.match(dry, /上限：全部 3 条都能读到，3 × 1–7 = 3–21 次/);
  assert.deepEqual(
    await sql`SELECT id,processing_error,processing_retry_at FROM articles WHERE id=ANY(${[a, b, c, manual, long, policy]}) ORDER BY id`,
    before,
  );
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='content.body-backfill'`)[0]!.n, 0, "the dry run writes nothing");

  await assert.rejects(run("--apply"), (error: { code?: number }) => error.code === 2, "--apply needs --limit");
  const first = await run("--apply", "--limit", "2");
  assert.match(first, /已安排 2 条补读.*剩余候选 1 条/);
  const scheduled = await sql`SELECT id,processing_error,processing_retry_at <= now() AS due FROM articles
    WHERE processing_error LIKE 'body_retry:%' AND id=ANY(${[a, b, c]}) ORDER BY id`;
  assert.equal(scheduled.length, 2);
  assert.ok(scheduled.every((s) => s.processing_error === "body_retry: 正文不足 20 字，等待第 1 次重读" && s.due));
  const second = await run("--apply", "--limit", "5");
  assert.match(second, /候选 1 条.*\n[\s\S]*已安排 1 条补读.*剩余候选 0 条/);
  assert.match(await run(), /候选 0 条/);
  for (const id of [manual, long, policy]) assert.equal(await bodyBackfilled(id), false);
  assert.equal(await bodyBackfilled(a), true);
  assert.equal(await receipts(), 0);

  // After a successful read, the backfilled article's paid analysis waits for the off-peak hours, behind live work.
  const peak = new Date("2026-11-09T02:00:00Z"); // a Monday, inside the provider's 01:00–04:00 UTC peak window
  await sql`UPDATE articles SET processing_state='new',processing_error=NULL,processing_retry_at=NULL WHERE id=${a}`;
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=${a}`;
  assert.ok(await queueProcessing(a, { step: "analyze", lowPriority: true, offPeak: true, now: peak }));
  const deferred = await row(a);
  assert.deepEqual([deferred.processing_error, deferred.processing_retry_at.toISOString()], [OFF_PEAK_WAIT, "2026-11-09T04:00:00.000Z"]);
  const [job] = await sql`SELECT priority,start_after FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=${a}`;
  assert.equal(job!.priority, -2);
  assert.equal(new Date(job!.start_after).toISOString(), "2026-11-09T04:00:00.000Z");
});

test("a manual revision made during the wait stops rereading; a concurrent withdrawal wins before the material reset", async () => {
  const src = await source();
  const revised = await article(src, "Copper update.");
  await runAnalysisJob({ articleId: revised });
  const fields = { title: "人工核对的铜矿更新", summary: "人工根据原文核对的中文导读，保留人工修订。" };
  await overrideFields(
    revised,
    {
      fields,
      reason: "synthetic manual revision",
      version: 0,
      command: "publish",
      source_revision: 1,
      source_checked: true,
      facts_checked: true,
      evidence_quote: "Copper update.",
    },
    "synthetic-owner",
  );
  const before = await sql`SELECT title,summary,visibility FROM publications WHERE article_id=${revised}`;
  await makeDue(revised);
  await sweepUnprocessed();
  assert.equal(await audits(revised, "content.body-reread"), 0);
  assert.equal((await row(revised)).revision, 1);
  assert.equal((await row(revised)).processing_retry_at, null, "manual control ends the automatic wait");
  assert.equal(await settleShortBody(revised, 1), "stale", "settling cannot restart a manually controlled wait");
  assert.deepEqual(await sql`SELECT title,summary,visibility FROM publications WHERE article_id=${revised}`, before);
  assert.equal((await sql`SELECT state FROM publication.manual_copies WHERE article_id=${revised}`)[0]!.state, "active");
  await sql`UPDATE sources SET config=config || ${sql.json({ acceptLanguage: "en-GB" })} WHERE id=${src}`;
  await sweepUnprocessed();
  assert.equal(await audits(revised, "content.body-resume"), 0, "a new reading configuration cannot bypass manual control either");
  assert.equal((await row(revised)).processing_state, "analyzed");

  const withdrawn = await article(src, "Copper update.");
  await runAnalysisJob({ articleId: withdrawn });
  await makeDue(withdrawn);
  let sweeping: Promise<unknown> | undefined;
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
      sweeping = sweepUnprocessed();
      // The due-list read has finished when its transaction waits for the same fence used by manual edits.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [waiter] = await sql`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%withdrawal-membership%'`;
        if (waiter!.n) break;
        assert.ok(Date.now() < deadline, "rereading must acquire the manual-publication fence before resetting material");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await tx`INSERT INTO editorial_overrides(article_id,fields,visibility,updated_by)
        VALUES(${withdrawn},'{}','withdrawn','synthetic-owner')`;
    });
  } finally {
    await sweeping;
  }
  assert.equal(await audits(withdrawn, "content.body-reread"), 0);
  assert.equal((await row(withdrawn)).body_status, "unconfirmed");
  assert.equal((await row(withdrawn)).processing_retry_at, null);
  assert.equal((await sql`SELECT id FROM pgboss.job WHERE name=${QUEUES.extractBody} AND data->>'articleId'=${withdrawn}`).length, 0);
  assert.equal(await receipts(), 0);
});

test("an unreadable historical public short article is withdrawn from the public projection; later manual copy still wins", async () => {
  const src = await source();
  const id = await article(src, "Copper update.", `https://mp.weixin.qq.com/s/legacy-${T}`);
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${id}`;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,selected,score,title_zh,summary_zh,output)
    VALUES(${id},1,'model','pass',false,70,'旧模型生成的铜矿标题','旧模型仅凭很短材料写出的中文导读。',${sql.json({ writer: "summarize" })})`;
  await publishArticle(id);
  assert.equal((await sql`SELECT visibility FROM publications WHERE article_id=${id}`)[0]!.visibility, "public");
  assert.ok(await v3Item(id), "public API includes the old model copy before rereading");
  assert.ok((await itemFeed("all", null)).includes(id), "RSS includes it before rereading");
  assert.ok(await scheduleBodyBackfill({ id, revision: 1, sourceId: src, sourceName: NAME }));
  await makeDue(id);
  await sweepUnprocessed();
  assert.equal((await row(id)).processing_state, "failed");
  assert.match((await row(id)).processing_error, /body_unreadable:.*来源页面不能重读/);
  const [publication] = await sql`SELECT visibility,eligible FROM publications WHERE article_id=${id}`;
  assert.deepEqual([publication!.visibility, publication!.eligible], ["withdrawn", false]);
  assert.equal((await sql`SELECT article_id FROM pool_search WHERE article_id=${id}`).length, 0);
  assert.equal(await v3Item(id), null, "public API follows the same withdrawn projection");
  assert.ok(!(await itemFeed("all", null)).includes(id), "RSS follows the same withdrawn projection");
  await publishArticle(id);
  assert.equal(
    (await sql`SELECT visibility FROM publications WHERE article_id=${id}`)[0]!.visibility,
    "withdrawn",
    "normal reprojection cannot revive old model copy",
  );
  await overrideFields(
    id,
    {
      fields: { title: "人工核对的铜矿标题", summary: "人工核对后的铜矿导读，按原文保留必要说明。" },
      reason: "synthetic reviewed correction",
      version: 0,
      command: "publish",
      source_revision: 1,
      source_checked: true,
      facts_checked: true,
      evidence_quote: "Copper update.",
    },
    "synthetic-owner",
  );
  assert.equal(
    (await sql`SELECT visibility FROM publications WHERE article_id=${id}`)[0]!.visibility,
    "public",
    "explicit manual copy outranks the automatic failure",
  );
  assert.equal(await receipts(), 0);
});
