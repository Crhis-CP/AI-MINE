import "./setup.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, test } from "node:test";
import { dbOf, closeDb } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { stopBoss } from "@amp/backend/jobs/queue";
import { collectSource } from "./crawl-fixture.ts";
import { grantDateFixture } from "./source-date-fixture.ts";

const sql = dbOf("content");
config.allowPrivateNetworkFetch = true;
let ready = false,
  listingHits = 0,
  detailHits = 0;
const published = new Date(Date.now() - 3600000);
const server = createServer((req, res) => {
  if (req.url?.startsWith("/detail/")) {
    detailHits++;
    if (!ready) {
      res.writeHead(500);
      res.end("fixture unavailable");
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(
      `<article><h1>Copper production ${req.url}</h1><time datetime="${published.toISOString()}"></time><p>${"Copper processing details and conditions. ".repeat(30)}</p></article>`,
    );
    return;
  }
  listingHits++;
  if (req.headers["if-none-match"] === '"fixture-v1"') {
    res.writeHead(304);
    res.end();
    return;
  }
  res.setHeader("content-type", "application/rss+xml");
  res.setHeader("etag", '"fixture-v1"');
  const long = req.url === "/long";
  const items = Array.from(
    { length: long ? 75 : 2 },
    (_, i) =>
      `<item><title>${long ? `Copper project ${i}` : "Read more"}</title><link>${origin}/detail/${long ? "long" : "pending"}-${i}</link>${long ? `<pubDate>${published.toUTCString()}</pubDate>` : "<pubDate>Mon, 01 Jan 2001 00:00:00 GMT</pubDate>"}</item>`,
  ).join("");
  const archive = long ? `<item><title>Unseen archive</title><link>${origin}/archive</link><pubDate>Mon, 01 Jan 2001 00:00:00 GMT</pubDate></item>` : "";
  res.end(`<rss version="2.0"><channel><title>Fixture</title>${items}${archive}</channel></rss>`);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});
async function source(id: string, path: string, detail?: Record<string, string | number | boolean>) {
  await sql`INSERT INTO sources(id,name,kind,lane,enabled,config,cursor)
    VALUES(${id},${id},'rss','news',true,${sql.json({ feedUrl: origin + path, ...(detail ? { detail } : {}) })},${sql.json({ initializedAt: new Date().toISOString() })})`;
  await grantDateFixture(id, [origin]);
}

test("a long current RSS window stores every new item before committing its validator", async () => {
  await source("long-window-fixture", "/long");
  const result = await collectSource("long-window-fixture");
  assert.equal(result.status, "ok", result.error);
  assert.equal(result.found, 76);
  assert.equal(result.created, 75, "new archive identities older than source admission stay outside the ordinary window");
  const again = await collectSource("long-window-fixture");
  assert.equal(again.found, 0, "the next conditional request may now accept 304 without losing the tail");
  assert.equal((await sql`SELECT count(*)::int AS n FROM articles WHERE source_id='long-window-fixture'`)[0].n, 75);
});

test("failed and budget-deferred detail work resumes for stored articles before accepting RSS 304", async () => {
  await source("detail-resume-fixture", "/small", {
    maxFetches: 1,
    titleSelector: "h1",
    titleAuthoritative: true,
    publishedAtSelector: "time",
    publishedAtAuthoritative: true,
  });
  assert.equal((await collectSource("detail-resume-fixture")).created, 2);
  ready = true;
  for (let i = 0; i < 2; i++) assert.equal((await collectSource("detail-resume-fixture")).status, "ok");
  const rows = await sql`SELECT title,published_at FROM articles WHERE source_id='detail-resume-fixture'`;
  assert.equal(rows.length, 2);
  assert.ok(
    rows.every((row) => row.title.startsWith("Copper production")),
    JSON.stringify({ rows, detailHits, runs: await sql`SELECT detail FROM fetch_runs WHERE source_id='detail-resume-fixture' ORDER BY id` }),
  );
  assert.ok(rows.every((row) => row.published_at?.getTime() === published.getTime()));
  const before = detailHits;
  const again = await collectSource("detail-resume-fixture");
  assert.equal(again.found, 0);
  assert.equal(detailHits, before);
  assert.ok(listingHits > 3);
});
