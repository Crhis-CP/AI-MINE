import type { ReportGroupInfo, ReportGroupedTimelineCard, ReportGroupReportsResponse } from "@amp/contracts/site";
import type { PoolQuery } from "./pool.ts";
import { beijingDate } from "@amp/contracts/time";
import { sql, type Db } from "../db.ts";
import { readerAnchor } from "./source-time.ts";
import { queryBinding, decodeCursor, encodeCursor, InvalidCursorError } from "../lib/cursor.ts";
import { shortHash } from "../lib/ids.ts";
import { withSearchCapacity } from "./pool.ts";
import { fetchItemsByIds, publicTimeMetadata, toFeedItemSummary } from "./items.ts";
import { readReportReadingRows } from "./groups.ts";
import { pickRepresentative, type RepresentativeRow } from "./representative.ts";
import { loadTimelineFactGroups } from "./timeline.ts";
import { currentReportMemberships } from "./report-groups.ts";
import { loadStoryProgress } from "./story-progress.ts";
import { readStoryReportLines, storyLine } from "./stories.ts";

export interface ReadingGroupQuery extends PoolQuery {
  scope?: "all" | "selected";
  featuredSince?: Date;
  cursor?: string | null;
  offset?: number;
  limit?: number;
  reportGroupId?: string;
  revision?: string | null;
  take?: number;
}
export interface ReadingRow extends RepresentativeRow {
  id: string;
  revision: number;
  source_id: string;
  sort_at: Date;
  fact_id: number | null;
  fact_public_id: string | null;
  story_id: number | null;
  own_fact: boolean;
  foldable: boolean;
  rel: number;
  tie: number;
}
interface Plan {
  key: string;
  anchor: number;
  members: ReadingRow[];
  representative: ReadingRow;
  reportGroup: ReportGroupInfo | null;
  /** A story's folded event card: every fact it stands for and how many developments they are. */
  story?: StoryFold;
}
export interface StoryFold {
  factIds: number[];
  developmentCount: number;
}

/** 精选 lists events: once per event (PG-02), a search keeps its matching reports apart. */
function foldsStories(q: ReadingGroupQuery) {
  return (q.scope === "selected" || !!q.selected) && !q.q?.trim();
}

/**
 * One card per story (PG-02 "同一事件在页上只出现一次"): the fact cards of a story fold into one card of its newest
 * development, placed where that development first appeared; the older ones open under it ("展开 N 条进展"). Facts
 * that the story page counts as one development (copies of one report, storyLine) are one development here too.
 * Display only: which facts and stories exist, and what is selected, is unchanged.
 */
async function foldStories(list: Plan[], now: Date, db: Db): Promise<Plan[]> {
  const byStory = new Map<number, Plan[]>();
  for (const plan of list) {
    const story = plan.key.startsWith("f") ? plan.representative.story_id : null;
    if (story !== null && story !== undefined) byStory.set(Number(story), [...(byStory.get(Number(story)) ?? []), plan]);
  }
  const stories = [...byStory].filter(([, plans]) => plans.length > 1);
  if (!stories.length) return list;
  const lines = await readStoryReportLines(
    stories.map(([id]) => id),
    now,
    db,
  );
  const replaced = new Map<Plan, Plan | null>();
  for (const [id, plans] of stories) {
    const line = storyLine(lines.filter((r) => Number(r.story_id) === id));
    const factOf = (plan: Plan) => Number(plan.key.slice(1));
    // A fact the story page does not list (no public editorial report) is its own development, ranked below the listed ones.
    const step = (plan: Plan) => line.developmentOfFact.get(factOf(plan)) ?? -1;
    const development = (plan: Plan) => (step(plan) < 0 ? `x${factOf(plan)}` : `d${step(plan)}`);
    const newest = development([...plans].sort((a, b) => step(b) - step(a) || b.anchor - a.anchor || b.key.localeCompare(a.key))[0]!);
    const current = plans.filter((plan) => development(plan) === newest).sort((a, b) => a.anchor - b.anchor || a.key.localeCompare(b.key));
    const card: Plan = {
      key: current[0]!.key,
      anchor: current[0]!.anchor,
      members: plans.flatMap((plan) => plan.members),
      representative: pickRepresentative(current.flatMap((plan) => plan.members)),
      reportGroup: null,
      story: { factIds: plans.map(factOf), developmentCount: new Set(plans.map(development)).size },
    };
    for (const plan of plans) replaced.set(plan, plan === current[0] ? card : null);
  }
  return list.flatMap((plan) => {
    const next = replaced.get(plan);
    return next === undefined ? [plan] : next ? [next] : [];
  });
}

function reportInfo(id: string, members: ReadingRow[], representative: ReadingRow): ReportGroupInfo {
  return {
    id,
    memberIds: members.map((m) => m.id).sort(),
    reportCount: members.length,
    additionalSourceCount: new Set(members.filter((m) => m.source_id !== representative.source_id).map((m) => m.source_id)).size,
  };
}
async function plans(q: ReadingGroupQuery, now: Date, db: Db) {
  const rows = await readReportReadingRows(q, now, db),
    membership = await currentReportMemberships(
      rows.map((r) => r.id),
      db,
      now,
    );
  const grouped = new Map<string, ReadingRow[]>();
  for (const row of rows) {
    const groupId = row.foldable && !row.own_fact ? membership.get(row.id)?.groupId : null;
    const key = groupId ? `r${groupId}` : row.foldable && row.own_fact && row.fact_id !== null ? `f${row.fact_id}` : `a${row.id}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  let list: Plan[] = [...grouped].map(([key, members]) => {
    const representative = pickRepresentative(members);
    return {
      key,
      anchor: Math.min(...members.map((m) => m.sort_at.getTime())),
      members,
      representative,
      reportGroup: key.startsWith("r") && members.length > 1 ? reportInfo(key.slice(1), members, representative) : null,
    };
  });
  if (foldsStories(q)) list = await foldStories(list, now, db);
  list.sort(
    (a, b) =>
      (q.q && q.tab === "relevance"
        ? Math.max(...b.members.map((m) => m.rel)) - Math.max(...a.members.map((m) => m.rel)) ||
          Math.max(...b.members.map((m) => m.tie)) - Math.max(...a.members.map((m) => m.tie))
        : 0) ||
      b.anchor - a.anchor ||
      b.key.localeCompare(a.key),
  );
  const revision = shortHash(list.map((g) => [g.key, ...g.members.map((m) => `${m.id}:${m.revision}`)].join(",")).join("|"), 16);
  return { list, revision, reportTotal: rows.length };
}
function binding(q: ReadingGroupQuery) {
  const { now: _now, cursor: _cursor, offset: _offset, limit: _limit, page: _page, revision: _revision, take: _take, ...filters } = q;
  return queryBinding({ ...filters, readingGroups: "reports-v1" });
}

export async function loadReportGroupedPage(q: ReadingGroupQuery, now: Date, db: Db = sql) {
  const read = async (db: Db) => {
    const { list, revision, reportTotal } = await plans(q, now, db),
      bind = binding(q);
    let offset = q.offset ?? 0;
    if (q.cursor) {
      const cursor = decodeCursor<{ o: number; b: string; r: string }>("rg1", q.cursor);
      if (cursor.b !== bind || cursor.r !== revision || !Number.isSafeInteger(cursor.o) || cursor.o < 0)
        throw new InvalidCursorError("reading groups changed or cursor does not match this query");
      offset = cursor.o;
    }
    const limit = Math.max(1, Math.min(q.limit ?? 20, 40)),
      page = list.slice(offset, offset + limit);
    const rows = await fetchItemsByIds(
      page.map((g) => g.representative.id),
      db,
    );
    const facts = page.filter((g) => g.key.startsWith("f"));
    const factGroups = await loadTimelineFactGroups(
      q,
      now,
      facts.flatMap((g) => (rows.get(g.representative.id) ? [rows.get(g.representative.id)!] : [])),
      facts.flatMap((g) => g.members.map((member) => member.id)),
      db,
      new Map(facts.flatMap((g) => (g.story ? [[g.representative.id, g.story] as const] : []))),
    );
    const progress = await loadStoryProgress([...rows.values()], now, db);
    const cards: ReportGroupedTimelineCard[] = page.flatMap((g) => {
      const row = rows.get(g.representative.id);
      if (!row) return [];
      const storyProgress = progress.get(row.id);
      return [
        {
          key: g.key,
          anchorAt: readerAnchor(new Date(g.anchor), row.published_at, row.source_time).toISOString(),
          item: toFeedItemSummary(row),
          group: factGroups.get(row.id) ?? null,
          ...(g.reportGroup ? { reportGroup: g.reportGroup } : {}),
          ...(storyProgress ? { storyProgress } : {}),
        },
      ];
    });
    const dayCounts: Record<string, number> = {};
    for (const g of list) {
      const day = beijingDate(g.anchor);
      dayCounts[day] = (dayCounts[day] ?? 0) + 1;
    }
    return {
      cards,
      total: list.length,
      reportTotal,
      dayCounts,
      nextCursor: offset + limit < list.length ? encodeCursor("rg1", { o: offset + limit, b: bind, r: revision }) : null,
    };
  };
  return db === sql ? sql.begin("isolation level repeatable read read only", read) : read(db);
}

export interface ReportGroupReportsInput extends ReadingGroupQuery {
  reportGroupId: string;
  take: number;
  revision: string | null;
}
export type ReportGroupReportsResult = { kind: "ok"; body: ReportGroupReportsResponse } | { kind: "not_found" } | { kind: "changed" };
export async function loadReportGroupReports(q: ReportGroupReportsInput, now = new Date()): Promise<ReportGroupReportsResult> {
  const read = async (db: Db): Promise<ReportGroupReportsResult> => {
    const { list } = await plans(q, now, db),
      group = list.find((g) => g.key === `r${q.reportGroupId}`);
    if (!group) return { kind: "not_found" };
    const members = [...group.members].sort((a, b) => b.timeline_at.getTime() - a.timeline_at.getTime() || a.id.localeCompare(b.id));
    const revision = shortHash(members.map((m) => `${m.id}:${m.revision}`).join(","), 16),
      bind = binding({ ...q, revision: null });
    let offset = 0;
    if (q.cursor) {
      const c = decodeCursor<{ o: number; b: string; r: string }>("rgr1", q.cursor);
      if (c.b !== bind || !Number.isSafeInteger(c.o) || c.o < 0) throw new InvalidCursorError("cursor does not match this reading group");
      if (c.r !== revision) return { kind: "changed" };
      offset = c.o;
    } else if (q.revision && q.revision !== revision) return { kind: "changed" };
    const take = Math.max(1, Math.min(q.take, 40)),
      page = members.slice(offset, offset + take),
      rows = await fetchItemsByIds(
        page.map((m) => m.id),
        db,
      ),
      dates = await publicTimeMetadata(
        page.map((m) => m.id),
        db,
      );
    return {
      kind: "ok",
      body: {
        reportGroupId: q.reportGroupId,
        revision,
        reports: page.flatMap((m) => {
          const r = rows.get(m.id);
          return r
            ? [
                {
                  id: r.id,
                  title: r.title,
                  summary: r.summary,
                  source: { id: r.source_id, name: r.source_name, kind: r.source_kind, firstParty: r.first_party },
                  timelineAt: r.timeline_at.toISOString(),
                  sourceTime: dates.get(r.id)?.sourceTime ?? null,
                  originalUrl: r.url,
                  selected: r.selected,
                },
              ]
            : [];
        }),
        nextCursor: offset + take < members.length ? encodeCursor("rgr1", { o: offset + take, b: bind, r: revision }) : null,
      },
    };
  };
  return q.q ? withSearchCapacity(read) : sql.begin("isolation level repeatable read read only", read);
}
export async function readItemReportGroup(articleId: string, now = new Date()): Promise<ReportGroupInfo | null> {
  return sql.begin("isolation level repeatable read read only", async (db) => {
    const member = (await currentReportMemberships([articleId], db, now)).get(articleId);
    if (!member) return null;
    const { list } = await plans({ channel: "all", category: null, tag: null, scope: "all", reportGroupId: member.groupId }, now, db);
    const group = list.find((g) => g.key === `r${member.groupId}`),
      own = group?.members.find((r) => r.id === articleId);
    return group && own && group.members.length > 1 ? reportInfo(member.groupId, group.members, own) : null;
  });
}
