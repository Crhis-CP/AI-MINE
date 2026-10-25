import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { installModules, serverModules } from "@amp/backend/modules";
import { updateSource, fetchNow, requestSourcePreview, runSourcePreview, SOURCE_PREVIEW_QUEUE } from "@amp/backend/admin/sources";
import { ensureQueue, enqueue, stopBoss } from "@amp/backend/jobs/queue";
import { grantDateFixture } from "./source-date-fixture.ts";
import { sourceOwnerHeaders } from "./source-owner-fixture.ts";
import { config } from "@amp/backend/config";
import { buildApp } from "./site-app.ts";

const original = serverModules(),
  queue = "news.module-kind-fixture";
after(async () => {
  installModules(original);
  await stopBoss();
  await closeDb();
});
async function fixture() {
  const id = `module-kind-${tag()}`,
    value = { feedUrl: "https://example.invalid/feed.xml" };
  await sql`INSERT INTO sources(id,name,kind,config,enabled,lane) VALUES(${id},'合成来源','rss',${sql.json(value)},false,'news')`;
  await grantDateFixture(id, [value.feedUrl]);
  await ensureQueue(queue);
  await ensureQueue(SOURCE_PREVIEW_QUEUE);
  return {
    id,
    value,
    version: async () => (await sql`SELECT updated_at FROM sources WHERE id=${id}`)[0]!.updated_at.toISOString(),
    jobs: async () => (await sql`SELECT id FROM pgboss.job WHERE name=${queue} AND data->>'sourceId'=${id}`).length,
    preview: async () => {
      const p = await requestSourcePreview(id, {}, "test");
      await runSourcePreview(String(p.preview_id), async () => ({
        ms: 1,
        count: 1,
        items: [{ title: "合成矿业资料", url: "https://example.invalid/article", publishedAt: null, excerpt: "合成预览" }],
      }));
    },
  };
}

test("resume hooks follow validated false-to-true transitions and share source/audit rollback", async () => {
  const f = await fixture(),
    calls: string[] = [];
  let fail = true;
  installModules([
    {
      name: "first",
      sourceKinds: {
        rss: {
          resumed: async (id, tx) => {
            calls.push("first");
            await enqueue(queue, { sourceId: id, lane: "news" }, {}, tx);
          },
        },
      },
    },
    {
      name: "second",
      sourceKinds: {
        rss: {
          resumed: async () => {
            calls.push("second");
            if (fail) throw Error("fixture resume unavailable");
          },
        },
      },
    },
  ]);
  const enable = async () => updateSource(f.id, { patch: { enabled: true }, version: await f.version() }, "test");
  await assert.rejects(enable(), /预览/);
  assert.deepEqual(calls, []);
  await f.preview();
  await assert.rejects(enable(), /fixture resume unavailable/);
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(await f.jobs(), 0);
  assert.equal((await sql`SELECT enabled FROM sources WHERE id=${f.id}`)[0]!.enabled, false);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE action='source.update' AND subject=${`source:${f.id}`}`).length, 0);
  fail = false;
  calls.length = 0;
  await enable();
  await enable();
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(await f.jobs(), 1);
});

test("manual hooks hold the runtime fence and failed audit serialization rolls back queued work", async () => {
  const f = await fixture();
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
  installModules([
    {
      name: "manual",
      sourceKinds: {
        rss: {
          fetchNow: async (source, tx) => {
            assert.deepEqual(source, { id: f.id, lane: "news", config: f.value });
            entered();
            await held;
            await enqueue(queue, { sourceId: source.id, lane: source.lane }, {}, tx);
            const cycle: Record<string, unknown> = {};
            cycle.self = cycle;
            return cycle;
          },
        },
      },
    },
  ]);
  const pending = fetchNow(f.id, "test");
  try {
    assert.equal(await Promise.race([ready.then(() => true), pending.then(() => false)]), true, "the module callback must be reached");
    const locked = await sql.begin(async (tx) => (await tx`SELECT pg_try_advisory_xact_lock(hashtext('lane-controls')) AS acquired`)[0]!.acquired);
    assert.equal(locked, false, "the pause fence stays held while the callback is in flight");
  } finally {
    release();
  }
  await assert.rejects(pending);
  assert.equal(await f.jobs(), 0);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE action='source.fetch' AND subject=${`source:${f.id}`}`).length, 0);
});

test("manual callbacks require Owner, respect pause/archive, and return the old public result shape", async (t) => {
  const f = await fixture(),
    previous = config.devAdmin;
  config.devAdmin = null;
  const app = await buildApp("private-api");
  t.after(async () => {
    await app.close();
    config.devAdmin = previous;
  });
  let calls = 0;
  installModules([
    { name: "no-fetch", sourceKinds: { rss: { resumed: async () => {} } } },
    {
      name: "manual",
      sourceKinds: {
        rss: {
          fetchNow: async (source, tx) => {
            calls++;
            return { jobId: await enqueue(queue, { sourceId: source.id, lane: source.lane }, {}, tx), accepted: true };
          },
        },
      },
    },
    {
      name: "later",
      sourceKinds: {
        rss: {
          fetchNow: async () => {
            throw Error("must not call a later fetch handler");
          },
        },
      },
    },
  ]);
  const url = `/api/admin/sources/${f.id}/fetch`;
  assert.equal((await app.inject({ method: "POST", url, payload: {} })).statusCode, 401);
  assert.equal(calls, 0);
  const headers = await sourceOwnerHeaders();
  const response = await app.inject({ method: "POST", url, headers, payload: {} });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { jobId: null });
  assert.equal(calls, 1);
  assert.equal(await f.jobs(), 1);
  const [audit] = await sql`SELECT after FROM audit_log WHERE action='source.fetch' AND subject=${`source:${f.id}`} ORDER BY id DESC LIMIT 1`;
  assert.equal(audit!.after.accepted, true);
  assert.ok(audit!.after.jobId);
  await sql`UPDATE ops.lane_controls SET paused=true,reason='合成暂停',actor='test',expires_at=now()+interval '1 hour',revision=revision+1 WHERE lane='news' AND switch='collection' AND holder='owner'`;
  try {
    await assert.rejects(fetchNow(f.id, "test"), /paused/);
    assert.equal(calls, 1);
  } finally {
    await sql`UPDATE ops.lane_controls SET paused=false,reason=NULL,actor=NULL,expires_at=NULL,revision=revision+1 WHERE lane='news' AND switch='collection' AND holder='owner'`;
  }
  await sql`UPDATE sources SET archived_at=now() WHERE id=${f.id}`;
  await assert.rejects(fetchNow(f.id, "test"), /归档/);
  assert.equal(calls, 1);
});
