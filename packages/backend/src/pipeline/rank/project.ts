// The event order of public news (package 2, step 2.5), projected into publication.event_rank: whether a report is
// new, a follow-up or old news, the day an old report would be filed under, and an importance that leaves outlet counts
// out (rules.ts). One row per public, eligible publication; a publication that is no longer public loses its row.
// Written only by worker jobs (the event shadow's job and the back-fill), never inside publishArticleTx (review of design
// M, F1): seats, sort_at, the selected ledger and the stored issues are neither read for a decision nor written here,
// and no reader request reads this table yet.
import { newsDuplicateProbes, newsShadowMaterials } from "../../content/materials.ts";
import { sql, type Db } from "../../db.ts";
import { groupingFrames } from "../../enrichment/records.ts";
import { locallyReadable } from "../events/local-text.ts";
import { memberClaim } from "../events/timing-rules.ts";
import { type FactTimingView, observeFactTiming, previewFactTiming, readFactTiming, TEXT_CHARS } from "../events/timing.ts";
import {
  earlierCopy,
  type FreshnessBasis,
  type FreshnessClass,
  freshness,
  type Genre,
  genreOf,
  type ImportanceInputs,
  importance,
  RANK_RULESET,
  rankAnchor,
  topicOf,
} from "./rules.ts";

/** Earlier copies looked at per report (the same address or stored hash; the same source decides). */
const TWIN_LIMIT = 50;

export interface EventRankRow {
  articleId: string;
  articleRevision: number;
  factId: number | null;
  storyId: number | null;
  reportedAt: Date;
  freshness: FreshnessClass;
  freshnessBasis: FreshnessBasis;
  occurredOn: string | null;
  anchorAt: Date | null;
  importance: number;
  importanceInputs: ImportanceInputs;
  genre: Genre;
  topic: string | null;
  ruleset: string;
}

/**
 * The row a publication gets now, or null when it is not public and eligible. `timing` stands in for the stored fact
 * timing (the back-fill's dry run); without it the stored timing is read.
 */
export async function computeEventRank(articleId: string, db: Db = sql, timing?: ReadonlyMap<number, FactTimingView | null>): Promise<EventRankRow | null> {
  const [p] = await db<
    {
      visibility: string;
      eligible: boolean;
      operator_withdrawn: boolean;
      post: boolean;
      title: string;
      category: string | null;
      tags: string[];
      score: number | null;
      representative_priority: number;
      timeline_at: Date;
      fact_id: number | null;
      story_id: number | null;
    }[]
  >`SELECT visibility,eligible,operator_withdrawn,(is_original_post OR x_post IS NOT NULL) AS post,title,category,tags,score,
      representative_priority,timeline_at,fact_id,story_id
    FROM publications WHERE article_id=${articleId}`;
  if (p?.visibility !== "public" || !p.eligible || p.operator_withdrawn) return null;
  const [material] = await newsShadowMaterials([articleId], 0, db);
  if (!material) return null;
  const [frame] = await groupingFrames([articleId], db);
  const twins = await newsDuplicateProbes(articleId, TWIN_LIMIT, db);
  // Only the judgement of the current revision speaks for the report.
  const current = frame?.input_revision === material.revision ? frame : null;
  const reportedAt = material.published_at ?? material.discovered_at;
  const claimed = memberClaim({ articleId, revision: material.revision, claim: current?.occurred_at ?? null, text: "", reportedAt });
  // The report's own day counts only when found in its text: read only when there is a usable claim to check and its
  // source allows reading it locally.
  const text =
    claimed.on !== null && (await locallyReadable([material], db)).has(articleId) ? (await newsShadowMaterials([articleId], TEXT_CHARS, db))[0] : undefined;
  const own = text
    ? memberClaim({ articleId, revision: material.revision, claim: current?.occurred_at ?? null, text: `${text.title}\n${text.body}`, reportedAt })
    : claimed;
  const fact = p.fact_id === null ? null : timing?.has(p.fact_id) ? timing.get(p.fact_id)! : ((await readFactTiming([p.fact_id], db))[0] ?? null);
  const input = {
    reportedAt,
    ownDate: own.verified ? own.on : null,
    factDate: fact ? { on: fact.occurredOn, basis: fact.occurredBasis } : null,
    firstReportedAt: fact?.firstReportedAt ?? null,
    storyFirstReportedAt: fact?.storyFirstReportedAt ?? null,
    recollectedFrom: earlierCopy(
      { sourceId: material.source_id, reportedAt },
      twins.map((t) => ({ sourceId: t.source_id, reportedAt: t.published_at ?? t.discovered_at })),
    ),
  };
  const f = freshness(input);
  const rank = importance({ score: p.score, representativePriority: p.representative_priority, tags: p.tags, freshness: f.class });
  return {
    articleId,
    articleRevision: material.revision,
    factId: p.fact_id,
    storyId: p.story_id,
    reportedAt,
    freshness: f.class,
    freshnessBasis: f.basis,
    occurredOn: f.occurredOn,
    anchorAt: rankAnchor(f, input, p.timeline_at),
    importance: rank.value,
    importanceInputs: rank.inputs,
    genre: genreOf({
      xPost: p.post,
      scope: current?.scope ?? null,
      category: p.category,
      authorRole: current?.author_role ?? null,
      title: p.title,
      representativePriority: p.representative_priority,
    }),
    topic: topicOf(p.category),
    ruleset: RANK_RULESET,
  };
}

/** Store a computed row, or remove the publication's row when it has none. decided_at moves only with freshness or anchor. */
async function writeEventRank(articleId: string, row: EventRankRow | null, db: Db): Promise<"written" | "removed" | "unchanged"> {
  if (!row) {
    const removed = await db`DELETE FROM publication.event_rank WHERE article_id=${articleId}`;
    return removed.count ? "removed" : "unchanged";
  }
  const written = await db`INSERT INTO publication.event_rank(lane,article_id,article_revision,fact_id,story_id,reported_at,freshness,freshness_basis,
      occurred_on,anchor_at,importance,importance_inputs,genre,topic,ruleset)
    VALUES('news',${articleId},${row.articleRevision},${row.factId},${row.storyId},${row.reportedAt},${row.freshness},${row.freshnessBasis},
      ${row.occurredOn}::date,${row.anchorAt},${row.importance},${db.json(row.importanceInputs as never)},${row.genre},${row.topic},${row.ruleset})
    ON CONFLICT(article_id) DO UPDATE SET article_revision=EXCLUDED.article_revision,fact_id=EXCLUDED.fact_id,story_id=EXCLUDED.story_id,
      reported_at=EXCLUDED.reported_at,freshness=EXCLUDED.freshness,freshness_basis=EXCLUDED.freshness_basis,occurred_on=EXCLUDED.occurred_on,
      anchor_at=EXCLUDED.anchor_at,importance=EXCLUDED.importance,importance_inputs=EXCLUDED.importance_inputs,genre=EXCLUDED.genre,
      topic=EXCLUDED.topic,ruleset=EXCLUDED.ruleset,updated_at=pg_catalog.clock_timestamp(),
      decided_at=CASE WHEN event_rank.freshness IS DISTINCT FROM EXCLUDED.freshness OR event_rank.anchor_at IS DISTINCT FROM EXCLUDED.anchor_at
        THEN pg_catalog.clock_timestamp() ELSE event_rank.decided_at END
    WHERE (event_rank.article_revision,event_rank.fact_id,event_rank.story_id,event_rank.reported_at,event_rank.freshness,event_rank.freshness_basis,
        event_rank.occurred_on,event_rank.anchor_at,event_rank.importance,event_rank.importance_inputs,event_rank.genre,event_rank.topic,event_rank.ruleset)
      IS DISTINCT FROM (EXCLUDED.article_revision,EXCLUDED.fact_id,EXCLUDED.story_id,EXCLUDED.reported_at,EXCLUDED.freshness,EXCLUDED.freshness_basis,
        EXCLUDED.occurred_on,EXCLUDED.anchor_at,EXCLUDED.importance,EXCLUDED.importance_inputs,EXCLUDED.genre,EXCLUDED.topic,EXCLUDED.ruleset)`;
  return written.count ? "written" : "unchanged";
}

/** Compute and store one publication's row (an idempotent repair: running it again changes nothing). */
export async function projectEventOrder(articleId: string, db: Db = sql) {
  return writeEventRank(articleId, await computeEventRank(articleId, db), db);
}

/** The fact a publication's stored row was decided with: where a report that moved came from. */
export async function rankedFact(articleId: string, db: Db = sql): Promise<number | null> {
  const [row] = await db<{ fact_id: number | null }[]>`SELECT fact_id FROM publication.event_rank WHERE article_id=${articleId}`;
  return row?.fact_id ?? null;
}

/** The public members of a fact and the reports holding a row for it, at most `limit`: whose rows a timing change moves. */
export async function factPublications(factId: number, limit: number, db: Db = sql): Promise<string[]> {
  const rows = await db<{ article_id: string }[]>`SELECT article_id FROM publications WHERE fact_id=${factId} AND visibility='public' AND eligible
    UNION SELECT article_id FROM publication.event_rank WHERE fact_id=${factId} ORDER BY article_id LIMIT ${limit}`;
  return rows.map((row) => row.article_id);
}

export interface BackfillPage {
  seen: number;
  written: number;
  removed: number;
  facts: number;
  classes: Record<FreshnessClass, number>;
  next: { at: Date; id: string } | null;
}

/**
 * One page of the event-order back-fill (scripts/event-order-backfill.ts): public news since `since`, newest first.
 * With `apply` the facts' timing and the rows are written; without it the same rows are computed and only counted.
 * It never goes through publishArticleTx, which can queue paid translation.
 */
export async function eventOrderBackfillPage(
  o: { since: Date; after: { at: Date; id: string } | null; limit: number; apply: boolean },
  db: Db = sql,
): Promise<BackfillPage> {
  const rows = await db<{ article_id: string; timeline_at: Date; fact_id: number | null }[]>`
    SELECT article_id,timeline_at,fact_id FROM publications
    WHERE channel='news' AND visibility='public' AND eligible AND timeline_at>${o.since}
      AND (${o.after?.at ?? null}::timestamptz IS NULL OR (timeline_at,article_id)<(${o.after?.at ?? null}::timestamptz,${o.after?.id ?? ""}::text))
    ORDER BY timeline_at DESC,article_id DESC LIMIT ${o.limit}`;
  const factIds = [...new Set(rows.flatMap((row) => (row.fact_id === null ? [] : [row.fact_id])))];
  const timing = o.apply ? undefined : await previewFactTiming(factIds, db);
  if (o.apply) await observeFactTiming(factIds, db);
  const page: BackfillPage = { seen: rows.length, written: 0, removed: 0, facts: factIds.length, classes: { new: 0, follow_up: 0, old: 0 }, next: null };
  for (const row of rows) {
    const rank = await computeEventRank(row.article_id, db, timing);
    if (rank) page.classes[rank.freshness]++;
    if (!o.apply) continue;
    const outcome = await writeEventRank(row.article_id, rank, db);
    if (outcome === "written") page.written++;
    if (outcome === "removed") page.removed++;
  }
  const last = rows.at(-1);
  page.next = rows.length === o.limit && last ? { at: last.timeline_at, id: last.article_id } : null;
  return page;
}
