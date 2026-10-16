import { publicSourceTime, sourceInstant } from "./source-time.ts";
// Reports through the public read layer: website DTOs and the v1 shapes. Only real reports are
// listed; a missing date is a 404, never another day. Withdrawn citations are marked, not shown.
import type { ReportCitation, ReportDetail, ReportIndexEntry, ReportNavigationEntry, ReportKind } from "@amp/contracts/site";
import { sql } from "../db.ts";
import { dailyUrl, itemUrl, siteUrl } from "./links.ts";
import { SITE, withSubject } from "@amp/industry/site";
import { isValidDate, isoWeekRange } from "@amp/contracts/time";
import { fetchItemsByIds, fetchMachineReportItems } from "./items.ts";
export { isReportWithdrawn, storyTextNeedsRefresh, storyWithdrawalAffected } from "./withdrawals.ts";

const PUBLIC_CORRECTION_REASONS = new Set([
  "引用报道已更正，本期内容随之更新。",
  "部分引用已撤回，本期仅保留仍可公开的内容。",
  "引用报道的公开状态已恢复，本期内容已重新核对。",
  "已依据当前公开报道完成本期更正。",
]);
function publicCorrections(value: unknown): Array<{ revision: number; reason: string; at: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    if (
      typeof row.revision !== "number" ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      typeof row.reason !== "string" ||
      typeof row.at !== "string" ||
      !Number.isFinite(Date.parse(row.at))
    )
      return [];
    return [
      {
        revision: row.revision,
        reason: PUBLIC_CORRECTION_REASONS.has(row.reason) ? row.reason : "本期内容已更正，请以当前版本为准。",
        at: new Date(row.at).toISOString(),
      },
    ];
  });
}

export type { ReportKind };
export function isPublicReportKey(kind: ReportKind, key: string) {
  return key === "latest" || (kind === "daily" ? isValidDate(key) : kind === "weekly" ? isoWeekRange(key) !== null : /^\d{4}-(0[1-9]|1[0-2])$/.test(key));
}

/** Same published report DTO, bounded to its existing public fields; no generation or cached citation qualification. */
export async function machineReport(kind: ReportKind, key = "latest") {
  if (!isPublicReportKey(kind, key)) return null;
  const selectedKey = key === "latest" ? (await reportIndexRows(kind, 1))[0]?.key : key;
  if (!selectedKey) return null;
  const report = await loadReport(kind, selectedKey, true);
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
  sourceTime: ReturnType<typeof publicSourceTime>;
  revision: number;
  title: string;
  summary: string | null;
  sourceName: string;
  sourceUrl: string;
}

async function availability(ids: string[], machine = false): Promise<Map<string, Availability>> {
  const out = new Map<string, Availability>();
  if (ids.length === 0) return out;
  // Machine citations use only the current public guide, never ITEM_COLUMNS' website excerpt fallback.
  const rows = machine ? await fetchMachineReportItems(ids) : await fetchItemsByIds(ids);
  for (const r of rows.values()) {
    out.set(r.id, {
      available: r.visibility === "public" && r.eligible && r.source_mode === "editorial",
      firstParty: r.first_party,
      sourceId: r.source_id,
      storyPublicId: r.story_public_id,
      publishedAt: sourceInstant(r.source_time),
      sourceTime: publicSourceTime(r.source_time),
      revision: r.revision,
      title: r.title,
      summary: r.summary,
      sourceName: r.source_name,
      sourceUrl: r.url,
    });
  }
  return out;
}
export async function currentPublicReferenceTitles(ids: string[]): Promise<Map<string, string>> {
  return new Map([...(await availability(ids))].filter(([, value]) => value.available).map(([id, value]) => [id, value.title]));
}

/** Missing projections are unconfirmed and therefore unavailable, like explicitly withdrawn ones. */
export async function unavailableIds(ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Set();
  const current = await availability(unique);
  return new Set(unique.filter((id) => !current.get(id)?.available));
}

/** Directory/feed metadata only: citation summaries and full report prose stay in the detail read. */
export async function reportIndexRows(kind: ReportKind, limit: number) {
  const rows = await sql<{ key: string; content: Record<string, any>; generated_at: Date }[]>`
    SELECT key,content,generated_at FROM reports r WHERE kind=${kind}
      AND NOT EXISTS(SELECT 1 FROM publication.withdrawal_targets w WHERE w.active AND w.lane='news' AND w.target_type='report' AND w.target_key=r.kind||':'||r.key)
    ORDER BY key DESC LIMIT ${limit}`;
  const current = await availability([
    ...new Set(
      rows.flatMap((r) =>
        reportCitations(r.content)
          .map((i) => i.itemId)
          .filter((id): id is string => !!id),
      ),
    ),
  ]);
  return rows.map((r) => ({ ...r, content: currentReportContent(r.content, current) }));
}

/**
 * A report's headline for indexes and feeds: its lead, else the first cited item that is still public.
 * `gone` must cover withdrawn candidates before the first public title (see {@link unavailableHeadlineIds}).
 */
export function reportHeadline(content: Record<string, any>, kind: "daily" | "periodic", gone: Set<string>): string | null {
  const removed = !!content.correctionPending || reportCitations(content).some((i) => i.itemId && gone.has(i.itemId));
  if (!removed && kind === "daily" && content.lead?.title) return String(content.lead.title);
  if (!removed && kind === "periodic" && periodicHeadline(content)) return periodicHeadline(content);
  const items: Array<Record<string, any>> =
    kind === "daily" ? (content.sections ?? []).flatMap((s: any) => s.items ?? []) : (content.themes ?? []).flatMap((t: any) => t.storyRefs ?? []);
  const first = items.find((i) => !i.itemId || !gone.has(i.itemId));
  return first?.title ?? null;
}

/** All citations, including flashes, qualify synthesized lead text before any feed reads it. */
export function reportLeadParagraph(content: Record<string, unknown>, gone: Set<string>): string | null {
  const cited = content as Parameters<typeof reportCitations>[0];
  if (content.correctionPending || reportCitations(cited).some((item) => item.itemId && gone.has(item.itemId))) return null;
  const lead = content.lead as { leadParagraph?: unknown } | undefined;
  return typeof lead?.leadParagraph === "string" ? lead.leadParagraph : null;
}

/** A weekly or monthly's own headline; the composer's "<site> 周报 · 2026-W38" names the issue, not its news. */
function periodicHeadline(content: Record<string, any>): string | null {
  const text = String(content.headline ?? content.title ?? "");
  return text && !/^.+ [周月]报 · \d{4}-/.test(text) ? text : null;
}

type CitationRef = { itemId?: string | null; related?: CitationRef[] };
function reportCitations(content: {
  sections?: Array<{ items?: CitationRef[] }>;
  themes?: Array<{ storyRefs?: CitationRef[] }>;
  flashes?: CitationRef[];
}): CitationRef[] {
  const entries = [
    ...(content.sections ?? []).flatMap((s) => s.items ?? []),
    ...(content.themes ?? []).flatMap((t) => t.storyRefs ?? []),
    ...(content.flashes ?? []),
  ];
  return [...entries, ...entries.flatMap((entry) => entry.related ?? [])];
}

/** Every source of synthesized prose must still be public, including flashes and later citations. */
export async function unavailableHeadlineIds(rows: Array<{ content: Record<string, any> }>, _kind: "daily" | "periodic"): Promise<Set<string>> {
  return unavailableIds(
    rows
      .flatMap((r) => reportCitations(r.content))
      .map((i) => i.itemId)
      .filter((id): id is string => !!id),
  );
}

function staleCitation(raw: Record<string, unknown>, current: Map<string, Availability>) {
  if (typeof raw.itemId !== "string") return false;
  const value = current.get(raw.itemId);
  if (!value?.available) return true;
  if (raw.publicationRevision === value.revision) return false;
  return raw.title !== value.title || (typeof raw.summary === "string" && raw.summary !== (value.summary ?? ""));
}
function currentReportContent(content: Record<string, any>, current: Map<string, Availability>) {
  const correctionPending = !!content.correctionPending || reportCitations(content).some((raw) => staleCitation(raw, current));
  const update = (entry: Record<string, any>) => ({ ...entry, ...citationFrom(entry, current) });
  return {
    ...content,
    correctionPending,
    sections: (content.sections ?? []).map((section: { items?: Record<string, any>[] }) => ({ ...section, items: (section.items ?? []).map(update) })),
    themes: (content.themes ?? []).map((theme: { storyRefs?: Record<string, any>[] }) => ({ ...theme, storyRefs: (theme.storyRefs ?? []).map(update) })),
    flashes: (content.flashes ?? []).map(update),
  };
}

function citationFrom(raw: Record<string, any>, avail: Map<string, Availability>, machine = false): ReportCitation {
  const id = raw.itemId ?? null;
  const a = id ? avail.get(id) : undefined;
  // A missing current projection never proves a cited item is still public.
  const available = id ? (a?.available ?? false) : !machine;
  if (!available) {
    // Withdrawn since: the reader sees a marked title; the summary and links are not sent at all.
    return {
      itemId: id,
      title: "已撤回的报道",
      summary: null,
      sourceName: "",
      sourceUrl: "",
      sourceId: null,
      firstParty: false,
      role: raw.role ?? null,
      storyPublicId: null,
      publishedAt: null,
      sourceTime: null,
      available: false,
    };
  }
  return {
    itemId: id,
    ...(typeof raw.sources === "number" && Number.isSafeInteger(raw.sources) && raw.sources > 0 ? { sources: raw.sources } : {}),
    ...(typeof raw.followUp === "string" && isValidDate(raw.followUp) ? { followUp: raw.followUp } : {}),
    ...(raw.fillIn === true ? { fillIn: true } : {}),
    ...(Array.isArray(raw.related)
      ? {
          related: raw.related.map((entry: Record<string, any>) => {
            const citation = citationFrom({ ...entry, related: undefined }, avail, machine);
            return {
              itemId: citation.itemId,
              sourceTime: citation.sourceTime ?? null,
              title: citation.title,
              sourceName: citation.sourceName,
              sourceUrl: citation.sourceUrl,
              sourceId: citation.sourceId,
              storyPublicId: citation.storyPublicId,
              available: citation.available,
            };
          }),
        }
      : {}),
    title: a?.title ?? String(raw.title ?? ""),
    summary: a ? a.summary : (raw.summary ?? null),
    sourceName: a?.sourceName ?? String(raw.sourceName ?? raw.source?.name ?? ""),
    sourceUrl: a?.sourceUrl ?? String(raw.sourceUrl ?? raw.links?.original ?? ""),
    sourceId: machine ? (a?.sourceId ?? null) : (raw.sourceId ?? a?.sourceId ?? null),
    firstParty: machine ? (a?.firstParty ?? false) : (raw.firstParty ?? a?.firstParty ?? false),
    role: raw.role ?? null,
    storyPublicId: machine ? (a?.storyPublicId ?? null) : (raw.storyPublicId ?? a?.storyPublicId ?? null),
    publishedAt: a?.publishedAt?.toISOString() ?? null,
    sourceTime: a?.sourceTime ?? null,
    available,
  };
}

function readingMinutes(text: string): number {
  return Math.max(1, Math.round([...text].length / 450));
}

async function neighbors(kind: ReportKind, key: string): Promise<{ prev: string | null; next: string | null }> {
  const [row] = await sql<{ prev: string | null; next: string | null }[]>`
    SELECT (SELECT key FROM reports r WHERE kind = ${kind} AND key < ${key} AND NOT EXISTS(SELECT 1 FROM publication.withdrawal_targets w WHERE w.active AND w.lane='news' AND w.target_type='report' AND w.target_key=r.kind||':'||r.key) ORDER BY key DESC LIMIT 1) AS prev,
      (SELECT key FROM reports r WHERE kind = ${kind} AND key > ${key} AND NOT EXISTS(SELECT 1 FROM publication.withdrawal_targets w WHERE w.active AND w.lane='news' AND w.target_type='report' AND w.target_key=r.kind||':'||r.key) ORDER BY key ASC LIMIT 1) AS next`;
  return { prev: row?.prev ?? null, next: row?.next ?? null };
}

export async function loadReport(kind: ReportKind, key: string, machine = false): Promise<ReportDetail | null> {
  const [r] = await sql<
    ReportRow[]
  >`SELECT kind, key, window_start, window_end, content, generated_at, revision FROM reports r WHERE kind = ${kind} AND key = ${key} AND NOT EXISTS(SELECT 1 FROM publication.withdrawal_targets w WHERE w.active AND w.lane='news' AND w.target_type='report' AND w.target_key=r.kind||':'||r.key)`;
  if (!r) return null;
  const c = r.content;
  const allCitations = reportCitations(c);
  const avail = await availability([...new Set(allCitations.flatMap((i) => (i.itemId ? [i.itemId] : [])))], machine);
  const cite = (raw: Record<string, any>) => citationFrom(raw, avail, machine);
  const removed = !!c.correctionPending || allCitations.some((raw) => !cite(raw).available || staleCitation(raw, avail));

  const sections =
    kind === "daily"
      ? (c.sections ?? []).map((s: any) => ({ label: removed ? "仍公开的报道" : String(s.label), summary: null, items: (s.items ?? []).map(cite) }))
      : (c.themes ?? []).map((t: any) => ({
          label: removed ? "仍公开的报道" : String(t.heading),
          summary: removed ? null : (t.summary ?? null),
          items: (t.storyRefs ?? []).map(cite),
        }));
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
  const overview =
    kind === "daily" || removed
      ? null
      : typeof c.overview === "string" && c.overview.trim()
        ? c.overview
        : stories.length
          ? `${kind === "weekly" ? "本周" : "本月"}汇集 ${stories.length} 件矿业动态，包括：${stories
              .slice(0, 3)
              .map((entry) => entry.title)
              .join("；")}。`
          : null;
  const title =
    kind === "daily" ? `${withSubject("日报")} · ${key}` : String(c.title ?? (kind === "weekly" ? `${SITE.name} 周报 · ${key}` : `${SITE.name} 月报 · ${key}`));
  return {
    kind,
    key,
    generationStatus: c.correctionPending
      ? c.generationStatus === "failed"
        ? "failed"
        : "pending"
      : removed
        ? "summary"
        : ["ready", "pending", "failed", "summary"].includes(c.generationStatus)
          ? c.generationStatus
          : "summary",
    title: removed ? `${SITE.name} ${kind === "daily" ? "日报" : kind === "weekly" ? "周报" : "月报"} · ${key}` : title,
    windowStart: r.window_start.toISOString(),
    windowEnd: r.window_end.toISOString(),
    generatedAt: r.generated_at.toISOString(),
    revision: r.revision,
    corrections: publicCorrections(c.corrections),
    lead: removed ? null : (c.lead ?? (headline ? { title: headline, leadParagraph: overview ?? "" } : null)),
    overview: kind === "daily" ? (removed ? null : (c.overview ?? null)) : overview,
    ...(typeof c.leadItemId === "string" && avail.get(c.leadItemId)?.available ? { leadItemId: c.leadItemId } : {}),
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
export async function reportIndex(kind: ReportKind) {
  // A failed current qualification must never fall back to a directory with withdrawn prose.
  const rows = await reportIndexRows(kind, INDEX_LIMIT);
  return { rows, gone: await unavailableHeadlineIds(rows, kind === "daily" ? "daily" : "periodic") };
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
      leadParagraph: reportLeadParagraph(r.content, gone),
      attribution: attribution(url),
    };
  });
  return { schemaVersion: 1 as const, count: items.length, items };
}

export async function v1Daily(date: string | "latest") {
  const key = date === "latest" ? (await reportIndexRows("daily", 1))[0]?.key : date;
  const report = key ? await loadReport("daily", key, true) : null;
  if (!report) return null;
  const url = dailyUrl(report.key);
  return {
    schemaVersion: 1 as const,
    report: {
      date: report.key,
      generatedAt: report.generatedAt,
      windowStart: report.windowStart,
      windowEnd: report.windowEnd,
      attribution: attribution(url),
      lead: report.lead,
      sections: report.sections.map((section) => ({
        label: section.label,
        items: section.items
          .filter((i) => i.available)
          .map((i) => ({
            title: i.title,
            summary: i.summary ?? "",
            source: { name: i.sourceName },
            links: { original: i.sourceUrl },
            attribution: attribution(i.itemId ? itemUrl(i.itemId) : url),
          })),
      })),
      flashes: report.flashes
        .filter((i) => i.available)
        .map((i) => ({
          title: i.title,
          source: { name: i.sourceName },
          links: { original: i.sourceUrl },
          publishedAt: i.publishedAt,
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

/** Cursor directory metadata; report prose is separately requalified by machineReport. */
export async function publicReportKeys(kind: ReportKind): Promise<Array<{ key: string }>> {
  return sql<
    { key: string }[]
  >`SELECT key FROM reports r WHERE kind=${kind} AND NOT EXISTS(SELECT 1 FROM publication.withdrawal_targets w WHERE w.active AND w.lane='news' AND w.target_type='report' AND w.target_key=r.kind||':'||r.key) ORDER BY key DESC`;
}
