// When each fact happened, kept per fact (package 2, step 2.5): the members' own date claims checked against their text
// (timing-rules.ts), and when the fact was first and last reported. Recomputed from the fact's current members on every
// observation, so a report that joins, leaves or is revised moves the answer; facts.occurred_at is never written. A
// claim already checked for the same revision, day and report time is reused, so only new members' texts are read.
// Written only here, by the shadow job and the event-order back-fill (events.fact_timing).
import { newsShadowMaterials } from "../../content/materials.ts";
import { sql, type Db } from "../../db.ts";
import { groupingFrames } from "../../enrichment/records.ts";
import { locallyReadable } from "./local-text.ts";
import { slicer } from "./recall.ts";
import { factTiming, type MemberClaim, memberClaim, type OccurredBasis } from "./timing-rules.ts";

/** Characters of a report's original text searched for its claimed day. */
export const TEXT_CHARS = 12_000;
/**
 * Bump when timing-rules.ts changes what counts as a checked day: stored checks of another ruleset, or of another length
 * of text searched, are not reused.
 */
export const TIMING_RULESET = `fact-timing-v1|text${TEXT_CHARS}`;
/** Members read per fact; a fact with more is beyond anything grouping produces, and is timed by its earliest members. */
export const FACT_MEMBER_LIMIT = 500;

export interface StoredClaim {
  rev: number;
  on: string | null;
  verified: boolean;
  at: string;
}
export interface FactTimingRow {
  factId: number;
  storyId: number | null;
  occurredOn: string | null;
  occurredBasis: OccurredBasis;
  claims: Record<string, StoredClaim>;
  firstReportedAt: Date;
  firstArticleId: string;
  lastReportedAt: Date;
  members: number;
  ruleset: string;
}
/** What the event order reads of a fact's timing. */
export interface FactTimingView {
  factId: number;
  storyId: number | null;
  occurredOn: string | null;
  occurredBasis: OccurredBasis;
  firstReportedAt: Date;
  /** The story's first report (stories.first_report_at). */
  storyFirstReportedAt: Date | null;
}

/** The live facts a report is a member of now. */
export async function articleFacts(articleId: string, db: Db = sql): Promise<number[]> {
  const rows = await db<{ fact_id: number }[]>`SELECT DISTINCT fa.fact_id FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id
    JOIN stories st ON st.id=f.story_id AND st.merged_into IS NULL WHERE fa.article_id=${articleId} AND fa.role IN ('primary','report')`;
  return rows.map((row) => row.fact_id);
}

async function storedTiming(factId: number, db: Db): Promise<FactTimingRow | null> {
  const [row] = await db<
    {
      story_id: number | null;
      occurred_on: string | null;
      occurred_basis: OccurredBasis;
      claims: Record<string, StoredClaim>;
      first_reported_at: Date;
      first_article_id: string;
      last_reported_at: Date;
      members: number;
      ruleset: string;
    }[]
  >`SELECT story_id,occurred_on::text AS occurred_on,occurred_basis,claims,first_reported_at,first_article_id,last_reported_at,members,ruleset
    FROM events.fact_timing WHERE fact_id=${factId}`;
  return row
    ? {
        factId,
        storyId: row.story_id,
        occurredOn: row.occurred_on,
        occurredBasis: row.occurred_basis,
        claims: row.claims,
        firstReportedAt: row.first_reported_at,
        firstArticleId: row.first_article_id,
        lastReportedAt: row.last_reported_at,
        members: row.members,
        ruleset: row.ruleset,
      }
    : null;
}

/** The fact's timing from its current members, reusing the checks of `stored`; null when it has no member left. */
export async function computeFactTiming(factId: number, stored: FactTimingRow | null, db: Db = sql): Promise<FactTimingRow | null> {
  const members = await db<{ article_id: string; story_id: number }[]>`SELECT fa.article_id,f.story_id FROM fact_articles fa
    JOIN facts f ON f.id=fa.fact_id JOIN stories st ON st.id=f.story_id AND st.merged_into IS NULL
    WHERE fa.fact_id=${factId} AND fa.role IN ('primary','report')
      AND (fa.manual OR NOT EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id=fa.article_id))
    ORDER BY fa.created_at,fa.article_id LIMIT ${FACT_MEMBER_LIMIT}`;
  if (!members.length) return null;
  const ids = members.map((m) => m.article_id);
  const materials = await newsShadowMaterials(ids, 0, db);
  const frames = await groupingFrames(ids, db);
  const frameOf = new Map(frames.map((f) => [f.article_id, f]));
  const reuse = stored?.ruleset === TIMING_RULESET ? stored.claims : {};
  const claims: MemberClaim[] = [];
  const unchecked: Array<{ articleId: string; revision: number; claim: string | null; reportedAt: Date }> = [];
  // Only the judgement of the member's current revision speaks for it.
  const claimOf = (m: (typeof materials)[number]) => {
    const frame = frameOf.get(m.id);
    return frame?.input_revision === m.revision ? frame.occurred_at : null;
  };
  // A claim is checked against the member's own text only while its source allows reading that text locally.
  const readable = await locallyReadable(
    materials.filter((m) => claimOf(m) !== null),
    db,
  );
  for (const m of materials) {
    const member = { articleId: m.id, revision: m.revision, claim: claimOf(m), reportedAt: m.published_at ?? m.discovered_at };
    const base = memberClaim({ ...member, text: "" });
    const kept = reuse[m.id];
    if (base.on === null || !readable.has(m.id)) claims.push(base);
    else if (kept && kept.rev === base.revision && kept.on === base.on && kept.at === base.at.toISOString()) claims.push({ ...base, verified: kept.verified });
    else unchecked.push(member);
  }
  // Checking a day in a 12,000-character text takes about half a millisecond: yield between members.
  const turn = slicer();
  for (let i = 0; i < unchecked.length; i += 50) {
    const part = unchecked.slice(i, i + 50);
    const texts = new Map(
      (
        await newsShadowMaterials(
          part.map((c) => c.articleId),
          TEXT_CHARS,
          db,
        )
      ).map((m) => [m.id, `${m.title}\n${m.body}`]),
    );
    for (const c of part) {
      claims.push(memberClaim({ ...c, text: texts.get(c.articleId) ?? "" }));
      await turn();
    }
  }
  const timing = factTiming(claims);
  if (!timing) return null;
  return {
    factId,
    storyId: members[0]!.story_id,
    occurredOn: timing.occurredOn,
    occurredBasis: timing.occurredBasis,
    claims: Object.fromEntries(
      [...claims]
        .sort((a, b) => a.articleId.localeCompare(b.articleId))
        .map((c) => [c.articleId, { rev: c.revision, on: c.on, verified: c.verified, at: c.at.toISOString() }]),
    ),
    firstReportedAt: timing.firstReportedAt,
    firstArticleId: timing.firstArticleId,
    lastReportedAt: timing.lastReportedAt,
    members: timing.members,
    ruleset: TIMING_RULESET,
  };
}

const sameTime = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);
/** Whether a change of timing can change another member's freshness (the fact's day, its basis, its first report). */
const orderMoves = (a: FactTimingRow, b: FactTimingRow) =>
  a.occurredOn !== b.occurredOn || a.occurredBasis !== b.occurredBasis || !sameTime(a.firstReportedAt, b.firstReportedAt) || a.storyId !== b.storyId;

/**
 * Recompute and store the timing of these facts. Returns the facts whose day, basis, first report or story moved (or
 * whose row appeared or went), whose other members the event order must look at again.
 */
export async function observeFactTiming(factIds: readonly number[], db: Db = sql): Promise<number[]> {
  const moved: number[] = [];
  for (const factId of [...new Set(factIds)].sort((a, b) => a - b)) {
    const stored = await storedTiming(factId, db);
    const next = await computeFactTiming(factId, stored, db);
    if (!next) {
      if (stored) {
        await db`DELETE FROM events.fact_timing WHERE fact_id=${factId}`;
        moved.push(factId);
      }
      continue;
    }
    if (
      stored &&
      !orderMoves(stored, next) &&
      stored.firstArticleId === next.firstArticleId &&
      sameTime(stored.lastReportedAt, next.lastReportedAt) &&
      stored.members === next.members &&
      stored.ruleset === next.ruleset &&
      JSON.stringify(stored.claims) === JSON.stringify(next.claims)
    )
      continue;
    await db`INSERT INTO events.fact_timing(lane,fact_id,story_id,occurred_on,occurred_basis,claims,first_reported_at,first_article_id,
        last_reported_at,members,ruleset)
      VALUES('news',${factId},${next.storyId},${next.occurredOn}::date,${next.occurredBasis},${db.json(next.claims as never)},${next.firstReportedAt},
        ${next.firstArticleId},${next.lastReportedAt},${next.members},${next.ruleset})
      ON CONFLICT(fact_id) DO UPDATE SET story_id=EXCLUDED.story_id,occurred_on=EXCLUDED.occurred_on,occurred_basis=EXCLUDED.occurred_basis,
        claims=EXCLUDED.claims,first_reported_at=EXCLUDED.first_reported_at,first_article_id=EXCLUDED.first_article_id,
        last_reported_at=EXCLUDED.last_reported_at,members=EXCLUDED.members,ruleset=EXCLUDED.ruleset,updated_at=pg_catalog.clock_timestamp()`;
    if (!stored || orderMoves(stored, next)) moved.push(factId);
  }
  return moved;
}

async function storyFirstReports(storyIds: number[], db: Db): Promise<Map<number, Date | null>> {
  if (!storyIds.length) return new Map();
  const rows = await db<{ id: number; first_report_at: Date | null }[]>`SELECT id,first_report_at FROM stories WHERE id=ANY(${storyIds}::bigint[])`;
  return new Map(rows.map((row) => [row.id, row.first_report_at]));
}

/** The stored timing of these facts as the event order reads it. */
export async function readFactTiming(factIds: readonly number[], db: Db = sql): Promise<FactTimingView[]> {
  if (!factIds.length) return [];
  const rows = await db<
    { fact_id: number; story_id: number | null; occurred_on: string | null; occurred_basis: OccurredBasis; first_reported_at: Date; story_first: Date | null }[]
  >`SELECT ft.fact_id,ft.story_id,ft.occurred_on::text AS occurred_on,ft.occurred_basis,ft.first_reported_at,st.first_report_at AS story_first
    FROM events.fact_timing ft LEFT JOIN stories st ON st.id=ft.story_id WHERE ft.fact_id=ANY(${[...factIds]}::bigint[])`;
  return rows.map((row) => ({
    factId: row.fact_id,
    storyId: row.story_id,
    occurredOn: row.occurred_on,
    occurredBasis: row.occurred_basis,
    firstReportedAt: row.first_reported_at,
    storyFirstReportedAt: row.story_first,
  }));
}

/** The timing these facts would get now, written nowhere (the back-fill's dry run). */
export async function previewFactTiming(factIds: readonly number[], db: Db = sql): Promise<Map<number, FactTimingView | null>> {
  const rows = new Map<number, FactTimingRow | null>();
  for (const factId of new Set(factIds)) rows.set(factId, await computeFactTiming(factId, await storedTiming(factId, db), db));
  const stories = await storyFirstReports([...new Set([...rows.values()].flatMap((row) => (row?.storyId == null ? [] : [row.storyId])))], db);
  return new Map(
    [...rows].map(([factId, row]) => [
      factId,
      row && {
        factId,
        storyId: row.storyId,
        occurredOn: row.occurredOn,
        occurredBasis: row.occurredBasis,
        firstReportedAt: row.firstReportedAt,
        storyFirstReportedAt: row.storyId === null ? null : (stories.get(row.storyId) ?? null),
      },
    ]),
  );
}
