import { tag } from "./setup.ts";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { requestSourcePreview } from "@amp/backend/admin/sources";
import { grantDateFixture } from "./source-date-fixture.ts";
import { saveRobots } from "../packages/backend/src/acquisition/pacing.ts";
const sql = dbOf("sources");
after(closeDb);

test("real RSS preview finishes with a single database connection and leaves its paused source cursor untouched", async (t) => {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end(
      '<?xml version="1.0"?><rss version="2.0"><channel><title>Synthetic mining</title><item><title>合成铜矿扩产预览</title><link>https://example.com/mining/one</link><description>合成矿业样例</description></item></channel></rss>',
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const id = `single-preview-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,config,enabled) VALUES(${id},'合成暂停RSS','rss',${sql.json({ feedUrl: `${origin}/rss` })},false)`;
  await grantDateFixture(id, [origin, "https://example.com"]);
  await saveRobots(origin, 404, "", new Date(), null, null);
  await sql`UPDATE acquisition.crawl_hosts SET next_slot=now()-interval '1 hour',last_finished=now()-interval '1 hour',cooldown_until=now()-interval '1 hour'`;
  const preview = await requestSourcePreview(id, {}, "test", { inline: true });
  const code = `import './tests/setup.ts';
    import {runSourcePreview} from '@amp/backend/admin/sources';
    import {config} from '@amp/backend/config';
    import {closeDb} from '@amp/backend/db';
    config.allowPrivateNetworkFetch=true;
    try {console.log('RESULT:'+JSON.stringify(await runSourcePreview(process.argv[1])));} finally {await closeDb();}`;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, String(preview.preview_id)], {
    env: { ...process.env, DATABASE_POOL_MAX: "1" },
    timeout: 4000,
  });
  const parsed = JSON.parse(result.stdout.match(/RESULT:(.+)/)![1]!);
  assert.equal(parsed.count, 1);
  assert.equal(hits, 1);
  assert.equal((await sql`SELECT status FROM sources.source_previews WHERE id=${preview.preview_id}`)[0]!.status, "succeeded");
  assert.deepEqual({ ...(await sql`SELECT enabled,cursor FROM sources WHERE id=${id}`)[0] }, { enabled: false, cursor: null });
});

test("the real RSS transport aborts within its preview deadline with one database connection", async (t) => {
  let hits = 0;
  const server = http.createServer((_req, _res) => {
    hits++;
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const id = `deadline-preview-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,config,enabled) VALUES(${id},'合成不响应RSS','rss',${sql.json({ feedUrl: `${origin}/rss` })},false)`;
  await grantDateFixture(id, [origin]);
  await saveRobots(origin, 404, "", new Date(), null, null);
  await sql`UPDATE acquisition.crawl_hosts SET next_slot=now()-interval '1 hour',last_finished=now()-interval '1 hour',cooldown_until=now()-interval '1 hour'`;
  const preview = await requestSourcePreview(id, {}, "test", { inline: true });
  const code = `import './tests/setup.ts';
    import {runSourcePreview} from '@amp/backend/admin/sources'; import {config} from '@amp/backend/config'; import {closeDb} from '@amp/backend/db';
    config.allowPrivateNetworkFetch=true;
    try {await runSourcePreview(process.argv[1],undefined,{timeoutMs:500});console.log('UNEXPECTED_SUCCESS');}
    catch(e) {console.log('REJECTED:'+e.name);} finally {await closeDb();}`;
  const child = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, String(preview.preview_id)], {
    env: { ...process.env, DATABASE_POOL_MAX: "1" },
    timeout: 4000,
  });
  assert.match(child.stdout, /REJECTED:TimeoutError/);
  assert.equal(hits, 1);
  const [row] = await sql`SELECT status,execution_token,lease_until FROM sources.source_previews WHERE id=${preview.preview_id}`;
  assert.equal(row!.status, "failed");
  assert.equal(row!.execution_token, null);
  assert.equal(row!.lease_until, null);
});
