import { readMatcherValues } from "./mentions.ts";
// Reading-group expansions: the reports behind "另有 N 家信源报道" and the developments behind
// "展开 N 条进展". Members must pass the same visibility, pool eligibility and parent-page filters.
import type { CategoryKey, ChannelKey } from "@amp/contracts/taxonomy";
import type { DevelopmentsResponse, GroupReportsResponse } from "@amp/contracts/site";
import { dbOf } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import { shortHash } from "../lib/ids.ts";
import {
  ITEM_COLUMNS,
  ITEM_FROM,
  categoryCondition,
  channelCondition,
  selectedCondition,
  listedCondition,
  tagCondition,
  toItemSummary,
  topicCondition,
  type ItemRow,
} from "./items.ts";
import { attachRepresentativeIdentity, pickRepresentative } from "./representative.ts";

const sql = dbOf("publication");

export interface GroupReportsQuery {
  factPublicId: string;
  channel: ChannelKey;
  category: CategoryKey | null;
  tag: string | null;
  topicTags: string[] | null;
  cursor: string | null;
  take: number;
  revision: string | null;
}

export type GroupReportsResult = { kind: "ok"; body: GroupReportsResponse } | { kind: "not_found" } | { kind: "changed" };

export async function loadGroupReports(q: GroupReportsQuery, now = new Date()): Promise<GroupReportsResult> {
  const [fact] = await sql<{ id: number }[]>`SELECT id FROM facts WHERE public_id = ${q.factPublicId}`;
  if (!fact) return { kind: "not_found" };
  const matchers = readMatcherValues(q.tag, q.topicTags, [], []);
  const filters = sql`${channelCondition(q.channel)} ${categoryCondition(q.category)} ${tagCondition(matchers)} ${topicCondition(matchers)}`;
  const members = await sql<
    {
      id: string;
      title: string;
      summary: string | null;
      timeline_at: Date;
      url: string;
      selected: boolean;
      source_id: string;
      source_name: string;
      source_kind: string;
      first_party: boolean;
    }[]
  >`
    SELECT p.article_id AS id, p.title, coalesce(p.summary, CASE WHEN s.site_fulltext THEN p.source_excerpt END) AS summary, p.timeline_at, p.url, p.selected,
           s.id AS source_id, s.name AS source_name, s.kind AS source_kind, p.first_party
    FROM publications p JOIN sources s ON s.id = p.source_id
    WHERE p.article_id IN (SELECT article_id FROM fact_articles WHERE fact_id = ${fact.id}) AND p.visibility = 'public' AND p.eligible
      AND (NOT p.selected OR p.visible_after <= ${now}) ${filters}
    ORDER BY p.timeline_at DESC, p.article_id ASC`;
  if (members.length === 0) return { kind: "not_found" };

  // The revision covers the actual member set; a cursor from another revision means "reload".
  const revision = shortHash(members.map((m) => m.id).join(","), 10);
  const binding = queryBinding({ f: q.factPublicId, c: q.channel, k: q.category, t: q.tag, p: q.topicTags });
  let offset = 0;
  if (q.cursor) {
    const c = decodeCursor<{ o: number; r: string; b: string }>("gr1", q.cursor);
    if (c.b !== binding) throw new InvalidCursorError("cursor does not match this group query");
    if (c.r !== revision) return { kind: "changed" };
    offset = c.o;
  } else if (q.revision && q.revision !== revision) {
    return { kind: "changed" };
  }
  const page = members.slice(offset, offset + q.take);
  const next = offset + q.take < members.length ? encodeCursor("gr1", { o: offset + q.take, r: revision, b: binding }) : null;
  return {
    kind: "ok",
    body: {
      factId: q.factPublicId,
      revision,
      reports: page.map((m) => ({
        id: m.id,
        title: m.title,
        summary: m.summary,
        source: { id: m.source_id, name: m.source_name, kind: m.source_kind as never, firstParty: m.first_party },
        timelineAt: m.timeline_at.toISOString(),
        originalUrl: m.url,
        selected: m.selected,
      })),
      nextCursor: next,
    },
  };
}

export interface DevelopmentsQuery {
  scope?: "all" | "selected";
  storyPublicId: string;
  channel: ChannelKey;
  category: CategoryKey | null;
  tag: string | null;
  topicTags: string[] | null;
  cursor: string | null;
  take: number;
  revision: string | null;
}

export type DevelopmentsResult = { kind: "ok"; body: DevelopmentsResponse } | { kind: "not_found" } | { kind: "changed" };

/**
 * The developments of a story's reading group: its facts with a selected report under the parent
 * page's filters, latest first, each with its first-party pick and its public report count.
 */
export async function loadDevelopments(q: DevelopmentsQuery, now = new Date()): Promise<DevelopmentsResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q.storyPublicId)) return { kind: "not_found" };
  const [story] = await sql<{ id: number; public_id: string; title: string }[]>`
    SELECT id, public_id::text, title FROM stories WHERE public_id = ${q.storyPublicId} AND merged_into IS NULL`;
  if (!story) return { kind: "not_found" };
  const matchers = readMatcherValues(q.tag, q.topicTags, [], []);
  const filters = sql`${channelCondition(q.channel)} ${categoryCondition(q.category)} ${tagCondition(matchers)} ${topicCondition(matchers)}`;
  type Member = Pick<ItemRow, "source_id" | "id" | "fact_id" | "first_party" | "body_mode" | "score" | "timeline_at" | "sort_at">;
  const scope = q.scope === "all" ? sql`${listedCondition(now)} AND p.eligible` : selectedCondition(now);
  const selected = await sql<Member[]>`
    SELECT p.article_id AS id, p.source_id, p.fact_id, p.first_party, p.body_mode, p.score, p.timeline_at, p.sort_at
    FROM publications p WHERE p.story_id = ${story.id} AND ${scope} ${filters}`;
  if (selected.length === 0) return { kind: "not_found" };
  const counts = new Map(
    (
      await sql<{ fact_id: number; n: number }[]>`
      SELECT fa.fact_id, count(DISTINCT p.article_id)::int AS n
      FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      WHERE f.story_id = ${story.id} AND p.visibility = 'public' AND p.eligible AND (NOT p.selected OR p.visible_after <= ${now}) ${filters}
      GROUP BY fa.fact_id`
    ).map((c) => [c.fact_id, c.n]),
  );
  await attachRepresentativeIdentity(selected);
  const byFact = new Map<number, Member[]>();
  for (const r of selected) if (r.fact_id !== null) byFact.set(r.fact_id, [...(byFact.get(r.fact_id) ?? []), r]);
  if (byFact.size === 0) return { kind: "not_found" };
  const facts = await sql<{ id: number; public_id: string; title: string; occurred_at: Date | null }[]>`
    SELECT id, public_id, title, occurred_at FROM facts WHERE id IN ${sql([...byFact.keys()])}`;
  const list = facts
    .map((f) => {
      const rows = byFact.get(f.id)!;
      const rep = pickRepresentative(rows);
      return {
        first: Math.min(...rows.map((r) => (r.sort_at ?? r.timeline_at).getTime())),
        development: {
          factId: f.public_id,
          title: f.title,
          occurredAt: f.occurred_at?.toISOString() ?? null,
          representativeId: rep.id,
          reportCount: counts.get(f.id) ?? rows.length,
        },
      };
    })
    .sort((a, b) => b.first - a.first || a.development.factId.localeCompare(b.development.factId))
    .map((d) => d.development);

  const revision = shortHash(list.map((d) => `${d.factId}:${d.representativeId}:${d.reportCount}`).join(","), 10);
  const binding = queryBinding({ scope: q.scope ?? "selected", s: q.storyPublicId, c: q.channel, k: q.category, t: q.tag, p: q.topicTags });
  let offset = 0;
  if (q.cursor) {
    const c = decodeCursor<{ o: number; r: string; b: string }>("dv1", q.cursor);
    if (c.b !== binding) throw new InvalidCursorError("cursor does not match this group query");
    if (c.r !== revision) return { kind: "changed" };
    offset = c.o;
  } else if (q.revision && q.revision !== revision) {
    return { kind: "changed" };
  }
  const next = offset + q.take < list.length ? encodeCursor("dv1", { o: offset + q.take, r: revision, b: binding }) : null;
  const page = list.slice(offset, offset + q.take);
  const rows = new Map(
    page.length
      ? (
          await sql<ItemRow[]>`
    SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN ${sql(page.map((d) => d.representativeId))}
      AND p.story_id = ${story.id} AND ${scope} ${filters}`
        ).map((row) => [row.id, row])
      : [],
  );
  if (rows.size !== page.length) return { kind: "changed" };
  const developments = page.flatMap(({ representativeId, ...development }) => {
    const row = rows.get(representativeId);
    return row ? [{ ...development, representative: toItemSummary(row) }] : [];
  });
  return {
    kind: "ok",
    body: { story: { publicId: story.public_id, title: story.title }, revision, developments, nextCursor: next },
  };
}

/** The published report-candidate snapshot owns the existing release lock and time-window query. */
export async function reportCandidateRows(start: Date, end: Date) {
  return sql.begin("isolation level read committed", async (tx) => {
    // Wait for in-flight releases and keep later ones outside this snapshot. The following SELECT
    // gets a fresh READ COMMITTED snapshot; model calls and report writes happen after the lock ends.
    await tx`SELECT pg_advisory_xact_lock(hashtext('report_candidates'))`;
    const rows = await tx<
      {
        id: string;
        revision: number;
        fact_id: number | null;
        timeline_at: Date;
        body_mode: string;
        title: string;
        summary: string | null;
        url: string;
        category: string | null;
        score: number | null;
        first_party: boolean;
        source_id: string;
        source_name: string;
        source_kind: string;
        fact_public_id: string | null;
        story_public_id: string | null;
        at: Date;
        backfill: boolean;
      }[]
    >`
      SELECT p.article_id AS id,p.revision,p.fact_id,p.timeline_at,p.body_mode, p.title, p.summary, p.url, p.category, p.score, p.first_party, s.id AS source_id, s.name AS source_name,
             s.kind AS source_kind, f.public_id AS fact_public_id, st.public_id::text AS story_public_id, p.timeline_at AS at, p.backfill
      FROM publications p JOIN sources s ON s.id = p.source_id
      LEFT JOIN facts f ON f.id = p.fact_id LEFT JOIN stories st ON st.id = f.story_id
      -- Attribute each item by the later of arrival and release; either range can use its index.
      WHERE p.visibility = 'public' AND p.selected AND NOT p.backfill
        AND (
          (p.visible_after <= p.timeline_at AND p.timeline_at >= ${start} AND p.timeline_at < ${end})
          OR (p.visible_after > p.timeline_at AND p.visible_after >= ${start} AND p.visible_after < ${end})
        )`;
    const identified = await attachRepresentativeIdentity(rows, tx);
    const facts = new Map<string, typeof identified>();
    for (const row of identified) {
      const key = row.fact_public_id ?? `article:${row.id}`;
      facts.set(key, [...(facts.get(key) ?? []), row]);
    }
    return [...facts.values()].map((members) => pickRepresentative(members));
  });
}

/** A scored public report proves judging ran; ordinary news is counted here, never included in the daily. */
export async function dailyJudgedReportCount(start: Date, end: Date): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM publications p JOIN sources s ON s.id=p.source_id
    WHERE p.visibility='public' AND p.eligible AND p.channel='news' AND s.lane='news'
      AND s.participation_mode='editorial' AND p.score IS NOT NULL AND NOT p.backfill
      AND (NOT p.selected OR p.visible_after <= ${end})
      AND p.timeline_at >= ${start} AND p.timeline_at < ${end}
      AND (p.first_public_at IS NULL OR p.first_public_at < ${end})`;
  return row!.n;
}
