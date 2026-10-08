// Ops alerts reach the site owner: a problem is announced once, repeated no more than its level allows
// (hourly for reader impact), closed with one recovery message; entries from before the levels existed
// close without a message. Metal prices not fetched for over a day wait for the 09:00 digest (TASK-0071).
// The request meter's automatic stops (hourly and daily) are announced as such, not as a used-up quota, and
// the days they happened are counted for the weekly usage report (TASK-0063).
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { getBoss, stopBoss } from "@amp/backend/jobs/queue";
import { upsertMaterial } from "@amp/backend/content/materials";
import { autoStopsBetween, checkAlerts, collectFindings, readMetalPriceRuns, sendDigest } from "@amp/backend/operations/alerts";

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
    // The error is said whenever the latest run failed, also when an ok run within 26 hours leaves only a source late.
    await seed({ hours: 30, record: { nbs: stored, worldbank: stored } }, { hours: 20, record: { nbs: stored, worldbank: failed } }, broken);
    const late = "worldbank：列表页返回 HTTP 503（上次成功 1月9日 03:00）";
    assert.deepEqual(await metals(), { ...listed(late), detail: `定时任务出错：Error: 登记文件不合格；${late}；${WHERE}` });
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

// ---- Automatic stops (TASK-0063) -------------------------------------------------------------------------------------
// Each test meters its own service (a budgets row and live attempts in database time) and removes it afterwards.
const gateway = dbOf("ai-gateway");

/** A service of this file's own with these limits and `calls` live attempts `minutesAgo` minutes ago. */
async function meter(service: string, limits: { perMinute: number; perHour: number; perDay: number }, calls: number, minutesAgo = 10) {
  await gateway`
    INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES (${service}, ${limits.perMinute}, ${limits.perHour}, ${limits.perDay}, 'test')
    ON CONFLICT (service) DO UPDATE SET per_minute = EXCLUDED.per_minute, per_hour = EXCLUDED.per_hour, per_day = EXCLUDED.per_day`;
  const [receipt] = await gateway<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, purpose, status, origin) VALUES (${`test-meter:${randomUUID()}`}, ${service}, 'test', 'received', 'live')
    RETURNING id`;
  for (let attempt = 1; attempt <= calls; attempt++)
    await gateway`
      INSERT INTO receipt_attempts (receipt_id, attempt, service, origin, status, started_at)
      VALUES (${receipt!.id}, ${attempt}, ${service}, 'live', 'received', now() - ${minutesAgo}::int * interval '1 minute')`;
}
async function unmeter(service: string) {
  await gateway`DELETE FROM receipts WHERE service = ${service}`;
  await gateway`DELETE FROM budgets WHERE service = ${service}`;
  await sql`UPDATE settings SET value = value - ${`budget.hour.${service}`}::text - ${`budget.day.${service}`}::text WHERE key = 'alerts.state'`;
}
const stopsOf = async (service: string) => (await collectFindings()).filter((f) => f.key.endsWith(`.${service}`));

test("auto-stops: the hourly and the daily meter each open their own alert, never worded as a used-up quota", async () => {
  const service = `test-meter-${T}`;
  try {
    await meter(service, { perMinute: 1000, perHour: 3, perDay: 1000 }, 3);
    const [hour, ...rest] = await stopsOf(service);
    assert.deepEqual([hour?.key, rest.length], [`budget.hour.${service}`, 0], "the hourly window alone");
    assert.deepEqual(
      [hour!.title, hour!.impact, hour!.heals, hour!.detail],
      [
        `${service} 过去 1 小时的调用次数异常，已自动暂停付费调用（不是总额上限）`,
        "相关功能停了，直到调用次数回落",
        "会，过去 1 小时的调用次数回落到限额以下就自动恢复；降到限额的八成以下时再发“已恢复”",
        "1 小时内 3 次，限额 3（budgets 表 per_hour）",
      ],
    );
    assert.match(
      hour!.action!,
      /先看后台“用量与模型密钥”里的“通知与请求频率”，这项服务近 1 小时、近 24 小时各用了多少次；这不是总额上限.*“通知与请求频率”里调高限额/,
    );
    for (const text of [hour!.title, hour!.impact, hour!.heals, hour!.action, hour!.detail]) assert.ok(!text!.includes("额度"), text);
    await gateway`UPDATE budgets SET per_day = 3 WHERE service = ${service}`;
    const both = await stopsOf(service);
    assert.deepEqual(both.map((f) => f.key).sort(), [`budget.day.${service}`, `budget.hour.${service}`], "both windows, one alert each");
    assert.equal(both.find((f) => f.key.startsWith("budget.day."))!.detail, "24 小时内 3 次，限额 3（budgets 表 per_day）");
    assert.equal(both.find((f) => f.key.startsWith("budget.day."))!.title, `${service} 过去 24 小时的调用次数异常，已自动暂停付费调用（不是总额上限）`);
    await gateway`UPDATE receipt_attempts SET model = 'm' WHERE service = ${service}`;
    assert.match((await stopsOf(service))[0]!.action!, /先看后台“用量与模型密钥”里的“模型与近期用量”，是哪一步调用变多；这不是总额上限/);
  } finally {
    await unmeter(service);
  }
});

test("auto-stops: a service with any limit at 0 or below was stopped by hand and gets no automatic-stop alert", async () => {
  const service = `test-meter-off-${T}`;
  try {
    await meter(service, { perMinute: 0, perHour: 1, perDay: 1 }, 3);
    assert.deepEqual(await stopsOf(service), []);
  } finally {
    await unmeter(service);
  }
});

test("auto-stops: opened lists a key only in the round it opens, and the recovery follows once the calls leave the hour", async () => {
  const service = `test-meter-run-${T}`;
  const mine = (keys: string[]) => keys.filter((k) => k.includes(`.${service}`));
  try {
    await meter(service, { perMinute: 1000, perHour: 2, perDay: 1000 }, 2);
    const t0 = Date.now();
    let r = await checkAlerts(t0);
    assert.deepEqual([mine(r.sent), mine(r.opened)], [[`budget.hour.${service}`], [`budget.hour.${service}`]]);
    r = await checkAlerts(t0 + 10 * 60_000);
    assert.ok(Array.isArray(r.opened));
    assert.deepEqual([mine(r.sent), mine(r.opened)], [[], []], "still open: neither repeated within the day nor opened again");
    await gateway`UPDATE receipt_attempts SET started_at = now() - interval '2 hours' WHERE service = ${service}`;
    r = await checkAlerts(t0 + 20 * 60_000);
    assert.deepEqual([mine(r.sent), mine(r.opened)], [[`budget.hour.${service}:recovered`], []]);
  } finally {
    await unmeter(service);
  }
});

test("auto-stops: an announced stop stays open between 80% and the limit, and recovers only below 80%", async () => {
  const service = `test-meter-margin-${T}`;
  const mine = (keys: string[]) => keys.filter((k) => k.includes(`.${service}`));
  const leaveHour = (n: number) =>
    gateway`UPDATE receipt_attempts SET started_at = now() - interval '2 hours'
            WHERE id IN (SELECT id FROM receipt_attempts WHERE service = ${service} AND started_at > now() - interval '1 hour' ORDER BY id LIMIT ${n})`;
  try {
    await meter(service, { perMinute: 1000, perHour: 5, perDay: 1000 }, 4);
    const t0 = Date.now();
    assert.deepEqual(mine((await checkAlerts(t0)).sent), [], "80% of the limit does not open an alert that was not announced");
    await meter(service, { perMinute: 1000, perHour: 5, perDay: 1000 }, 1);
    assert.deepEqual(mine((await checkAlerts(t0 + 10 * 60_000)).sent), [`budget.hour.${service}`], "the limit opens it");
    await leaveHour(1);
    let r = await checkAlerts(t0 + 20 * 60_000);
    assert.deepEqual([mine(r.sent), mine(r.open)], [[], [`budget.hour.${service}`]], "4 of 5: still open, no recovery");
    await leaveHour(1);
    r = await checkAlerts(t0 + 30 * 60_000);
    assert.deepEqual([mine(r.sent), mine(r.open)], [[`budget.hour.${service}:recovered`], []], "3 of 5: below 80%, recovered");
  } finally {
    await unmeter(service);
  }
});

test("auto-stops: with alerts on but no chat id, the alert is logged as not sent and nothing goes to Feishu", async (t) => {
  const service = `test-meter-nochat-${T}`;
  const env = { on: process.env.FEISHU_INTERNAL_ENABLED, alert: process.env.FEISHU_ALERT_CHAT_ID, internal: process.env.FEISHU_INTERNAL_CHAT_ID };
  const feishu: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (new URL(url).hostname.endsWith("feishu.cn")) {
      feishu.push(url);
      return Response.json({ code: 0, tenant_access_token: "t", expire: 7200, data: { message_id: "m" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const log = t.mock.method(console, "log", () => {});
  try {
    process.env.FEISHU_INTERNAL_ENABLED = "true";
    delete process.env.FEISHU_ALERT_CHAT_ID;
    delete process.env.FEISHU_INTERNAL_CHAT_ID;
    await meter(service, { perMinute: 1000, perHour: 1, perDay: 1000 }, 1);
    const r = await checkAlerts(Date.now());
    assert.ok(r.sent.includes(`budget.hour.${service}`), "the alert went through sendAlert");
    const warned = log.mock.calls
      .map((call) => JSON.parse(String(call.arguments[0])) as { level?: string; msg?: string; title?: string })
      .find((line) => line.title?.includes(service));
    assert.deepEqual([warned?.level, warned?.msg], ["warn", "alert (not sent: no FEISHU_ALERT_CHAT_ID or FEISHU_INTERNAL_CHAT_ID)"]);
    assert.deepEqual(feishu, [], "no request to Feishu");
  } finally {
    globalThis.fetch = realFetch;
    for (const [name, value] of [
      ["FEISHU_INTERNAL_ENABLED", env.on],
      ["FEISHU_ALERT_CHAT_ID", env.alert],
      ["FEISHU_INTERNAL_CHAT_ID", env.internal],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await unmeter(service);
  }
});

test("auto-stops: autoStopsBetween counts the days a stop was open, per service and Beijing day, from the runs that record opened", async () => {
  const at = (iso: string) => new Date(iso);
  const runs: { at: Date; open: string[]; opened?: string[]; status?: string; job?: string }[] = [
    { at: at("2099-12-31T15:00:00Z"), open: ["budget.hour.svc-a"], opened: ["budget.hour.svc-a"] }, // before the window
    { at: at("2100-01-02T01:00:00Z"), open: ["budget.hour.svc-x"] }, // a run from before opened was recorded
    { at: at("2100-01-02T02:00:00Z"), open: [], opened: [] }, // nothing open: still the start of coverage
    { at: at("2100-01-02T03:00:00Z"), open: ["budget.hour.svc-a", "content.process"], opened: ["budget.hour.svc-a", "content.process"] },
    { at: at("2100-01-02T05:00:00Z"), open: ["budget.hour.svc-a", "budget.day.svc-a", "budget.hour.svc-b"], opened: ["budget.day.svc-a", "budget.hour.svc-b"] },
    { at: at("2100-01-02T15:30:00Z"), open: ["budget.hour.svc-a"], opened: [] }, // 23:30 in Beijing: same day
    { at: at("2100-01-02T16:30:00Z"), open: ["budget.hour.svc-a"], opened: [] }, // 00:30 the next Beijing day, still open
    { at: at("2100-01-03T02:00:00Z"), open: ["budget.hour.svc-c"], opened: ["budget.hour.svc-c"], status: "failed" },
    { at: at("2100-01-03T02:00:00Z"), open: ["budget.hour.svc-d"], opened: ["budget.hour.svc-d"], job: "ops.digest" },
    { at: at("2100-01-05T00:00:00Z"), open: ["budget.hour.svc-e"], opened: ["budget.hour.svc-e"] }, // the window's end is excluded
  ];
  const ids: number[] = [];
  try {
    for (const run of runs) {
      const detail = run.opened ? { open: run.open, sent: [], opened: run.opened } : { open: run.open, sent: [] };
      const [row] = await sql<{ id: number }[]>`
        INSERT INTO job_runs (job, started_at, finished_at, status, detail)
        VALUES (${run.job ?? "ops.alerts"}, ${run.at}, ${run.at}, ${run.status ?? "ok"}, ${sql.json(detail as never)})
        RETURNING id`;
      ids.push(row!.id);
    }
    const stops = await autoStopsBetween(at("2100-01-01T00:00:00Z"), at("2100-01-05T00:00:00Z"));
    assert.deepEqual(stops, { days: 2, byService: { "svc-a": 2, "svc-b": 1 }, coveredFrom: at("2100-01-02T02:00:00Z") });
    assert.deepEqual(await autoStopsBetween(at("2100-02-01T00:00:00Z"), at("2100-02-08T00:00:00Z")), { days: 0, byService: {}, coveredFrom: null });
  } finally {
    await sql`DELETE FROM job_runs WHERE id IN ${sql(ids)}`;
  }
});
