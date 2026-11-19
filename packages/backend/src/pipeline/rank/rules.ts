// How the news line orders what it already selected, by rules alone (no model call, no database). Three defects the
// Owner saw drive it: a report about something that happened last month shown as the newest item; the daily issue
// leading with the same story three days running; the lead chosen by how many outlets carried a story.
//
// Nothing here changes what is selected, which items are main or flashes in a daily issue, the seats or
// publications.sort_at: callers apply these answers at read time, beside the stored order (design M, B5).
import { beijingDate, beijingMidnight } from "@amp/contracts/time";
import { ENTITIES } from "@amp/industry/taxonomy";
import { isCommentaryCategory } from "@amp/industry/mining-taxonomy";
import { documentKeys } from "../../events/relate.ts";
import { dayGap, type OccurredBasis } from "../events/timing-rules.ts";

/**
 * Start values, to be fixed from the production measurements (design M, G2). Each is part of RANK_RULESET, so a stored
 * row always says which values produced it.
 */
export const THRESHOLDS = {
  /** A report whose event day is more than this many days before its own Beijing day is old news. */
  oldGapDays: 4,
  /** Without an event day: the fact was first reported more than this long before this report. */
  lateReportHours: 72,
  /** The same source carried the same text at least this long before (re-collected under a new address). */
  recollectHours: 48,
  /** A fact that joined its story this long after the story's first report is a follow-up. */
  followUpHours: 6,
  /** A story counts as developed for a daily issue when its event day is no more than this many days before the issue date. */
  developedDays: 2,
  defaultScore: 50,
  officialBonus: 5,
  /** Tagged major miners, until the entity library gives each company its own weight. Small: the score already weighs the company. */
  entityBonus: 2,
  oldPenalty: 30,
  followUpPenalty: 12,
  /** How many earlier issues' leads an undeveloped story may not repeat. Two covers "three days running" and A, B, A. */
  leadMemory: 2,
} as const;

export const RANK_RULESET = `rank-v1:${Object.entries(THRESHOLDS)
  .map(([key, value]) => `${key}=${value}`)
  .join(",")}`;

export type FreshnessClass = "new" | "follow_up" | "old";
export type FreshnessBasis = "own_date" | "fact_date" | "late_report" | "recollected" | "no_evidence";
export type Genre = "report" | "official_release" | "commentary" | "roundup" | "document" | "post";

export interface FreshnessInput {
  /** When this report came out. */
  reportedAt: Date;
  /** This report's own claimed day, only when its text writes that day (timing-rules memberClaim().verified). */
  ownDate: string | null;
  /** The fact's day and how it is known (timing-rules factTiming()). */
  factDate: { on: string | null; basis: OccurredBasis } | null;
  /** The fact's first report. */
  firstReportedAt: Date | null;
  storyFirstReportedAt: Date | null;
  /** The earliest copy of the same text from the same source (see earlierCopy). */
  recollectedFrom: Date | null;
}
export interface Freshness {
  class: FreshnessClass;
  basis: FreshnessBasis;
  /** The event day the answer rests on, when it rests on one. */
  occurredOn: string | null;
}

const HOUR = 3_600_000;

/**
 * The earliest earlier copy of this report from its own source: the same text collected before under another address.
 * Another outlet carrying the same wire text is not a re-collection; it is a report of its own, and its age is judged
 * through the fact (late_report).
 */
export function earlierCopy(self: { sourceId: string; reportedAt: Date }, twins: ReadonlyArray<{ sourceId: string; reportedAt: Date }>): Date | null {
  const earlier = twins.filter((t) => t.sourceId === self.sourceId && t.reportedAt.getTime() < self.reportedAt.getTime()).map((t) => t.reportedAt.getTime());
  return earlier.length ? new Date(Math.min(...earlier)) : null;
}

/**
 * New, follow-up or old, first rule that applies wins:
 * 1. an earlier copy from the same source at least recollectHours before → old (recollected);
 * 2. a trusted event day more than oldGapDays before the report's Beijing day → old. Trusted means written in this
 *    report's own text, or the fact's day when it was found in a member's text or two members agree on it. A single
 *    unchecked claim never makes a report old by itself: it may be a background date or a period end;
 * 3. no trusted event day, and the fact was first reported more than lateReportHours before → old (late_report);
 * 4. the fact joined its story more than followUpHours after the story began → follow-up;
 * 5. otherwise new.
 * A fresh event day wins over an old first report (2 before 3): a new development of an old event is news.
 */
export function freshness(i: FreshnessInput, t = THRESHOLDS): Freshness {
  const reportedAt = i.reportedAt.getTime();
  if (i.recollectedFrom && reportedAt - i.recollectedFrom.getTime() >= t.recollectHours * HOUR) return { class: "old", basis: "recollected", occurredOn: null };
  const factTrusted = i.factDate?.on && (i.factDate.basis === "verified" || i.factDate.basis === "agreed") ? i.factDate.on : null;
  const occurredOn = i.ownDate ?? factTrusted;
  const dated = occurredOn ? (i.ownDate ? "own_date" : "fact_date") : null;
  if (occurredOn && dated) {
    if (dayGap(beijingDate(i.reportedAt), occurredOn) > t.oldGapDays) return { class: "old", basis: dated, occurredOn };
  } else if (i.firstReportedAt && reportedAt - i.firstReportedAt.getTime() > t.lateReportHours * HOUR)
    return { class: "old", basis: "late_report", occurredOn: null };
  const basis = dated ?? "no_evidence";
  if (i.firstReportedAt && i.storyFirstReportedAt && i.firstReportedAt.getTime() - i.storyFirstReportedAt.getTime() > t.followUpHours * HOUR)
    return { class: "follow_up", basis, occurredOn };
  return { class: "new", basis, occurredOn };
}

/**
 * Where an old report is filed in a time-ordered list: on its event day (a Beijing midnight, which every page reads as
 * a date alone), else when the fact was first reported, else when the same source first carried it. Null for new and
 * follow-up reports, which keep their own place. Never later than the report's own list time, so the rule can only
 * move a report back, never forward.
 */
export function rankAnchor(f: Freshness, i: FreshnessInput, timelineAt: Date): Date | null {
  if (f.class !== "old") return null;
  const anchor =
    f.basis === "recollected" ? i.recollectedFrom : f.occurredOn ? beijingMidnight(f.occurredOn) : f.basis === "late_report" ? i.firstReportedAt : null;
  if (!anchor) return null;
  return anchor.getTime() < timelineAt.getTime() ? anchor : timelineAt;
}

/**
 * A card's place in a time-ordered list. Today it is its earliest member's time; with the event order, old members
 * do not count while the card has a member that is not old, so one old copy cannot drag a fresh card back to last
 * month. Only a card whose members are all old moves to their (earliest) event time. `rankAnchor` is null for a
 * member that is not old, or whose rank row the reader may not use yet.
 */
export function cardAnchor(members: ReadonlyArray<{ sortAt: Date; rankAnchor: Date | null }>): number {
  if (!members.length) throw new Error("A card has at least one member");
  const current = members.filter((m) => m.rankAnchor === null);
  return current.length ? Math.min(...current.map((m) => m.sortAt.getTime())) : Math.min(...members.map((m) => m.rankAnchor!.getTime()));
}

const MAJOR_TAGS = new Set(Object.values(ENTITIES).flatMap((e) => (e.displayTag ? [e.displayTag] : [])));

export interface ImportanceInputs {
  score: number;
  official: number;
  entity: number;
  novelty: number;
}

/**
 * How much an item matters to a reader of the issue: its score, plus a little for an official release and for a tagged
 * major miner, minus a lot for old news. How many outlets carried it is deliberately not an input: wire copies made a
 * routine story outrank a policy change carried by one outlet. Outlet counts stay a displayed number only.
 */
export function importance(
  i: { score: number | null; representativePriority: number; tags: readonly string[]; freshness: FreshnessClass },
  t = THRESHOLDS,
): { value: number; inputs: ImportanceInputs } {
  const inputs = {
    score: i.score ?? t.defaultScore,
    // The same test the daily issue uses for an official representative (reports/edition.ts).
    official: i.representativePriority < 3 ? t.officialBonus : 0,
    entity: i.tags.some((tag) => MAJOR_TAGS.has(tag)) ? t.entityBonus : 0,
    novelty: i.freshness === "old" ? -t.oldPenalty : 0,
  };
  return { value: Math.round((inputs.score + inputs.official + inputs.entity + inputs.novelty) * 100) / 100, inputs };
}

/**
 * What kind of piece an item is, from data already stored, first match wins. Kept apart from the topic (the
 * category), which it does not change.
 */
export function genreOf(i: {
  xPost: boolean;
  scope: string | null;
  category: string | null;
  authorRole: string | null;
  title: string;
  representativePriority: number;
}): Genre {
  if (i.xPost) return "post";
  if (i.scope === "composite") return "roundup";
  if (isCommentaryCategory(i.category) || i.authorRole === "observer") return "commentary";
  if (documentKeys([i.title]).length) return "document";
  if (i.representativePriority < 3) return "official_release";
  return "report";
}

/** The item's topic: its category, except the commentary class, which says what kind of piece it is rather than what about. */
export function topicOf(category: string | null): string | null {
  return category && !isCommentaryCategory(category) ? category : null;
}

/**
 * Whether a story moved since the last issue: its fact in this issue was first reported inside the issue's window (a
 * new fact), or its event day is recent. Most development reports state no date, so the first test carries most cases.
 */
export function developed(
  i: { factFirstReportedAt: Date | null; occurredOn: string | null; windowStart: Date; windowEnd: Date; issueDate: string },
  t = THRESHOLDS,
): boolean {
  const first = i.factFirstReportedAt?.getTime();
  if (first !== undefined && first >= i.windowStart.getTime() && first < i.windowEnd.getTime()) return true;
  return i.occurredOn !== null && dayGap(i.issueDate, i.occurredOn) <= t.developedDays;
}

export interface LeadCandidate {
  id: string;
  /** The story the item belongs to (its public id), else the item itself: two items of one story share a key. */
  key: string;
  importance: number;
  freshness: FreshnessClass;
  /** A later report of an event an earlier issue already covered. */
  followUp: boolean;
  developed: boolean;
}

/**
 * The order an issue's main items are read in; the first is the lead. Old news goes last while anything else exists; a
 * story that led one of the last issues goes after the rest unless it developed; then importance, less the follow-up
 * penalty for a follow-up that did not develop; ties by id so the answer is stable. Nothing is dropped: an issue whose
 * only item is yesterday's lead still leads with it.
 */
export function issueOrder(c: readonly LeadCandidate[], recentLeads: readonly string[], t = THRESHOLDS): string[] {
  const barred = new Set(recentLeads.slice(0, t.leadMemory));
  const late = (x: LeadCandidate) => (x.freshness === "old" ? 2 : 0) + (barred.has(x.key) && !x.developed ? 1 : 0);
  const weight = (x: LeadCandidate) => x.importance - (x.followUp && !x.developed ? t.followUpPenalty : 0);
  return [...c].sort((a, b) => late(a) - late(b) || weight(b) - weight(a) || a.id.localeCompare(b.id)).map((x) => x.id);
}

/** The lead of an issue (issueOrder's first item). */
export function leadOf(c: readonly LeadCandidate[], recentLeads: readonly string[], t = THRESHOLDS): string {
  const [lead] = issueOrder(c, recentLeads, t);
  if (lead === undefined) throw new Error("An issue without items has no lead");
  return lead;
}

/** The fields of a stored hot-board entry the event order reads and rewrites (events/hot-read.ts HotEntry). */
export interface HotEntryShape {
  rank: number;
  storyId: number;
  representativeItemId: string | null;
  representativeUrl: string | null;
  representativeSource: string | null;
}

/**
 * The hot board with the event order: stories with no fresh fact in the ranking's window go below the others; heat
 * order is kept inside each group and ranks are renumbered. Heat itself is not touched. A fresh story is represented
 * by its latest fresh report instead of the one with most outlets; its link and source are then cleared for the read
 * side to fill from that item. A story the map does not know keeps its place: no evidence is not staleness.
 */
export function eventAwareHot<E extends HotEntryShape>(
  entries: readonly E[],
  stories: ReadonlyMap<number, { fresh: boolean; latestFreshArticleId: string | null }>,
): E[] {
  const ordered = [...entries].sort((a, b) => a.rank - b.rank);
  const stale = (e: E) => stories.get(e.storyId)?.fresh === false;
  return [...ordered.filter((e) => !stale(e)), ...ordered.filter(stale)].map((entry, index) => {
    const latest = stories.get(entry.storyId)?.latestFreshArticleId ?? null;
    return latest && latest !== entry.representativeItemId
      ? { ...entry, rank: index + 1, representativeItemId: latest, representativeUrl: null, representativeSource: null }
      : { ...entry, rank: index + 1 };
  });
}
