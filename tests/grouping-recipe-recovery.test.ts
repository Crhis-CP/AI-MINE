import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { recoverPendingGroupings } from "@amp/backend/events/group";
import { stopBoss, ensureQueue, QUEUES } from "@amp/backend/jobs/queue";
import { enqueueJob } from "../packages/backend/src/jobs/module-queues.ts";
import { BATCH_PROMPT_VERSION, FACT_CONVERGENCE_VERSION } from "../packages/backend/src/events/relate.ts";
import { failMaterialGrouping } from "../packages/backend/src/content/grouping.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
import { readCurrentSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";

const failure = "Every candidate and any unknown query scope require an explicit answer";
after(async () => {
  await stopBoss();
  await closeDb();
});
beforeEach(async () => {
  await sql`UPDATE sources SET enabled=false`;
  await ensureQueue(QUEUES.group);
  await sql`DELETE FROM pgboss.job WHERE name='events.group'`;
});
async function fixture(recipe = "previous-group-recipe") {
  const source = `recipe-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind) VALUES(${source},'合成矿业来源','rss')`;
  const { articleId } = await upsertMaterial({
    sourceId: source,
    url: `https://example.com/${source}`,
    title: "矿企项目正式获批",
    bodyText: "合成公告正文",
    via: "fetch",
  });
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${articleId}`;
  const receiptId = await rejectedReceipt(articleId, recipe);
  await failMaterialGrouping(articleId, 1, { waiting: false, receiptId: Number(receiptId), error: `Error: ${failure}` });
  return { id: articleId, source, receiptId };
}
async function rejectedReceipt(id: string, recipe: string) {
  const response = { choices: [{ message: { content: JSON.stringify({ decisions: [], selection: { addsValue: false, reason: "合成输出" } }) } }] };
  const [r] = await sql<
    { id: string }[]
  >`INSERT INTO receipts(logical_key,service,model,purpose,subject,status,request,response,attempts,error,cost,currency,cost_basis)
    VALUES(${tag()},'deepseek','deepseek-flash','group_article',${`article:${id}@1`},'failed',${sql.json({ lane: "news", promptVersion: recipe })},${sql.json(response)},1,${`unusable output: ${failure}`},1.25,'CNY','actual') RETURNING id::text`;
  const [attempt] = await sql<
    { id: string }[]
  >`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,response,cost,currency,cost_basis,finished_at)
    VALUES(${r!.id},1,'deepseek','deepseek-flash','received',${sql.json(response)},1.25,'CNY','actual',now()) RETURNING id::text`;
  await sql`UPDATE receipts SET response_attempt_id=${attempt!.id} WHERE id=${r!.id}`;
  return r!.id;
}

async function completedSplit() {
  const f = await fixture("group-batch+group-value@previous");
  const [story] = await sql`INSERT INTO stories(public_id,title) VALUES(${crypto.randomUUID()},'合成公告及解读') RETURNING id`;
  const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${`f${tag()}`},${story.id},'合成后发解读') RETURNING id`;
  await sql`UPDATE receipts SET status='completed',error=NULL WHERE id=${f.receiptId}`;
  await sql`UPDATE articles SET grouping_status='complete',grouping_input_revision=revision,selection_adds_value=true,
    selection_value_reason='旧解读规则',grouped_at=now(),backfill=false,published_at=now()-interval '1 minute' WHERE id=${f.id}`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,input_revision) VALUES(${fact.id},${f.id},1)`;
  await sql`INSERT INTO publications(article_id,source_id,channel,title,visibility,eligible,selected,selection_candidate,seat,fact_id,story_id,url,discovered_at,timeline_at,sort_at,visible_after)
    VALUES(${f.id},${f.source},'news','合成公告及解读','public',true,true,true,true,${fact.id},${story.id},${`https://example.com/${f.id}`},now(),now(),now(),now())`;
  await sql`INSERT INTO grouping_decisions(article_id,fact_id,story_id,verdict,candidates,receipt_id,input_revision)
    VALUES(${f.id},${fact.id},${story.id},'new-fact-in-story','[{"id":1,"relation":"SAME_STORY","confidence":0.93}]',${f.receiptId},1)`;
  return { ...f, fact: Number(fact.id), story: Number(story.id) };
}
const state = async (id: string) =>
  (await sql`SELECT grouping_status,grouping_receipt_id::text,grouping_retry_at,processing_state FROM articles WHERE id=${id}`)[0]!;
const paid = async (receiptId: string) => ({
  receipt: (await sql`SELECT * FROM receipts WHERE id=${receiptId}`)[0],
  attempts: await sql`SELECT * FROM receipt_attempts WHERE receipt_id=${receiptId} ORDER BY attempt`,
});

test("changed grouping recipe resumes an exhausted known-output failure once without altering paid evidence or scoring", async () => {
  const f = await fixture();
  const evidence = await paid(f.receiptId);
  const exhausted = await enqueueJob(QUEUES.group, { lane: "news", articleId: f.id }, { singletonKey: f.id });
  await sql`UPDATE pgboss.job SET state='failed',retry_count=3,completed_on=now() WHERE name='events.group' AND id=${exhausted}`;
  const results = await Promise.all([recoverPendingGroupings(1), recoverPendingGroupings(1)]);
  assert.equal(
    results.reduce((n, r) => n + r.enqueued, 0),
    1,
    "concurrent sweeps claim once",
  );
  assert.equal((await state(f.id)).grouping_status, "pending");
  assert.equal((await state(f.id)).processing_state, "analyzed");
  assert.deepEqual(await paid(f.receiptId), evidence, "response, attempts, cost and original failure remain unchanged");
  assert.equal((await recoverPendingGroupings(1)).enqueued, 0);
  await sql`DELETE FROM pgboss.job WHERE name='events.group' AND data->>'articleId'=${f.id}`;
  const newReceipt = await rejectedReceipt(f.id, BATCH_PROMPT_VERSION);
  await failMaterialGrouping(f.id, 1, { waiting: false, receiptId: Number(newReceipt), error: `Error: ${failure}` });
  await sql`UPDATE articles SET grouping_retry_at=now()-interval '1 hour' WHERE id=${f.id}`;
  assert.equal((await recoverPendingGroupings()).enqueued, 0, "the same rejected current recipe cannot loop on the recovery timer");
  assert.equal((await state(f.id)).grouping_status, "failed");
  assert.deepEqual(await paid(f.receiptId), evidence);
});

test("unknown, in-flight, unrelated, revised, disabled and already queued work is not released", async () => {
  const unknown = await fixture(),
    inflight = await fixture(),
    unrelated = await fixture(),
    revised = await fixture(),
    disabled = await fixture(),
    queued = await fixture();
  await sql`UPDATE receipts SET status='unknown' WHERE id=${unknown.receiptId}`;
  await sql`UPDATE receipts SET status='pending' WHERE id=${inflight.receiptId}`;
  await sql`UPDATE receipts SET error='transport rejected' WHERE id=${unrelated.receiptId}`;
  await sql`UPDATE articles SET revision=2 WHERE id=${revised.id}`;
  await sql`UPDATE sources SET enabled=false WHERE id=${disabled.source}`;
  await enqueueJob(QUEUES.group, { lane: "news", articleId: queued.id }, { singletonKey: queued.id, startAfter: 3600 });
  const fixtures = [unknown, inflight, unrelated, revised, disabled, queued];
  const before = await Promise.all(fixtures.map((f) => state(f.id)));
  assert.equal((await recoverPendingGroupings()).enqueued, 0);
  assert.deepEqual(await Promise.all(fixtures.map((f) => state(f.id))), before);
  assert.equal((await paid(unknown.receiptId)).receipt!.status, "unknown");
  assert.equal((await paid(inflight.receiptId)).receipt!.status, "pending");
});

test("manual lane pause prevents recipe rearming and leaves the eligible failure available after explicit resume", async () => {
  const f = await fixture();
  const before = await state(f.id);
  await sql`UPDATE ops.lane_controls SET paused=true,reason='合成人工暂停',actor='synthetic-owner',expires_at=now()+interval '1 hour' WHERE lane='news' AND switch='processing' AND holder='owner'`;
  try {
    assert.equal((await recoverPendingGroupings()).paused, true);
    assert.deepEqual(await state(f.id), before);
  } finally {
    await sql`UPDATE ops.lane_controls SET paused=false WHERE lane='news' AND switch='processing' AND holder='owner'`;
  }
  assert.equal((await recoverPendingGroupings(1)).enqueued, 1);
});

test("old completed story splits are admitted five at a time without changing their paid evidence", async () => {
  const fixtures = [];
  for (let i = 0; i < 6; i++) fixtures.push(await completedSplit());
  const evidence = await Promise.all(fixtures.map((f) => paid(f.receiptId)));
  assert.equal((await recoverPendingGroupings()).enqueued, 5);
  assert.equal((await sql`SELECT count(*)::int AS n FROM regroup_pending WHERE article_id=ANY(${fixtures.map((f) => f.id)})`)[0].n, 5);
  assert.equal((await recoverPendingGroupings()).enqueued, 1, "already queued repairs do not consume the next batch");
  assert.equal((await recoverPendingGroupings()).enqueued, 0);
  assert.deepEqual(await Promise.all(fixtures.map((f) => paid(f.receiptId))), evidence);
});

test("completed split repair preserves current recipes, unknown attempts, revisions, manual controls and unavailable seats", async () => {
  const changes = [
    (f: Awaited<ReturnType<typeof completedSplit>>) =>
      sql`UPDATE receipts SET request=jsonb_set(request,'{promptVersion}',${sql.json(BATCH_PROMPT_VERSION)}) WHERE id=${f.receiptId}`,
    (f: Awaited<ReturnType<typeof completedSplit>>) => sql`UPDATE receipts SET status='unknown' WHERE id=${f.receiptId}`,
    (f: Awaited<ReturnType<typeof completedSplit>>) => sql`UPDATE receipts SET status='pending' WHERE id=${f.receiptId}`,
    (f: Awaited<ReturnType<typeof completedSplit>>) => sql`UPDATE receipts SET response_attempt_id=NULL WHERE id=${f.receiptId}`,
    (f: Awaited<ReturnType<typeof completedSplit>>) => sql`UPDATE articles SET revision=2 WHERE id=${f.id}`,
    (f: Awaited<ReturnType<typeof completedSplit>>) => sql`UPDATE articles SET discovered_at=now()-interval '15 days' WHERE id=${f.id}`,
    (f: Awaited<ReturnType<typeof completedSplit>>) => sql`UPDATE fact_articles SET manual=true WHERE article_id=${f.id}`,
    (f: Awaited<ReturnType<typeof completedSplit>>) =>
      sql`INSERT INTO grouping_overrides(article_id,reason,actor) VALUES(${f.id},'人工独立','synthetic-owner')`,
    (f: Awaited<ReturnType<typeof completedSplit>>) => sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${f.id}`,
    (f: Awaited<ReturnType<typeof completedSplit>>) => sql`UPDATE sources SET enabled=false WHERE id=${f.source}`,
    (f: Awaited<ReturnType<typeof completedSplit>>) => enqueueJob(QUEUES.group, { lane: "news", articleId: f.id }, { singletonKey: f.id, startAfter: 3600 }),
    (f: Awaited<ReturnType<typeof completedSplit>>) => sql`INSERT INTO grouping_decisions(article_id,verdict,input_revision) VALUES(${f.id},'kept',1)`,
  ];
  const fixtures = [];
  for (const change of changes) {
    const f = await completedSplit();
    await change(f);
    fixtures.push(f);
  }
  const before = await Promise.all(fixtures.map((f) => state(f.id)));
  assert.equal((await recoverPendingGroupings()).enqueued, 0);
  assert.deepEqual(await Promise.all(fixtures.map((f) => state(f.id))), before);
  assert.equal((await sql`SELECT count(*)::int AS n FROM regroup_pending WHERE article_id=ANY(${fixtures.map((f) => f.id)})`)[0].n, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM grouping_overrides WHERE article_id=ANY(${fixtures.map((f) => f.id)})`)[0].n, 1);
});

async function convergenceFixture(extra = 0) {
  const canonical = await completedSplit(),
    peer = await completedSplit(),
    anchor = await completedSplit();
  const residuals = [peer];
  for (let i = 0; i < extra; i++) residuals.push(await completedSplit());
  const all = [canonical, anchor, ...residuals];
  await sql`UPDATE facts SET story_id=${canonical.story} WHERE id=${peer.fact}`;
  for (const f of all) {
    const fact = f === canonical ? canonical.fact : peer.fact;
    await grantDateFixture(f.source, ["https://example.com/"]);
    await sql`UPDATE receipts SET request=jsonb_set(request,'{promptVersion}',${sql.json(BATCH_PROMPT_VERSION)}) WHERE id=${f.receiptId}`;
    await sql`UPDATE fact_articles SET fact_id=${fact} WHERE article_id=${f.id}`;
    await sql`UPDATE grouping_decisions SET fact_id=${fact},story_id=${canonical.story},verdict='same-fact',candidates='[]' WHERE article_id=${f.id}`;
    await sql`UPDATE publications SET fact_id=${fact},story_id=${canonical.story},selected=${f === canonical || f === anchor},seat=${f === canonical || f === anchor} WHERE article_id=${f.id}`;
  }
  const versions = await sql`SELECT id,source_date_version::int FROM articles WHERE id=ANY(${[anchor.id, canonical.id, peer.id]})`;
  const manifest = {
    materialRevision: 1,
    reports: versions.map((r) => ({ articleId: r.id, revision: 1, dateVersion: r.source_date_version, publicationRevision: 1 })),
    candidates: [canonical, peer].map((f) => ({ factId: f.fact, storyId: canonical.story, articleId: f.id, revision: 1 })),
  };
  const candidates = [peer, canonical].map((f, index) => ({ id: f.fact, relation: "SAME_OCCURRENCE", confidence: index ? 0.95 : 0.97 }));
  await sql`UPDATE grouping_decisions SET input_manifest=${sql.json(manifest)},candidates=${sql.json(candidates)} WHERE article_id=${anchor.id}`;
  return { canonical, peer, anchor, residuals, all, manifest };
}

async function finishConvergence(f: Awaited<ReturnType<typeof convergenceFixture>>, id = f.anchor.id, positive = true) {
  const fact = positive ? f.canonical.fact : f.peer.fact;
  const [material] = await sql`SELECT grouping_receipt_id FROM articles WHERE id=${id}`;
  await sql`UPDATE articles SET grouping_status='complete',grouping_input_revision=revision,selection_adds_value=${positive} WHERE id=${id}`;
  await sql`UPDATE fact_articles SET fact_id=${fact} WHERE article_id=${id}`;
  await sql`UPDATE publications SET visibility='public',eligible=true,fact_id=${fact},story_id=${f.canonical.story},selected=false,seat=false WHERE article_id=${id}`;
  await sql`DELETE FROM regroup_pending WHERE article_id=${id}`;
  await sql`DELETE FROM pgboss.job WHERE name='events.group' AND data->>'articleId'=${id}`;
  await sql`INSERT INTO grouping_decisions(article_id,fact_id,story_id,verdict,input_revision,receipt_id,input_manifest)
    VALUES(${id},${fact},${f.canonical.story},'same-fact',1,${material.grouping_receipt_id},${sql.json({
      ...f.manifest,
      factConvergenceVersion: FACT_CONVERGENCE_VERSION,
      factConvergence: positive
        ? { version: FACT_CONVERGENCE_VERSION, storyId: f.canonical.story, canonicalFactId: f.canonical.fact, factIds: [f.canonical.fact, f.peer.fact] }
        : null,
    })})`;
}

test("old same-occurrence conflict admits only its current selected anchor once, including after a negative completion", async () => {
  const f = await convergenceFixture(1);
  await sql`UPDATE publications SET revision=revision+1 WHERE article_id=${f.canonical.id}`;
  const reading = f.residuals[1]!;
  await sql`UPDATE grouping_decisions SET input_manifest=${sql.json({ ...f.manifest, reports: [...f.manifest.reports, { articleId: reading.id, revision: 1, dateVersion: null }] })} WHERE article_id=${f.anchor.id}`;
  await sql`UPDATE articles SET revision=2 WHERE id=${reading.id}`;
  const evidence = await Promise.all(f.all.map((r) => paid(r.receiptId)));
  const sweeps = await Promise.all([recoverPendingGroupings(), recoverPendingGroupings()]);
  assert.equal(
    sweeps.reduce((n, r) => n + r.enqueued, 0),
    1,
  );
  assert.equal((await state(f.anchor.id)).grouping_status, "pending");
  for (const r of [f.canonical, ...f.residuals]) assert.equal((await state(r.id)).grouping_status, "complete", "old evidence cannot move other members");
  await finishConvergence(f, f.anchor.id, false);
  assert.equal((await recoverPendingGroupings()).enqueued, 0, "the new algorithm's negative answer cannot rearm the old conflict");
  assert.deepEqual(await Promise.all(f.all.map((r) => paid(r.receiptId))), evidence);
});

test("new same-occurrence proof repairs residual members within the shared five limit and survives a witness moving to canonical", async () => {
  const f = await convergenceFixture(4);
  await finishConvergence(f);
  const invalidate = [
    [
      () => sql`UPDATE articles SET source_date_version=source_date_version+1 WHERE id=${f.peer.id}`,
      () => sql`UPDATE articles SET source_date_version=source_date_version-1 WHERE id=${f.peer.id}`,
    ],
    [
      () => sql`UPDATE fact_articles SET manual=true WHERE article_id=${f.peer.id}`,
      () => sql`UPDATE fact_articles SET manual=false WHERE article_id=${f.peer.id}`,
    ],
    [() => sql`UPDATE sources SET enabled=false WHERE id=${f.peer.source}`, () => sql`UPDATE sources SET enabled=true WHERE id=${f.peer.source}`],
    [
      () => sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${f.peer.id}`,
      () => sql`UPDATE publications SET visibility='public' WHERE article_id=${f.peer.id}`,
    ],
    [
      () => sql`UPDATE publications SET operator_withdrawn=true WHERE article_id=${f.peer.id}`,
      () => sql`UPDATE publications SET operator_withdrawn=false WHERE article_id=${f.peer.id}`,
    ],
    [
      () => sql`UPDATE receipts SET status='unknown' WHERE id=${f.peer.receiptId}`,
      () => sql`UPDATE receipts SET status='completed' WHERE id=${f.peer.receiptId}`,
    ],
  ];
  for (const [change, restore] of invalidate) {
    await change!();
    assert.equal((await recoverPendingGroupings()).enqueued, 0, "stale, manual, disabled, withdrawn or unknown evidence is not an anchor");
    await restore!();
  }
  const policy = (await readCurrentSourcePolicy(f.peer.source))!;
  await saveSourcePolicy(
    f.peer.source,
    {
      policy: { ...policy, permissions: { ...policy.permissions, external_model: "deny" } },
      expectedVersion: policy.permission_version,
      reason: "Synthetic permission denial",
    },
    "test",
  );
  assert.equal((await recoverPendingGroupings()).enqueued, 0, "denied evidence cannot nominate other members");
  await saveSourcePolicy(f.peer.source, { policy, expectedVersion: policy.permission_version + 1, reason: "Synthetic permission restoration" }, "test");
  const unknown = f.residuals.at(-1)!;
  await sql`UPDATE receipts SET status='unknown' WHERE id=${unknown.receiptId}`;
  const old = [await completedSplit(), await completedSplit()];
  const evidence = await Promise.all([...f.all, ...old].map((r) => paid(r.receiptId)));
  assert.equal((await recoverPendingGroupings()).enqueued, 5, "two old recipe repairs and three convergence repairs share one budget");
  assert.equal((await state(f.canonical.id)).grouping_status, "complete", "canonical membership is not rejudged");
  assert.equal((await state(f.peer.id)).grouping_status, "pending", "an ordinary nonselected member uses the same consumer");
  await finishConvergence(f, f.peer.id);
  await finishConvergence(f, f.residuals[1]!.id, false);
  assert.equal((await recoverPendingGroupings()).enqueued, 1, "a proof survives its original later-fact witness moving to canonical");
  assert.equal((await recoverPendingGroupings()).enqueued, 0);
  assert.equal((await state(f.residuals[1]!.id)).grouping_status, "complete", "a negative current-version member cannot loop under another positive anchor");
  assert.equal((await state(unknown.id)).grouping_status, "complete", "an unknown current paid attempt stays untouched");
  assert.deepEqual(await Promise.all([...f.all, ...old].map((r) => paid(r.receiptId))), evidence);
});
