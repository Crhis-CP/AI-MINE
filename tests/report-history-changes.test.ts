import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { normalizeSourceTime } from "@amp/contracts/time-assertion";
import { historicalReportRows, reportChangeNotifications, ackReportChangeNotifications, sourceReportIssue } from "@amp/backend/publication/groups";

after(closeDb);
const source = "report-history-source",
  configHash = "a".repeat(64);
await sql`INSERT INTO sources(id,name,kind,source_date_config_hash) VALUES(${source},'Synthetic historical source','rss',${configHash})`;
const time = (date: string, utc: string | null) =>
  normalizeSourceTime(
    {
      meaning: "published",
      raw: utc ?? date,
      local_date: date,
      local_time: utc ? utc.slice(11, 19) : null,
      utc,
      timezone: utc ? "UTC" : null,
      precision: utc ? "second" : "date",
      basis: "Synthetic original date",
      condition_text: null,
    },
    { instantBasis: utc ? "explicit" : null, timezoneEvidence: utc ? "UTC fixture" : null },
  );

async function fixture(suffix: string, sourceTime: ReturnType<typeof time>) {
  const at = new Date("2020-01-01T00:00:00Z"),
    discovered = new Date("2020-01-10T12:00:00Z"),
    url = `https://source.invalid/history-${suffix}`;
  const material = await upsertMaterial({
    sourceId: source,
    url,
    title: "Synthetic late mining report",
    bodyText: "Synthetic mining project evidence.",
    publishedAt: at,
    discoveredAt: discovered,
    via: "fetch",
  });
  await sql`UPDATE articles SET source_date_version=1,source_date_state='reliable' WHERE id=${material.articleId}`;
  await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,discovered_at,published_at,timeline_at,sort_at,visible_after,selected,eligible,backfill,source_time,source_date_version,source_time_material_revision,source_date_config_hash)
    VALUES(${material.articleId},'Synthetic title','Synthetic summary',${source},'news',${url},${discovered},${at},${at},${at},${discovered},true,true,true,${sql.json(sourceTime)},1,1,${configHash})`;
  return material.articleId;
}

test("known source clocks use the cutoff; date-only inputs use the following issue without inventing a clock", () => {
  assert.equal(sourceReportIssue(time("2020-01-01", "2020-01-01T23:59:59Z")), "2020-01-02");
  assert.equal(sourceReportIssue(time("2020-01-02", "2020-01-02T00:00:00Z")), "2020-01-03");
  const day = time("2020-01-01", null);
  assert.equal(sourceReportIssue(day), "2020-01-02");
  assert.equal(day.utc, null);
  assert.equal(sourceReportIssue(null), null);
  assert.equal(sourceReportIssue({ precision: "date", local_date: "2020-02-30" }), null);
});

test("late and backfill reports use reliable original dates; stale bindings do not enter historical inputs", async () => {
  const id = await fixture("late", time("2020-01-01", null));
  const rows = await historicalReportRows(new Date("2020-01-01T00:00:00Z"), new Date("2020-01-02T00:00:00Z"));
  assert.ok(rows.some((row) => row.id === id));
  assert.ok(!(await historicalReportRows(new Date("2020-01-10T00:00:00Z"), new Date("2020-01-11T00:00:00Z"))).some((row) => row.id === id));
  await sql`UPDATE articles SET source_date_version=2 WHERE id=${id}`;
  assert.ok(!(await historicalReportRows(new Date("2020-01-01T00:00:00Z"), new Date("2020-01-02T00:00:00Z"))).some((row) => row.id === id));
});

test("old acknowledgements and rolled-back consumers cannot erase a later source change", async () => {
  const id = await fixture("revision", time("2020-01-01", null));
  const first = (await reportChangeNotifications(200)).find((change) => change.articleId === id)!;
  assert.ok(first.periods.includes("2020-01-02"));
  await sql`UPDATE publications SET source_time=${sql.json(time("2020-01-02", null))} WHERE article_id=${id}`;
  await sql.begin((tx) => ackReportChangeNotifications([first], tx));
  const changed = (await reportChangeNotifications(200)).find((change) => change.articleId === id)!;
  assert.equal(changed.generation, first.generation + 1);
  assert.ok(changed.periods.includes("2020-01-02") && changed.periods.includes("2020-01-03"));
  await assert.rejects(
    sql.begin(async (tx) => {
      await ackReportChangeNotifications([changed], tx);
      throw new Error("Synthetic consumer interruption");
    }),
    /Synthetic consumer interruption/,
  );
  assert.ok((await reportChangeNotifications(200)).some((change) => change.articleId === id));
  await sql.begin((tx) => ackReportChangeNotifications([changed], tx));
  assert.ok(!(await reportChangeNotifications(200)).some((change) => change.articleId === id));
  await sql`UPDATE publications SET title='A later source correction' WHERE article_id=${id}`;
  await sql.begin((tx) => ackReportChangeNotifications([changed], tx));
  const next = (await reportChangeNotifications(200)).find((change) => change.articleId === id)!;
  assert.ok(next.generation > changed.generation, "acknowledge/recreate must not recycle a generation and lose the new change");
});
