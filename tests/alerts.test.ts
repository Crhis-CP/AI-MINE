// Ops alerts reach the site owner: a problem is announced once, repeated no more than its level allows
// (hourly for reader impact), closed with one recovery message; entries from before the levels existed
// close without a message. Metal prices not fetched for over a day wait for the 09:00 digest (TASK-0071).
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { getBoss, stopBoss } from "@amp/backend/jobs/queue";
import { upsertMaterial } from "@amp/backend/content/materials";
import { checkAlerts, collectFindings, readMetalPriceRuns, sendDigest } from "@amp/backend/operations/alerts";

const sql = dbOf("ops");

const T = tag();
const SOURCE = `test-alerts-${T}`;
let saved: { key: string; value: unknown }[] = [];
const ids: string[] = [];

before(async () => {
  await getBoss(); // collectFindings reads the job tables
  saved = await sql`SELECT key, value FROM settings WHERE key IN ('alerts.state', 'heartbeat.worker')`;
  await sql`DELETE FROM settings WHERE key = 'heartbeat.worker'`;
  await sql`INSERT INTO sources (id, name, kind, next_fetch_at) VALUES (${SOURCE}, 'Test alerts', 'rss', '2100-01-01')`;
  // Ten new articles that have waited three hours: new content is stuck, readers see nothing new.
  for (let i = 0; i < 10; i++) {
    const { articleId } = await upsertMaterial({
      sourceId: SOURCE,
      url: `https://example.com/${T}-${i}`,
      title: `stuck ${i}`,
      bodyStatus: "none",
      via: "fetch",
    } as never);
    ids.push(articleId);
  }
  await sql`UPDATE articles SET discovered_at = now() - interval '3 hours', processing_state = 'new' WHERE id IN ${sql(ids)}`;
});
after(async () => {
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await sql`DELETE FROM settings WHERE key = 'alerts.state'`;
  for (const s of saved)
    await sql`INSERT INTO settings (key, value, updated_by) VALUES (${s.key}, ${sql.json(s.value as never)}, 'test') ON CONFLICT (key) DO NOTHING`;
  await stopBoss();
  await closeDb();
});

test("an outage is announced once, repeated hourly, and closed with one recovery", async () => {
  process.env.COLLECT_ENABLED = "true";
  process.env.MODEL_CALLS_ENABLED = "true";
  const t0 = Date.now();
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('alerts.state', ${sql.json({ "receipts.unknown": { title: "付费请求结果未知", since: new Date(t0 - 86400_000).toISOString(), sentAt: new Date(t0 - 3600_000).toISOString() } })}, 'test')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  const stuck = (sent: string[]) => sent.filter((k) => k.startsWith("content.process"));

  let r = await checkAlerts(t0);
  assert.deepEqual(stuck(r.sent), ["content.process"]);
  assert.ok(!r.sent.some((k) => k.startsWith("receipts.unknown")), "an entry from before the levels closes silently");
  assert.ok(!r.open.includes("receipts.unknown"));
  r = await checkAlerts(t0 + 50 * 60_000);
  assert.deepEqual(stuck(r.sent), [], "no repeat within the hour");
  r = await checkAlerts(t0 + 61 * 60_000);
  assert.deepEqual(stuck(r.sent), ["content.process"], "hourly reminder while it lasts");

  await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id IN ${sql(ids)}`;
  r = await checkAlerts(t0 + 70 * 60_000);
  assert.deepEqual(stuck(r.sent), ["content.process:recovered"]);
  r = await checkAlerts(t0 + 80 * 60_000);
  assert.deepEqual(stuck(r.sent), []);
});

// ---- Metal prices (TASK-0071) -------------------------------------------------------------------------------------
// These metals.prices runs are this file's own, at a fixed far-future hour, and removed after each test: no run another
// test writes falls in the 30 days the reader looks back from NOW.
const NOW = Date.parse("2100-01-10T01:00:00Z"); // 09:00 in Beijing, when the digest goes out
const WHERE = "看 job_runs 里 metals.prices 的运行记录";
const seeded: number[] = [];

/** A period of a source's entry, as the refresh writes it. */
const period = (label: string, held: string | null = null, heldSeries?: { key: string; reason: string }[]) => ({
  period: label,
  version: `${label}的价格`,
  inserted: held || heldSeries ? 0 : 10,
  touched: 0,
  changed: [],
  held,
  notes: [],
  ...(heldSeries ? { heldSeries } : {}),
});
/** A source's entry, ok worked out as the refresh does; no period and no error is TASK-0046's note. */
const entry = (periods: ReturnType<typeof period>[], error: string | null = null) => ({
  ok: !error && periods.every((p) => p.held === null && !p.heldSeries),
  at: "",
  error,
  inserted: 0,
  touched: 0,
  periods,
  ...(!error && !periods.length ? { note: "这次一期都没有返回" } : {}),
});

/** This file's runs become exactly these, each `hours` before NOW; one without a record failed with `error`. */
async function seed(...runs: { hours: number; record?: Record<string, ReturnType<typeof entry>>; error?: string; job?: string }[]) {
  if (seeded.length) await sql`DELETE FROM job_runs WHERE id IN ${sql(seeded.splice(0))}`;
  for (const run of runs) {
    const at = new Date(NOW - run.hours * 3600_000);
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO job_runs (job, started_at, finished_at, status, detail, error)
      VALUES (${run.job ?? "metals.prices"}, ${at}, ${at}, ${run.record ? "ok" : "failed"}, ${run.record ? sql.json(run.record as never) : null}, ${run.error ?? null})
      RETURNING id`;
    seeded.push(row!.id);
  }
}

test("metal prices: a source not fetched for over a day is in the digest, with its latest reason and last success", async () => {
  process.env.COLLECT_ENABLED = "true";
  const metals = async () => (await collectFindings(NOW)).find((f) => f.key === "metals.fetch");
  const listed = (...lines: string[]) => ({
    key: "metals.fetch",
    level: "digest",
    title: `金属价格有 ${lines.length} 个来源超过一天没抓到，暂用上一期数据`,
    detail: [...lines, WHERE].join("；"),
  });
  const stopped = (detail: string) => ({ key: "metals.fetch", level: "digest", title: "金属价格超过一天没有抓取成功，暂用上一期数据", detail });
  const stored = entry([period("2099年12月下旬")]);
  const failed = entry([], "列表页返回 HTTP 503");
  try {
    // The last success within 26 hours: nothing, though the latest run failed; a source no longer in the runs (stopped
    // in the registry) is not looked at.
    await seed({ hours: 40, record: { imf: failed } }, { hours: 25, record: { nbs: stored } }, { hours: 2, record: { nbs: failed } });
    assert.equal(await metals(), undefined);
    // Exactly 26 hours is not over it; a minute more is.
    await seed({ hours: 26, record: { nbs: stored } }, { hours: 2, record: { nbs: failed } });
    assert.equal(await metals(), undefined);
    await seed({ hours: 26 + 1 / 60, record: { nbs: stored } }, { hours: 2, record: { nbs: failed } });
    assert.deepEqual(await metals(), listed("nbs：列表页返回 HTTP 503（上次成功 1月9日 06:59）"));
    // Over 26 hours: the source, its latest reason (an error before any period held back) and its last success in
    // Beijing time.
    await seed(
      { hours: 30, record: { nbs: stored } },
      { hours: 10, record: { nbs: entry([period("2100年1月上旬", "发布页读不到标题")], "写库出错：连接断开") } },
    );
    assert.deepEqual(await metals(), listed("nbs：写库出错：连接断开（上次成功 1月9日 03:00）"));
    // Never a success: listed once it first appeared over 26 hours ago, not before.
    await seed({ hours: 30, record: { nbs: failed } }, { hours: 10, record: { nbs: failed } });
    assert.deepEqual(await metals(), listed("nbs：列表页返回 HTTP 503（还没有成功过）"));
    await seed({ hours: 20, record: { nbs: failed } }, { hours: 10, record: { nbs: failed } });
    assert.equal(await metals(), undefined);
    // A period held back, one waiting for it and a series held back alone are no success (a period held back whole is
    // the reason before a series); the runs after them that returned no period (TASK-0046's note) keep that outcome.
    const held = period("2100年1月上旬", "nbs.copper 是 128000，是上一期 80000 的 1.60 倍，超出 0.67–1.5 倍");
    const holding = [
      { hours: 30, record: { imf: entry([period("2099年11月")]), nbs: stored, worldbank: entry([period("2099年11月")]) } },
      {
        hours: 10,
        record: {
          imf: entry([period("2099年12月", null, [{ key: "imf.copper", reason: "说明对不上" }])]),
          nbs: entry([held, period("2100年1月中旬", "等 2100年1月上旬")]),
          worldbank: entry([period("2099年11月", "表头对不上"), period("2099年12月", null, [{ key: "wb.copper", reason: "说明对不上" }])]),
        },
      },
    ];
    const reasons = [
      "imf：2099年12月按品种扣下：imf.copper（说明对不上）（上次成功 1月9日 03:00）",
      `nbs：2100年1月上旬被扣下：${held.held}（上次成功 1月9日 03:00）`,
      "worldbank：2099年11月被扣下：表头对不上（上次成功 1月9日 03:00）",
    ];
    await seed(...holding);
    assert.deepEqual(await metals(), listed(...reasons));
    const nothing = { imf: entry([]), nbs: entry([]), worldbank: entry([]) };
    await seed(...holding, { hours: 5, record: nothing }, { hours: 1, record: nothing });
    assert.deepEqual(await metals(), listed(...reasons));
    // "No new version" (the stored newest period read again) is a success, and so is a note after one, at its own time,
    // or with no period returned in the 30 days.
    await seed(
      { hours: 30, record: { imf: entry([]), nbs: stored, worldbank: entry([period("2099年11月")]) } },
      { hours: 10, record: { imf: entry([]), nbs: entry([{ ...period("2099年12月下旬"), inserted: 0, touched: 10 }]), worldbank: entry([]) } },
    );
    assert.equal(await metals(), undefined);
    // A period stored by force (TASK-0076's metals.prices.manual) clears its hold: the scheduled runs after it that return
    // no period (World Bank's same version within 7 days) keep the forced outcome.
    await seed(
      { hours: 40, record: { worldbank: entry([period("2099年11月", "wb.copper 是上一期的 2.10 倍，超出 0.67–1.5 倍")]) } },
      { hours: 30, job: "metals.prices.manual", record: { worldbank: entry([period("2099年11月")]) } },
      { hours: 20, record: { worldbank: entry([]) } },
      { hours: 10, record: { worldbank: entry([]) } },
    );
    assert.equal(await metals(), undefined);
    // Runs on record but none ok for over 26 hours (a bad registry throws, or the schedule stopped): said whether or not
    // a source is known; a failed latest run's error is said once, first.
    const broken = { hours: 10, error: "Error: 登记文件不合格" };
    await seed({ hours: 26, record: { nbs: stored } }, broken);
    assert.equal(await metals(), undefined);
    await seed({ hours: 26 + 1 / 60, record: { nbs: stored } }, broken);
    assert.deepEqual(await metals(), stopped(`定时任务出错：Error: 登记文件不合格；nbs：定时任务之后没有跑成功（上次成功 1月9日 06:59）；${WHERE}`));
    await seed({ hours: 50, record: { nbs: stored } });
    assert.deepEqual(await metals(), stopped(`nbs：定时任务之后没有跑成功（上次成功 1月8日 07:00）；${WHERE}`));
    await seed(broken);
    assert.deepEqual(await metals(), stopped(`定时任务出错：Error: 登记文件不合格；${WHERE}`));
    // A source's older reason stays its own; errors are cut to 200 characters like the other alerts.
    await seed({ hours: 50, record: { nbs: failed } }, { hours: 30, error: "Error: 登记文件不合格" }, broken);
    assert.deepEqual(await metals(), stopped(`定时任务出错：Error: 登记文件不合格；nbs：列表页返回 HTTP 503（还没有成功过）；${WHERE}`));
    await seed({ hours: 50, record: { nbs: entry([], "错".repeat(300)) } }, { hours: 10, error: "误".repeat(300) });
    assert.deepEqual(await metals(), stopped(`定时任务出错：${"误".repeat(200)}；nbs：${"错".repeat(200)}（还没有成功过）；${WHERE}`));
    // At most 6 sources are written out; the title counts them all.
    const seven = Object.fromEntries(["s1", "s2", "s3", "s4", "s5", "s6", "s7"].map((key) => [key, failed]));
    await seed({ hours: 30, record: seven }, { hours: 10, record: seven });
    const many = await metals();
    assert.equal(many?.title, "金属价格有 7 个来源超过一天没抓到，暂用上一期数据");
    assert.deepEqual(many?.detail?.split("；"), [...["s1", "s2", "s3", "s4", "s5", "s6"].map((key) => `${key}：列表页返回 HTTP 503（还没有成功过）`), WHERE]);
    // A record it cannot read (an entry without periods) becomes the item instead of stopping every other alert.
    await seed({ hours: 10, record: { nbs: { ...stored, periods: undefined } as never } });
    const unread = await metals();
    assert.equal(unread?.title, "金属价格的运行记录读不出来，没法判断有没有抓到");
    assert.match(unread?.detail ?? "", /^TypeError: .+；看 job_runs 里 metals\.prices 的运行记录$/);
    // No run at all (not deployed yet), or collection off (the schedule does not run): nothing.
    await seed();
    assert.equal(await metals(), undefined);
    await seed(broken);
    process.env.COLLECT_ENABLED = "false";
    assert.equal(await metals(), undefined);
  } finally {
    process.env.COLLECT_ENABLED = "true";
    await seed();
  }
});

test("metal prices: the reminder goes out in the 09:00 digest only, never as an immediate alert", async (t) => {
  process.env.COLLECT_ENABLED = "true";
  process.env.FEISHU_INTERNAL_ENABLED = "false";
  const log = t.mock.method(console, "log", () => {});
  try {
    await seed({ hours: 30, record: { nbs: entry([period("2099年12月下旬")]) } }, { hours: 10, record: { nbs: entry([], "列表页返回 HTTP 503") } });
    const r = await checkAlerts(NOW);
    assert.ok(!r.sent.some((key) => key.startsWith("metals.")) && !r.open.includes("metals.fetch"));
    log.mock.resetCalls();
    await sendDigest(NOW);
    // Until Feishu is on, the worker log keeps it: the line saying it was not sent, titled 系统日报.
    const line = log.mock.calls.map((call) => String(call.arguments[0])).find((text) => text.includes("系统日报"));
    const digest = JSON.parse(line ?? "{}") as { msg?: string; lines?: string[] };
    assert.equal(digest.msg, "alert (not sent: FEISHU_INTERNAL_ENABLED is off)");
    const item = `金属价格有 1 个来源超过一天没抓到，暂用上一期数据\n   nbs：列表页返回 HTTP 503（上次成功 1月9日 03:00）；${WHERE}`;
    assert.ok(digest.lines?.some((text) => text.endsWith(item)));
  } finally {
    await seed();
  }
});

test("metal prices: a source's periods held back come from its latest run that returned periods, waiting ones left out", async () => {
  try {
    await seed(
      { hours: 30, record: { nbs: entry([period("2099年12月中旬", "发布页读不到标题（<h1> 的脚本里没有 title1）")]) } },
      {
        hours: 20,
        record: {
          nbs: entry([period("2099年12月下旬", "nbs.copper 出现 0 次"), period("2100年1月上旬", "等 2099年12月下旬")]),
          worldbank: entry([period("2099年11月", "说明对不上")]),
        },
      },
      { hours: 10, record: { nbs: entry([], "列表页返回 HTTP 503"), worldbank: entry([]) } },
      // Not read: another job, and runs outside the 30 days up to NOW.
      { hours: 5, job: "reports.daily", record: { nbs: entry([period("2099年12月下旬")]) } },
      { hours: 31 * 24, record: { nbs: entry([period("2099年12月上旬")]) } },
      { hours: -1, record: { nbs: entry([period("2100年1月中旬", "发布页读不到标题")]) } },
    );
    const runs = await readMetalPriceRuns(new Date(NOW));
    assert.deepEqual(runs.sources.nbs?.held, ["2099年12月下旬"]);
    assert.deepEqual(runs.sources.worldbank?.held, ["2099年11月"]);
    const hours = (n: number) => new Date(NOW - n * 3600_000);
    assert.deepEqual(
      [runs.latest?.at, runs.lastOkRunAt, runs.sources.nbs?.firstSeenAt, runs.sources.nbs?.lastOkAt, runs.sources.worldbank?.lastOkAt],
      [hours(10), hours(10), hours(30), null, null],
    );
    // TASK-0076's manual runs count for their source (a period stored by force), never for the schedule.
    await seed(
      { hours: 20, record: { nbs: entry([period("2099年12月下旬", "nbs.copper 是上一期的 2.10 倍，超出 0.67–1.5 倍")]) } },
      { hours: 10, job: "metals.prices.manual", record: { nbs: entry([period("2099年12月下旬")]) } },
    );
    const forced = await readMetalPriceRuns(new Date(NOW));
    assert.deepEqual([forced.sources.nbs?.held, forced.sources.nbs?.lastOkAt, forced.latest?.at, forced.lastOkRunAt], [[], hours(10), hours(20), hours(20)]);
  } finally {
    await seed();
  }
});
