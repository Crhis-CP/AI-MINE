// Read current qualified metadata on every request. Withdrawals must not survive in a disk fallback.
import { dbOf } from "../db.ts";
import { escapeXml } from "../lib/text.ts";
import { siteUrl } from "./links.ts";
import { topicPageCounts } from "./topics.ts";
import { policyDiscoveryEntries } from "./policies.ts";
import { policyReport } from "./policies-reports.ts";

const sql = dbOf("publication");

const MAX_URLS = 45_000;
interface Entry {
  loc: string;
  lastmod?: Date | null;
  changefreq?: string;
  priority?: number;
}

async function entriesForSitemap(): Promise<Entry[]> {
  const entries: Entry[] = [];
  const [latestItem] = await sql<{ t: Date | null }[]>`SELECT max(timeline_at) AS t FROM publications WHERE visibility = 'public' AND selected`;
  const [latestDaily] = await sql<{ key: string | null; t: Date | null }[]>`SELECT max(key) AS key, max(generated_at) AS t FROM reports WHERE kind = 'daily'`;
  const now = latestItem?.t ?? new Date();
  entries.push(
    { loc: "/", lastmod: now, changefreq: "hourly", priority: 1 },
    { loc: "/all", lastmod: now, changefreq: "hourly", priority: 0.9 },
    { loc: "/daily", lastmod: latestDaily?.t, changefreq: "daily", priority: 0.9 },
    { loc: "/hot", lastmod: now, changefreq: "hourly", priority: 0.9 },
    { loc: "/daily/archive", lastmod: latestDaily?.t, changefreq: "daily", priority: 0.7 },
    { loc: "/weekly", changefreq: "weekly", priority: 0.7 },
    { loc: "/monthly", changefreq: "monthly", priority: 0.6 },
    { loc: "/topics", changefreq: "daily", priority: 0.7 },
    { loc: "/metals", changefreq: "daily", priority: 0.7 },
    { loc: "/policies", changefreq: "daily", priority: 0.8 },
    { loc: "/agent", lastmod: now, changefreq: "weekly", priority: 0.7 },
    { loc: "/about", changefreq: "monthly", priority: 0.5 },
    { loc: "/terms", changefreq: "monthly", priority: 0.4 },
    { loc: "/privacy", changefreq: "monthly", priority: 0.4 },
    { loc: "/changelog", lastmod: now, changefreq: "weekly", priority: 0.5 },
  );
  const reports = await sql<{ kind: string; key: string; generated_at: Date }[]>`SELECT kind, key, generated_at FROM reports ORDER BY kind, key DESC`;
  for (const r of reports)
    entries.push({
      loc: `/${r.kind}/${r.key}`,
      lastmod: r.generated_at,
      changefreq: r.kind === "daily" ? "never" : "monthly",
      priority: r.kind === "daily" ? 0.6 : 0.6,
    });
  for (const t of await topicPageCounts()) {
    if (!t.indexable) continue;
    entries.push({ loc: `/topics/${t.slug}`, lastmod: t.latest, changefreq: "daily", priority: 0.6 });
    for (let p = 2; p <= t.pages; p++) entries.push({ loc: `/topics/${t.slug}/page/${p}`, lastmod: t.latest, changefreq: "weekly", priority: 0.3 });
  }
  // Stories with reports of their own; pages that only gather reports grouped elsewhere (imported story
  // levels, regrouped history) are reachable but not listed.
  const stories = await sql<{ public_id: string; latest_at: Date | null }[]>`
    SELECT public_id::text, latest_at FROM stories WHERE merged_into IS NULL AND EXISTS (
      SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      WHERE f.story_id = stories.id AND fa.role IN ('primary', 'report') AND p.visibility = 'public' AND p.eligible)
    ORDER BY latest_at DESC NULLS LAST LIMIT 500`;
  for (const s of stories) entries.push({ loc: `/story/${s.public_id}`, lastmod: s.latest_at, changefreq: "daily", priority: 0.5 });
  for (const policy of await policyDiscoveryEntries())
    entries.push({ loc: `/policies/${encodeURIComponent(policy.id)}`, lastmod: policy.lastModified, changefreq: "monthly", priority: 0.6 });
  const policyReports = await sql<{ id: string }[]>`SELECT id FROM publication.policy_reports WHERE current_revision>0 ORDER BY period_key DESC,id`;
  for (const row of policyReports) {
    const report = await policyReport(row.id, { limit: 1 });
    if (report.item_count)
      entries.push({ loc: `/policies/reports/${encodeURIComponent(row.id)}`, lastmod: new Date(report.issued_at), changefreq: "monthly", priority: 0.6 });
  }
  const items = await sql<{ id: string; t: Date }[]>`
    SELECT article_id AS id, updated_at AS t FROM publications WHERE visibility = 'public' AND indexable ORDER BY timeline_at DESC,article_id`;
  for (const it of items) entries.push({ loc: `/items/${it.id}`, lastmod: it.t, changefreq: "monthly", priority: 0.5 });
  return entries;
}

export class SitemapPageNotFound extends Error {}

/** Split instead of silently dropping entries after the single-file capacity. */
export function renderSitemap(entries: Entry[], page?: number, capacity = MAX_URLS): string {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_URLS) throw new Error("Invalid sitemap capacity");
  const pages = Math.max(1, Math.ceil(entries.length / capacity));
  if (page !== undefined && (!Number.isSafeInteger(page) || page < 1 || page > pages)) throw new SitemapPageNotFound("Sitemap page not found");
  if (page === undefined && pages > 1)
    return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemaps/0.9">\n${Array.from(
      { length: pages },
      (_, i) => `<sitemap><loc>${escapeXml(siteUrl(`/sitemaps/${i + 1}.xml`))}</loc></sitemap>`,
    ).join("\n")}\n</sitemapindex>\n`;
  const start = ((page ?? 1) - 1) * capacity;
  const body = entries
    .slice(start, start + capacity)
    .map((e) => {
      const parts = [`<loc>${escapeXml(siteUrl(e.loc))}</loc>`];
      if (e.lastmod) parts.push(`<lastmod>${e.lastmod.toISOString()}</lastmod>`);
      if (e.changefreq) parts.push(`<changefreq>${e.changefreq}</changefreq>`);
      if (e.priority !== undefined) parts.push(`<priority>${e.priority}</priority>`);
      return `<url>\n${parts.join("\n")}\n</url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemaps/0.9">\n${body}\n</urlset>\n`;
}

export async function sitemapXml(page?: number): Promise<string> {
  return renderSitemap(await entriesForSitemap(), page);
}
