// 读者兴趣记录 (TASK-0596; Owner 2026-11-07, DEC-78补充·信源扩充、后台实时化与更新日志用语): every complete Beijing day,
// the page views in ops.visit_pages summed by what the reader filters classify the viewed articles under (category,
// mineral, company, country), the day's 50 most read articles, and the list and topic pages. “前期肯定不准，但是这就是
// 作为一个数据参考”: a reference only; selection rules are not read from it. No model, no visitor-level data.
//
// - The classification is the publication read layer's own (readerInterestFacts): the same category the lists show,
//   the minerals and companies whose filter shows the article, the jurisdictions whose country filter does. An
//   article without a reader page when the day is recorded counts in item_views but under no filter value.
// - ops.reader-interest (worker, hourly) records each complete day once it has settled (the api writes its last
//   views within seconds of midnight); scripts/reader-interest-backfill.ts records older days. Recording a day again
//   replaces it in one transaction. Rows are kept for good; visit_pages is not needed afterwards.
import { addDays, beijingDate, beijingMidnight } from "@amp/contracts/time";
import { ARTICLE_ID_PATTERN } from "@amp/contracts/taxonomy";
import type { ReaderInterest } from "@amp/contracts/http/private";
import { CATEGORY_LABELS } from "@amp/industry/taxonomy";
import { sql } from "@amp/backend/db";
import { readerInterestFacts } from "@amp/backend/publication/detail";
import { listTopics } from "@amp/backend/publication/topics";

export const TOP_ITEMS = 50;
/** How long after Beijing midnight a day counts as complete (the api flushes every 10 s). */
const SETTLE_MS = 15 * 60_000;
/** Days the hourly job looks back for one not yet recorded (older ones are the backfill's). */
const LOOKBACK_DAYS = 7;
/** List and topic pages recorded under the "page" dimension. A topic keeps its own address; others are their route. */
const LIST_ROUTES = new Set([
  "/",
  "/all",
  "/hot",
  "/topics",
  "/topics/:slug",
  "/topics/:slug/page/:page",
  "/metals",
  "/daily",
  "/daily/archive",
  "/weekly",
  "/monthly",
  "/policies",
  "/policies/reports",
]);
type Dimension = "category" | "mineral" | "company" | "country" | "page";

export interface InterestDay {
  day: string;
  itemViews: number;
  classifiedViews: number;
  listViews: number;
  items: Array<{ articleId: string; title: string | null; category: string | null; views: number }>;
  facets: Array<{ dimension: Dimension; key: string; label: string; views: number }>;
}

/** Read one day's page views and classify them. Writes nothing. */
export async function computeInterestDay(day: string): Promise<InterestDay> {
  const pages = await sql<{ path: string; route: string; views: number }[]>`
    SELECT path,route,views FROM ops.visit_pages WHERE day=${day}::date`;
  const itemViews = new Map<string, number>();
  const listViews = new Map<string, number>();
  let itemTotal = 0,
    listTotal = 0;
  for (const { path, route, views } of pages) {
    if (route === "/items/:id") {
      itemTotal += views;
      const id = path.slice("/items/".length);
      // Past a day's address limit the api keeps a view under the route alone: counted, not attributable.
      if (path !== route && ARTICLE_ID_PATTERN.test(id)) itemViews.set(id, (itemViews.get(id) ?? 0) + views);
    } else if (LIST_ROUTES.has(route)) {
      listTotal += views;
      listViews.set(path, (listViews.get(path) ?? 0) + views);
    }
  }
  const facts = await readerInterestFacts([...itemViews.keys()]);
  const facets = new Map<string, { dimension: Dimension; key: string; label: string; views: number }>();
  const add = (dimension: Dimension, key: string, label: string, views: number) => {
    const id = `${dimension}\n${key}`;
    const row = facets.get(id) ?? { dimension, key, label: label.slice(0, 200), views: 0 };
    row.views += views;
    facets.set(id, row);
  };
  let classified = 0;
  for (const [id, views] of itemViews) {
    const fact = facts.get(id);
    if (!fact) continue;
    classified += views;
    if (fact.category) add("category", fact.category, CATEGORY_LABELS[fact.category] ?? fact.category, views);
    for (const m of fact.minerals) add("mineral", m.key, m.label, views);
    for (const c of fact.companies) add("company", c.key, c.label, views);
    for (const c of fact.countries) add("country", c.key, c.label, views);
  }
  if (listViews.size) {
    const topics = new Map((await listTopics()).map((t) => [`/topics/${t.slug}`, t.name]));
    for (const [path, views] of listViews) add("page", path.slice(0, 200), topics.get(path) ?? path, views);
  }
  const items = [...itemViews]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, TOP_ITEMS)
    .map(([articleId, views]) => {
      const fact = facts.get(articleId);
      return { articleId, title: fact?.title.slice(0, 500) ?? null, category: fact?.category ?? null, views };
    });
  return {
    day,
    itemViews: itemTotal,
    classifiedViews: classified,
    listViews: listTotal,
    items,
    facets: [...facets.values()].sort((a, b) => a.dimension.localeCompare(b.dimension) || b.views - a.views || a.key.localeCompare(b.key)),
  };
}

/** Store a computed day, replacing what was stored for it. */
export async function storeInterestDay(record: InterestDay): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM ops.reader_interest_items WHERE day=${record.day}::date`;
    await tx`DELETE FROM ops.reader_interest_facets WHERE day=${record.day}::date`;
    await tx`DELETE FROM ops.reader_interest_days WHERE day=${record.day}::date`;
    await tx`INSERT INTO ops.reader_interest_days(day,item_views,classified_views,list_views)
      VALUES(${record.day}::date,${record.itemViews},${record.classifiedViews},${record.listViews})`;
    const items = record.items;
    if (items.length)
      await tx`INSERT INTO ops.reader_interest_items(day,article_id,title,category,views)
        SELECT ${record.day}::date,* FROM unnest(${items.map((i) => i.articleId)}::text[],${items.map((i) => i.title)}::text[],
          ${items.map((i) => i.category)}::text[],${items.map((i) => i.views)}::int[])`;
    const facets = record.facets;
    if (facets.length)
      await tx`INSERT INTO ops.reader_interest_facets(day,dimension,key,label,views)
        SELECT ${record.day}::date,* FROM unnest(${facets.map((f) => f.dimension)}::text[],${facets.map((f) => f.key)}::text[],
          ${facets.map((f) => f.label)}::text[],${facets.map((f) => f.views)}::int[])`;
  });
}

/** The last complete day: yesterday once today is SETTLE_MS old, otherwise the day before. */
export function lastCompleteDay(now: Date): string {
  const today = beijingDate(now);
  return now.getTime() >= beijingMidnight(today).getTime() + SETTLE_MS ? addDays(today, -1) : addDays(today, -2);
}

/** Days with visit figures up to the last complete one, oldest first; recorded ones only when `again`. */
export async function interestDaysToRecord(now: Date, options: { from?: string | null; again?: boolean } = {}): Promise<string[]> {
  const rows = await sql<{ day: string }[]>`
    SELECT pg_catalog.to_char(v.day,'YYYY-MM-DD') AS day FROM ops.visit_days v
    WHERE v.day <= ${lastCompleteDay(now)}::date AND (${options.from ?? null}::date IS NULL OR v.day >= ${options.from ?? null}::date)
      AND (${options.again ?? false} OR NOT EXISTS (SELECT 1 FROM ops.reader_interest_days r WHERE r.day=v.day))
    ORDER BY v.day`;
  return rows.map((row) => row.day);
}

/** Worker job: record each complete day of the last week that has not been recorded yet. */
export async function recordReaderInterest(now = new Date()) {
  const days = await interestDaysToRecord(now, { from: addDays(beijingDate(now), -LOOKBACK_DAYS) });
  for (const day of days) await storeInterestDay(await computeInterestDay(day));
  return { recorded: days };
}

const TOP_FACETS = 15;
const TOP_LISTED_ITEMS = 20;
type InterestRange = ReaderInterest["week"];

async function interestRange(from: string, before: string): Promise<InterestRange> {
  const [totals] = await sql<{ days: number; item_views: number; classified_views: number }[]>`
    SELECT count(*)::int AS days,coalesce(sum(item_views),0)::bigint AS item_views,coalesce(sum(classified_views),0)::bigint AS classified_views
    FROM ops.reader_interest_days WHERE day >= ${from}::date AND day < ${before}::date`;
  const facets = await sql<{ dimension: Dimension; key: string; label: string; views: number }[]>`
    SELECT dimension,key,(array_agg(label ORDER BY day DESC))[1] AS label,sum(views)::bigint AS views
    FROM ops.reader_interest_facets WHERE day >= ${from}::date AND day < ${before}::date
    GROUP BY dimension,key ORDER BY dimension,views DESC,key`;
  const items = await sql<{ article_id: string; title: string | null; category: string | null; views: number }[]>`
    SELECT article_id,(array_agg(title ORDER BY day DESC) FILTER (WHERE title IS NOT NULL))[1] AS title,
      (array_agg(category ORDER BY day DESC) FILTER (WHERE category IS NOT NULL))[1] AS category,sum(views)::bigint AS views
    FROM ops.reader_interest_items WHERE day >= ${from}::date AND day < ${before}::date
    GROUP BY article_id ORDER BY views DESC,article_id LIMIT ${TOP_LISTED_ITEMS}`;
  const of = (dimension: Dimension) =>
    facets
      .filter((f) => f.dimension === dimension)
      .slice(0, TOP_FACETS)
      .map((f) => ({ key: f.key, label: f.label, views: Number(f.views) }));
  return {
    days: totals?.days ?? 0,
    item_views: Number(totals?.item_views ?? 0),
    classified_views: Number(totals?.classified_views ?? 0),
    category: of("category"),
    mineral: of("mineral"),
    company: of("company"),
    country: of("country"),
    page: of("page"),
    items: items.map((i) => ({ article_id: i.article_id, title: i.title, category: i.category, views: Number(i.views) })),
  };
}

/** The 访问概况 section: the last 7 and 30 complete days before `today`. */
export async function readerInterestOverview(today: string): Promise<ReaderInterest> {
  const [week, month, [first]] = await Promise.all([
    interestRange(addDays(today, -7), today),
    interestRange(addDays(today, -30), today),
    sql<{ since: string | null }[]>`SELECT pg_catalog.to_char(min(day),'YYYY-MM-DD') AS since FROM ops.reader_interest_days`,
  ]);
  return { since: first?.since ?? null, week, month };
}
