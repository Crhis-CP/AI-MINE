// A source that stamps every entry with the same midnight ("Thu, 05 Nov 2026 00:00:00 +0000" on each pubDate, as
// the Portal Minero feed does) gives dates, not times (AGENTS.md 12): collection reads such a listing as dates,
// readings stored before that read as dates on every exit, and the server's minute time repair corrects
// projections already published. One explicit midnight among real times, or one day's midnights, stay times.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { TimeAssertion } from "@amp/contracts/time-assertion";
import { closeDb, sql } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { stopBoss } from "@amp/backend/jobs/queue";
import { readSourceDateContext } from "@amp/backend/admin/sources";
import { upsertMaterial } from "@amp/backend/content/materials";
import { publishArticle, repairPublicationTimes } from "@amp/backend/publication/publish";
import { loadItemDetail, publicItemMetadata } from "@amp/backend/publication/detail";
import { observeSourceDate, placeholderClock } from "../packages/backend/src/sources/date-extraction.ts";
import { readerAnchor } from "../packages/backend/src/publication/source-time.ts";
import { fetchItemsByIds, toFeedItemSummary } from "../packages/backend/src/publication/items.ts";
import { collectSource } from "./crawl-fixture.ts";
import { grantDateFixture } from "./source-date-fixture.ts";

after(async () => {
  await stopBoss();
  await closeDb();
});

const DAY = 86_400_000;
const utcDay = (n: number) => new Date(Math.floor(Date.now() / DAY) * DAY - n * DAY);
/** How a date-only feed stamps the UTC day n days ago: "Thu, 05 Nov 2026 00:00:00 +0000" (or another clock). */
const stamped = (n: number, clock = "00:00:00") => utcDay(n).toUTCString().replace("00:00:00 GMT", `${clock} +0000`);
const isoDay = (n: number) => utcDay(n).toISOString().slice(0, 10);
const timeOf = async (articleId: string) => (await publicItemMetadata(articleId))!.source_time as TimeAssertion | null;

test("the placeholder rule needs three clock readings over two days, all at midnight", () => {
  const clock = (day: string, local_time: string) => ({ precision: "second" as const, local_date: day, local_time });
  assert.ok(placeholderClock([clock("2026-11-03", "00:00:00"), clock("2026-11-04", "00:00:00"), clock("2026-11-05", "00:00")]));
  assert.ok(!placeholderClock([clock("2026-11-04", "00:00:00"), clock("2026-11-05", "00:00:00")]), "two readings prove nothing");
  assert.ok(!placeholderClock([clock("2026-11-05", "00:00:00"), clock("2026-11-05", "00:00:00"), clock("2026-11-05", "00:00:00")]), "one day's batch");
  assert.ok(!placeholderClock([clock("2026-11-03", "00:00:00"), clock("2026-11-04", "09:41:00"), clock("2026-11-05", "00:00:00")]), "a real time");
  assert.ok(placeholderClock([clock("2026-11-03", "00:00:00.000"), clock("2026-11-04", "00:00:00"), clock("2026-11-05", "00:00:00"), null]));
});

test("a feed stamping every entry with the same midnight is collected as dates, anchored like any date-only source", async (t) => {
  const feeds: Record<string, string[]> = {
    "/stamped": [stamped(1), stamped(2), stamped(3), stamped(4)],
    "/timed": [stamped(1, "10:15:00"), stamped(2), stamped(3, "14:30:00")],
  };
  const server = createServer((req, res) => {
    const path = req.url ?? "";
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end(
      `<rss><channel>${(feeds[path] ?? [])
        .map(
          (date, i) =>
            `<item><title>合成矿业资讯 ${path.slice(1)} ${i}</title><link>${base}${path}/item-${i}</link><pubDate>${date}</pubDate><description>${"合成来源正文。".repeat(70)}</description></item>`,
        )
        .join("")}</channel></rss>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const old = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  t.after(() => {
    config.allowPrivateNetworkFetch = old;
  });
  const source = async (path: string) => {
    const id = `stamped-${tag()}`;
    // As the Portal Minero source is configured: an RSS pubDate declared as RFC 2822.
    const sourceConfig = { feedUrl: `${base}${path}`, summaryIsBody: true, language: "es", sourceDate: { format: "rfc2822", language: "es" } };
    await sql`INSERT INTO sources (id, name, kind, enabled, config, cursor) VALUES
      (${id}, 'Synthetic stamped feed', 'rss', true, ${sql.json(sourceConfig)}, ${sql.json({ initializedAt: new Date(Date.now() - 10 * DAY).toISOString() })})`;
    await grantDateFixture(id, [base]);
    return id;
  };
  const readings = (id: string) =>
    sql<{ id: string; published_at: Date; time: TimeAssertion; excerpt: string }[]>`
      SELECT a.id, a.published_at, o.result->'evidence'->'time' AS time, o.observation->>'excerpt' AS excerpt
      FROM articles a JOIN content.source_date_observations o ON o.id=a.source_date_observation_id WHERE a.source_id=${id} ORDER BY a.published_at DESC`;

  const stampedId = await source("/stamped");
  assert.equal((await collectSource(stampedId)).status, "ok");
  const rows = await readings(stampedId);
  assert.equal(rows.length, 4);
  for (const [i, row] of rows.entries()) {
    const day = isoDay(i + 1);
    assert.deepEqual([row.time.precision, row.time.local_date, row.time.local_time, row.time.utc], ["date", day, null, null]);
    assert.equal(row.published_at.toISOString(), new Date(`${day}T00:00:00+08:00`).toISOString(), "the start of that day in Beijing, never 08:00");
    assert.ok(row.excerpt.includes("00:00:00 +0000") && row.excerpt.includes(row.time.raw), "the evidence keeps what the source printed");
  }
  await publishArticle(rows[0]!.id);
  assert.deepEqual((({ precision, local_date, utc }) => ({ precision, local_date, utc }))((await timeOf(rows[0]!.id))!), {
    precision: "date",
    local_date: isoDay(1),
    utc: null,
  });

  // One midnight among real times is a real time, as stated.
  const timedId = await source("/timed");
  assert.equal((await collectSource(timedId)).status, "ok");
  const timed = await readings(timedId);
  assert.equal(timed.length, 3);
  const midnight = timed.find((row) => row.time.local_date === isoDay(2))!;
  assert.deepEqual([midnight.time.precision, midnight.time.local_time], ["second", "00:00:00"]);
});

async function storedSource() {
  const id = `stored-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,config,site_fulltext) VALUES(${id},'合成日期来源','rss','T1','editorial','{}',true)`;
  await grantDateFixture(id, ["https://example.invalid/"]);
  return id;
}

/** Material stored straight from its pubDate, as collection stored it before it recognised placeholder midnights. */
async function stored(sourceId: string, raw: string) {
  const url = `https://example.invalid/${sourceId}/${randomUUID()}`;
  const context = (await readSourceDateContext(sourceId))!;
  const material = await upsertMaterial({
    sourceId,
    url,
    title: "合成矿业资讯",
    bodyText: "合成矿业资讯正文，提供原文标注的发布时间，用于独立验证公开时间，不访问真实模型。",
    language: "zh",
    bodyStatus: "ok",
    via: "fetch",
    discoveredAt: new Date(),
    sourceDateObservation: observeSourceDate(context, url, raw, "rss.pubDate"),
    permissionVersion: 1,
    expectedSourceDateVersion: 0,
  });
  await publishArticle(material.articleId);
  return material.articleId;
}

test("readings stored before are read as dates once the source shows its midnight is a placeholder; the time repair corrects published ones", async () => {
  const id = await storedSource();
  const ids: string[] = [];
  for (const n of [3, 2, 1]) ids.push(await stored(id, stamped(n)));
  // The evidence is what the source printed, unchanged.
  const evidence = await sql<{ precision: string }[]>`SELECT o.result->'evidence'->'time'->>'precision' AS precision
    FROM articles a JOIN content.source_date_observations o ON o.id=a.source_date_observation_id WHERE a.source_id=${id}`;
  assert.deepEqual(
    evidence.map((row) => row.precision),
    ["second", "second", "second"],
  );
  // Published after the third reading: already its date alone.
  assert.deepEqual((({ precision, local_date, utc, local_time }) => ({ precision, local_date, utc, local_time }))((await timeOf(ids[2]!))!), {
    precision: "date",
    local_date: isoDay(1),
    utc: null,
    local_time: null,
  });
  // Published while the source had fewer readings: still the clock (shown as 08:00 in Beijing) until the repair runs.
  assert.equal((await timeOf(ids[0]!))!.precision, "second");
  assert.ok((await repairPublicationTimes()).changed >= 2);
  for (const [i, articleId] of ids.entries()) {
    const time = (await timeOf(articleId))!;
    assert.deepEqual([time.precision, time.local_date, time.utc], ["date", isoDay(3 - i), null]);
    assert.doesNotMatch(time.label, /08:00|北京时间/);
  }
  const found = await loadItemDetail(ids[0]!);
  assert.equal(found.kind, "found");
  if (found.kind === "found") {
    assert.equal(found.detail.sourceTime?.precision, "date");
    assert.equal(found.detail.publishedAt, null, "no instant is published for a date");
  }
  assert.equal((await repairPublicationTimes()).changed, 0, "corrected once, not again");
  // A list card placed on its source day (an old or late report) shows that day, not the stored midnight's 08:00.
  await sql`UPDATE publications SET timeline_at=published_at WHERE article_id=${ids[0]!}`;
  const card = toFeedItemSummary((await fetchItemsByIds([ids[0]!])).get(ids[0]!)!);
  assert.equal(card.timelineAt, new Date(`${isoDay(3)}T00:00:00+08:00`).toISOString());
  // A report found within 48 hours sits at the time it was received, which stays as it is.
  const [fresh] = await sql<{ timeline_at: Date; discovered_at: Date }[]>`SELECT timeline_at,discovered_at FROM publications WHERE article_id=${ids[2]!}`;
  assert.equal(fresh!.timeline_at.getTime(), fresh!.discovered_at.getTime());
  assert.equal(toFeedItemSummary((await fetchItemsByIds([ids[2]!])).get(ids[2]!)!).timelineAt, fresh!.timeline_at.toISOString());
});

test("a list anchor is moved to the start of the Beijing day only when it is a date-only source's own moment", () => {
  const placeholder = new Date("2026-11-05T00:00:00Z"),
    day = { meaning: "published", raw: "05 Nov 2026", local_date: "2026-11-05", local_time: null, timezone: null, utc: null, precision: "date" };
  const time = {
    ...day,
    basis: "原文标注的发布时间",
    condition_text: null,
    meaning_label: "来源发布",
    label: "来源发布于 2026-11-05",
    beijing_date: "2026-11-05",
  };
  assert.equal(readerAnchor(placeholder, placeholder, time).toISOString(), "2026-11-04T16:00:00.000Z");
  const receipt = new Date("2026-11-05T12:09:43Z");
  assert.equal(readerAnchor(receipt, placeholder, time), receipt, "a receipt time is kept");
  assert.equal(readerAnchor(placeholder, placeholder, null), placeholder, "an unknown source time changes nothing");
});

test("one explicit midnight among real times, or one day's midnights, stay real times", async () => {
  const mixed = await storedSource();
  const mixedIds: string[] = [];
  for (const raw of [stamped(3), stamped(2, "09:41:00"), stamped(1)]) mixedIds.push(await stored(mixed, raw));
  const sameDay = await storedSource();
  const sameDayIds: string[] = [];
  for (let n = 0; n < 3; n++) sameDayIds.push(await stored(sameDay, stamped(1)));
  await repairPublicationTimes();
  for (const articleId of [mixedIds[0]!, mixedIds[2]!, ...sameDayIds]) {
    const time = (await timeOf(articleId))!;
    assert.deepEqual([time.precision, time.local_time], ["second", "00:00:00"], articleId);
    assert.match(time.label, /08:00/);
  }
});
