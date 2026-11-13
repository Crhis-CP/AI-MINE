import { readCurrentPublicPolicies } from "@amp/backend/admin/sources";
import { postPermission, publicPostSummary } from "./post-view.ts";
import { attachSourcePolicies } from "./reader-context.ts";
import { originalPostProjectionAllowed } from "../lib/original-post-admission.ts";
import { originalPostAdmissionCondition } from "./items.ts";
import { confirmedSelected } from "./items.ts";
import { readHistoricalBackground } from "./historical-background.ts";
import { publicHeatSeries, publicHeatSeriesMany } from "../events/participation-read.ts";
import { attachRepresentativePriority, pickRepresentative } from "./representative.ts";
import type { z } from "zod";
import type { V3EventsQuery } from "@amp/contracts/http/v3";
import { addDays, beijingMidnight } from "@amp/contracts/time";
import { newsJurisdictionScope, readPublicStoryDirectory, publicTimeMetadata } from "./items.ts";
import { readMatcherValues } from "./mentions.ts";
import { searchTerms } from "./pool.ts";
import { loadTopicTags } from "./topics.ts";
// Stories (events) and the hot ranking through the public read layer. The website sees heat values;
// v1 / MCP / Skill only see ranks and counts.
import type { HeatPoint, HotResponse, StoryDetail, StoryReportView } from "@amp/contracts/site";
import { sql, withCustomPlans, type Db } from "../db.ts";
import { latestHotRanking, rankingExtras, storyParticipation } from "../events/hot-read.ts";
import { storyTextNeedsRefresh, storyWithdrawalAffected } from "./withdrawals.ts";
import { readDigestDetail, storyStatusFor } from "../events/digest.ts";
import { TITLE_KEY_MIN_CHARS, titleKey } from "../events/relate.ts";
import { siteUrl, storyUrl } from "./links.ts";
import { readerAnchor } from "./source-time.ts";
import { serverModules } from "../modules.ts";
import { SITE } from "@amp/industry/site";
import { beijingDate } from "@amp/contracts/time";

/** The fact a report is listed under when it is linked to several: its primary fact, then a report link, then the oldest fact. */
const listedFact = () => sql`(fa.role = 'primary') DESC, (fa.role = 'report') DESC, f.id`;

/** What the copy rule needs of a report: when it appeared, its headlines and whether it is the official copy. */
export interface CopyCandidate {
  id: string;
  at: Date;
  title: string;
  original_title: string | null;
  first_party: boolean;
}

/**
 * Copies of one report: a wire copy, a reprint, the same article stored twice under another address. They carry
 * the same headline (the source's own, else ours) on the same Beijing day, the exact-duplicate rule grouping uses
 * (events/relate.ts certainDuplicate); headlines too short to tell reports apart never tie. Each group lists the
 * copy to keep first: an official one, then the earliest. Every reader list that shows reports uses this.
 */
export function copyGroups<R extends CopyCandidate>(rows: R[]): R[][] {
  const itemOf = (r: R) => {
    const key = titleKey(r.original_title || r.title);
    return [...key].length >= TITLE_KEY_MIN_CHARS ? `${beijingDate(r.at)}|${key}` : `report:${r.id}`;
  };
  const items = new Map<string, R[]>();
  for (const r of rows) items.set(itemOf(r), [...(items.get(itemOf(r)) ?? []), r]);
  return [...items.values()].map((copies) =>
    [...copies].sort((a, b) => Number(b.first_party) - Number(a.first_party) || a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id)),
  );
}

/** One row per report, copies folded (copyGroups), in the order given. */
export function foldCopies<R extends CopyCandidate>(rows: R[]): R[] {
  const kept = new Set(copyGroups(rows).map((copies) => copies[0]!));
  return rows.filter((r) => kept.has(r));
}

/** What a story's line needs of each report: its fact as well. */
export interface LineReport extends CopyCandidate {
  fact_id: number;
}

/**
 * A story's line of developments, the same on the story page and on feed cards. Copies of one report
 * (copyGroups) are one item, kept once. Facts that carry copies of one item are one development, named by the
 * fact of its earliest report. Developments run oldest first by first report; on the same instant the fact
 * founded later is the later step.
 */
export function storyLine<R extends LineReport>(rows: R[]) {
  const items = copyGroups(rows);
  const joined = new Map<number, number>();
  const root = (fact: number): number => {
    const up = joined.get(fact);
    if (up === undefined || up === fact) return fact;
    const top = root(up);
    joined.set(fact, top);
    return top;
  };
  for (const copies of items)
    for (const copy of copies.slice(1)) {
      const a = root(copies[0]!.fact_id),
        b = root(copy.fact_id);
      if (a !== b) joined.set(Math.max(a, b), Math.min(a, b));
    }
  const kept = items.map((copies) => copies[0]!);
  const earliest = new Map<number, R>();
  for (const r of kept) {
    const set = root(r.fact_id),
      seen = earliest.get(set);
    if (!seen || r.at < seen.at || (r.at.getTime() === seen.at.getTime() && r.fact_id < seen.fact_id)) earliest.set(set, r);
  }
  const developmentFact = (fact: number) => earliest.get(root(fact))!.fact_id;
  const members = new Map<number, R[]>();
  for (const r of kept) members.set(developmentFact(r.fact_id), [...(members.get(developmentFact(r.fact_id)) ?? []), r]);
  const developments = [...members]
    .map(([factId, reports]) => ({ factId, members: reports, first: new Date(Math.min(...reports.map((r) => r.at.getTime()))) }))
    .sort((a, b) => a.first.getTime() - b.first.getTime() || a.factId - b.factId);
  const index = new Map(developments.map((d, i) => [d.factId, i]));
  return {
    /** Oldest first; members are the kept copies. */
    developments,
    /** Every listed report, kept or folded, to the index of its development. */
    developmentOf: new Map(rows.map((r) => [r.id, index.get(developmentFact(r.fact_id))!])),
    /** Every fact with a listed report to the index of its development. */
    developmentOfFact: new Map(rows.map((r) => [r.fact_id, index.get(developmentFact(r.fact_id))!])),
  };
}

/**
 * storyWithdrawalAffected for many stories in one statement (same conditions): the stories whose text may describe
 * withdrawn material. Read here, where story and fact rows are this module's read model.
 */
export async function storiesWithdrawalAffected(storyIds: number[], db: Db = sql): Promise<Set<number>> {
  if (!storyIds.length) return new Set();
  const rows = await db<{ id: number }[]>`SELECT st.id FROM stories st WHERE st.id = ANY(${storyIds}::bigint[]) AND (
    EXISTS(SELECT 1 FROM publication.withdrawal_targets w WHERE w.active AND w.lane='news' AND
      ((w.target_type='story' AND w.target_key=st.public_id::text) OR
       (w.target_type='event' AND w.target_key IN (SELECT f.public_id::text FROM facts f WHERE f.story_id=st.id))))
    OR EXISTS(SELECT 1 FROM publications p WHERE p.story_id=st.id AND p.visibility='withdrawn'))`;
  return new Set(rows.map((r) => Number(r.id)));
}

/**
 * What readers see as a development's title. A fact's title was written from one of its reports and is not rewritten when
 * that report is withdrawn or loses its original-post grant, so a story touched by either (`guarded`) names each
 * development after its earliest report that is still public. Story page, hot list and feed cards all read titles here.
 */
export function developmentTitle(factTitle: string, members: { title: string; at: Date }[], guarded: boolean) {
  if (!guarded) return factTitle;
  return [...members].sort((a, b) => a.at.getTime() - b.at.getTime())[0]?.title ?? "";
}

/** Each story's listed reports for the feed's progress line, chosen as on the story page (storyReports). */
export async function readStoryReportLines(storyIds: number[], now: Date, db: Db = sql) {
  if (!storyIds.length) return [];
  return db<(LineReport & { story_id: number; fact_title: string })[]>`
    SELECT DISTINCT ON (f.story_id, p.article_id) f.story_id, p.article_id AS id, f.id AS fact_id, f.title AS fact_title, p.title, p.original_title,
      p.first_party, coalesce(p.published_at, p.discovered_at) AS at
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    JOIN sources s ON s.id = p.source_id
    WHERE f.story_id = ANY(${storyIds}::bigint[]) AND p.visibility = 'public' AND ${originalPostAdmissionCondition()}
      AND s.participation_mode = 'editorial' AND (NOT p.selected OR p.visible_after <= ${now})
    ORDER BY f.story_id, p.article_id, ${listedFact()}`;
}

/** All graph associations can have contributed to cached story text; current grants fence old copy too. */
export async function originalPostAffectedStories(ids: number[], db: Db = sql): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const rows = await db<
    {
      id: number;
      source_id: string;
      url: string;
      is_original_post: boolean;
      original_post_admission_required: boolean | null;
      summary: string | null;
      post_summary_kind: string | null;
    }[]
  >`WITH members AS (
    SELECT f.story_id,fa.article_id FROM facts f JOIN fact_articles fa ON fa.fact_id=f.id WHERE f.story_id=ANY(${ids}::bigint[])
    UNION SELECT story_id,article_id FROM story_signals WHERE story_id=ANY(${ids}::bigint[])
  ) SELECT members.story_id AS id,p.source_id,p.url,p.is_original_post,p.original_post_admission_required,p.summary,p.x_post->>'summaryKind' AS post_summary_kind
    FROM members JOIN publications p ON p.article_id=members.article_id WHERE p.is_original_post`;
  const sources = [...new Set(rows.map((row) => row.source_id))],
    policies = new Map<string, unknown>();
  for (let offset = 0; offset < sources.length; offset += 100)
    for (const [id, policy] of await readCurrentPublicPolicies(sources.slice(offset, offset + 100), db)) policies.set(id, policy);
  return new Set(
    rows
      .filter(
        (row) =>
          !originalPostProjectionAllowed(row) ||
          !postPermission(policies.get(row.source_id), row.source_id, row.url, "public_summary") ||
          (!!row.summary && row.post_summary_kind !== "summary"),
      )
      .map((row) => row.id),
  );
}

export type StoryLookup = { kind: "found"; storyId: number; publicId: string } | { kind: "merged"; target: string } | { kind: "not_found" };

export async function resolveStory(publicId: string): Promise<StoryLookup> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(publicId)) return { kind: "not_found" };
  const [s] = await sql<{ id: number; merged_into: number | null }[]>`SELECT id, merged_into FROM stories WHERE public_id = ${publicId}`;
  let targetId: number | null = s ? (s.merged_into ?? null) : null;
  if (!s) {
    const [alias] = await sql<{ story_id: number }[]>`SELECT story_id FROM story_aliases WHERE public_id = ${publicId}`;
    if (!alias) return { kind: "not_found" };
    targetId = alias.story_id;
  }
  if (targetId) {
    // Follow merge chains to the surviving story.
    for (let i = 0; i < 10; i++) {
      const rows: Array<{ id: number; public_id: string; merged_into: number | null }> =
        await sql`SELECT id, public_id::text, merged_into FROM stories WHERE id = ${targetId}`;
      const t = rows[0];
      if (!t) return { kind: "not_found" };
      if (!t.merged_into) return { kind: "merged", target: t.public_id };
      targetId = t.merged_into;
    }
    return { kind: "not_found" };
  }
  return { kind: "found", storyId: s!.id, publicId };
}

interface ReportRow extends LineReport {
  sourceTime?: import("@amp/contracts/time-assertion").TimeAssertion | null;
  id: string;
  title: string;
  summary: string | null;
  source_excerpt: string | null;
  url: string;
  selected: boolean;
  score: number | null;
  body_mode: string;
  timeline_at: Date;
  at: Date;
  source_id: string;
  source_name: string;
  source_kind: string;
  first_party: boolean;
  fact_public_id: string;
  fact_id: number;
  is_original_post: boolean;
  post_summary_kind: string | null;
  source_policy?: unknown;
}

/**
 * Every report linked to the story's facts that has a public page (rules.hasItemPage: editorial source,
 * summarised or not), mentions included (an article's other events). New grouping only links
 * pool-eligible articles; imported hot stories also carry reports the AI pool leaves out, which the live
 * pages showed. hot_signal material only adds heat and is not listed, as on the live pages.
 */
async function storyReports(storyId: number, now: Date): Promise<ReportRow[]> {
  const rows = await sql<ReportRow[]>`
    SELECT DISTINCT ON (p.article_id) p.article_id AS id, p.title, p.original_title, p.summary,
      CASE WHEN s.site_fulltext THEN p.source_excerpt END AS source_excerpt, p.url, (${confirmedSelected()}) AS selected, p.score, p.body_mode, p.timeline_at,
      coalesce(p.published_at, p.discovered_at) AS at, s.id AS source_id, s.name AS source_name, s.kind AS source_kind,
      p.first_party, f.public_id AS fact_public_id, f.id AS fact_id,p.is_original_post,p.x_post->>'summaryKind' AS post_summary_kind
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    JOIN sources s ON s.id = p.source_id
    WHERE f.story_id = ${storyId} AND p.visibility = 'public' AND ${originalPostAdmissionCondition()} AND s.participation_mode = 'editorial'
      AND (NOT p.selected OR p.visible_after <= ${now})
    ORDER BY p.article_id, ${listedFact()}`;
  await attachSourcePolicies(rows);
  for (const row of rows) {
    if (!row.is_original_post) continue;
    Object.assign(row, publicPostSummary({ ...row, summary: row.summary ?? row.source_excerpt }, now.getTime()));
    row.source_excerpt = null;
  }
  const dates = await publicTimeMetadata(rows.map((row) => row.id));
  for (const row of rows) row.sourceTime = dates.get(row.id)?.sourceTime ?? null;
  return attachRepresentativePriority(rows);
}

function reportView(r: ReportRow): StoryReportView {
  return {
    id: r.id,
    title: r.title,
    summary: r.summary ?? r.source_excerpt,
    source: { id: r.source_id, name: r.source_name, kind: r.source_kind as never, firstParty: r.first_party },
    publishedAt: r.at.toISOString(),
    sourceTime: r.sourceTime ?? null,
    originalUrl: r.url,
    selected: r.selected,
    factId: r.fact_public_id,
  };
}

async function storyContent(storyId: number, now: Date) {
  const [s] = await sql<
    {
      public_id: string;
      text_stale: boolean;
      origin: string;
      version: number;
      updated_at: Date;
      title: string;
      summary: string | null;
      first_report_at: Date | null;
      latest_at: Date | null;
      digest: string | null;
      digest_updated_at: Date | null;
      latest: string | null;
      digest_detail: unknown;
    }[]
  >`
    SELECT public_id::text,origin,version,updated_at,((digest_updated_at IS NULL AND version>1) OR coalesce(updated_at>digest_updated_at,false)) AS text_stale, title, summary, first_report_at, latest_at, digest, digest_updated_at, latest, digest_detail FROM stories WHERE id = ${storyId}`;
  if (!s) return null;
  const listed = await storyReports(storyId, now);
  if (listed.length === 0) return null;
  const facts = await sql<{ id: number; public_id: string; title: string; occurred_at: Date | null; created_at: Date }[]>`
    SELECT id, public_id, title, occurred_at, created_at FROM facts WHERE story_id = ${storyId}`;
  const factRow = new Map(facts.map((f) => [f.id, f]));
  // Copies of one report are listed once, under the development that carries it (storyLine).
  const line = storyLine(listed);
  const reports = line.developments.flatMap((d) =>
    d.members.map((r) => ({ ...r, fact_id: d.factId, fact_public_id: factRow.get(d.factId)?.public_id ?? r.fact_public_id })),
  );
  reports.sort((a, b) => b.at.getTime() - a.at.getTime());
  const admissionAffected = (await originalPostAffectedStories([storyId])).has(storyId);
  const pending = storyTextNeedsRefresh(s) || admissionAffected,
    affected = await storyWithdrawalAffected(
      storyId,
      s.public_id,
      facts.map((f) => f.public_id),
    );
  if (pending || (affected && s.origin === "manual")) s.title = reports[0]!.title;
  if (pending) {
    s.digest = null;
    s.latest = null;
    s.digest_detail = null;
  }
  if (pending || affected) s.summary = null;
  // Newest first; the story page and feed cards read the same line oldest first.
  const developments = line.developments
    .map((d) => {
      const f = factRow.get(d.factId)!;
      const members = reports.filter((r) => r.fact_id === d.factId);
      const rep = pickRepresentative(members);
      return {
        factId: f.public_id,
        title: developmentTitle(f.title, members, admissionAffected || affected),
        occurredAt: f.occurred_at?.toISOString() ?? null,
        firstReportAt: d.first.toISOString(),
        reportCount: members.length,
        representative: rep,
      };
    })
    .reverse();

  return { s, reports, developments };
}

async function relatedStories(storyId: number) {
  const rows = await sql<{ id: number; public_id: string; title: string; relation: "storyline" | "related"; latest_at: Date | null }[]>`
    SELECT st.id,st.public_id::text, st.title, l.relation, st.latest_at FROM story_links l JOIN stories st ON st.id = l.other_id
    WHERE l.story_id = ${storyId} AND st.merged_into IS NULL ORDER BY st.latest_at DESC NULLS LAST LIMIT 8`;
  return (
    await Promise.all(
      rows.map(async (row) => {
        const current = await storyContent(row.id, new Date());
        return current ? [{ public_id: row.public_id, title: current.s.title, relation: row.relation, latest_at: row.latest_at }] : [];
      }),
    )
  ).flat();
}

export async function loadStoryDetail(storyId: number, now = new Date()): Promise<StoryDetail | null> {
  const content = await storyContent(storyId, now);
  if (!content) return null;
  const { s, reports, developments } = content;
  const ranking = await latestHotRanking();
  const why = await storyParticipation(storyId, now);
  const entry = ranking?.entries.find((e) => e.storyId === storyId && e.evidenceHash === why?.evidenceHash) ?? null;
  // Only hours observed in full are drawn (the chart leaves a gap otherwise).
  const heat = await publicHeatSeries(storyId, now);
  const related = await relatedStories(storyId);
  const latestAt = s.latest_at ?? reports[0]!.at;
  // Without a digest or a summary of its own, the story opens with its first development's representative report.
  const origin = developments[developments.length - 1]?.representative;
  const originSummary = origin?.summary ?? origin?.source_excerpt;
  return {
    publicId: s.public_id,
    title: s.title,
    status: storyStatusFor(latestAt, now.getTime()),
    reportCount: reports.length,
    sourceCount: new Set(reports.map((r) => r.source_id)).size,
    firstReportAt: (s.first_report_at ?? reports[reports.length - 1]!.at).toISOString(),
    latestAt: latestAt.toISOString(),
    digest: s.digest,
    digestUpdatedAt: s.digest_updated_at?.toISOString() ?? null,
    // Older digests have no structure; the parts are only shown beside the digest they were written with.
    ...(s.digest ? readDigestDetail(s.digest_detail) : {}),
    summary: s.summary,
    excerpt: !s.digest && !s.summary && originSummary ? { text: originSummary, sourceName: origin!.source_name } : null,
    latest: s.latest,
    whyHot: {
      participants48h: why?.participants48h ?? 0,
      newParticipants6h: why?.newParticipants6h ?? 0,
      recentReports24h: why?.recentReports24h ?? 0,
      observationComplete: why?.complete ?? false,
      rank: entry?.rank ?? null,
      heat: entry?.heat ?? null,
    },
    developments: developments.map((d) => ({ ...d, representative: reportView(d.representative) })),
    officialReports: reports
      .filter((r) => r.first_party)
      .slice(0, 12)
      .map(reportView),
    timeline: reports.slice(0, 100).map(reportView),
    background: await readHistoricalBackground(s.public_id),
    heat: heat.map((h): HeatPoint => ({ hour: h.hour.toISOString(), heat: Number(h.heat), participants: h.participants })),
    related: related.map((r) => ({ publicId: r.public_id, title: r.title, relation: r.relation, latestAt: r.latest_at?.toISOString() ?? null })),
  };
}

const SPARK_HOURS = 24;

/** Hourly heat of the ranked stories over the day before the ranking, one slot per hour. */
async function sparklines(storyIds: number[], at: Date): Promise<Map<number, Array<number | null>>> {
  const end = Math.floor(at.getTime() / 3600000) * 3600000;
  const start = end - SPARK_HOURS * 3600000;
  const series = await publicHeatSeriesMany(storyIds, at, 1);
  const rows = [...series].flatMap(([story_id, points]) => points.map((point) => ({ story_id, ...point })));
  const out = new Map<number, Array<number | null>>(storyIds.map((id) => [id, Array.from({ length: SPARK_HOURS + 1 }, () => null)]));
  for (const r of rows) {
    const slot = Math.round((r.hour.getTime() - start) / 3600000);
    const line = out.get(Number(r.story_id));
    if (line && slot >= 0 && slot <= SPARK_HOURS) line[slot] = Number(r.heat);
  }
  return out;
}

/** Each story's newest development title (storyLine), named as on the story page (developmentTitle). Exported for tests. */
export async function newestDevelopments(storyIds: number[], now: Date): Promise<Map<number, string>> {
  const ids = [...new Set(storyIds)];
  if (!ids.length) return new Map();
  const [rows, admission, withdrawn] = await Promise.all([readStoryReportLines(ids, now), originalPostAffectedStories(ids), storiesWithdrawalAffected(ids)]);
  const out = new Map<number, string>();
  for (const id of ids) {
    const own = rows.filter((r) => r.story_id === id);
    const last = storyLine(own).developments.at(-1);
    const factTitle = own.find((r) => r.fact_id === last?.factId)?.fact_title ?? "";
    if (last) out.set(id, developmentTitle(factTitle, last.members, admission.has(id) || withdrawn.has(id)));
  }
  return out;
}

export async function loadHot(): Promise<HotResponse> {
  const ranking = await latestHotRanking();
  if (!ranking) return { computedAt: null, ruleVersion: null, windowHours: 48, entries: [] };
  const at = new Date(ranking.computedAt);
  const [sparks, extras] = await Promise.all([
    sparklines(
      ranking.entries.map((e) => e.storyId),
      at,
    ),
    rankingExtras(ranking),
  ]);
  const newest = await newestDevelopments(
    ranking.entries.map((e) => e.storyId),
    new Date(),
  );
  return {
    computedAt: ranking.computedAt,
    ruleVersion: ranking.ruleVersion,
    // The window the ranking was computed with: 72 hours every day since TASK-0642; a ranking stored before it keeps its own value.
    windowHours: Number(ranking.coverage?.windowHours) || 48,
    entries: ranking.entries.map((e) => {
      const text = extras.text(e);
      return {
        rank: e.rank,
        story: { publicId: e.storyPublicId, title: e.title },
        heat: e.heat,
        trend: e.trend,
        trendPct: e.trendPct,
        badges: e.badges,
        participantCount: e.participantCount,
        sourceCount: e.sourceCount,
        signalCount: e.signalCount,
        reportCount: e.reportCount,
        sourceNames: e.sourceNames,
        latestAt: e.latestAt,
        firstReportAt: e.firstReportAt,
        representative: e.representativeItemId
          ? { id: e.representativeItemId, url: e.representativeUrl ?? "", sourceName: e.representativeSource ?? "" }
          : null,
        spark: sparks.get(e.storyId) ?? [],
        summary: text.summary,
        // The same 最新进展 as the story page: the newest development of its line, not a separately written sentence.
        latest: newest.has(e.storyId) ? newest.get(e.storyId)! : text.latest,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// v1 shapes (ranks and counts only; no heat values)
// ---------------------------------------------------------------------------

function v1StoryLink(publicId: string, api = false): string {
  const path = api ? `/api/v1/stories/${publicId}` : `/story/${publicId}`;
  for (const module of serverModules()) {
    const value = module.storyOrigin?.();
    if (value === null || value === undefined || value === "") continue;
    if (typeof value !== "string" || !URL.canParse(value) || [...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127))
      throw new Error("Invalid module story origin");
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new Error("Invalid module story origin");
    return `${url.origin}${path}`;
  }
  return siteUrl(path);
}

/** The public API, MCP and RSS keep the top 10 (docs/03-data/02-public-api-contract.md); the web page lists every qualified event (TASK-0642). */
export const V1_HOT_LIMIT = 10;

export async function v1HotTopics() {
  const ranking = await latestHotRanking();
  const items = (ranking?.entries ?? []).slice(0, V1_HOT_LIMIT).map((e) => ({
    rank: e.rank,
    id: e.representativeItemId ?? e.storyPublicId,
    title: e.title,
    source: { name: e.representativeSource ?? e.sourceNames[0] ?? SITE.name },
    links: {
      original: e.representativeUrl ?? storyUrl(e.storyPublicId),
      story: v1StoryLink(e.storyPublicId),
    },
    sourceCount: e.sourceCount,
    signalCount: e.signalCount,
    participantCount: e.participantCount,
    sourceNames: e.sourceNames,
    latestAt: new Date(e.latestAt).toISOString(),
  }));
  return { schemaVersion: 1 as const, count: items.length, items };
}

export async function v1Story(storyId: number) {
  const now = new Date();
  const content = await storyContent(storyId, now);
  if (!content) return null;
  const { s, reports, developments } = content;
  const latestAt = s.latest_at ?? reports[0]!.at;
  const neighbors = (await relatedStories(storyId)).map((r) => ({
    publicId: r.public_id,
    title: r.title,
    relation: r.relation,
    links: { api: v1StoryLink(r.public_id, true) },
  }));
  return {
    schemaVersion: 1 as const,
    story: {
      publicId: s.public_id,
      title: s.title,
      status: storyStatusFor(latestAt, now.getTime()) === "settled" ? ("settled" as const) : ("active" as const),
      sourceCount: new Set(reports.map((r) => r.source_id)).size,
      reportCount: reports.length,
      firstReportAt: (s.first_report_at ?? reports[reports.length - 1]!.at).toISOString(),
      latestAt: latestAt.toISOString(),
      // The story page's 最新进展: the newest development of the line.
      latest: developments[0]?.title ?? s.latest ?? s.title,
      digest: s.digest,
      digestUpdatedAt: s.digest_updated_at?.toISOString() ?? null,
      reports: reports.slice(0, 50).map((r) => ({
        id: r.id,
        title: r.title,
        summary: r.summary,
        source: { name: r.source_name, firstParty: r.first_party },
        // A report whose source gave only a date sits at the start of that day in Beijing (BR-TIME-01), never at a stored foreign midnight.
        publishedAt: readerAnchor(r.at, r.at, r.sourceTime).toISOString(),
        links: { original: r.url },
      })),
      storyline: neighbors.filter((n) => n.relation === "storyline"),
      related: neighbors.filter((n) => n.relation === "related"),
    },
  };
}

export async function publicStoryVersion(id: number): Promise<number> {
  const [row] = await sql<{ version: number }[]>`SELECT version FROM stories WHERE id=${id}`;
  return row?.version ?? 1;
}
/** Narrow event directory from the same currently public, eligible material scope. */
export async function publicStoryDirectory(q: z.infer<typeof V3EventsQuery>) {
  const topic = q.topic ? await loadTopicTags(q.topic) : null;
  if (q.topic && !topic) return [];
  const now = new Date(),
    geo = newsJurisdictionScope(q.jurisdiction),
    start = q.on ?? q.from,
    end = q.on ?? q.to;
  const matchers = readMatcherValues(q.mineral, topic, geo.jurisdictionCodes, searchTerms(q.q ?? ""), geo.jurisdictionRecipe);
  const query = {
    category: q.category ?? null,
    source: q.source ?? null,
    jurisdiction: q.jurisdiction ?? null,
    jurisdictionCodes: geo.jurisdictionCodes,
    jurisdictionRecipe: geo.jurisdictionRecipe,
    rangeStart: start ? beijingMidnight(start) : null,
    rangeEnd: end ? beijingMidnight(addDays(end, 1)) : null,
    selected: q.view === "featured",
    merged: q.status === "merged",
    now,
  };
  return withCustomPlans((db) => readPublicStoryDirectory(db, query, matchers));
}
