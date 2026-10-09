import "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@amp/backend/config";
import { closeDb, dbOf } from "@amp/backend/db";
import { getBoss, stopBoss } from "@amp/backend/jobs/queue";
import { registerSourceJobs } from "@amp/backend/jobs/sources";
import { enqueueSourceFetch } from "../packages/backend/src/jobs/source-queues.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
const sql = dbOf("acquisition"),
  requests: { path: string; at: number }[] = [];
const server = http.createServer((req, res) => {
  const path = req.url!;
  requests.push({ path, at: Date.now() });
  if (path === "/robots.txt") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("User-agent: *\nCrawl-delay: 2");
    return;
  }
  res.writeHead(200, { "content-type": "application/rss+xml" });
  res.end(`<rss><channel><item><title>合成矿业材料</title><link>${base}${path}/item</link></item></channel></rss>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
Object.assign(process.env, { COLLECT_ENABLED: "true", COLLECT_NEWS_ENABLED: "true", COLLECT_POLICY_ENABLED: "true" });
after(async () => {
  await stopBoss();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
});
test("actual news/policy consumers finish deferred reservations without sleeping or reporting false failure/success", async () => {
  const boss = await getBoss();
  await registerSourceJobs(boss);
  for (const lane of ["news", "policy"] as const) {
    await sql`INSERT INTO sources(id,name,kind,lane,enabled,participation_mode,config) VALUES(${`crawl-${lane}`},${lane},'rss',${lane},true,'isolated',${sql.json({ feedUrl: `${base}/${lane}` })})`;
    await grantDateFixture(`crawl-${lane}`, [base]);
    await enqueueSourceFetch(lane, { sourceId: `crawl-${lane}` });
  }
  const deadline = Date.now() + 25_000;
  for (;;) {
    const [count] =
      await sql`SELECT (SELECT count(*) FROM articles WHERE source_id IN ('crawl-news','crawl-policy'))::int n,(SELECT count(*) FROM fetch_runs WHERE source_id IN ('crawl-news','crawl-policy') AND status='ok')::int finished`;
    if (count.n === 2 && count.finished === 2) break;
    assert.ok(Date.now() < deadline, "both queues must resume and finish");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(requests.filter((row) => row.path === "/robots.txt").length, 1);
  for (let i = 1; i < requests.length; i++) assert.ok(requests[i]!.at - requests[i - 1]!.at >= 1950, "same host must respect 2s minimum");
  const runs =
    await sql`SELECT status,new_count,detail,extract(epoch FROM finished_at-started_at) AS seconds FROM fetch_runs WHERE source_id IN ('crawl-news','crawl-policy')`;
  assert.equal(runs.filter((row) => row.status === "failed").length, 0);
  assert.equal(runs.filter((row) => row.status === "ok").length, 2);
  assert.equal(
    runs.reduce((sum, row) => sum + row.new_count, 0),
    2,
  );
  const deferred = runs.filter((row) => row.detail?.state === "deferred");
  assert.ok(deferred.length > 0);
  assert.ok(deferred.every((row) => row.status === "skipped" && row.seconds < 1));
});
