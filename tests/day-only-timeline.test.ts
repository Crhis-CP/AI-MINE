// Sources that print a date alone, through collection, publication and the public list (TASK-0040): the
// date is kept as the published time, the start of that day in Beijing whatever its spelling (ISO included),
// so the upstream's timeline rule works on it and pages can show the date alone: a new source's first
// import and an item found more than 48 hours late go on their own day and stay out of "today". The
// correction script dry-runs without writing, corrects and republishes once, and keeps a manual withdrawal.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { config } from "@amp/backend/config";
import { closeDb, dbOf } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { collectSource } from "@amp/backend/sources/collect";
import { publishArticle } from "@amp/backend/publication/publish";
import { loadPool } from "@amp/backend/publication/pool";
import { setVisibility } from "@amp/backend/admin/content";
import { beijingDate } from "@amp/contracts/time";
import { grantDateFixture } from "./source-date-fixture.ts";

const sql = dbOf("content");
const T = tag();
const LIST = `test-dayonly-${T}`;
const DETAIL = `test-dayonly-detail-${T}`;
const DAY = 86_400_000;
const today = beijingDate(new Date());
const daysAgo = (n: number) => beijingDate(new Date(Date.parse(`${today}T12:00:00+08:00`) - n * DAY));
const beijingMidnight = (day: string) => new Date(`${day}T00:00:00+08:00`).toISOString();
const slashed = (day: string) => day.replaceAll("-", "/");
const BODY = "合成的矿业资讯正文，用于检验只写日期的来源在时间线上的位置，内容足够长。";

let entries: Array<{ slug: string; title: string; day: string }> = [];
const server = http.createServer((req, res) => {
  const url = req.url ?? "";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (url === "/list") return res.end(`<ul>${entries.map((e) => `<li><a href="/a/${e.slug}">${e.title}</a><span>${e.day}</span></li>`).join("")}</ul>`);
  if (url === "/dlist") return res.end(`<ul>${entries.map((e) => `<li><a href="/a/${e.slug}">${e.title}</a></li>`).join("")}</ul>`);
  const e = entries.find((x) => url === `/a/${x.slug}`);
  res.end(`<html><body><h1>${e?.title ?? ""}</h1><p>${BODY}</p><span class="pub">${e ? slashed(e.day) : ""}</span></body></html>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;

const listing = { language: "zh-CN", itemSelector: "li", linkSelector: "a[href]" };
const detail = {
  publishedAtSelector: ".pub",
  maxFetches: 5,
  sourceDate: { format: "declared", language: "zh-CN", formatPattern: "YYYY/MM/DD" },
};
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, site_fulltext, next_fetch_at) VALUES
    (${LIST}, '只写日期的列表', 'web_list', ${sql.json({ ...listing, url: `${base}/list`, publishedAtRegex: "<span>(\\d{4}-\\d{2}-\\d{2})</span>" })},
      'T1', 'editorial', true, '2100-01-01'),
    (${DETAIL}, '日期只在详情页', 'web_list', ${sql.json({ ...listing, url: `${base}/dlist`, detail })}, 'T1', 'editorial', true, '2100-01-01')`;
  for (const id of [LIST, DETAIL]) await grantDateFixture(id, [base]);
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

/** Collects a source, fills in the body the extraction job would fetch, and publishes every item. */
async function collect(sourceId: string) {
  assert.equal((await collectSource(sourceId, { force: true })).status, "ok");
  await sql`UPDATE articles SET body_text = ${BODY}, body_status = 'ok' WHERE source_id = ${sourceId} AND body_text IS NULL`;
  for (const { id } of await sql<{ id: string }[]>`SELECT id FROM articles WHERE source_id = ${sourceId}`) await publishArticle(id);
}
const row = async (title: string) =>
  (await sql<{ id: string; published_at: Date | null; timeline_at: Date; backfill: boolean; backfill_reason: string | null }[]>`
    SELECT id, published_at, timeline_at, backfill, backfill_reason FROM articles WHERE title = ${title}`)[0]!;
const pool = () => loadPool({ channel: "all", category: null, tag: null, topicTags: null } as never);
const ours = (items: Array<{ title: string }>) => items.filter((i) => i.title.endsWith(T)).map((i) => i.title);

test("a date alone is kept as the start of that day; old ones go on their day, not today", async () => {
  // First import of a new source: what is already listed is archived by its own date.
  entries = [
    { slug: "stock-today", title: `存量今天 ${T}`, day: today },
    { slug: "stock-yesterday", title: `存量昨天 ${T}`, day: daysAgo(1) },
    { slug: "stock-old", title: `存量两个月前 ${T}`, day: daysAgo(60) },
  ];
  await collect(LIST);
  const old = await row(`存量两个月前 ${T}`);
  assert.equal(old.published_at?.toISOString(), beijingMidnight(daysAgo(60)), "an ISO date alone is the start of that day in Beijing");
  assert.deepEqual([old.timeline_at.toISOString(), old.backfill_reason], [beijingMidnight(daysAgo(60)), "first-import"]);
  assert.equal((await row(`存量昨天 ${T}`)).timeline_at.toISOString(), beijingMidnight(daysAgo(1)));
  let listed = await pool();
  assert.equal(listed.items.find((i) => i.title === `存量两个月前 ${T}`)?.publishedAt, beijingMidnight(daysAgo(60)), "the public list shows that day");

  // Later runs: found within 48 hours of its date it is news; found later it goes on its own day.
  entries.push({ slug: "new-yesterday", title: `新稿昨天 ${T}`, day: daysAgo(1) }, { slug: "new-old", title: `新稿三天前 ${T}`, day: daysAgo(3) });
  await collect(LIST);
  const late = await row(`新稿三天前 ${T}`);
  assert.deepEqual([late.timeline_at.toISOString(), late.backfill_reason], [beijingMidnight(daysAgo(3)), "stale-on-discovery"]);
  const fresh = await row(`新稿昨天 ${T}`);
  assert.equal(fresh.backfill, false, "within 48 hours: news, on the timeline when found");
  assert.equal(fresh.published_at?.toISOString(), beijingMidnight(daysAgo(1)));

  listed = await pool();
  const todays = ours(listed.items.filter((i) => beijingDate(i.timelineAt) === today));
  assert.ok(!todays.includes(`存量两个月前 ${T}`) && !todays.includes(`新稿三天前 ${T}`) && !todays.includes(`存量昨天 ${T}`), todays.join(", "));
  assert.ok(todays.includes(`新稿昨天 ${T}`) && todays.includes(`存量今天 ${T}`), todays.join(", "));
});

test("a date found only on the detail page is read the same way, in Beijing time when written 2026/09/26", async () => {
  entries = [{ slug: "detail-old", title: `详情页三天前 ${T}`, day: daysAgo(3) }];
  await collect(DETAIL);
  const r = await row(`详情页三天前 ${T}`);
  assert.equal(r.published_at?.toISOString(), beijingMidnight(daysAgo(3)), "kept by the date commit, not cleared");
  assert.deepEqual([r.timeline_at.toISOString(), r.backfill_reason], [beijingMidnight(daysAgo(3)), "first-import"]);
});

test("the correction script dry-runs, corrects and republishes once, and keeps a manual withdrawal", async () => {
  // Two items stored the old way: no published time, on the timeline when they were found.
  const late = await row(`新稿三天前 ${T}`);
  const kept = await row(`存量两个月前 ${T}`);
  await sql`UPDATE articles SET published_at = NULL, published_at_claim = NULL, timeline_at = discovered_at, backfill = false, backfill_reason = NULL
    WHERE id IN ${sql([late.id, kept.id])}`;
  for (const id of [late.id, kept.id]) await publishArticle(id);
  const [{ version }] = await sql<{ version: number }[]>`SELECT coalesce(max(version), 0) AS version FROM editorial_overrides WHERE article_id = ${kept.id}`;
  await setVisibility(kept.id, { visibility: "withdrawn", reason: "合成：人工下架", version }, "test");
  const script = fileURLToPath(new URL("../scripts/retime-day-only.ts", import.meta.url));
  const run = (...args: string[]) => execFileSync(process.execPath, [script, ...args], { env: process.env, encoding: "utf8" });

  const dry = run("--dry-run");
  assert.ok(dry.includes(late.id) && dry.includes(kept.id), "the dry run lists what it would change");
  assert.equal((await row(`新稿三天前 ${T}`)).published_at, null, "a dry run writes nothing");

  run();
  const fixed = await row(`新稿三天前 ${T}`);
  assert.deepEqual(
    [fixed.published_at?.toISOString(), fixed.timeline_at.toISOString(), fixed.backfill_reason],
    [beijingMidnight(daysAgo(3)), beijingMidnight(daysAgo(3)), "stale-on-discovery"],
  );
  const [pub] = await sql<{ published_at: Date; timeline_at: Date }[]>`SELECT published_at, timeline_at FROM publications WHERE article_id = ${late.id}`;
  assert.deepEqual([pub!.published_at.toISOString(), pub!.timeline_at.toISOString()], [beijingMidnight(daysAgo(3)), beijingMidnight(daysAgo(3))], "republished");
  const [withdrawn] = await sql<{ visibility: string }[]>`SELECT visibility FROM publications WHERE article_id = ${kept.id}`;
  assert.equal(withdrawn!.visibility, "withdrawn", "a manual withdrawal stays");
  assert.equal((await row(`存量两个月前 ${T}`)).timeline_at.toISOString(), beijingMidnight(daysAgo(60)));

  const again = run("--dry-run");
  assert.ok(!again.includes(late.id) && !again.includes(kept.id), "a second run changes nothing");
});
