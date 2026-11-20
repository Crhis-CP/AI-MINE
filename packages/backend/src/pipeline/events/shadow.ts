// The event rules in shadow (package 2, step 2.4): after the live engine has grouped a report, decide it again by the
// rules alone (rules.ts decideEvent: no model call, no new vector) and store that answer next to a snapshot of what the
// live engine did (events.shadow_decisions). Nothing here writes a membership, a publication, an analysis or a receipt,
// so nothing a reader sees can change; the rows measure agreement and the model calls a switch would save.
// Switched by the settings key events.shadow, owned here: on only while it holds "on" (docs/runbooks/event-shadow.md).
import { z } from "zod";
import { isHistorical, newsShadowMaterials } from "../../content/materials.ts";
import { sql, type Db } from "../../db.ts";
import { groupingFrames, readGroupingAnalysis } from "../../enrichment/records.ts";
import { documentKeys, reportText } from "../../events/relate.ts";
import { newsRelationJurisdictions } from "../../publication/items.ts";
import { sourceParticipants } from "../../sources/participants.ts";
import { bodyFingerprint } from "./fingerprint.ts";
import { recallCandidates, type RecallResult } from "./recall.ts";
import { decideEvent, type EventCandidate, type EventDecision, type EventQuery, EVENT_RULESET } from "./rules.ts";
import { memberClaim } from "./timing-rules.ts";
import { readFactTiming, TEXT_CHARS } from "./timing.ts";

/** Shadow rows are kept this long (operations/retention.ts); the switch decision needs two weeks of them. */
export const SHADOW_RETENTION_DAYS = 45;
const DAY = 86_400_000;

let switchRead: { at: number; on: boolean } | null = null;
/** Whether the shadow runs: the settings key events.shadow holds "on". Absent or any other value is off. Read at most once a minute. */
export async function eventShadowEnabled(maxAgeMs = 60_000): Promise<boolean> {
  const now = Date.now();
  if (switchRead && now - switchRead.at < maxAgeMs) return switchRead.on;
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key='events.shadow'`;
  switchRead = { at: now, on: row?.value === "on" };
  return switchRead.on;
}

// The live engine's reading of a judgement (events/group.ts decide: FactFrame and the scope), so "has a frame" is the same.
const Frame = z
  .object({
    title: z.string().max(80).nullish(),
    subject: z.string().max(80).nullish(),
    action: z.string().max(80).nullish(),
    object: z.string().max(160).nullish(),
    occurredAt: z.string().nullish(),
  })
  .nullable()
  .catch(null);
const Judgement = z.object({ scope: z.enum(["single", "composite", "unknown"]).catch("unknown"), fact: Frame.optional() });

export type ShadowOutcome =
  | { state: "missing" | "kept" }
  | { state: "decided"; verdict: EventDecision["verdict"]; rule: EventDecision["rule"]; wouldCall: number; recall: RecallResult["stats"] | null };

/** The trusted occurrence day of a report: its own claim found in its text (a bare model claim is not trusted). */
function ownDay(m: { id: string; revision: number; title: string; body: string; published_at: Date | null; discovered_at: Date }, claim: string | null) {
  const own = memberClaim({ articleId: m.id, revision: m.revision, claim, text: `${m.title}\n${m.body}`, reportedAt: m.published_at ?? m.discovered_at });
  return own.verified ? own.on : null;
}

async function jurisdictions(materials: ReadonlyArray<{ id: string; revision: number }>, db: Db): Promise<Map<string, string | null>> {
  return new Map(
    (
      await newsRelationJurisdictions(
        materials.map((m) => ({ id: m.id, revision: m.revision })),
        db,
      )
    ).map((j) => [j.id, j.jurisdiction]),
  );
}

/** The recalled reports as the rules compare them: source, time, country, body fingerprint and trusted occurrence day. */
async function shadowCandidates(recall: RecallResult, db: Db): Promise<EventCandidate[]> {
  const ids = recall.candidates.map((c) => c.articleId);
  const [materials, frames, timings] = await Promise.all([
    newsShadowMaterials(ids, TEXT_CHARS, db),
    groupingFrames(ids, db),
    readFactTiming([...new Set(recall.candidates.map((c) => c.factId))], db),
  ]);
  const materialOf = new Map(materials.map((m) => [m.id, m]));
  const frameOf = new Map(frames.map((f) => [f.article_id, f]));
  const timingOf = new Map(timings.map((t) => [t.factId, t]));
  const placeOf = await jurisdictions(materials, db);
  return recall.candidates.flatMap((hit) => {
    const m = materialOf.get(hit.articleId);
    if (!m) return [];
    const frame = frameOf.get(hit.articleId);
    const timing = timingOf.get(hit.factId);
    // A candidate's fact day counts when checked in a member's text or agreed by two members; else its own checked claim.
    const factDay = timing && (timing.occurredBasis === "verified" || timing.occurredBasis === "agreed") ? timing.occurredOn : null;
    return [
      {
        articleId: hit.articleId,
        sourceId: m.source_id,
        title: hit.title,
        at: m.published_at,
        jurisdiction: placeOf.get(hit.articleId) ?? null,
        fingerprint: bodyFingerprint(m.body),
        occurredOn: factDay ?? ownDay(m, frame?.input_revision === m.revision ? frame.occurred_at : null),
        factId: hit.factId,
        storyId: hit.storyId,
        cosine: hit.cosine,
        lexical: hit.lexical,
        sameUrl: hit.sameUrl,
        sameHash: hit.sameHash,
        documentKey: hit.documentKey,
        selected: hit.selected,
      },
    ];
  });
}

/**
 * Decide one grouped report by the rules and store the answer. `keepExisting` (a re-delivered or manual run, where the
 * live engine decided nothing new) leaves a row already written for this revision as it is.
 */
export async function shadowDecide(articleId: string, opts: { keepExisting?: boolean } = {}, db: Db = sql): Promise<ShadowOutcome> {
  const [material] = await newsShadowMaterials([articleId], TEXT_CHARS, db);
  if (!material) return { state: "missing" };
  const revision = material.revision;
  if (opts.keepExisting) {
    const [row] = await db`SELECT 1 FROM events.shadow_decisions WHERE article_id=${articleId} AND article_revision=${revision} AND ruleset=${EVENT_RULESET}`;
    if (row) return { state: "kept" };
  }
  const [[live], [manual], analysis, [source], places] = await Promise.all([
    db<{ verdict: string; fact_id: number | null; story_id: number | null; called: boolean; candidates: unknown; created_at: Date }[]>`
      SELECT verdict,fact_id,story_id,receipt_id IS NOT NULL AS called,candidates,created_at FROM grouping_decisions
      WHERE article_id=${articleId} AND (input_revision IS NULL OR input_revision=${revision}) ORDER BY id DESC LIMIT 1`,
    db`SELECT 1 FROM grouping_overrides WHERE article_id=${articleId} UNION ALL SELECT 1 FROM fact_articles WHERE article_id=${articleId} AND manual LIMIT 1`,
    readGroupingAnalysis(articleId, revision, db),
    sourceParticipants([material.source_id], db),
    jurisdictions([material], db),
  ]);
  const parsed = Judgement.safeParse(analysis?.output);
  const scope = parsed.success ? parsed.data.scope : "unknown";
  const frame = parsed.success && scope !== "composite" ? (parsed.data.fact ?? null) : null;
  const title = analysis?.title_zh || material.title;
  const query: EventQuery = {
    articleId,
    sourceId: material.source_id,
    title,
    at: material.published_at,
    jurisdiction: places.get(articleId) ?? null,
    fingerprint: bodyFingerprint(material.body),
    occurredOn: ownDay(material, frame?.occurredAt ?? null),
    editorial: source?.participation_mode === "editorial",
    relevance: analysis?.relevance ?? null,
    scope,
    frame: !!frame,
    manual: !!manual,
    historical: isHistorical(material),
    hasVector: false,
    readingBackground: false,
  };

  const gate = decideEvent(query, []);
  // Outside the rules (rule 0) nothing is recalled: the pool is read only for reports the rules judge.
  const recall =
    gate.verdict === "not_judged"
      ? null
      : await recallCandidates(
          {
            articleId,
            text: reportText(title, analysis?.summary_zh),
            documentKeys: scope === "composite" ? [] : documentKeys([analysis?.title_zh, material.title, frame?.title]),
            composite: scope === "composite",
            // The pool as the live engine saw it; a run with no live decision yet sees the graph as it is now.
            liveAt: live?.created_at ?? new Date(),
          },
          db,
        );
  const decision = recall
    ? decideEvent({ ...query, hasVector: recall.hasVector, readingBackground: recall.readingBackground }, await shadowCandidates(recall, db))
    : gate;

  await db`INSERT INTO events.shadow_decisions(lane,article_id,article_revision,ruleset,verdict,rule,target_fact_id,target_story_id,similarity,
      candidates,would_call,live_verdict,live_fact_id,live_story_id,live_called,live_candidates)
    VALUES('news',${articleId},${revision},${decision.ruleset},${decision.verdict},${decision.rule},${decision.targetFactId},${decision.targetStoryId},
      ${decision.similarity === null ? null : Number(decision.similarity)},${db.json(decision.candidates as never)},${decision.wouldCall},${live?.verdict ?? null},${live?.fact_id ?? null},
      ${live?.story_id ?? null},${live?.called ?? null},${live?.candidates == null ? null : db.json(live.candidates as never)})
    ON CONFLICT(article_id,article_revision,ruleset) DO UPDATE SET verdict=EXCLUDED.verdict,rule=EXCLUDED.rule,target_fact_id=EXCLUDED.target_fact_id,
      target_story_id=EXCLUDED.target_story_id,similarity=EXCLUDED.similarity,candidates=EXCLUDED.candidates,would_call=EXCLUDED.would_call,
      live_verdict=EXCLUDED.live_verdict,live_fact_id=EXCLUDED.live_fact_id,live_story_id=EXCLUDED.live_story_id,live_called=EXCLUDED.live_called,
      live_candidates=EXCLUDED.live_candidates,decided_at=pg_catalog.clock_timestamp()`;
  return { state: "decided", verdict: decision.verdict, rule: decision.rule, wouldCall: decision.wouldCall, recall: recall?.stats ?? null };
}

/** Drop shadow rows older than the retention (operations/retention.ts, daily). */
export async function pruneShadowDecisions(now = new Date(), db: Db = sql): Promise<number> {
  const deleted = await db`DELETE FROM events.shadow_decisions WHERE decided_at<${new Date(now.getTime() - SHADOW_RETENTION_DAYS * DAY)}`;
  return deleted.count;
}
