import { sha256 } from "@amp/backend/lib/ids";
// Manual delivery recovery must claim one version before sending or changing its outcome.
import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "@amp/backend/config";
import { closeDb, sql } from "@amp/backend/db";
import { deliverContent, resendDelivery, markStaleDeliveries } from "@amp/backend/notify/deliver";
import { pushSelected } from "../packages/backend/src/notify/selected.ts";
import { geographyRecipe } from "../packages/backend/src/editorial/geography.ts";
import { buildApp } from "./site-app.ts";

const T = tag();
const TARGET = `test-delivery-${T}`;
const WEBHOOK = "https://delivery.invalid/test";
const app = await buildApp();
const ids: number[] = [];
const requests: number[] = [];
const articleIds = new Map<number, string>();
const cards: unknown[] = [];
let answer = async (_id: number) => Response.json({ code: 0 });

before(async () => {
  config.devAdmin = { displayName: T };
  process.env.TEST_DELIVERY_WEBHOOK = WEBHOOK;
  // Exercise the live branch entirely in-process; any unexpected network request fails the test.
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), WEBHOOK);
    const card = JSON.parse(String(init?.body)).card;
    cards.push(card);
    const id = Number(card.id ?? card.header.title.content);
    requests.push(id);
    return answer(id);
  }) as typeof fetch;
  config.feishuContentPushEnabled = true;
  await sql`INSERT INTO notify_targets (key, purpose, kind, config_ref, enabled)
    VALUES (${TARGET}, 'content', 'feishu_webhook', 'TEST_DELIVERY_WEBHOOK', true)`;
});
const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  config.feishuContentPushEnabled = false;
  await app.close();
  await sql`DELETE FROM audit_log WHERE actor = ${`dev:${T}`}`;
  await sql`DELETE FROM deliveries WHERE target_key = ${TARGET}`;
  await sql`DELETE FROM notify_targets WHERE key = ${TARGET}`;
  await closeDb();
});

async function delivery(status = "unknown") {
  const [row] = await sql<{ id: number }[]>`INSERT INTO deliveries (target_key, subject_kind, subject_id, dedupe_key, status)
    VALUES (${TARGET}, 'selected', 'test', ${`${T}-${ids.length}`}, ${status}) RETURNING id`;
  ids.push(row.id);
  const articleId = `delivery-${T}-${row.id}`;
  articleIds.set(row.id, articleId);
  await sql`INSERT INTO sources(id,name,kind) VALUES(${articleId},'合成来源','rss')`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
    VALUES(${articleId},${articleId},${articleId},${`https://example.com/${articleId}`},${String(row.id)},now(),now())`;
  await sql`INSERT INTO publications(article_id,source_id,channel,title,url,discovered_at,timeline_at,selected,seat,eligible,summary,sort_at,selection_candidate,visible_after)
    VALUES(${articleId},${articleId},'news',${String(row.id)},${`https://example.com/${articleId}`},now(),now(),true,true,true,'当前摘要',now(),true,now())`;
  await sql`UPDATE deliveries SET subject_id=${articleId},dedupe_key=${`selected:article:${articleId}`} WHERE id=${row.id}`;
  await sql`UPDATE deliveries SET payload = ${sql.json({ id: row.id })} WHERE id = ${row.id}`;
  return row.id;
}
const state = async (id: number) =>
  (
    await sql<{ status: string; attempts: number; version: string }[]>`
  SELECT status, attempts, updated_at::text AS version FROM deliveries WHERE id = ${id}`
  )[0];
const resolve = (id: number, outcome = "resend") =>
  app.inject({
    method: "POST",
    url: `/api/admin/deliveries/${id}/resolve`,
    headers: { "x-csrf-token": "dev" },
    payload: { outcome, note: "checked the group" },
  });

/** Hold writes, but allow both requests to read the same version before their updates race. */
async function hold(id: number) {
  const acquired = gate<number>();
  const release = gate();
  const done = sql.begin(async (tx) => {
    await tx`SELECT id FROM deliveries WHERE id = ${id} FOR UPDATE`;
    const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    acquired.open(row.pid);
    await release.promise;
  });
  const pid = await acquired.promise;
  return {
    release: async () => {
      release.open();
      await done;
    },
    blocked: async (count: number) => {
      const deadline = performance.now() + 5000;
      // Include waiters queued behind the first blocked UPDATE, not just the direct lock holder.
      while (true) {
        const [row] = await sql<{ n: number }[]>`WITH RECURSIVE waiting(pid) AS (
          SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
          UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY(pg_blocking_pids(a.pid))
        ) SELECT count(*)::int AS n FROM waiting`;
        if (row.n >= count) return;
        assert.ok(performance.now() < deadline, `expected ${count} blocked delivery updates, got ${row.n}`);
        await delay(10);
      }
    },
  };
}

test("two concurrent retries send once and return a conflict for the losing admin request", async () => {
  const id = await delivery();
  const lock = await hold(id);
  const pending = [resolve(id), resolve(id)];
  // Start Fastify's lazy injection promises while the row is locked.
  const done = Promise.all(pending);
  try {
    await lock.blocked(2);
  } finally {
    await lock.release();
  }
  const replies = await done;
  assert.deepEqual(replies.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(replies.find((r) => r.statusCode === 409)!.json().code, "conflict");
  assert.equal(requests.filter((n) => n === id).length, 1);
  assert.equal((await state(id)).attempts, 1);
  assert.equal((await state(id)).status, "sent");
  const audits = await sql`SELECT id FROM audit_log WHERE subject = ${`delivery:${id}`} AND action = 'delivery.resend'`;
  assert.equal(audits.length, 1, "only the winning recovery is audited");
});

test("a stale version cannot resend after a fast failure returns the delivery to failed", async () => {
  const id = await delivery("failed");
  const version = (await state(id)).version;
  answer = async () => Response.json({ code: 99 }, { status: 429 });
  try {
    assert.equal((await resendDelivery(id, version)).status, "failed");
    await assert.rejects(resendDelivery(id, version), { code: "conflict" });
    assert.equal(requests.filter((n) => n === id).length, 1);
    assert.equal((await state(id)).attempts, 1);
    assert.equal((await resolve(id)).statusCode, 200, "a fresh explicit retry remains possible");
    assert.equal((await state(id)).attempts, 2);
  } finally {
    answer = async () => Response.json({ code: 0 });
  }
});

for (const outcome of ["sent", "drop"]) {
  test(`a stale ${outcome} cannot overwrite a retry in flight; another delivery remains independent`, async () => {
    const id = await delivery();
    const other = await delivery();
    const lock = await hold(id);
    const arrived = gate();
    const finish = gate();
    answer = async (sentId) => {
      if (sentId === id) {
        arrived.open();
        await finish.promise;
      }
      return Response.json({ code: 0 });
    };
    const retry = resolve(id).then((r) => r);
    let marking: ReturnType<typeof resolve> | undefined;
    try {
      await lock.blocked(1);
      marking = resolve(id, outcome).then((r) => r);
      await lock.blocked(2);
      await lock.release();
      await arrived.promise;
      assert.equal((await marking).statusCode, 409);
      assert.equal((await state(id)).status, "sending");
      assert.equal((await resolve(other)).statusCode, 200);
    } finally {
      await lock.release();
      finish.open();
      await Promise.allSettled([retry, marking]);
      answer = async () => Response.json({ code: 0 });
    }
    assert.equal((await retry).statusCode, 200);
    assert.equal((await state(id)).status, "sent");
    assert.equal((await state(id)).attempts, 1);
  });
}

test("disabled pushes and missing credentials leave the retry available without sending", async () => {
  const id = await delivery();
  const before = await state(id);
  config.feishuContentPushEnabled = false;
  try {
    await assert.rejects(resendDelivery(id), /disabled/);
  } finally {
    config.feishuContentPushEnabled = true;
  }
  delete process.env.TEST_DELIVERY_WEBHOOK;
  try {
    await assert.rejects(resendDelivery(id), /webhook not configured/);
  } finally {
    process.env.TEST_DELIVERY_WEBHOOK = WEBHOOK;
  }
  assert.deepEqual(await state(id), before);
  assert.equal(requests.filter((n) => n === id).length, 0);
});

test("resend checks current target, publication and fact identity before any transport", async () => {
  const disabled = await delivery();
  await sql`UPDATE notify_targets SET enabled=false WHERE key=${TARGET}`;
  try {
    await assert.rejects(resendDelivery(disabled), { code: "conflict" });
  } finally {
    await sql`UPDATE notify_targets SET enabled=true WHERE key=${TARGET}`;
  }
  const restarted = await delivery();
  await sql`UPDATE notify_targets SET enabled_at=now()+interval '1 minute' WHERE key=${TARGET}`;
  try {
    await assert.rejects(resendDelivery(restarted), { code: "conflict" });
  } finally {
    await sql`UPDATE notify_targets SET enabled_at=null WHERE key=${TARGET}`;
  }
  const rejected = [disabled, restarted];
  for (const change of ["withdrawn", "unselected", "old", "backfill", "future", "silent", "new_fact"]) {
    const id = await delivery();
    const a = articleIds.get(id)!;
    if (change === "withdrawn") await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${a}`;
    if (change === "unselected") await sql`UPDATE publications SET selected=false WHERE article_id=${a}`;
    if (change === "old") await sql`UPDATE publications SET timeline_at=now()-interval '13 hours' WHERE article_id=${a}`;
    if (change === "backfill") await sql`UPDATE publications SET backfill=true WHERE article_id=${a}`;
    if (change === "future") await sql`UPDATE publications SET visible_after=now()+interval '1 hour' WHERE article_id=${a}`;
    if (change === "silent") await sql`INSERT INTO editorial_overrides(article_id,fields) VALUES(${a},'{"silent":true}')`;
    if (change === "new_fact") await sql`UPDATE publications SET fact_id=123456 WHERE article_id=${a}`;
    await assert.rejects(resendDelivery(id), { code: "conflict" }, change);
    rejected.push(id);
  }
  assert.equal(requests.filter((id) => rejected.includes(id)).length, 0);
});

test("resend regenerates the card from the current approved copy", async () => {
  const id = await delivery();
  await sql`UPDATE publications SET summary='已核对的更正摘要' WHERE article_id=${articleIds.get(id)!}`;
  assert.equal((await resendDelivery(id)).status, "sent");
  assert.match(JSON.stringify(cards.at(-1)), /已核对的更正摘要/);
  const [saved] = await sql`SELECT payload FROM deliveries WHERE id=${id}`;
  assert.deepEqual(saved.payload, cards.at(-1));
});

test("a retry waiting for its claim observes a completed withdrawal", async () => {
  const id = await delivery();
  const lock = await hold(id);
  const retry = resolve(id).then((r) => r);
  try {
    await lock.blocked(1);
    await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${articleIds.get(id)!}`;
  } finally {
    await lock.release();
  }
  assert.equal((await retry).statusCode, 409);
  assert.equal(requests.filter((n) => n === id).length, 0);
  assert.equal((await state(id)).attempts, 0);
});

test("an HTTP success without a valid provider acknowledgement remains unknown", async () => {
  for (const reply of [() => new Response("proxy page"), () => Response.json({ message: "missing code" }), () => Response.json({ code: 0 }, { status: 503 })]) {
    const id = await delivery();
    answer = async () => reply();
    try {
      assert.equal((await resendDelivery(id)).status, "unknown");
    } finally {
      answer = async () => Response.json({ code: 0 });
    }
  }
});

test("a completed withdrawal during title-lease contention prevents sending", async () => {
  const id = await delivery();
  const leaseKey = `selected-title:${sha256(String(id)).slice(0, 24)}`;
  await sql`INSERT INTO delivery_leases(lease_key,holder,expires_at) VALUES(${leaseKey},${articleIds.get(id)!},now()+interval '1 hour')`;
  const acquired = gate<number>(),
    release = gate();
  const lock = sql.begin(async (tx) => {
    await tx`SELECT lease_key FROM delivery_leases WHERE lease_key=${leaseKey} FOR UPDATE`;
    const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    acquired.open(row.pid);
    await release.promise;
  });
  const pid = await acquired.promise;
  const retry = resolve(id).then((r) => r);
  try {
    const deadline = performance.now() + 5000;
    while (!(await sql`SELECT pid FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))`).length) {
      assert.ok(performance.now() < deadline, "retry reached the title lease");
      await delay(10);
    }
    await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${articleIds.get(id)!}`;
  } finally {
    release.open();
    await lock;
  }
  assert.equal((await retry).statusCode, 409);
  assert.equal(requests.filter((n) => n === id).length, 0);
  assert.equal((await state(id)).attempts, 0);
});

test("country delivery uses current multi-country evidence and retains the general channel", async () => {
  const id = await delivery("failed"),
    articleId = articleIds.get(id)!;
  const keys = [`${TARGET}-general`, `${TARGET}-ar`, `${TARGET}-pe`];
  await sql`UPDATE notify_targets SET enabled=false WHERE key=${TARGET}`;
  for (const [index, country] of [null, "AR", "PE"].entries())
    await sql`INSERT INTO notify_targets(key,purpose,kind,enabled,jurisdiction) VALUES(${keys[index]!},${country === null ? "content" : "country_content"},'log',true,${country})`;
  const req = { subjectKind: "selected" as const, subjectId: articleId, dedupeKey: `selected:article:${articleId}`, contentAt: new Date(), card: { id } };
  try {
    const legacy = await sql`SELECT key FROM notify_targets WHERE purpose='content' AND enabled AND key=ANY(${keys}::text[])`;
    assert.deepEqual(
      legacy.map((row) => row.key),
      [keys[0]],
      "a rollback binary cannot broadcast every article into a country target",
    );
    assert.deepEqual((await deliverContent(req)).map((row) => row.target).sort(), [keys[0]], "unknown geography goes only to the general channel");
    await sql`DELETE FROM deliveries WHERE target_key=ANY(${keys}::text[])`;
    await sql`INSERT INTO publication.news_geography(article_id,article_revision,analysis_id,recipe,state,jurisdictions)
      VALUES(${articleId},1,NULL,${geographyRecipe()},'identified',ARRAY['AR','PE'])`;
    assert.deepEqual((await deliverContent(req)).map((row) => row.target).sort(), [...keys].sort());
    assert.deepEqual(await deliverContent(req), [], "each target keeps its own dedupe identity");
    await sql`DELETE FROM deliveries WHERE target_key=ANY(${keys}::text[])`;
    await sql`UPDATE articles SET revision=revision+1 WHERE id=${articleId}`;
    assert.deepEqual(
      (await deliverContent(req)).map((row) => row.target),
      [keys[0]],
      "old-revision geography cannot route a card",
    );
  } finally {
    await sql`DELETE FROM deliveries WHERE target_key=ANY(${keys}::text[])`;
    await sql`DELETE FROM notify_targets WHERE key=ANY(${keys}::text[])`;
    await sql`UPDATE notify_targets SET enabled=true WHERE key=${TARGET}`;
  }
});

test("manual recovery rechecks the target country before sending the rebuilt card", async () => {
  const id = await delivery(),
    articleId = articleIds.get(id)!;
  await sql`UPDATE notify_targets SET jurisdiction='AR',purpose='country_content' WHERE key=${TARGET}`;
  try {
    await sql`INSERT INTO publication.news_geography(article_id,article_revision,analysis_id,recipe,state,jurisdictions)
      VALUES(${articleId},1,NULL,${geographyRecipe()},'identified',ARRAY['PE'])`;
    await assert.rejects(resendDelivery(id), { code: "conflict" });
    assert.equal(requests.filter((n) => n === id).length, 0);
    assert.equal((await state(id)).status, "unknown");
    await sql`UPDATE publication.news_geography SET jurisdictions=ARRAY['AR'] WHERE article_id=${articleId}`;
    assert.equal((await resendDelivery(id)).status, "sent");
    assert.equal(requests.filter((n) => n === id).length, 1);
  } finally {
    await sql`UPDATE notify_targets SET jurisdiction=NULL,purpose='content' WHERE key=${TARGET}`;
  }
});

test("a country correction committed while send admission waits is rechecked for normal and manual sends", { timeout: 10000 }, async () => {
  await sql`UPDATE notify_targets SET jurisdiction='AR',purpose='country_content' WHERE key=${TARGET}`;
  try {
    for (const retry of [false, true]) {
      const id = await delivery(),
        articleId = articleIds.get(id)!;
      await sql`INSERT INTO publication.news_geography(article_id,article_revision,analysis_id,recipe,state,jurisdictions)
        VALUES(${articleId},1,NULL,${geographyRecipe()},'identified',ARRAY['AR'])`;
      if (!retry) await sql`DELETE FROM deliveries WHERE id=${id}`;
      const entered = gate<number>(),
        release = gate();
      const held = sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('lane-controls'))`;
        const [row] = await tx`SELECT pg_backend_pid() AS pid`;
        entered.open(row.pid);
        await release.promise;
      });
      const pid = await entered.promise;
      const sending = (
        retry
          ? resendDelivery(id)
          : deliverContent({ subjectKind: "selected", subjectId: articleId, dedupeKey: `selected:article:${articleId}`, contentAt: new Date(), card: { id } })
      ).then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
      try {
        const deadline = performance.now() + 3000;
        while (!(await sql`SELECT pid FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))`).length) {
          assert.ok(performance.now() < deadline, "sender should reach the control fence");
          await delay(10);
        }
        await sql`UPDATE publication.news_geography SET jurisdictions=ARRAY['PE'] WHERE article_id=${articleId}`;
      } finally {
        release.open();
        await held;
      }
      const outcome = await sending;
      if (retry) assert.equal((outcome as { error: { code: string } }).error.code, "conflict");
      else assert.deepEqual((outcome as { result: unknown }).result, []);
      assert.equal(requests.filter((n) => n === id).length, 0);
    }
  } finally {
    await sql`UPDATE notify_targets SET jurisdiction=NULL,purpose='content' WHERE key=${TARGET}`;
  }
});

test("a qualified non-global representative reaches its country once per fact, never the general channel", async () => {
  const id = await delivery(),
    articleId = articleIds.get(id)!;
  const country = `${TARGET}-non-seat`;
  await sql`INSERT INTO notify_targets(key,purpose,kind,enabled,config_ref,jurisdiction) VALUES
    (${country},'country_content','feishu_webhook',true,'TEST_DELIVERY_WEBHOOK','AR')`;
  try {
    await sql`UPDATE publications SET seat=false,fact_id=987654 WHERE article_id=${articleId}`;
    await sql`INSERT INTO publication.news_geography(article_id,article_revision,analysis_id,recipe,state,jurisdictions)
      VALUES(${articleId},1,NULL,${geographyRecipe()},'identified',ARRAY['AR'])`;
    assert.equal((await pushSelected(articleId)).status, "pushed");
    assert.equal(requests.filter((n) => n === id).length, 1);
    assert.deepEqual(
      (await sql`SELECT target_key FROM deliveries WHERE subject_id=${articleId} AND status='sent'`).map((r) => r.target_key),
      [country],
    );
    assert.equal((await pushSelected(articleId)).status, "skipped");
    await sql`UPDATE publications SET seat=true WHERE article_id=${articleId}`;
    assert.equal((await pushSelected(articleId)).status, "pushed", "general channel keeps its own fact identity");
    assert.equal(requests.filter((n) => n === id).length, 2);
    const other = await delivery(),
      otherId = articleIds.get(other)!;
    await sql`UPDATE publications SET fact_id=987654 WHERE article_id=${otherId}`;
    await sql`INSERT INTO publication.news_geography(article_id,article_revision,analysis_id,recipe,state,jurisdictions)
      VALUES(${otherId},1,NULL,${geographyRecipe()},'identified',ARRAY['AR'])`;
    assert.equal((await pushSelected(otherId)).status, "skipped", "another report of the same fact cannot send twice");
    assert.equal(requests.filter((n) => n === other).length, 0);
  } finally {
    await sql`DELETE FROM deliveries WHERE target_key=ANY(${[country]}::text[])`;
    await sql`DELETE FROM notify_targets WHERE key=ANY(${[country]}::text[])`;
  }
});

test("normal and recovered sends recheck eligibility and rebuild the card after admission waits", { timeout: 30000 }, async () => {
  for (const mode of ["normal", "manual", "automatic"])
    for (const change of ["withdrawn", "silent", "unconfirmed", "ineligible", "seat", "fact", "old", "backfill", "future", "copy"]) {
      const retry = mode !== "normal";
      const id = await delivery(),
        articleId = articleIds.get(id)!;
      if (!retry) await sql`DELETE FROM deliveries WHERE id=${id}`;
      if (mode === "automatic") await sql`UPDATE deliveries SET status='failed',retry_reason='not_sent',retry_at=now() WHERE id=${id}`;
      const entered = gate<number>(),
        release = gate();
      const held = sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('lane-controls'))`;
        entered.open((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
        await release.promise;
      });
      const pid = await entered.promise;
      const sending = (mode === "automatic" ? markStaleDeliveries() : retry ? resendDelivery(id) : pushSelected(articleId)).then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
      try {
        const deadline = performance.now() + 3000;
        while (!(await sql`SELECT pid FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))`).length) {
          assert.ok(performance.now() < deadline, `${retry}/${change} reaches admission fence`);
          await delay(10);
        }
        if (change === "withdrawn") await sql`UPDATE publications SET operator_withdrawn=true WHERE article_id=${articleId}`;
        if (change === "silent") await sql`INSERT INTO editorial_overrides(article_id,fields) VALUES(${articleId},'{"silent":true}')`;
        if (change === "unconfirmed") await sql`UPDATE publications SET selection_candidate=false WHERE article_id=${articleId}`;
        if (change === "ineligible") await sql`UPDATE publications SET eligible=false WHERE article_id=${articleId}`;
        if (change === "seat") await sql`UPDATE publications SET seat=false WHERE article_id=${articleId}`;
        if (change === "fact") await sql`UPDATE publications SET fact_id=876543 WHERE article_id=${articleId}`;
        if (change === "old") await sql`UPDATE publications SET timeline_at=now()-interval '13 hours' WHERE article_id=${articleId}`;
        if (change === "backfill") await sql`UPDATE publications SET backfill=true WHERE article_id=${articleId}`;
        if (change === "future") await sql`UPDATE publications SET visible_after=now()+interval '1 hour' WHERE article_id=${articleId}`;
        if (change === "copy") await sql`UPDATE publications SET summary='等待后取得的当前摘要' WHERE article_id=${articleId}`;
      } finally {
        release.open();
        await held;
      }
      const outcome = await sending;
      assert.equal(requests.filter((n) => n === id).length, change === "copy" ? 1 : 0, `${retry}/${change}`);
      if (change === "copy") {
        assert.match(JSON.stringify(cards.at(-1)), /等待后取得的当前摘要/);
        assert.deepEqual((await sql`SELECT payload FROM deliveries WHERE subject_id=${articleId}`)[0].payload, cards.at(-1));
      } else if (mode === "manual") assert.equal((outcome as { error: { code: string } }).error.code, "conflict");
      if (change === "future") {
        const [waiting] = await sql`SELECT id,status,retry_reason,retry_at,attempts FROM deliveries WHERE subject_id=${articleId}`;
        assert.equal(waiting.attempts, 0, "a waiting claim consumes no transport attempt");
        if (mode === "manual") assert.equal(waiting.status, "unknown", "manual deferral never grants automatic retry to an uncertain send");
        else {
          assert.equal(waiting.status, "failed");
          assert.equal(waiting.retry_reason, "not_sent");
          assert.ok(waiting.retry_at > new Date());
        }
        await sql`UPDATE publications SET visible_after=now()-interval '1 second' WHERE article_id=${articleId}`;
        if (mode === "manual") await resendDelivery(id);
        else {
          await sql`UPDATE deliveries SET retry_at=now()-interval '1 second' WHERE id=${waiting.id}`;
          await markStaleDeliveries();
        }
        await markStaleDeliveries();
        await pushSelected(articleId);
        const [sent] = await sql`SELECT id,status,attempts FROM deliveries WHERE subject_id=${articleId}`;
        assert.equal(sent.id, waiting.id);
        assert.equal(sent.status, "sent");
        assert.equal(sent.attempts, 1);
        assert.equal(requests.filter((n) => n === id).length, 1, "the same delivery sends exactly once after release");
      }
    }
});
