import { readMatcherValues } from "./mentions.ts";
import { attachSourcePolicies } from "./reader-context.ts";
// Reports of the same fact share a card and its first appearance. New developments in the same
// story remain separate cards; changing the representative never brings an old fact back to today.
import type { GroupInfo, TimelineCard, TimelineFilters, TimelineResponse } from "@amp/contracts/site";
import { addCalendarMonths, beijingDate, beijingMidnight } from "@amp/contracts/time";
import { sql } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import {
  selectedCondition,
  confirmedSelected,
  ITEM_COLUMNS,
  ITEM_FROM,
  categoryCondition,
  jurisdictionCondition,
  newsJurisdictionScope,
  channelCondition,
  tagCondition,
  toFeedItemSummary,
  topicCondition,
  type ItemRow,
} from "./items.ts";

export interface TimelineQuery extends TimelineFilters {
  scope?: "all" | "selected";
  featuredSince?: Date;
  offset?: number;
  jurisdictionCodes?: string[];
  jurisdictionRecipe?: string;
  cursor?: string | null;
  limit?: number;
  topicTags?: string[] | null;
  now?: Date;
}

interface GroupRow {
  gk: string;
  anchor_at: Date;
}

function entryCondition(q: TimelineQuery, now: Date) {
  if (q.scope === "all") return sql`p.visibility = 'public' AND (NOT p.selected OR p.visible_after <= ${now}) AND p.eligible`;
  return sql`${selectedCondition(now)} AND p.timeline_at >= ${q.featuredSince ?? null}`;
}

function binding(q: TimelineQuery): string {
  return queryBinding({
    scope: q.scope ?? "selected",
    c: q.channel,
    k: q.category,
    t: q.tag,
    p: q.topic ?? null,
    ...(q.jurisdiction ? { j: q.jurisdiction } : {}),
  });
}

import { attachRepresentativePriority, pickRepresentative, type RepresentativeRow } from "./representative.ts";
export { pickRepresentative } from "./representative.ts";

/** Only a report still belonging to its fact can share that fact's card. Mentions stay independent. */
function ownFactEvidence() {
  return sql`EXISTS (SELECT 1 FROM fact_articles fa WHERE fa.fact_id=p.fact_id AND fa.article_id=p.article_id AND fa.role IN ('primary', 'report'))`;
}

/** Public evidence behind the same fact's expandable source list, under the current filters. */
async function groupPool(q: TimelineQuery, now: Date, factIds: number[]) {
  const matchers = readMatcherValues(q.tag, q.topicTags, q.jurisdictionCodes?.length ? q.jurisdictionCodes : q.jurisdiction ? [q.jurisdiction] : [], []);
  if (!factIds.length) return [];
  return sql<{ story_id: number | null; fact_id: number; article_id: string; source_id: string; at: Date }[]>`
    SELECT DISTINCT f.story_id, f.id AS fact_id, p.article_id, p.source_id, p.timeline_at AS at
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    WHERE f.id IN ${sql(factIds)} AND fa.role IN ('primary', 'report')
      AND p.visibility = 'public' AND p.eligible AND (NOT p.selected OR p.visible_after <= ${now}) ${channelCondition(q.channel)} ${categoryCondition(q.category)} ${tagCondition(matchers)} ${topicCondition(matchers)} ${jurisdictionCondition(q.jurisdiction ?? null, q.jurisdictionCodes, q.jurisdictionRecipe ?? "", matchers)}`;
}

/**
 * The selected set grouped into cards (fact or standalone item) with their anchor times, newest
 * first. Every timeline page, day count and "new items" probe reads this list; it is kept for five
 * seconds per filter scope (a release becomes visible at most that much later).
 */
const groupedCache = new Map<string, { at: number; rows: Array<{ gk: string; anchor: number }> }>();
const groupedPending = new Map<string, Promise<Array<{ gk: string; anchor: number }>>>();
async function groupedAnchors(q: TimelineQuery, now: Date): Promise<Array<{ gk: string; anchor: number }>> {
  const key = binding(q);
  const cached = q.now ? undefined : groupedCache.get(key);
  if (cached && Date.now() - cached.at < 5000) return cached.rows;
  const pending = q.now ? undefined : groupedPending.get(key);
  if (pending) return pending;
  const load = queryGroupedAnchors(q, now);
  if (q.now) return load;
  groupedPending.set(key, load);
  try {
    const rows = await load;
    if (groupedCache.size >= 50) groupedCache.delete(groupedCache.keys().next().value!);
    groupedCache.set(key, { at: Date.now(), rows });
    return rows;
  } finally {
    groupedPending.delete(key);
  }
}

async function queryGroupedAnchors(q: TimelineQuery, now: Date) {
  const matchers = readMatcherValues(q.tag, q.topicTags, q.jurisdictionCodes?.length ? q.jurisdictionCodes : q.jurisdiction ? [q.jurisdiction] : [], []);
  const rows = (
    await sql<{ gk: string; anchor_at: Date }[]>`
      WITH base AS (
        SELECT p.sort_at, CASE WHEN p.fact_id IS NOT NULL AND ${ownFactEvidence()} THEN 'f' || p.fact_id::text ELSE 'a' || p.article_id END AS gk
        FROM publications p
        WHERE ${entryCondition(q, now)} ${channelCondition(q.channel)} ${categoryCondition(q.category)} ${tagCondition(matchers)} ${topicCondition(matchers)} ${jurisdictionCondition(q.jurisdiction ?? null, q.jurisdictionCodes, q.jurisdictionRecipe ?? "", matchers)}
      )
      SELECT gk, min(sort_at) AS anchor_at FROM base GROUP BY gk ORDER BY anchor_at DESC, gk COLLATE "C" DESC`
  ).map((r) => ({ gk: r.gk, anchor: r.anchor_at.getTime() }));
  return rows;
}

export async function loadTimeline(q: TimelineQuery): Promise<Omit<TimelineResponse, "hot" | "generatedAt"> & { total: number }> {
  q = { ...q, ...newsJurisdictionScope(q.jurisdiction) };
  const now = q.now ?? new Date();
  q = { ...q, featuredSince: beijingMidnight(addCalendarMonths(beijingDate(now), -3)) };
  const matchers = readMatcherValues(q.tag, q.topicTags, q.jurisdictionCodes?.length ? q.jurisdictionCodes : q.jurisdiction ? [q.jurisdiction] : [], []);
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 40);
  const bind = binding(q);
  let after: { a: number; g: string } | null = null;
  if (q.cursor) {
    const c = decodeCursor<{ a: number; g: string; b: string }>("tl2", q.cursor);
    if (c.b !== bind || typeof c.a !== "number" || typeof c.g !== "string") throw new InvalidCursorError("cursor does not match this query");
    after = { a: c.a, g: c.g };
  }

  // Independent of the page: read alongside it.
  const refreshAtRead = nextRelease(q, now);
  refreshAtRead.catch(() => {});
  const grouped = await groupedAnchors(q, now);
  const start = after ? grouped.findIndex((g) => g.anchor < after!.a || (g.anchor === after!.a && g.gk < after!.g)) : (q.offset ?? 0);
  const groups: GroupRow[] = (start < 0 ? [] : grouped.slice(start, start + limit + 1)).map((g) => ({ gk: g.gk, anchor_at: new Date(g.anchor) }));

  const page = groups.slice(0, limit);
  const hasMore = groups.length > limit;

  const factIds = page.filter((g) => g.gk.startsWith("f")).map((g) => Number(g.gk.slice(1)));

  // Read only ranking fields for the whole group; bodies, media and translations are hydrated for this page's representatives.
  type Member = RepresentativeRow & Pick<ItemRow, "id" | "sort_at" | "source_id"> & { story_id: number | null; fact_id: number };
  const [members, pool] = await Promise.all([
    factIds.length
      ? sql<Member[]>`
        SELECT p.story_id, p.fact_id, p.source_id, p.article_id AS id, p.first_party, p.body_mode, p.score, p.timeline_at, p.sort_at FROM publications p
        WHERE p.fact_id IN ${sql(factIds)} AND ${ownFactEvidence()}
          AND ${entryCondition(q, now)} ${channelCondition(q.channel)} ${categoryCondition(q.category)} ${tagCondition(matchers)} ${topicCondition(matchers)} ${jurisdictionCondition(q.jurisdiction ?? null, q.jurisdictionCodes, q.jurisdictionRecipe ?? "", matchers)}`
      : Promise.resolve([] as Member[]),
    groupPool(q, now, factIds),
  ]);
  await attachRepresentativePriority(members);
  const groupFactIds = [...new Set([...members.map((m) => m.fact_id), ...pool.map((r) => r.fact_id)])];
  const factInfo = new Map(
    groupFactIds.length
      ? (await sql<{ id: number; public_id: string; title: string }[]>`SELECT id, public_id, title FROM facts WHERE id IN ${sql(groupFactIds)}`).map((f) => [
          f.id,
          f,
        ])
      : [],
  );

  const planned: Array<{ key: string; anchorAt: string; id: string; group: GroupInfo | null }> = [];
  for (const g of page) {
    if (g.gk.startsWith("a")) {
      planned.push({ key: g.gk, anchorAt: g.anchor_at.toISOString(), id: g.gk.slice(1), group: null });
      continue;
    }
    const factId = Number(g.gk.slice(1));
    const candidates = members.filter((member) => member.fact_id === factId);
    if (!candidates.length) continue;
    const rep = pickRepresentative(candidates);
    const reports = pool.filter((report) => report.fact_id === factId);
    const group: GroupInfo = {
      factId: factInfo.get(factId)?.public_id ?? String(factId),
      story: null,
      additionalSourceCount: new Set(reports.filter((report) => report.source_id !== rep.source_id).map((report) => report.source_id)).size,
      reportCount: new Set(reports.map((report) => report.article_id)).size,
      developmentCount: 1,
      latestDevelopment: null,
    };
    const showGroup = group.reportCount > 1;
    planned.push({ key: g.gk, anchorAt: g.anchor_at.toISOString(), id: rep.id, group: showGroup ? group : null });
  }

  // Recheck scope when hydrating: a withdrawal may commit after the narrow representative read.
  const rows = new Map(
    planned.length
      ? (
          await sql<ItemRow[]>`
    SELECT ${ITEM_COLUMNS()} ${ITEM_FROM()} WHERE p.article_id IN ${sql(planned.map((p) => p.id))}
      AND ${entryCondition(q, now)} ${channelCondition(q.channel)} ${categoryCondition(q.category)} ${tagCondition(matchers)} ${topicCondition(matchers)} ${jurisdictionCondition(q.jurisdiction ?? null, q.jurisdictionCodes, q.jurisdictionRecipe ?? "", matchers)}`
        ).map((row) => [row.id, row])
      : [],
  );
  const currentMembers = members.length
    ? await sql<{ id: string; fact_id: number }[]>`
    SELECT p.article_id AS id,p.fact_id FROM publications p WHERE p.article_id=ANY(${members.map((member) => member.id)}::text[])
      AND ${confirmedSelected()} AND ${entryCondition(q, now)} AND ${ownFactEvidence()} ${channelCondition(q.channel)} ${categoryCondition(q.category)} ${tagCondition(matchers)} ${topicCondition(matchers)} ${jurisdictionCondition(q.jurisdiction ?? null, q.jurisdictionCodes, q.jurisdictionRecipe ?? "", matchers)}`
    : [];
  await attachSourcePolicies([...rows.values()]);
  const cards: TimelineCard[] = planned.flatMap(({ id, key, anchorAt, group }) => {
    const row = rows.get(id);
    if (!row) return [];
    if (group) {
      group.story = row.story_public_id ? { publicId: row.story_public_id, title: row.story_title ?? "" } : null;
      group.memberIds = [...new Set(currentMembers.filter((member) => member.fact_id === row.fact_id).map((member) => member.id))];
    }
    return [{ key, anchorAt, item: toFeedItemSummary(row), group }];
  });

  // Day header counts for the days on this page, over the full grouped set.
  const days = new Set(page.map((g) => beijingDate(g.anchor_at)));
  const dayCounts: Record<string, number> = {};
  if (days.size) {
    for (const g of grouped) {
      const day = beijingDate(g.anchor);
      if (days.has(day)) dayCounts[day] = (dayCounts[day] ?? 0) + 1;
    }
  }

  const refreshAt = await refreshAtRead;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor("tl2", { a: last.anchor_at.getTime(), g: last.gk, b: bind }) : null;
  return {
    total: grouped.length,
    filters: { channel: q.channel, category: q.category, tag: q.tag, topic: q.topic ?? null, ...(q.jurisdiction ? { jurisdiction: q.jurisdiction } : {}) },
    cards,
    nextCursor,
    refreshAt,
    dayCounts,
  };
}

/** Earliest pending release in this scope; caches of this scope must expire by then. */
export async function nextRelease(q: TimelineQuery, now: Date): Promise<string | null> {
  q = { ...q, ...newsJurisdictionScope(q.jurisdiction) };
  const matchers = readMatcherValues(q.tag, q.topicTags, q.jurisdictionCodes?.length ? q.jurisdictionCodes : q.jurisdiction ? [q.jurisdiction] : [], []);
  const [row] = await sql<{ t: Date | null }[]>`
    SELECT min(p.visible_after) AS t FROM publications p
    WHERE p.visibility = 'public' AND p.selected AND p.visible_after > ${now} ${channelCondition(q.channel)} ${categoryCondition(q.category)} ${tagCondition(matchers)} ${topicCondition(matchers)} ${jurisdictionCondition(q.jurisdiction ?? null, q.jurisdictionCodes, q.jurisdictionRecipe ?? "", matchers)}`;
  return row?.t ? row.t.toISOString() : null;
}

// Policy HTTP composition uses this existing frozen publication entry.
export { listPolicies, policyScope, policyDetail, policyReading, policyHistory, policyThread, PolicyReadError } from "./policies.ts";
export { listPolicyReports, policyReport } from "./policies-reports.ts";
