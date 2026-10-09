// Reports through the public read layer: website DTOs and the v1 shapes. Only real reports are
// listed; a missing date is a 404, never another day. Withdrawn citations are marked, not shown.
import type { ReportCitation, ReportDetail, ReportIndexEntry, ReportNavigationEntry, ReportKind } from "@amp/contracts/site";
import { dbOf } from "../db.ts";
import { cached, type Cached } from "../lib/cache.ts";
import { dailyUrl, itemUrl, siteUrl } from "./links.ts";
import { SITE, withSubject } from "@amp/industry/site";
import { isValidDate, isoWeekRange } from "@amp/contracts/time";

const sql = dbOf("publication");

export type { ReportKind };
export function isPublicReportKey(kind: ReportKind, key: string) {
  return key === "latest" || (kind === "daily" ? isValidDate(key) : kind === "weekly" ? isoWeekRange(key) !== null : /^\d{4}-(0[1-9]|1[0-2])$/.test(key));
}

/** Same published report DTO, bounded to its existing public fields; no generation or cached citation qualification. */
export async function machineReport(kind: ReportKind, key = "latest") {
  if (!isPublicReportKey(kind, key)) return null;
  const selectedKey = key === "latest" ? (await reportIndexRows(kind, 1))[0]?.key : key;
  if (!selectedKey) return null;
  const report = await loadReport(kind, selectedKey);
  if (!report) return null;
  const { metrics: _metrics, ...view } = report;
  const removed = [...view.stories, ...view.flashes].some((item) => !item.available);
  return {
    report: {
      ...view,
      title: removed ? `${SITE.name} ${kind === "daily" ? "日报" : kind === "weekly" ? "周报" : "月报"} · ${selectedKey}` : view.title,
      lead: removed ? null : view.lead,
      overview: removed ? null : view.overview,
      highlights: view.highlights.filter((item) => item.available),
      flashes: view.flashes.filter((item) => item.available),
      stories: view.stories.filter((item) => item.available).map((item) => ({ ...item, label: removed ? "仍公开的报道" : item.label })),
      sections: view.sections
        .map((section) => ({
          ...section,
          label: removed ? "仍公开的报道" : section.label,
          summary: removed ? null : section.summary,
          items: section.items.filter((item) => item.available),
        }))
        .filter((section) => section.items.length),
    },
    limitation: removed ? "部分引用已撤回，当前只提供仍可公开的引用，综合文字暂不输出。" : null,
    attribution: { name: SITE.name, url: siteUrl(`/${kind}/${selectedKey}`) },
  };
}

interface ReportRow {
  kind: ReportKind;
  key: string;
  window_start: Date;
  window_end: Date;
  content: Record<string, any>;
  generated_at: Date;
  revision: number;
}

interface Availability {
  available: boolean;
  firstParty: boolean;
  sourceId: string | null;
  storyPublicId: string | null;
  publishedAt: Date | null;
}

async function availability(ids: string[]): Promise<Map<string, Availability>> {
  const out = new Map<string, Availability>();
  if (ids.length === 0) return out;
  const rows = await sql<
    {
      id: string;
      visibility: string;
      eligible: boolean;
      first_party: boolean;
      source_id: string;
      story_public_id: string | null;
      at: Date | null;
    }[]
  >`
    SELECT p.article_id AS id, p.visibility, p.eligible, p.first_party, p.source_id, st.public_id::text AS story_public_id,
      coalesce(p.published_at, p.discovered_at) AS at
    FROM publications p LEFT JOIN stories st ON st.id = p.story_id
    WHERE p.article_id IN ${sql(ids)}`;
  for (const r of rows) {
    out.set(r.id, {
      available: r.visibility === "public" && r.eligible,
      firstParty: r.first_party,
      sourceId: r.source_id,
      storyPublicId: r.story_public_id,
      publishedAt: r.at,
    });
  }
  return out;
}

/** Ids among `ids` that are no longer public. Ids absent from this database stay cited as published. */
export async function unavailableIds(ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Set();
  const rows = await sql<{ id: string }[]>`
    SELECT article_id AS id FROM publications
    WHERE article_id = ANY(${unique}::text[]) AND (visibility <> 'public' OR NOT eligible)`;
  return new Set(rows.map((r) => r.id));
}

/** Directory/feed metadata only: citation summaries and full report prose stay in the detail read. */
export async function reportIndexRows(kind: ReportKind, limit: number) {
  return sql<{ key: string; content: Record<string, any>; generated_at: Date }[]>`
    SELECT key, generated_at, jsonb_build_object(
      'lead', content->'lead', 'headline', content->'headline', 'title', content->'title',
      CASE WHEN kind = 'daily' THEN 'sections' ELSE 'themes' END,
      jsonb_build_array(jsonb_build_object(CASE WHEN kind = 'daily' THEN 'items' ELSE 'storyRefs' END,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('itemId', item->'itemId', 'title', item->'title') ORDER BY ord), '[]'::jsonb)
         FROM jsonb_array_elements(jsonb_path_query_array(content,
           CASE WHEN kind = 'daily' THEN '$.sections[*].items[*]'::jsonpath ELSE '$.themes[*].storyRefs[*]'::jsonpath END
         )) WITH ORDINALITY AS cited(item, ord))))) AS content
    FROM reports WHERE kind = ${kind} ORDER BY key DESC LIMIT ${limit}`;
}

/**
 * A report's headline for indexes and feeds: its lead, else the first cited item that is still public.
 * `gone` must cover withdrawn candidates before the first public title (see {@link unavailableHeadlineIds}).
 */
export function reportHeadline(content: Record<string, any>, kind: "daily" | "periodic", gone: Set<string>): string | null {
  if (kind === "daily" && content.lead?.title) return String(content.lead.title);
  if (kind === "periodic" && periodicHeadline(content)) return periodicHeadline(content);
  const items: Array<Record<string, any>> =
    kind === "daily" ? (content.sections ?? []).flatMap((s: any) => s.items ?? []) : (content.themes ?? []).flatMap((t: any) => t.storyRefs ?? []);
  const first = items.find((i) => !i.itemId || !gone.has(i.itemId));
  return first?.title ?? null;
}

/** A weekly or monthly's own headline; the composer's "<site> 周报 · 2026-W38" names the issue, not its news. */
function periodicHeadline(content: Record<string, any>): string | null {
  const text = String(content.headline ?? content.title ?? "");
  return text && !/^.+ [周月]报 · \d{4}-/.test(text) ? text : null;
}

/** Check only the first possible headline of each report; advance reports whose candidate was withdrawn. */
export async function unavailableHeadlineIds(rows: Array<{ content: Record<string, any> }>, kind: "daily" | "periodic"): Promise<Set<string>> {
  const reports = rows
    .filter((r) => (kind === "daily" ? !r.content.lead?.title : !periodicHeadline(r.content)))
    .map(
      (r): Array<{ itemId?: string | null }> =>
        kind === "daily" ? (r.content.sections ?? []).flatMap((s: any) => s.items ?? []) : (r.content.themes ?? []).flatMap((t: any) => t.storyRefs ?? []),
    );
  const gone = new Set<string>();
  const checked = new Set<string>();
  while (true) {
    const candidates = reports
      .map((items) => items.find((i) => !i.itemId || !gone.has(i.itemId))?.itemId)
      .filter((id): id is string => !!id && !checked.has(id));
    if (!candidates.length) return gone;
    for (const id of await unavailableIds(candidates)) gone.add(id);
    for (const id of candidates) checked.add(id);
  }
}

function citationFrom(raw: Record<string, any>, avail: Map<string, Availability>): ReportCitation {
  const id = raw.itemId ?? null;
  const a = id ? avail.get(id) : undefined;
  // Items absent from this database (older than the imported window) stay cited as they were published.
  const available = id ? (a ? a.available : true) : true;
  if (!available) {
    // Withdrawn since: the reader sees a marked title; the summary and links are not sent at all.
    return {
      itemId: id,
      title: String(raw.title ?? ""),
      summary: null,
      sourceName: "",
      sourceUrl: "",
      sourceId: null,
      firstParty: false,
      role: raw.role ?? null,
      storyPublicId: null,
      publishedAt: null,
      available: false,
    };
  }
  return {
    itemId: id,
    title: String(raw.title ?? ""),
    summary: raw.summary ?? null,
    sourceName: String(raw.sourceName ?? raw.source?.name ?? ""),
    sourceUrl: String(raw.sourceUrl ?? raw.links?.original ?? ""),
    sourceId: raw.sourceId ?? a?.sourceId ?? null,
    firstParty: raw.firstParty ?? a?.firstParty ?? false,
    role: raw.role ?? null,
    storyPublicId: raw.storyPublicId ?? a?.storyPublicId ?? null,
    publishedAt: a?.publishedAt?.toISOString() ?? null,
    available,
  };
}

function readingMinutes(text: string): number {
  return Math.max(1, Math.round([...text].length / 450));
}

async function neighbors(kind: ReportKind, key: string): Promise<{ prev: string | null; next: string | null }> {
  const [row] = await sql<{ prev: string | null; next: string | null }[]>`
    SELECT (SELECT key FROM reports WHERE kind = ${kind} AND key < ${key} ORDER BY key DESC LIMIT 1) AS prev,
      (SELECT key FROM reports WHERE kind = ${kind} AND key > ${key} ORDER BY key ASC LIMIT 1) AS next`;
  return { prev: row?.prev ?? null, next: row?.next ?? null };
}

export async function loadReport(kind: ReportKind, key: string): Promise<ReportDetail | null> {
  const [r] = await sql<
    ReportRow[]
  >`SELECT kind, key, window_start, window_end, content, generated_at, revision FROM reports WHERE kind = ${kind} AND key = ${key}`;
  if (!r) return null;
  const c = r.content;
  const rawItems: Array<Record<string, any>> = [
    ...(c.sections ?? []).flatMap((s: any) => s.items ?? []),
    ...(c.flashes ?? []),
    ...(c.themes ?? []).flatMap((t: any) => t.storyRefs ?? []),
  ];
  const avail = await availability([...new Set(rawItems.map((i) => i.itemId).filter(Boolean))]);
  const cite = (raw: Record<string, any>) => citationFrom(raw, avail);

  const sections =
    kind === "daily"
      ? (c.sections ?? []).map((s: any) => ({ label: String(s.label), summary: null, items: (s.items ?? []).map(cite) }))
      : (c.themes ?? []).map((t: any) => ({ label: String(t.heading), summary: t.summary ?? null, items: (t.storyRefs ?? []).map(cite) }));
  const labelled: Array<ReportCitation & { label: string }> = sections.flatMap((s: { label: string; items: ReportCitation[] }) =>
    s.items.map((i) => ({ ...i, label: s.label })),
  );
  // Weekly and monthly reports carry the editor's reading order across themes.
  const order: string[] = Array.isArray(c.storyOrder) ? c.storyOrder : [];
  const rank = new Map(order.map((id, i) => [id, i]));
  const stories = order.length
    ? [...labelled].sort((a, b) => (rank.get(a.itemId ?? "") ?? order.length) - (rank.get(b.itemId ?? "") ?? order.length))
    : labelled;
  const all: ReportCitation[] = labelled;
  const highlightIds: string[] = c.highlights ?? [];
  const highlights = highlightIds.length
    ? highlightIds.map((id) => all.find((x: ReportCitation) => x.itemId === id)).filter((x): x is ReportCitation => !!x)
    : all.slice(0, 3);
  const text = [c.lead?.leadParagraph ?? "", c.overview ?? "", ...all.map((i: ReportCitation) => `${i.title}${i.summary ?? ""}`)].join("");
  const { prev, next } = await neighbors(kind, key);
  const headline = kind === "daily" ? null : periodicHeadline(c);
  const title =
    kind === "daily" ? `${withSubject("日报")} · ${key}` : String(c.title ?? (kind === "weekly" ? `${SITE.name} 周报 · ${key}` : `${SITE.name} 月报 · ${key}`));
  return {
    kind,
    key,
    title,
    windowStart: r.window_start.toISOString(),
    windowEnd: r.window_end.toISOString(),
    generatedAt: r.generated_at.toISOString(),
    revision: r.revision,
    lead: c.lead ?? (headline ? { title: headline, leadParagraph: String(c.overview ?? "") } : null),
    overview: c.overview ?? null,
    highlights,
    sections,
    stories,
    flashes: (c.flashes ?? []).map(cite),
    metrics: c.metrics ?? {},
    readingMinutes: readingMinutes(text),
    prev,
    next,
  };
}

/**
 * The newest 400 issues of a kind with their withdrawn headline candidates. Every archive, navigation
 * and feed of that kind reads this; it is rebuilt at most once a minute per process (a new issue or a
 * withdrawal shows within a minute, like the pages' own caches).
 */
const INDEX_LIMIT = 400;
const indexes = new Map<ReportKind, Cached<{ rows: Awaited<ReturnType<typeof reportIndexRows>>; gone: Set<string> }>>();
export function reportIndex(kind: ReportKind) {
  let entry = indexes.get(kind);
  if (!entry) {
    entry = cached(
      async () => {
        const rows = await reportIndexRows(kind, INDEX_LIMIT);
        return { rows, gone: await unavailableHeadlineIds(rows, kind === "daily" ? "daily" : "periodic") };
      },
      { freshMs: 60_000, maxStaleMs: 10 * 60_000 },
    );
    indexes.set(kind, entry);
  }
  return entry.get();
}

export async function listReports(kind: ReportKind, limit = INDEX_LIMIT): Promise<ReportIndexEntry[]> {
  const index = await reportIndex(kind);
  const rows = index.rows.slice(0, limit);
  const shape = kind === "daily" ? "daily" : "periodic";
  const gone = index.gone;
  return rows.map((r) => {
    const items =
      kind === "daily" ? (r.content.sections ?? []).flatMap((s: any) => s.items ?? []) : (r.content.themes ?? []).flatMap((t: any) => t.storyRefs ?? []);
    return {
      key: r.key,
      title: reportHeadline(r.content, shape, gone),
      generatedAt: r.generated_at.toISOString(),
      count: items.length,
    };
  });
}

// ---------------------------------------------------------------------------
// v1
// ---------------------------------------------------------------------------

const attribution = (url: string) => ({ name: SITE.name, url });

export async function v1Dailies(limit: number) {
  const index = await reportIndex("daily");
  const rows = index.rows.slice(0, limit);
  const gone = index.gone;
  const items = rows.map((r) => {
    const url = dailyUrl(r.key);
    return {
      date: r.key,
      generatedAt: r.generated_at.toISOString(),
      leadTitle: reportHeadline(r.content, "daily", gone),
      leadParagraph: r.content.lead?.leadParagraph ?? null,
      attribution: attribution(url),
    };
  });
  return { schemaVersion: 1 as const, count: items.length, items };
}

export async function v1Daily(date: string | "latest") {
  const [r] =
    date === "latest"
      ? await sql<
          ReportRow[]
        >`SELECT kind, key, window_start, window_end, content, generated_at, revision FROM reports WHERE kind = 'daily' ORDER BY key DESC LIMIT 1`
      : await sql<ReportRow[]>`SELECT kind, key, window_start, window_end, content, generated_at, revision FROM reports WHERE kind = 'daily' AND key = ${date}`;
  if (!r) return null;
  const c = r.content;
  const raw = [...(c.sections ?? []).flatMap((s: any) => s.items ?? []), ...(c.flashes ?? [])];
  const avail = await availability([...new Set(raw.map((i: any) => i.itemId).filter(Boolean))] as string[]);
  const ok = (i: any) => !i.itemId || (avail.get(i.itemId)?.available ?? true);
  const links = (i: any) => ({ original: String(i.sourceUrl ?? "") });
  const url = dailyUrl(r.key);
  return {
    schemaVersion: 1 as const,
    report: {
      date: r.key,
      generatedAt: r.generated_at.toISOString(),
      windowStart: r.window_start.toISOString(),
      windowEnd: r.window_end.toISOString(),
      attribution: attribution(url),
      lead: c.lead && raw.every(ok) ? { title: String(c.lead.title), leadParagraph: String(c.lead.leadParagraph) } : null,
      sections: (c.sections ?? []).map((s: any) => ({
        label: String(s.label),
        items: (s.items ?? []).filter(ok).map((i: any) => ({
          title: String(i.title),
          summary: String(i.summary ?? ""),
          source: { name: String(i.sourceName ?? "") },
          links: links(i),
          attribution: attribution(i.itemId ? itemUrl(i.itemId) : url),
        })),
      })),
      flashes: (c.flashes ?? []).filter(ok).map((i: any) => ({
        title: String(i.title),
        source: { name: String(i.sourceName ?? "") },
        links: links(i),
        publishedAt: new Date(i.publishedAt ?? r.generated_at).toISOString(),
        attribution: attribution(i.itemId ? itemUrl(i.itemId) : url),
      })),
    },
  };
}

export { siteUrl };

export function reportNavigation(kind: ReportKind, index: ReportIndexEntry[], key: string): ReportNavigationEntry[] {
  const at = index.findIndex((e) => e.key === key);
  return index.map((entry, n) => ({
    key: entry.key,
    ...(kind !== "daily" || entry.key.slice(0, 7) === key.slice(0, 7) || n < 3 || Math.abs(n - at) <= 1 ? { title: entry.title } : {}),
  }));
}

export async function loadReportNavigation(kind: ReportKind, key: string) {
  return reportNavigation(kind, await listReports(kind), key);
}

export async function loadReportMonth(kind: ReportKind, month: string) {
  return (await listReports(kind)).filter((e) => e.key.startsWith(month)).map(({ key, title }) => ({ key, title }));
}
