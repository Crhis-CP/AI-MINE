// First-party visit statistics (TASK-0571; Owner 2026-11-06/07): reader page views, daily and monthly visitors,
// pages, referring sites and device classes, read in the private admin. No cookie, no stored browser identifier and
// no third-party service.
//
// - The api records a page-view beacon in process memory and writes the batch every FLUSH_MS (one transaction);
//   page rendering never waits for it, and a failed write is dropped and counted, never retried or surfaced.
// - A visitor is an HMAC of the client address and browser string under a random salt of the Beijing day (daily
//   visitors) and of the Beijing month (monthly visitors). Salts live only in ops.visit_salts and are never sent
//   anywhere; the count job deletes a salt once its day or month is over, and the api never re-creates a past one.
//   The raw address and browser string stay in this process's memory until the next write, at most FLUSH_MS.
// - The count job (worker, every 10 minutes) turns the key sets into counts, then deletes a day's keys on the day
//   after next and a month's keys on the 2nd of the following month. Only the per-day and per-month counts stay.
import { createHmac, randomBytes } from "node:crypto";
import { addCalendarMonths, addDays, beijingDate } from "@amp/contracts/time";
import { VisitOverview } from "@amp/contracts/http/private";
import { sql, type Db } from "@amp/backend/db";
import { savedItems } from "@amp/backend/publication/availability";
import { deviceClass, isBot, isPrefetch, monthOf, readerPage, referrerHost, visitorKey, type VisitDevice } from "./visit-rules.ts";

export const FLUSH_MS = 10_000;
/** Distinct visitors held between two writes; beyond it a view still counts, its visitor does not. */
const MAX_IDENTITIES = 20_000;
/** Distinct content addresses per day before further ones are kept under their route pattern only. */
const MAX_PATHS_PER_DAY = 5_000;
/** Page views one client (address and browser) may add per minute. */
const PER_CLIENT_PER_MINUTE = 60;

interface Batch {
  days: Map<string, { views: number; english: number }>;
  pages: Map<string, { day: string; path: string; route: string; views: number }>;
  referrers: Map<string, { day: string; host: string; views: number }>;
  devices: Map<string, { day: string; device: VisitDevice; views: number }>;
  identities: Map<string, { day: string; device: VisitDevice; address: string; userAgent: string }>;
}
const emptyBatch = (): Batch => ({ days: new Map(), pages: new Map(), referrers: new Map(), devices: new Map(), identities: new Map() });

let batch = emptyBatch();
let timer: ReturnType<typeof setTimeout> | null = null;
let writing: Promise<void> | null = null;
const dayPaths = new Map<string, Set<string>>();
const clientMinute = { minute: -1, counts: new Map<string, number>() };
const clientSecret = randomBytes(32);
const saltCache = new Map<string, Buffer>();
/** Process-lifetime diagnostics: page views lost to a failed write, and failed writes. */
export const visitWriteStats = { droppedViews: 0, failedWrites: 0 };

export interface VisitHit {
  path: string;
  referrer?: string | null;
  address: string;
  userAgent: string;
  headers: Record<string, string | string[] | undefined>;
  ownHosts: readonly string[];
  now?: Date;
}

/** Record one beacon in memory. Returns whether it counted as a reader page view. Never throws, never waits. */
export function recordVisit(hit: VisitHit): boolean {
  const page = readerPage(hit.path);
  if (!page || isBot(hit.userAgent) || isPrefetch(hit.headers)) return false;
  const now = hit.now ?? new Date();
  const minute = Math.floor(now.getTime() / 60_000);
  if (clientMinute.minute !== minute) {
    clientMinute.minute = minute;
    clientMinute.counts.clear();
  }
  const client = createHmac("sha256", clientSecret).update(`${hit.address}\n${hit.userAgent}`).digest("base64url");
  const seen = clientMinute.counts.get(client) ?? 0;
  if (seen >= PER_CLIENT_PER_MINUTE || (!seen && clientMinute.counts.size >= 50_000)) return false;
  clientMinute.counts.set(client, seen + 1);

  const day = beijingDate(now);
  const device = deviceClass(hit.userAgent);
  const days = batch.days.get(day) ?? { views: 0, english: 0 };
  days.views += 1;
  if (page.english) days.english += 1;
  batch.days.set(day, days);

  let paths = dayPaths.get(day);
  if (!paths) {
    for (const old of dayPaths.keys()) if (old < addDays(day, -1)) dayPaths.delete(old);
    paths = new Set();
    dayPaths.set(day, paths);
  }
  let path = page.path;
  if (!paths.has(path)) {
    if (paths.size >= MAX_PATHS_PER_DAY) path = page.route;
    else paths.add(path);
  }
  const pageKey = `${day}\n${path}`;
  const pageRow = batch.pages.get(pageKey) ?? { day, path, route: page.route, views: 0 };
  pageRow.views += 1;
  batch.pages.set(pageKey, pageRow);

  const host = referrerHost(hit.referrer, hit.ownHosts);
  if (host) {
    const key = `${day}\n${host}`;
    const row = batch.referrers.get(key) ?? { day, host, views: 0 };
    row.views += 1;
    batch.referrers.set(key, row);
  }
  const deviceKey = `${day}\n${device}`;
  const deviceRow = batch.devices.get(deviceKey) ?? { day, device, views: 0 };
  deviceRow.views += 1;
  batch.devices.set(deviceKey, deviceRow);

  const identity = `${day}\n${hit.address}\n${hit.userAgent}`;
  if (!batch.identities.has(identity) && batch.identities.size < MAX_IDENTITIES)
    batch.identities.set(identity, { day, device, address: hit.address, userAgent: hit.userAgent });

  if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      void flushVisits();
    }, FLUSH_MS);
    timer.unref?.();
  }
  return true;
}

/** Write what is recorded so far. Concurrent calls share one write; a failure drops the batch and is counted. */
export async function flushVisits(now = new Date()): Promise<void> {
  if (writing) await writing;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const current = batch;
  if (!current.days.size) return;
  batch = emptyBatch();
  writing = writeBatch(current, now)
    .catch(() => {
      visitWriteStats.failedWrites += 1;
      for (const { views } of current.days.values()) visitWriteStats.droppedViews += views;
      console.warn(JSON.stringify({ level: "warn", msg: "visit statistics write dropped", failedWrites: visitWriteStats.failedWrites }));
    })
    .finally(() => {
      writing = null;
    });
  await writing;
}

/**
 * The salt of a period. Only the current period's salt is ever created; a past one that is gone stays gone. A salt
 * read inside the write is only noted in `committed`; the caller caches it once the transaction has committed, so a
 * rolled-back salt never outlives its transaction (another process would create a different one, splitting visitors).
 */
async function saltFor(tx: Db, period: "day" | "month", startsOn: string, current: boolean, committed: Map<string, Buffer>): Promise<Buffer | null> {
  const cacheKey = `${period}:${startsOn}`;
  const cached = saltCache.get(cacheKey);
  if (cached) return cached;
  if (current) await tx`INSERT INTO ops.visit_salts(period,starts_on,salt) VALUES(${period},${startsOn}::date,${randomBytes(32)}) ON CONFLICT DO NOTHING`;
  const [row] = await tx<{ salt: Buffer }[]>`SELECT salt FROM ops.visit_salts WHERE period=${period} AND starts_on=${startsOn}::date`;
  if (row && current) committed.set(cacheKey, row.salt);
  return row?.salt ?? null;
}

async function writeBatch(current: Batch, now: Date): Promise<void> {
  const today = beijingDate(now),
    thisMonth = monthOf(today);
  for (const key of saltCache.keys()) if (key !== `day:${today}` && key !== `month:${thisMonth}`) saltCache.delete(key);
  const committed = new Map<string, Buffer>();
  await sql.begin(async (tx) => {
    const dayKeys: { day: string; visitor: string; device: VisitDevice }[] = [],
      monthKeys: { month: string; visitor: string }[] = [];
    const salts = new Map<string, Buffer | null>();
    const salt = async (period: "day" | "month", startsOn: string, isCurrent: boolean) => {
      const key = `${period}:${startsOn}`;
      if (!salts.has(key)) salts.set(key, await saltFor(tx, period, startsOn, isCurrent, committed));
      return salts.get(key)!;
    };
    for (const { day, device, address, userAgent } of current.identities.values()) {
      const daySalt = await salt("day", day, day === today),
        monthSalt = await salt("month", monthOf(day), monthOf(day) === thisMonth);
      if (daySalt) dayKeys.push({ day, visitor: visitorKey(daySalt, address, userAgent), device });
      if (monthSalt) monthKeys.push({ month: monthOf(day), visitor: visitorKey(monthSalt, address, userAgent) });
    }
    current.identities.clear();
    const days = [...current.days];
    await tx`INSERT INTO ops.visit_days(day,page_views,english_views)
      SELECT * FROM unnest(${days.map(([d]) => d)}::date[],${days.map(([, v]) => v.views)}::int[],${days.map(([, v]) => v.english)}::int[])
      ON CONFLICT (day) DO UPDATE SET page_views=ops.visit_days.page_views+EXCLUDED.page_views,
        english_views=ops.visit_days.english_views+EXCLUDED.english_views`;
    const pages = [...current.pages.values()];
    await tx`INSERT INTO ops.visit_pages(day,path,route,views)
      SELECT * FROM unnest(${pages.map((p) => p.day)}::date[],${pages.map((p) => p.path)}::text[],${pages.map((p) => p.route)}::text[],${pages.map((p) => p.views)}::int[])
      ON CONFLICT (day,path) DO UPDATE SET views=ops.visit_pages.views+EXCLUDED.views`;
    const referrers = [...current.referrers.values()];
    if (referrers.length)
      await tx`INSERT INTO ops.visit_referrers(day,host,views)
        SELECT * FROM unnest(${referrers.map((r) => r.day)}::date[],${referrers.map((r) => r.host)}::text[],${referrers.map((r) => r.views)}::int[])
        ON CONFLICT (day,host) DO UPDATE SET views=ops.visit_referrers.views+EXCLUDED.views`;
    const devices = [...current.devices.values()];
    await tx`INSERT INTO ops.visit_devices(day,device,views)
      SELECT * FROM unnest(${devices.map((d) => d.day)}::date[],${devices.map((d) => d.device)}::text[],${devices.map((d) => d.views)}::int[])
      ON CONFLICT (day,device) DO UPDATE SET views=ops.visit_devices.views+EXCLUDED.views`;
    if (dayKeys.length)
      await tx`INSERT INTO ops.visit_day_keys(day,visitor,device)
        SELECT * FROM unnest(${dayKeys.map((k) => k.day)}::date[],${dayKeys.map((k) => k.visitor)}::text[],${dayKeys.map((k) => k.device)}::text[])
        ON CONFLICT DO NOTHING`;
    if (monthKeys.length)
      await tx`INSERT INTO ops.visit_month_keys(month,visitor)
        SELECT * FROM unnest(${monthKeys.map((k) => k.month)}::date[],${monthKeys.map((k) => k.visitor)}::text[])
        ON CONFLICT DO NOTHING`;
  });
  for (const [key, value] of committed) saltCache.set(key, value);
}

/**
 * Worker job: count the key sets into ops.visit_days / visit_devices / visit_months, then delete what is no longer
 * needed: day keys older than yesterday, month keys older than last month once the 1st is over, and every salt of a
 * day or month that has ended.
 */
export async function countVisits(now = new Date()) {
  const today = beijingDate(now),
    yesterday = addDays(today, -1),
    thisMonth = monthOf(today),
    keepMonth = monthOf(yesterday);
  return sql.begin(async (tx) => {
    const days = await tx`INSERT INTO ops.visit_days(day,visitors,counted_at)
      SELECT day,count(*)::int,now() FROM ops.visit_day_keys GROUP BY day
      ON CONFLICT (day) DO UPDATE SET visitors=EXCLUDED.visitors,counted_at=EXCLUDED.counted_at`;
    await tx`INSERT INTO ops.visit_devices(day,device,visitors)
      SELECT day,device,count(*)::int FROM ops.visit_day_keys GROUP BY day,device
      ON CONFLICT (day,device) DO UPDATE SET visitors=EXCLUDED.visitors`;
    const months = await tx`INSERT INTO ops.visit_months(month,visitors,counted_at)
      SELECT month,count(*)::int,now() FROM ops.visit_month_keys GROUP BY month
      ON CONFLICT (month) DO UPDATE SET visitors=EXCLUDED.visitors,counted_at=EXCLUDED.counted_at`;
    const dayKeys = await tx`DELETE FROM ops.visit_day_keys WHERE day < ${yesterday}::date`;
    const monthKeys = await tx`DELETE FROM ops.visit_month_keys WHERE month < ${keepMonth}::date`;
    const salts = await tx`DELETE FROM ops.visit_salts
      WHERE (period='day' AND starts_on < ${today}::date) OR (period='month' AND starts_on < ${thisMonth}::date)`;
    return { days: days.count, months: months.count, deleted: { dayKeys: dayKeys.count, monthKeys: monthKeys.count, salts: salts.count } };
  });
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/** The admin's 访问概况. Today's and this month's visitors are counted live from the key sets. */
export async function visitOverview(now = new Date()): Promise<VisitOverview> {
  const today = beijingDate(now),
    from30 = addDays(today, -29),
    from7 = addDays(today, -6),
    thisMonth = monthOf(today),
    from12 = addCalendarMonths(thisMonth, -11);
  const days = await sql<{ day: string; page_views: number; english_views: number; visitors: number | null; present: boolean }[]>`
    WITH live AS (SELECT day,count(*)::int AS n FROM ops.visit_day_keys WHERE day >= ${from30}::date GROUP BY day)
    SELECT pg_catalog.to_char(d,'YYYY-MM-DD') AS day,coalesce(v.page_views,0) AS page_views,coalesce(v.english_views,0) AS english_views,
      coalesce(l.n,v.visitors) AS visitors,v.day IS NOT NULL AS present
    FROM generate_series(${from30}::date,${today}::date,interval '1 day') AS d
    LEFT JOIN ops.visit_days v ON v.day=d::date LEFT JOIN live l ON l.day=d::date
    ORDER BY d`;
  const months = await sql<{ month: string; visitors: number | null; page_views: number }[]>`
    WITH live AS (SELECT month,count(*)::int AS n FROM ops.visit_month_keys WHERE month >= ${from12}::date GROUP BY month),
      views AS (SELECT pg_catalog.date_trunc('month',day)::date AS month,sum(page_views)::bigint AS n FROM ops.visit_days WHERE day >= ${from12}::date GROUP BY 1)
    SELECT pg_catalog.to_char(m,'YYYY-MM') AS month,coalesce(l.n,s.visitors) AS visitors,coalesce(w.n,0) AS page_views
    FROM generate_series(${from12}::date,${thisMonth}::date,interval '1 month') AS m
    LEFT JOIN ops.visit_months s ON s.month=m::date LEFT JOIN live l ON l.month=m::date LEFT JOIN views w ON w.month=m::date
    ORDER BY m`;
  const [pagesWeek, pagesMonth, sections, referrersWeek, referrersMonth, devices, [first]] = await Promise.all([
    topPages(from7),
    topPages(from30),
    sql<{ route: string; views: number }[]>`SELECT route,sum(views)::bigint AS views FROM ops.visit_pages WHERE day >= ${from30}::date
      GROUP BY route ORDER BY views DESC,route LIMIT 40`,
    topReferrers(from7),
    topReferrers(from30),
    sql<{ device: VisitDevice; views: number; visitor_days: number }[]>`
      SELECT device,sum(views)::bigint AS views,coalesce(sum(visitors),0)::bigint AS visitor_days FROM ops.visit_devices
      WHERE day >= ${from30}::date GROUP BY device ORDER BY views DESC,device`,
    sql<{ since: string | null }[]>`SELECT pg_catalog.to_char(min(day),'YYYY-MM-DD') AS since FROM ops.visit_days WHERE page_views > 0`,
  ]);
  const titles = await itemTitles([...pagesWeek, ...pagesMonth]);
  const withTitles = (rows: { route: string; path: string; views: number }[]) =>
    rows.map((row) => ({ route: row.route, path: row.path, views: Number(row.views), title: titles.get(row.path) ?? null }));
  const figures = (row: { visitors: number | null; page_views: number } | undefined) => ({
    visitors: row?.visitors ?? null,
    page_views: Number(row?.page_views ?? 0),
  });
  // The seven complete days before today that have figures.
  const week = days.slice(-8, -1).filter((d) => d.present);
  const weekVisitors = week.filter((d) => d.visitors !== null);
  return VisitOverview.parse({
    generated_at: now.toISOString(),
    today,
    since: first?.since ?? null,
    cards: {
      today: figures(days.at(-1)),
      yesterday: figures(days.at(-2)),
      week_average: {
        visitors: weekVisitors.length ? round1(weekVisitors.reduce((sum, d) => sum + d.visitors!, 0) / weekVisitors.length) : null,
        page_views: week.length ? round1(week.reduce((sum, d) => sum + d.page_views, 0) / week.length) : null,
        days: week.length,
      },
      this_month: figures(months.at(-1)),
      last_month: figures(months.at(-2)),
    },
    days: days.map((d) => ({ day: d.day, visitors: d.visitors, page_views: d.page_views, english_views: d.english_views })),
    months: months.map((m) => ({ month: m.month, visitors: m.visitors, page_views: Number(m.page_views) })),
    pages: { week: withTitles(pagesWeek), month: withTitles(pagesMonth) },
    sections: sections.map((s) => ({ route: s.route, views: Number(s.views) })),
    referrers: {
      week: referrersWeek.map((r) => ({ host: r.host, views: Number(r.views) })),
      month: referrersMonth.map((r) => ({ host: r.host, views: Number(r.views) })),
    },
    devices: devices.map((d) => ({ device: d.device, views: Number(d.views), visitor_days: Number(d.visitor_days) })),
  });
}

async function topPages(from: string) {
  return sql<{ route: string; path: string; views: number }[]>`
    SELECT path,min(route) AS route,sum(views)::bigint AS views FROM ops.visit_pages WHERE day >= ${from}::date
    GROUP BY path ORDER BY views DESC,path LIMIT 20`;
}

async function topReferrers(from: string) {
  return sql<{ host: string; views: number }[]>`
    SELECT host,sum(views)::bigint AS views FROM ops.visit_referrers WHERE day >= ${from}::date
    GROUP BY host ORDER BY views DESC,host LIMIT 20`;
}

/** Titles of the articles among the most read pages, through the public read layer (withdrawn ones stay untitled). */
async function itemTitles(rows: { route: string; path: string }[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.filter((row) => row.route === "/items/:id").map((row) => row.path.slice("/items/".length)))];
  if (!ids.length) return new Map();
  try {
    const { items } = await savedItems(ids);
    return new Map(items.map((item) => [`/items/${item.id}`, item.title]));
  } catch {
    return new Map();
  }
}
