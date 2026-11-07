import "./setup.ts";
// First-party visit statistics (TASK-0571): the beacon, the batch write, daily and monthly visitors under rotating
// salts, the count job's deletion of salts and key sets, and the admin overview behind sign-in.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { beijingDate, addDays } from "@amp/contracts/time";
import { VisitOverview } from "@amp/contracts/http/private";
import { installModules, serverModules } from "@amp/backend/modules";
import { buildApp } from "./site-app.ts";
import { countVisits, flushVisits, recordVisit, visitOverview } from "../modules/site-admin/backend/visits.ts";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const OWN = ["aimine.example"];
const original = { modules: serverModules(), admin: config.devAdmin, host: config.privateHost };
after(async () => {
  installModules(original.modules);
  config.devAdmin = original.admin;
  config.privateHost = original.host;
  await closeDb();
});

const at = (iso: string) => new Date(iso);
const hit = (now: Date, address: string, userAgent: string, path: string, extra: { referrer?: string; headers?: Record<string, string> } = {}) =>
  recordVisit({ path, address, userAgent, referrer: extra.referrer ?? null, headers: extra.headers ?? {}, ownHosts: OWN, now });
const rows = async (table: string) => (await sql.unsafe(`SELECT * FROM ops.${table} ORDER BY 1,2`)) as Record<string, unknown>[];
const count = async (table: string, where = "true") => Number((await sql.unsafe(`SELECT count(*)::int AS n FROM ops.${table} WHERE ${where}`))[0]!.n);
const salts = async () =>
  (await sql`SELECT period,to_char(starts_on,'YYYY-MM-DD') AS starts_on FROM ops.visit_salts ORDER BY 1,2`).map((r) => `${r.period}:${r.starts_on}`);

test("daily visitors use the day's salt, monthly visitors the month's; the count job keeps only counts", async () => {
  // Beijing 2026-11-03 10:00.
  const d1 = at("2026-11-03T02:00:00Z");
  assert.equal(hit(d1, "203.0.113.7", CHROME, "/items/abc"), true);
  assert.equal(hit(d1, "203.0.113.7", CHROME, "/items/abc?from=list"), true);
  assert.equal(hit(d1, "203.0.113.7", CHROME, "/en/all"), true);
  assert.equal(hit(d1, "198.51.100.9", IPHONE, "/", { referrer: "https://www.baidu.com/s?wd=%E9%94%82" }), true);
  assert.equal(hit(d1, "198.51.100.9", IPHONE, "/all", { referrer: "https://aimine.example/" }), true);
  // Not page views: a crawler, a prefetch, the admin, a file, an unknown address.
  assert.equal(hit(d1, "192.0.2.1", "Mozilla/5.0 (compatible; Googlebot/2.1)", "/"), false);
  assert.equal(hit(d1, "203.0.113.7", CHROME, "/items/abc", { headers: { "sec-purpose": "prefetch" } }), false);
  assert.equal(hit(d1, "203.0.113.7", CHROME, "/admin/visits"), false);
  assert.equal(hit(d1, "203.0.113.7", CHROME, "/assets/app.js"), false);
  assert.equal(hit(d1, "203.0.113.7", CHROME, "/no-such-page"), false);
  await flushVisits(d1);

  assert.deepEqual(
    (await rows("visit_days")).map((r) => [beijingDate(r.day as Date), r.page_views, r.english_views, r.visitors]),
    [["2026-11-03", 5, 1, null]],
  );
  assert.deepEqual(
    (await sql`SELECT path,route,views FROM ops.visit_pages ORDER BY path`).map((r) => [r.path, r.route, r.views]),
    [
      ["/", "/", 1],
      ["/all", "/all", 2],
      ["/items/abc", "/items/:id", 2],
    ],
  );
  assert.deepEqual(
    (await sql`SELECT host,views FROM ops.visit_referrers`).map((r) => [r.host, r.views]),
    [["baidu.com", 1]],
  );
  assert.deepEqual(
    (await sql`SELECT device,views FROM ops.visit_devices ORDER BY device`).map((r) => [r.device, r.views]),
    [
      ["desktop", 3],
      ["phone", 2],
    ],
  );
  assert.equal(await count("visit_day_keys"), 2, "same address and browser on one day is one visitor");
  assert.equal(await count("visit_month_keys"), 2);
  assert.deepEqual(await salts(), ["day:2026-11-03", "month:2026-11-01"]);
  // Only HMAC keys are stored: no address or browser string anywhere in the statistics.
  const stored = JSON.stringify(await Promise.all(["visit_day_keys", "visit_month_keys", "visit_pages", "visit_referrers"].map(rows)));
  for (const raw of ["203.0.113.7", "198.51.100.9", "Chrome/130", "iPhone"]) assert.ok(!stored.includes(raw), raw);

  // Next day: a new day salt, so the same visitor counts again for the day, but once for the month.
  const d2 = at("2026-11-04T03:00:00Z");
  hit(d2, "203.0.113.7", CHROME, "/");
  await flushVisits(d2);
  assert.equal(await count("visit_day_keys", "day='2026-11-04'"), 1);
  assert.equal(await count("visit_month_keys"), 2, "the same visitor in the same month is one monthly visitor");
  assert.deepEqual(await salts(), ["day:2026-11-03", "day:2026-11-04", "month:2026-11-01"]);
  const [k3] = await sql`SELECT visitor FROM ops.visit_day_keys WHERE day='2026-11-03' AND device='desktop'`;
  const [k4] = await sql`SELECT visitor FROM ops.visit_day_keys WHERE day='2026-11-04'`;
  assert.notEqual(k3!.visitor, k4!.visitor, "day keys cannot be linked across days");

  const counted = await countVisits(d2);
  assert.equal(counted.deleted.salts, 1, "the ended day's salt is destroyed");
  assert.deepEqual(await salts(), ["day:2026-11-04", "month:2026-11-01"]);
  assert.deepEqual(
    (await sql`SELECT to_char(day,'YYYY-MM-DD') AS day,visitors FROM ops.visit_days ORDER BY day`).map((r) => [r.day, r.visitors]),
    [
      ["2026-11-03", 2],
      ["2026-11-04", 1],
    ],
  );
  assert.equal(await count("visit_day_keys", "day='2026-11-03'"), 2, "yesterday's keys stay one more day");

  // A late write for a day whose salt is gone keeps its page view but never re-creates the salt or a key.
  hit(d1, "203.0.113.7", CHROME, "/hot");
  await flushVisits(d2);
  assert.deepEqual(await salts(), ["day:2026-11-04", "month:2026-11-01"]);
  assert.equal(await count("visit_day_keys", "day='2026-11-03'"), 2);
  assert.equal((await sql`SELECT page_views FROM ops.visit_days WHERE day='2026-11-03'`)[0]!.page_views, 6);

  // Two days later the day's key set is deleted; its counts stay.
  await countVisits(at("2026-11-05T01:00:00Z"));
  assert.equal(await count("visit_day_keys", "day='2026-11-03'"), 0);
  assert.equal(await count("visit_day_keys", "day='2026-11-04'"), 1);
  assert.equal((await sql`SELECT visitors FROM ops.visit_days WHERE day='2026-11-03'`)[0]!.visitors, 2);
  assert.deepEqual(
    (await sql`SELECT device,visitors FROM ops.visit_devices WHERE day='2026-11-03' ORDER BY device`).map((r) => [r.device, r.visitors]),
    [
      ["desktop", 1],
      ["phone", 1],
    ],
  );

  // A new month: a new month salt; November is counted, its salt destroyed, and its keys deleted on 2 December.
  const dec1 = at("2026-12-01T02:00:00Z");
  hit(dec1, "203.0.113.7", CHROME, "/");
  await flushVisits(dec1);
  await countVisits(dec1);
  assert.deepEqual(await salts(), ["day:2026-12-01", "month:2026-12-01"]);
  assert.equal(await count("visit_month_keys", "month='2026-11-01'"), 2, "last month's keys stay through the 1st");
  await countVisits(at("2026-12-02T02:00:00Z"));
  assert.equal(await count("visit_month_keys", "month='2026-11-01'"), 0);
  assert.equal(await count("visit_day_keys", "day < '2026-12-01'"), 0);
  assert.deepEqual(await salts(), ["month:2026-12-01"]);
  assert.deepEqual(
    (await sql`SELECT to_char(month,'YYYY-MM') AS month,visitors FROM ops.visit_months ORDER BY month`).map((r) => [r.month, r.visitors]),
    [
      ["2026-11", 2],
      ["2026-12", 1],
    ],
  );

  // The overview reads the kept counts.
  const overview = await visitOverview(at("2026-12-02T04:00:00Z"));
  assert.equal(overview.since, "2026-11-03");
  assert.deepEqual(overview.cards.last_month, { visitors: 2, page_views: 7 });
  assert.deepEqual(overview.cards.this_month, { visitors: 1, page_views: 1 });
  assert.deepEqual(overview.cards.yesterday, { visitors: 1, page_views: 1 });
  assert.equal(overview.cards.today.page_views, 0);
  assert.deepEqual(
    overview.months.slice(-2).map((m) => [m.month, m.visitors, m.page_views]),
    [
      ["2026-11", 2, 7],
      ["2026-12", 1, 1],
    ],
  );
  assert.equal(overview.days.length, 30);
  assert.equal(overview.days.at(-1)!.day, "2026-12-02");
  assert.deepEqual(overview.pages.month[0], { route: "/", path: "/", views: 3, title: null });
  assert.deepEqual(overview.referrers.month, [{ host: "baidu.com", views: 1 }]);
});

test("the beacon answers 204 and counts only reader pages; the overview needs a signed-in operator", async () => {
  await sql`TRUNCATE ops.visit_days,ops.visit_pages,ops.visit_referrers,ops.visit_devices,ops.visit_day_keys,ops.visit_month_keys,ops.visit_months,ops.visit_salts`;
  config.privateHost = "visits.private.test";
  config.devAdmin = null;
  const app = await buildApp();
  after(() => app.close());
  const beacon = (body: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: "/api/site/visit",
      headers: { "content-type": "text/plain;charset=UTF-8", "user-agent": IPHONE, "x-forwarded-for": "198.51.100.20", ...headers },
      payload: typeof body === "string" ? body : JSON.stringify(body),
    });
  for (const response of [
    await beacon({ path: "/items/abc", referrer: "https://www.google.com/" }),
    await beacon({ path: "/en/policies" }),
    await beacon({ path: "/items/abc" }, { "x-forwarded-for": "198.51.100.21", "user-agent": CHROME }),
    await beacon({ path: "/" }, { "user-agent": "curl/8.5.0" }),
    await beacon({ path: "/" }, { "sec-purpose": "prefetch" }),
    await beacon({ path: "/" }, { "sec-fetch-site": "cross-site" }),
    await beacon({ path: "/admin" }),
    await beacon("not json"),
    await beacon({ path: "/", extra: true }),
  ]) {
    assert.equal(response.statusCode, 204, response.body);
    assert.equal(response.body, "");
    assert.equal(response.headers["set-cookie"], undefined);
    assert.equal(response.headers["cache-control"], "no-store");
  }
  await flushVisits();

  const read = (headers: Record<string, string> = {}) =>
    app.inject({ url: "/api/admin/visits", headers: { "x-forwarded-host": config.privateHost!, ...headers } });
  assert.equal((await read()).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/admin/visits" })).statusCode, 404, "hidden without the admin host");
  config.devAdmin = { displayName: "Synthetic operator" };
  const response = await read();
  assert.equal(response.statusCode, 200, response.body);
  const overview = VisitOverview.parse(response.json());
  assert.equal(overview.today, beijingDate(new Date()));
  assert.deepEqual(overview.cards.today, { visitors: 2, page_views: 3 });
  assert.equal(overview.days.at(-1)!.english_views, 1);
  assert.deepEqual(overview.referrers.week, [{ host: "google.com", views: 1 }]);
  assert.deepEqual(
    overview.pages.week.map((p) => [p.path, p.views]),
    [
      ["/items/abc", 2],
      ["/policies", 1],
    ],
  );
  assert.deepEqual(
    overview.devices.map((d) => [d.device, d.views]),
    [
      ["phone", 2],
      ["desktop", 1],
    ],
  );
  assert.equal(overview.since, beijingDate(new Date()));
  assert.equal(overview.cards.yesterday.visitors, null, "no figures before counting started: shown as —, never 0");
  assert.ok(!response.body.includes("198.51.100") && !response.body.includes("iPhone"));
  // Fixture data for yesterday reaches the cards and the 30-day series.
  const yesterday = addDays(beijingDate(new Date()), -1);
  await sql`INSERT INTO ops.visit_days(day,page_views,english_views,visitors,counted_at) VALUES(${yesterday}::date,40,4,12,now())`;
  const again = VisitOverview.parse((await read()).json());
  assert.deepEqual(again.cards.yesterday, { visitors: 12, page_views: 40 });
  assert.equal(again.cards.week_average.days, 1);
  assert.equal(again.cards.week_average.visitors, 12);
});
