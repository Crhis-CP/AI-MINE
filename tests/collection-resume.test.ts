import "./setup.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { stopBoss } from "@amp/backend/jobs/queue";
import { collectSource } from "./crawl-fixture.ts";
import { grantDateFixture } from "./source-date-fixture.ts";

config.allowPrivateNetworkFetch = true;
let ready = false,
  listingHits = 0,
  detailHits = 0;
let titlePrefix = "Copper production";
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
      `<article><h1>${titlePrefix} ${req.url}</h1><time datetime="${published.toISOString()}"></time><p>${"Copper processing details and conditions. ".repeat(30)}</p></article>`,
    );
    return;
  }
  listingHits++;
  if (req.url === "/undated") {
    res.setHeader("content-type", "text/html");
    res.end(`<ul>${[0, 1].map((i) => `<li><a href="${origin}/detail/undated-${i}">Copper project ${i}</a></li>`).join("")}</ul>`);
    return;
  }
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
  titlePrefix = "Corrected copper production";
  const expired = new Date(Date.now() - 25 * 3600000).toISOString();
  await sql`UPDATE sources SET cursor=jsonb_set(cursor,'{detailCheckedAt}',${sql.json(expired)}) WHERE id='detail-resume-fixture'`;
  await sql`UPDATE articles SET raw=jsonb_set(raw,'{collectionDetail,checkedAt}',${sql.json(expired)}) WHERE source_id='detail-resume-fixture'`;
  assert.equal((await collectSource("detail-resume-fixture")).status, "ok");
  const corrected = await sql`SELECT title FROM articles WHERE source_id='detail-resume-fixture'`;
  assert.equal(corrected.length, 2, "rechecking preserves article identities");
  assert.equal(
    corrected.filter((row) => row.title.startsWith(titlePrefix)).length,
    1,
    "unchanged detail rules still refresh a corrected title within the fetch budget",
  );
});

test("undated web listings accumulate reliable detail dates across the per-round budget without clearing earlier evidence", async (t) => {
  ready = true;
  titlePrefix = "Copper production";
  const id = "undated-detail-resume-fixture";
  await sql`INSERT INTO sources(id,name,kind,lane,enabled,config,cursor) VALUES
    (${id},${id},'web_list','news',true,${sql.json({
      url: `${origin}/undated`,
      itemSelector: "li",
      linkSelector: "a",
      titleSelector: "a",
      sourceDate: { format: "iso8601", language: "en" },
      detail: { maxFetches: 1, publishedAtSelector: "time" },
    })},${sql.json({ initializedAt: new Date().toISOString() })})`;
  await grantDateFixture(id, [origin]);
  const rows = () => sql`SELECT id,url,revision,published_at,source_date_state,source_date_version,source_date_observation_id
    FROM articles WHERE source_id=${id} ORDER BY url`;
  const beforeHits = detailHits;
  assert.equal((await collectSource(id)).status, "ok");
  const first = await rows();
  assert.deepEqual(
    first.map((row) => row.source_date_state),
    ["reliable", "pending"],
  );
  assert.equal(detailHits - beforeHits, 1);
  // A later scheduled list is newer than the detail fixture's virtual pacing clock.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 2 * 3600000 });
  assert.equal((await collectSource(id)).status, "ok");
  const second = await rows();
  assert.deepEqual(
    second.map((row) => row.source_date_state),
    ["reliable", "reliable"],
  );
  assert.equal(detailHits - beforeHits, 2, "the second round uses its budget for the other article");
  assert.deepEqual(second[0], first[0], "missing unconfigured listing dates do not replace the bound reliable detail date");
  assert.ok(second.every((row) => row.published_at.getTime() === published.getTime()));
  const missing = await sql`SELECT o.id,o.result,s.last_observed_at,o.observed_at
    FROM content.source_date_observations o JOIN content.source_date_observation_seen s USING(article_id,revision,config_hash)
    WHERE o.article_id=${first[0].id} AND o.observation->>'raw'=''
      AND o.observation->>'locator'='listing publication field absent'`;
  assert.equal(missing.length, 1, "the missing listing observation remains in the audit history");
  assert.equal(missing[0].result.reason, "missing");
  assert.notEqual(missing[0].id, second[0].source_date_observation_id);
  assert.ok(missing[0].last_observed_at.getTime() >= missing[0].observed_at.getTime());
});
