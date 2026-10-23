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
import { sql, withCustomPlans } from "../db.ts";
import { latestHotRanking, rankingExtras, storyParticipation } from "../events/hot-read.ts";
import { storyTextNeedsRefresh, storyWithdrawalAffected } from "./withdrawals.ts";
import { storyStatusFor } from "../events/digest.ts";
import { storyApiUrl, storyUrl } from "./links.ts";
import { SITE } from "@amp/industry/site";

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

interface ReportRow {
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
}

/**
 * Every report linked to the story's facts that has a public page (rules.hasItemPage: editorial source,
 * summarised or not), mentions included (an article's other events). New grouping only links
 * pool-eligible articles; imported hot stories also carry reports the AI pool leaves out, which the live
 * pages showed. hot_signal material only adds heat and is not listed, as on the live pages.
 */
async function storyReports(storyId: number, now: Date): Promise<ReportRow[]> {
  const rows = await sql<ReportRow[]>`
    SELECT DISTINCT ON (p.article_id) p.article_id AS id, p.title, p.summary,
      CASE WHEN s.site_fulltext THEN p.source_excerpt END AS source_excerpt, p.url, (${confirmedSelected()}) AS selected, p.score, p.body_mode, p.timeline_at,
      coalesce(p.published_at, p.discovered_at) AS at, s.id AS source_id, s.name AS source_name, s.kind AS source_kind,
      p.first_party, f.public_id AS fact_public_id, f.id AS fact_id
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    JOIN sources s ON s.id = p.source_id
    WHERE f.story_id = ${storyId} AND p.visibility = 'public' AND s.participation_mode = 'editorial'
      AND (NOT p.selected OR p.visible_after <= ${now})
    ORDER BY p.article_id, (fa.role = 'primary') DESC`;
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
    }[]
  >`
    SELECT public_id::text,origin,version,updated_at,((digest_updated_at IS NULL AND version>1) OR coalesce(updated_at>digest_updated_at,false)) AS text_stale, title, summary, first_report_at, latest_at, digest, digest_updated_at, latest FROM stories WHERE id = ${storyId}`;
  if (!s) return null;
  const reports = await storyReports(storyId, now);
  if (reports.length === 0) return null;
  reports.sort((a, b) => b.at.getTime() - a.at.getTime());

  const byFact = new Map<number, ReportRow[]>();
  for (const r of reports) byFact.set(r.fact_id, [...(byFact.get(r.fact_id) ?? []), r]);
  const facts = await sql<{ id: number; public_id: string; title: string; occurred_at: Date | null; created_at: Date }[]>`
    SELECT id, public_id, title, occurred_at, created_at FROM facts WHERE story_id = ${storyId}`;
  const pending = storyTextNeedsRefresh(s),
    affected = await storyWithdrawalAffected(
      storyId,
      s.public_id,
      facts.map((f) => f.public_id),
    );
  if (pending || (affected && s.origin === "manual")) s.title = reports[0]!.title;
  if (pending) {
    s.digest = null;
    s.latest = null;
  }
  if (pending || affected) s.summary = null;
  const developments = facts
    .filter((f) => byFact.has(f.id))
    .map((f) => {
      const members = byFact.get(f.id)!;
      const rep = pickRepresentative(members);
      const first = members.reduce((m, r) => (r.at < m ? r.at : m), members[0]!.at);
      return {
        factId: f.public_id,
        title: f.title,
        occurredAt: f.occurred_at?.toISOString() ?? null,
        firstReportAt: first.toISOString(),
        reportCount: members.length,
        representative: rep,
      };
    })
    .sort((a, b) => Date.parse(b.firstReportAt) - Date.parse(a.firstReportAt));

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
  return {
    computedAt: ranking.computedAt,
    ruleVersion: ranking.ruleVersion,
    windowHours: 48,
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
        latest: text.latest,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// v1 shapes (ranks and counts only; no heat values)
// ---------------------------------------------------------------------------

export async function v1HotTopics() {
  const ranking = await latestHotRanking();
  const items = (ranking?.entries ?? []).map((e) => ({
    rank: e.rank,
    id: e.representativeItemId ?? e.storyPublicId,
    title: e.title,
    source: { name: e.representativeSource ?? e.sourceNames[0] ?? SITE.name },
    links: {
      original: e.representativeUrl ?? storyUrl(e.storyPublicId),
      story: storyUrl(e.storyPublicId),
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
    links: { api: storyApiUrl(r.public_id) },
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
      latest: s.latest ?? developments[0]?.title ?? s.title,
      digest: s.digest,
      digestUpdatedAt: s.digest_updated_at?.toISOString() ?? null,
      reports: reports.slice(0, 50).map((r) => ({
        id: r.id,
        title: r.title,
        summary: r.summary,
        source: { name: r.source_name, firstParty: r.first_party },
        publishedAt: r.at.toISOString(),
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
  const matchers = readMatcherValues(q.mineral, topic, geo.jurisdictionCodes, searchTerms(q.q ?? ""));
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
