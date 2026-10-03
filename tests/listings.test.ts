// A listing that names one article more than once stores it once, a feed whose entries are sections
// of one page (release notes #september-24-2026 …) keeps one article per section when the source says
// so, and a feed that garbles different characters on every load keeps one version. Before the
// fixes all three became revisions of one article on every fetch.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@amp/backend/config";
import { closeDb, dbOf } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { collectSource } from "@amp/backend/sources/collect";

const sql = dbOf("acquisition");

const T = tag();
const DUP_SOURCE = `test-rss-dup-${T}`;
const NOTES_SOURCE = `test-rss-notes-${T}`;
const GARBLED_SOURCE = `test-rss-garbled-${T}`;
const DAY = 86_400_000;

const item = (title: string, link: string, daysAgo: number) =>
  `<item><title>${title}</title><link>${link}</link><guid>${link}</guid><pubDate>${new Date(Date.now() - daysAgo * DAY).toUTCString()}</pubDate><description>${title} summary</description></item>`;
const feeds: Record<string, string> = {
  // developers.openai.com lists one video twice, under two titles.
  "/dup.xml": [
    item(`DevDay — optimization breakout ${T}`, `https://example.org/watch-${T}`, 0.1),
    item(`Balance accuracy, latency, and cost ${T}`, `https://example.org/watch-${T}`, 0.1),
  ].join(""),
  "/notes.xml": ["september-24", "september-23", "september-22"]
    .map((d, i) => item(`Release notes — ${d} ${T}`, `https://example.org/notes-${T}/overview#${d}`, 0.1 + i))
    .join(""),
};
// A feed that loses a character here and there on every load, sent as two or three U+FFFD, in titles and
// in descriptions longer than the excerpt kept from them.
const story = "9月25日，维多利亚的秘密上海淮海旗舰店开业，这是维密在中国市场运营十周年之际对线下门店的一次重新布局。".repeat(50);
const lose = (s: string, at: number, n: number) => s.slice(0, at) + "\uFFFD".repeat(n) + s.slice(at + 1);
const title = `维密重回上海淮海路，中国市场进入扩店阶段 ${T}`;
const garbledLoads = [
  [title, story],
  [title, lose(story, 120, 3)],
  [lose(title, 2, 2), lose(story, 700, 2)],
];
let garbledLoad = 0;
const server = http.createServer((req, res) => {
  let entries = feeds[req.url ?? ""] ?? "";
  if (req.url === "/garbled.xml") {
    const [t, description] = garbledLoads[garbledLoad++ % garbledLoads.length]!;
    entries = `<item><title>${t}</title><link>https://example.org/p/${T}?f=rss</link><pubDate>${new Date().toUTCString()}</pubDate><description><![CDATA[<p>${description}</p>]]></description></item>`;
  }
  res.writeHead(200, { "content-type": "application/rss+xml; charset=utf-8" });
  res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${entries}</channel></rss>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;

before(async () => {
  const cursor = sql.json({ initializedAt: new Date().toISOString() });
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at) VALUES
    (${DUP_SOURCE}, 'Test feed', 'rss', ${sql.json({ feedUrl: `${base}/dup.xml` })}, 'T1', 'editorial', ${cursor}, '2100-01-01'),
    (${NOTES_SOURCE}, 'Test release notes', 'rss', ${sql.json({ feedUrl: `${base}/notes.xml`, preserveUrlFragment: true })}, 'T1', 'editorial', ${cursor}, '2100-01-01'),
    (${GARBLED_SOURCE}, 'Test garbling feed', 'rss', ${sql.json({ feedUrl: `${base}/garbled.xml` })}, 'T1', 'hot_signal', ${cursor}, '2100-01-01')`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

const articles = (sourceId: string) =>
  sql<{ url: string; title: string; revision: number }[]>`SELECT url, title, revision FROM articles WHERE source_id = ${sourceId} ORDER BY url`;

test("an article a feed lists twice is stored once and stays put across fetches", async () => {
  for (let run = 0; run < 3; run++) assert.equal((await collectSource(DUP_SOURCE, { force: true })).status, "ok");
  const rows = await articles(DUP_SOURCE);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.title, rows[0]!.revision], [`DevDay — optimization breakout ${T}`, 1], "the first entry, never revised");
});

test("sections of one page are separate articles when the source keeps fragments", async () => {
  for (let run = 0; run < 2; run++) assert.equal((await collectSource(NOTES_SOURCE, { force: true })).status, "ok");
  const rows = await articles(NOTES_SOURCE);
  assert.deepEqual(
    rows.map((r) => [r.url.replace(/^.*#/, "#"), r.revision]),
    [
      ["#september-22", 1],
      ["#september-23", 1],
      ["#september-24", 1],
    ],
  );
});

test("a feed that garbles different characters on every load keeps one version", async () => {
  for (let run = 0; run < 3; run++) assert.equal((await collectSource(GARBLED_SOURCE, { force: true })).status, "ok");
  const rows = await articles(GARBLED_SOURCE);
  assert.deepEqual(
    rows.map((r) => [r.title, r.revision]),
    [[title, 1]],
  );
});
