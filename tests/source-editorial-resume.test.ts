import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { readCurrentSourcePolicy, saveSourcePolicy, updateSource } from "@amp/backend/admin/sources";
import { getBoss, QUEUES, stopBoss } from "@amp/backend/jobs/queue";
import { settleNonEditorial, sweepUnprocessed } from "@amp/backend/jobs/content";
import { grantDateFixture } from "./source-date-fixture.ts";

before(async () => {
  process.env.COLLECT_ENABLED = "true";
  process.env.COLLECT_NEWS_ENABLED = "true";
  await getBoss();
});
after(async () => {
  await stopBoss();
  await closeDb();
});

async function source() {
  const id = `editorial-resume-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,lane,enabled,participation_mode,config)
    VALUES(${id},'Synthetic editorial promotion','rss','news',true,'hot_signal',${sql.json({ feedUrl: "https://example.invalid/feed", language: "zh" })})`;
  await grantDateFixture(id, ["https://example.invalid/"]);
  return id;
}
async function signal(sourceId: string) {
  const { articleId } = await upsertMaterial({
    sourceId,
    url: `https://example.invalid/${tag()}`,
    title: "合成铜矿项目进展",
    language: "zh",
    bodyText: "合成铜矿项目披露建设进度与设计产能，文字仅供自动续接测试。",
    bodyStatus: "ok",
    publishedAt: new Date(),
    via: "fetch",
  });
  await settleNonEditorial(articleId);
  await sql`UPDATE articles SET grouping_status='complete',grouping_input_revision=revision,
    selection_adds_value=true,selection_value_reason='Synthetic signal decision',grouped_at=now() WHERE id=${articleId}`;
  return articleId;
}
async function promote(id: string) {
  const [current] = await sql`SELECT updated_at FROM sources WHERE id=${id}`;
  await updateSource(
    id,
    { patch: { participation_mode: "editorial" }, version: current!.updated_at.toISOString(), reason: "Synthetic Owner decision" },
    "test-owner",
  );
}
const snapshot = async (ids: string[]) =>
  sql`SELECT id,source_id,revision,body_status,processing_state,processing_error,grouping_status,grouping_input_revision,
    selection_adds_value,selection_value_reason,grouped_at FROM articles WHERE id=ANY(${ids}::text[]) ORDER BY id`;
const analysisJobs = (ids: string[]) => sql`SELECT data FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=ANY(${ids}::text[]) ORDER BY id`;

test("an actual source-mode change lets the server resume only unjudged automatic signals once", async () => {
  const sourceId = await source();
  const ready = await signal(sourceId),
    restored = await signal(sourceId),
    unfinished = await signal(sourceId),
    judged = await signal(sourceId),
    edited = await signal(sourceId),
    withdrawn = await signal(sourceId),
    manualGroup = await signal(sourceId),
    standalone = await signal(sourceId),
    unexplained = await signal(sourceId);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,selected)
    VALUES(${judged},1,'rule','pass',false)`;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,output) VALUES(${unfinished},1,'model','{}'::jsonb)`;
  await sql`INSERT INTO editorial_overrides(article_id,fields,updated_by) VALUES(${edited},'{"title":"人工保留标题"}','test')`;
  await sql`INSERT INTO editorial_overrides(article_id,visibility,updated_by) VALUES(${withdrawn},'withdrawn','test')`;
  await sql`INSERT INTO editorial_overrides(article_id,visibility,updated_by) VALUES(${restored},'public','test')`;
  const [story] = await sql`INSERT INTO stories(public_id,title) VALUES(${crypto.randomUUID()},'Synthetic signal story') RETURNING id`;
  await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at)
    VALUES(${story!.id},${ready},${sourceId},${sourceId},'signal',now())`;
  const [fact] = await sql`INSERT INTO facts(public_id,title) VALUES(${`promotion-${tag()}`},'Synthetic manual fact') RETURNING id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,manual,input_revision) VALUES(${fact!.id},${manualGroup},true,1)`;
  await sql`INSERT INTO grouping_overrides(article_id,reason,actor) VALUES(${standalone},'Keep standalone','test')`;
  await sql`UPDATE articles SET processing_error='unresolved prior failure' WHERE id=${unexplained}`;
  const protectedIds = [judged, edited, withdrawn, manualGroup, standalone, unexplained],
    before = await snapshot(protectedIds),
    receipts = await sql`SELECT count(*)::int AS n FROM receipt_attempts`;
  await promote(sourceId);
  await sweepUnprocessed();
  const [row] = await snapshot([ready]);
  assert.equal(row!.processing_state, "new", "the ordinary server sweep must resume an approved source's unjudged signal");
  assert.equal(row!.revision, 1);
  assert.equal(row!.grouping_status, "pending");
  assert.equal(row!.grouping_input_revision, null);
  assert.equal(row!.selection_adds_value, null, "signal-only completion is not editorial confirmation");
  assert.equal(row!.grouped_at, null);
  assert.equal((await sql`SELECT 1 FROM story_signals WHERE article_id=${ready}`).length, 0, "old heat evidence is removed through the event owner");
  assert.deepEqual(
    (await analysisJobs([ready])).map((job) => job.data.lane),
    ["news"],
  );
  assert.equal((await analysisJobs([restored])).length, 1, "a restored public override is not a permanent historical exclusion");
  assert.equal((await analysisJobs([unfinished])).length, 1, "a record without a judgement does not strand the approved continuation");
  assert.equal((await analysisJobs(protectedIds)).length, 0);
  assert.deepEqual(await snapshot(protectedIds), before, "current judgements and human decisions are not reset");
  await sweepUnprocessed();
  assert.equal((await analysisJobs([ready])).length, 1);
  assert.deepEqual(await sql`SELECT count(*)::int AS n FROM receipt_attempts`, receipts);
});

test("paused source and lane preserve the promotion until the normal sweep can continue", async () => {
  const sourceId = await source(),
    id = await signal(sourceId);
  const [control] = await sql`SELECT paused,reason,actor,expires_at FROM ops.lane_controls WHERE lane='news' AND switch='processing' AND holder='owner'`;
  await sql`UPDATE ops.lane_controls SET paused=true,reason='Synthetic pause',actor='test',expires_at=now()+interval '1 day'
    WHERE lane='news' AND switch='processing' AND holder='owner'`;
  try {
    await promote(sourceId);
    await sweepUnprocessed();
    assert.equal((await analysisJobs([id])).length, 0);
    assert.equal((await snapshot([id]))[0]!.processing_state, "skipped");
    await sql`UPDATE ops.lane_controls SET paused=${control!.paused},reason=${control!.reason},actor=${control!.actor},expires_at=${control!.expires_at}
      WHERE lane='news' AND switch='processing' AND holder='owner'`;
    await sql`UPDATE sources SET enabled=false WHERE id=${sourceId}`;
    await sweepUnprocessed();
    assert.equal((await analysisJobs([id])).length, 0);
    await sql`UPDATE sources SET enabled=true WHERE id=${sourceId}`;
    await sweepUnprocessed();
    assert.equal((await analysisJobs([id])).length, 1, "pause must not consume the automatic continuation");
  } finally {
    await sql`UPDATE ops.lane_controls SET paused=${control!.paused},reason=${control!.reason},actor=${control!.actor},expires_at=${control!.expires_at}
      WHERE lane='news' AND switch='processing' AND holder='owner'`;
  }
});

test("unproved skipped records and denied current processing permission do not authorize continuation", async () => {
  const unprovedSource = await source(),
    unproved = await signal(unprovedSource);
  await sql`UPDATE sources SET participation_mode='editorial' WHERE id=${unprovedSource}`;
  const policySource = await source(),
    policyMaterial = await signal(policySource);
  await sql`UPDATE sources SET lane='policy' WHERE id=${policySource}`;
  await promote(policySource);
  const sourceId = await source(),
    held = await signal(sourceId),
    permission = (await readCurrentSourcePolicy(sourceId))!;
  await saveSourcePolicy(
    sourceId,
    {
      policy: { ...permission, permissions: { ...permission.permissions, external_model: "deny" } },
      expectedVersion: permission.permission_version,
      reason: "Synthetic permission hold",
    },
    "test-owner",
  );
  await promote(sourceId);
  await sweepUnprocessed();
  assert.equal((await analysisJobs([unproved, policyMaterial, held])).length, 0);
  assert.ok((await snapshot([unproved, policyMaterial, held])).every((row) => row.processing_state === "skipped"));
  const current = (await readCurrentSourcePolicy(sourceId))!;
  await saveSourcePolicy(sourceId, { policy: permission, expectedVersion: current.permission_version, reason: "Synthetic permission restored" }, "test-owner");
  await sweepUnprocessed();
  assert.equal((await analysisJobs([held])).length, 1);
  assert.equal((await analysisJobs([unproved, policyMaterial])).length, 0);
});
