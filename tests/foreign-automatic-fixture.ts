// SELF_AUTHORED intake through real HTTP, source workers and translation jobs; never a quality sample.
import assert from "node:assert/strict";
import { previewSourceFixture } from "./source-preview-fixture.ts";
import type { TestContext } from "node:test";
const registeredWorkers = new WeakSet<Awaited<ReturnType<typeof getBoss>>>();
const fixtureCleanup = new WeakMap<TestContext, Array<() => Promise<void>>>();
import { setTimeout as delay } from "node:timers/promises";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { buildApp } from "./site-app.ts";
import { config } from "@amp/backend/config";
import { closeDb, sql as runtimeSql, initializeDb } from "@amp/backend/db";
import { getBoss, stopBoss } from "@amp/backend/jobs/queue";
import { registerSourceJobs } from "@amp/backend/jobs/sources";
import { registerEventJobs } from "@amp/backend/jobs/events";
import { registerContentJobs } from "@amp/backend/jobs/content";
import { scheduleDueSources } from "@amp/backend/sources/collect";
import { automaticFeedFixture, type FeedCase } from "./automatic-feed-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";

export async function foreignFixture(
  t: TestContext,
  options: {
    name: string;
    language?: unknown;
    samples: readonly FeedCase[];
    translate?: (marker: string, text: string) => Promise<unknown>;
    siteFulltext?: boolean;
  },
) {
  await initializeDb("test");
  const fixture = await automaticFeedFixture({ ...options, publishedAt: new Date(Date.now() - 3_600_000).toUTCString() });
  const saved = { ...config },
    dispatcher = getGlobalDispatcher(),
    offline = new MockAgent();
  offline.disableNetConnect();
  for (const url of [fixture.feedUrl, fixture.providerUrl]) offline.enableNetConnect(new URL(url).host);
  setGlobalDispatcher(offline);
  const keys = ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL", "DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"];
  const previous = [...keys, "EMBEDDINGS_ENABLED"].map((key) => [key, process.env[key]] as const),
    apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  let boss: Awaited<ReturnType<typeof getBoss>> | undefined;
  const stopWorkers = async () => {
    if (!boss || !registeredWorkers.has(boss)) return;
    const current = boss;
    await Promise.all((await current.getQueues()).map((queue) => current.offWork(queue.name, { wait: true })));
    registeredWorkers.delete(current);
  };
  let surfacesClosed = false;
  const closeSurfaces = async () => {
    if (surfacesClosed) return;
    surfacesClosed = true;
    await stopWorkers();
    for (const app of apps) await app.close();
    await fixture.close();
    setGlobalDispatcher(dispatcher);
    await offline.close();
    Object.assign(config, saved);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  let cleanup = fixtureCleanup.get(t);
  if (!cleanup) {
    cleanup = [];
    fixtureCleanup.set(t, cleanup);
    t.after(async () => {
      try {
        for (const close of [...fixtureCleanup.get(t)!].reverse()) await close();
      } finally {
        await stopBoss();
        await closeDb();
      }
    });
  }
  cleanup.push(closeSurfaces);
  for (const key of keys) process.env[key] = key.endsWith("BASE_URL") ? `${fixture.providerUrl}/v1` : "synthetic-key";
  process.env.EMBEDDINGS_ENABLED = "false";
  for (const model of ["qwen3.7-flash", "glm-5.3-flash-selection", "glm-5.3-flash", "deepseek-flash", "qwen3.8-flash"])
    await installUsageFixtureForModel(model);
  Object.assign(config, {
    allowPrivateNetworkFetch: true,
    modelCallsEnabled: true,
    egressProxyUrl: null,
    privateHost: "private.foreign.test",
    devAdmin: { displayName: "Synthetic owner" },
  });
  const admin = await buildApp("private-api"),
    reader = await buildApp("public-api");
  apps.push(admin, reader);
  const headers = { "x-forwarded-host": "private.foreign.test", "x-csrf-token": "dev" };
  const created = await admin.inject({
    method: "POST",
    url: "/api/admin/sources",
    headers,
    payload: {
      id: options.name,
      name: `SELF_AUTHORED ${options.name}`,
      kind: "rss",
      tier: "T2",
      config: { feedUrl: fixture.feedUrl, ...(options.language === undefined ? {} : { language: options.language }) },
      permission_scope: { hosts: [new URL(fixture.feedUrl).hostname, "example.invalid"], path_prefixes: ["/"], document_types: [], excluded_content: [] },
      attachments_in_scope: false,
      site_fulltext: options.siteFulltext ?? true,
      syndicate_fulltext: false,
    },
  });
  assert.equal(created.statusCode, 200, created.body);
  await previewSourceFixture(options.name);
  const current = (await admin.inject({ url: `/api/admin/sources/${options.name}`, headers })).json().source;
  const enabled = await admin.inject({
    method: "PATCH",
    url: `/api/admin/sources/${options.name}`,
    headers,
    payload: { patch: { enabled: true }, version: current.updated_at, reason: "enable isolated self-authored source" },
  });
  assert.equal(enabled.statusCode, 200, enabled.body);
  boss = await getBoss();
  if (!registeredWorkers.has(boss)) {
    await registerSourceJobs(boss);
    await registerContentJobs(boss, 1);
    await registerEventJobs(boss);
    registeredWorkers.add(boss);
  }
  assert.equal((await scheduleDueSources()).enqueued, 1);
  const sql = runtimeSql;
  const until = async (label: string, check: () => Promise<boolean>) => {
    for (let n = 0; n < 600; n++) {
      if (await check()) return;
      await delay(50);
    }
    assert.fail(
      `${label}: ${JSON.stringify({ rows: await rows(), calls: fixture.calls.map(({ marker, step }) => ({ marker, step })), jobs: await sql`SELECT name,state,data,left(output::text,600) AS output FROM pgboss.job WHERE state IN ('created','retry','active')` })}`,
    );
  };
  const rows = () => sql`SELECT a.id,a.title,a.language,a.processing_state,a.processing_error,p.visibility,p.selected
    FROM articles a LEFT JOIN publications p ON p.article_id=a.id WHERE a.source_id=${options.name} ORDER BY a.title`;
  return { ...fixture, boss, sql, reader, admin, headers, until, rows, closeSurfaces, stopWorkers };
}
