import { setTimeout as delay } from "node:timers/promises";
import { tag, gate } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { config } from "@amp/backend/config";
import { sql, closeDb } from "@amp/backend/db";
import { markStaleDeliveries } from "@amp/backend/notify/deliver";
import { resolveDelivery } from "@amp/backend/admin/runs";
import { pushSelected } from "../packages/backend/src/notify/selected.ts";

const target = `recovery-${tag()}`,
  url = "https://delivery.invalid/recovery";
let hits = 0,
  answer = async () => Response.json({ code: 0 });
const realFetch = globalThis.fetch;
before(async () => {
  process.env.RECOVERY_WEBHOOK = url;
  globalThis.fetch = (async (input) => {
    assert.equal(String(input), url);
    hits++;
    return answer();
  }) as typeof fetch;
  await sql`INSERT INTO notify_targets(key,purpose,kind,enabled,config_ref) VALUES(${target},'content','feishu_webhook',true,'RECOVERY_WEBHOOK')`;
});
beforeEach(async () => {
  await sql`DELETE FROM deliveries WHERE target_key=${target}`;
  await sql`UPDATE notify_targets SET enabled=true,enabled_at=null WHERE key=${target}`;
  config.feishuContentPushEnabled = true;
  hits = 0;
  answer = async () => Response.json({ code: 0 });
});
after(async () => {
  globalThis.fetch = realFetch;
  config.feishuContentPushEnabled = false;
  await closeDb();
});

async function material(status: string | null = "pending", attempts = 0) {
  const id = `recovery-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind) VALUES(${id},'合成来源','rss')`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
    VALUES(${id},${id},${id},${`https://example.com/${id}`},${id},now(),now())`;
  await sql`INSERT INTO publications(article_id,source_id,channel,title,url,discovered_at,timeline_at,sort_at,selected,seat,eligible,summary)
    VALUES(${id},${id},'news',${id},${`https://example.com/${id}`},now(),now(),now(),true,true,true,'合成摘要')`;
  if (status)
    await sql`INSERT INTO deliveries(target_key,subject_kind,subject_id,dedupe_key,status,attempts,updated_at)
    VALUES(${target},'selected',${id},${`selected:article:${id}`},${status},${attempts},now()-interval '16 minutes')`;
  return id;
}
const delivery = async (id: string) => (await sql`SELECT * FROM deliveries WHERE subject_id=${id}`)[0]!;

test("a crash before sending recovers once through the current content gate", async () => {
  const id = await material();
  await markStaleDeliveries();
  assert.equal((await delivery(id)).status, "sent");
  assert.equal((await delivery(id)).attempts, 1);
  await markStaleDeliveries();
  assert.equal(hits, 1);
});

test("old failures, uncertain sends and operator abandonment never gain automatic permission", async () => {
  const old = await material("failed"),
    uncertain = await material("sending"),
    dropped = await material("failed");
  const row = await delivery(dropped);
  await sql`UPDATE deliveries SET retry_reason='not_sent',retry_at=now() WHERE id=${row.id}`;
  await resolveDelivery(row.id, { outcome: "drop", note: "operator abandoned" }, "test");
  await markStaleDeliveries();
  assert.equal(hits, 0);
  assert.equal((await delivery(old)).retry_reason, null);
  assert.equal((await delivery(uncertain)).status, "unknown");
  assert.ok((await delivery(dropped)).abandoned_at);
  await assert.rejects(resolveDelivery(row.id, { outcome: "resend", note: "stale action" }, "test"), { code: "conflict" });
});

test("a definite rate limit waits for Retry-After then recovers without a new dedupe identity", async () => {
  const id = await material(null);
  answer = async () => Response.json({ code: 99 }, { status: 429, headers: { "retry-after": "3600" } });
  await pushSelected(id);
  const first = await delivery(id);
  assert.equal(first.retry_reason, "rate_limited");
  assert.ok(first.retry_at.getTime() >= Date.now() + 3590000);
  await markStaleDeliveries();
  assert.equal(hits, 1);
  await sql`UPDATE deliveries SET retry_at=now()-interval '1 second' WHERE id=${first.id}`;
  answer = async () => Response.json({ code: 0 });
  await markStaleDeliveries();
  assert.equal((await delivery(id)).id, first.id);
  assert.equal((await delivery(id)).status, "sent");
  assert.equal(hits, 2);
});

test("automatic attempts are bounded and current withdrawals are respected", async () => {
  const id = await material("failed", 5),
    withdrawn = await material();
  await sql`UPDATE deliveries SET retry_reason='rate_limited',retry_at=now() WHERE subject_id=${id}`;
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${withdrawn}`;
  answer = async () => Response.json({ code: 99 }, { status: 429 });
  await markStaleDeliveries();
  assert.equal((await delivery(id)).attempts, 6);
  assert.equal((await delivery(id)).retry_at, null);
  assert.equal((await delivery(withdrawn)).attempts, 0);
  await markStaleDeliveries();
  assert.equal(hits, 1);
});

test("concurrent recoverers claim once; a disabled environment keeps the opportunity", { timeout: 5000 }, async () => {
  const id = await material();
  config.feishuContentPushEnabled = false;
  await markStaleDeliveries();
  assert.equal(hits, 0);
  assert.equal((await delivery(id)).retry_reason, "not_sent");
  config.feishuContentPushEnabled = true;
  const arrived = gate(),
    finish = gate();
  answer = async () => {
    arrived.open();
    await finish.promise;
    return Response.json({ code: 0 });
  };
  const first = markStaleDeliveries();
  await arrived.promise;
  const second = markStaleDeliveries();
  finish.open();
  await Promise.all([first, second]);
  assert.equal(hits, 1);
  assert.equal((await delivery(id)).attempts, 1);
});

test("publication pause prevents normal and recovered sends without consuming attempts", async () => {
  const id = await material(null);
  await sql`UPDATE ops.lane_controls SET paused=true,reason='operator pause',actor='test',expires_at=now()+interval '1 hour'
    WHERE lane='news' AND switch='publication' AND holder='owner'`;
  try {
    await pushSelected(id);
    assert.equal(hits, 0);
    await sql`UPDATE deliveries SET updated_at=now()-interval '16 minutes' WHERE subject_id=${id}`;
    await markStaleDeliveries();
    assert.equal((await delivery(id)).attempts, 0);
    assert.equal((await delivery(id)).retry_reason, "not_sent");
  } finally {
    await sql`UPDATE ops.lane_controls SET paused=false WHERE lane='news' AND switch='publication' AND holder='owner'`;
  }
  await markStaleDeliveries();
  assert.equal(hits, 1);
  assert.equal((await delivery(id)).status, "sent");
});

test("pause committed while a recovery waits for its row prevents physical sending", { timeout: 5000 }, async () => {
  const id = await material("failed"),
    row = await delivery(id);
  await sql`UPDATE deliveries SET retry_reason='not_sent',retry_at=now() WHERE id=${row.id}`;
  const entered = gate<number>(),
    release = gate();
  const lock = sql.begin(async (tx) => {
    await tx`SELECT id FROM deliveries WHERE id=${row.id} FOR UPDATE`;
    const [pid] = await tx<{ id: number }[]>`SELECT pg_backend_pid() AS id`;
    entered.open(pid.id);
    await release.promise;
  });
  const pid = await entered.promise;
  const recovering = markStaleDeliveries();
  try {
    const deadline = performance.now() + 3000;
    while (!(await sql`SELECT pid FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))`).length) {
      assert.ok(performance.now() < deadline);
      await delay(10);
    }
    await sql`UPDATE ops.lane_controls SET paused=true,reason='pause during claim',actor='test',expires_at=now()+interval '1 hour'
      WHERE lane='news' AND switch='publication' AND holder='owner'`;
  } finally {
    release.open();
    await lock;
  }
  await recovering;
  assert.equal(hits, 0);
  assert.equal((await delivery(id)).attempts, 0);
  assert.equal((await delivery(id)).retry_reason, "not_sent");
  await sql`UPDATE ops.lane_controls SET paused=false WHERE lane='news' AND switch='publication' AND holder='owner'`;
  await markStaleDeliveries();
  assert.equal(hits, 1);
});

test("new retry metadata cannot resurrect an abandonment made by the rollback binary", async () => {
  const id = await material("failed"),
    row = await delivery(id);
  await sql`UPDATE deliveries SET retry_reason='rate_limited',retry_at=now() WHERE id=${row.id}`;
  // Exact legacy drop writes: the old binary knows neither recovery field nor abandoned_at.
  await sql`UPDATE deliveries SET status='failed',response='人工放弃：旧版核对后停止',updated_at=now() WHERE id=${row.id}`;
  await markStaleDeliveries();
  await markStaleDeliveries();
  assert.equal(hits, 0);
  assert.ok((await delivery(id)).abandoned_at);
  assert.equal((await delivery(id)).retry_at, null);
});
