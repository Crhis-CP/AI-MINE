// The event rules in shadow (package 2, step 2.4): after the live engine has grouped a report, decide it again by the
// rules alone (rules.ts decideEvent: no model call, no new vector), recalling in the mode the live engine runs in
// (recall.ts recallMode: lexical while embeddings are off, the default), and store that answer next to a snapshot of what the
// live engine did (events.shadow_decisions). Nothing here writes a membership, a publication, an analysis or a receipt,
// so nothing a reader sees can change; the rows measure agreement and the model calls a switch would save.
// A report's own text (for its fingerprint and its checked day) is read only after its source is found to allow that
// locally (local-text.ts). Queries run one after another on the shared pool.
// Switched by the settings key events.shadow, owned here: on only while it holds "on" (docs/runbooks/event-shadow.md).
import { z } from "zod";
import { isHistorical, newsShadowMaterials, type ShadowMaterial } from "../../content/materials.ts";
import { sql, type Db } from "../../db.ts";
import { groupingFrames, readGroupingAnalysis } from "../../enrichment/records.ts";
import { documentKeys, reportText } from "../../events/relate.ts";
import { newsRelationJurisdictions } from "../../publication/items.ts";
import { sourceParticipants } from "../../sources/participants.ts";
import { bodyFingerprint } from "./fingerprint.ts";
import { locallyReadable } from "./local-text.ts";
import { recallCandidates, recallMode, type RecallMode, type RecallResult, recallRuleset, slicer } from "./recall.ts";
import { decideEvent, type EventCandidate, type EventDecision, type EventQuery, EVENT_RULESET } from "./rules.ts";
import { memberClaim } from "./timing-rules.ts";
import { readFactTiming, TEXT_CHARS } from "./timing.ts";

/**
 * What a stored row was decided under: the rules, the recall mode and bounds and the text read; rows of other settings
 * are never pooled. Without an argument, the mode the live engine runs in now (what the agreement report reads).
 */
export function shadowRuleset(mode: RecallMode = recallMode()): string {
  return `${EVENT_RULESET}|${recallRuleset(mode)}|text${TEXT_CHARS}`;
}
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
  | {
      state: "decided";
      verdict: EventDecision["verdict"];
      rule: EventDecision["rule"];
      wouldCall: number;
      /** Review calls that may come on top, depending on the judge's answers: an upper bound. */
      confirmUpperBound: number;
      recall: RecallResult["stats"] | null;
      /** Reports whose own text was read (only those whose source allows it). */
      textsRead: number;
    };

/** Bodies of the materials whose source allows reading them locally; the others are not read at all. */
async function readableTexts(materials: readonly ShadowMaterial[], db: Db): Promise<Map<string, ShadowMaterial>> {
  const readable = await locallyReadable(materials, db);
  const ids = materials.filter((m) => readable.has(m.id)).map((m) => m.id);
  return new Map((await newsShadowMaterials(ids, TEXT_CHARS, db)).map((m) => [m.id, m]));
}

/**
 * What the rules read of a report's own text: its body fingerprint and its trusted occurrence day (its own claim found in
 * its text; a bare model claim is not trusted). Neither exists when the text was not read.
 */
function ownText(text: ShadowMaterial | undefined, claim: string | null) {
  if (!text) return { fingerprint: null, occurredOn: null };
  const own = memberClaim({
    articleId: text.id,
    revision: text.revision,
    claim,
    text: `${text.title}\n${text.body}`,
    reportedAt: text.published_at ?? text.discovered_at,
  });
  return { fingerprint: bodyFingerprint(text.body), occurredOn: own.verified ? own.on : null };
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
async function shadowCandidates(recall: RecallResult, db: Db): Promise<{ candidates: EventCandidate[]; textsRead: number }> {
  const ids = recall.candidates.map((c) => c.articleId);
  const materials = await newsShadowMaterials(ids, 0, db);
  const frames = await groupingFrames(ids, db);
  const timings = await readFactTiming([...new Set(recall.candidates.map((c) => c.factId))], db);
  const placeOf = await jurisdictions(materials, db);
  const texts = await readableTexts(materials, db);
  const materialOf = new Map(materials.map((m) => [m.id, m]));
  const frameOf = new Map(frames.map((f) => [f.article_id, f]));
  const timingOf = new Map(timings.map((t) => [t.factId, t]));
  // A text's fingerprint and day take a few milliseconds each: yield between candidates.
  const turn = slicer();
  const candidates: EventCandidate[] = [];
  for (const hit of recall.candidates) {
    const m = materialOf.get(hit.articleId);
    if (!m) continue;
    const frame = frameOf.get(hit.articleId);
    const timing = timingOf.get(hit.factId);
    // A candidate's fact day counts when checked in a member's text or agreed by two members; else its own checked claim.
    const factDay = timing && (timing.occurredBasis === "verified" || timing.occurredBasis === "agreed") ? timing.occurredOn : null;
    const own = ownText(texts.get(m.id), frame?.input_revision === m.revision ? frame.occurred_at : null);
    candidates.push({
      articleId: hit.articleId,
      sourceId: m.source_id,
      title: hit.title,
      at: m.published_at,
      jurisdiction: placeOf.get(hit.articleId) ?? null,
      fingerprint: own.fingerprint,
      occurredOn: factDay ?? own.occurredOn,
      factId: hit.factId,
      storyId: hit.storyId,
      cosine: hit.cosine,
      lexical: hit.lexical,
      sameUrl: hit.sameUrl,
      sameHash: hit.sameHash,
      documentKey: hit.documentKey,
      selected: hit.selected,
    });
    await turn();
  }
  return { candidates, textsRead: texts.size };
}

/**
 * Decide one grouped report by the rules and store the answer. `keepExisting` (a re-delivered or manual run, where the
 * live engine decided nothing new) leaves a row already written for this revision as it is, before reading anything else.
 */
export async function shadowDecide(articleId: string, opts: { keepExisting?: boolean } = {}, db: Db = sql): Promise<ShadowOutcome> {
  const [material] = await newsShadowMaterials([articleId], 0, db);
  if (!material) return { state: "missing" };
  const revision = material.revision;
  // One mode for the whole decision: the row's ruleset names the mode its recall ran in.
  const mode = recallMode();
  const ruleset = shadowRuleset(mode);
  if (opts.keepExisting) {
    const [row] = await db`SELECT 1 FROM events.shadow_decisions WHERE article_id=${articleId} AND article_revision=${revision} AND ruleset=${ruleset}`;
    if (row) return { state: "kept" };
  }
  const [live] = await db<{ verdict: string; fact_id: number | null; story_id: number | null; called: boolean; candidates: unknown; created_at: Date }[]>`
    SELECT verdict,fact_id,story_id,receipt_id IS NOT NULL AS called,candidates,created_at FROM grouping_decisions
    WHERE article_id=${articleId} AND (input_revision IS NULL OR input_revision=${revision}) ORDER BY id DESC LIMIT 1`;
  const [manual] =
    await db`SELECT 1 FROM grouping_overrides WHERE article_id=${articleId} UNION ALL SELECT 1 FROM fact_articles WHERE article_id=${articleId} AND manual LIMIT 1`;
  const analysis = await readGroupingAnalysis(articleId, revision, db);
  const [source] = await sourceParticipants([material.source_id], db);
  const places = await jurisdictions([material], db);
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
    fingerprint: null,
    occurredOn: null,
    editorial: source?.participation_mode === "editorial",
    relevance: analysis?.relevance ?? null,
    scope,
    frame: !!frame,
    manual: !!manual,
    historical: isHistorical(material),
    recallComplete: false,
    readingBackground: false,
  };

  const gate = decideEvent(query, []);
  // Outside the rules (rule 0) nothing is recalled and no text is read: only reports the rules judge cost that.
  const judged =
    gate.verdict === "not_judged"
      ? null
      : await (async () => {
          const mine = await readableTexts([material], db);
          const own = ownText(mine.get(articleId), frame?.occurredAt ?? null);
          const recall = await recallCandidates(
            {
              articleId,
              text: reportText(title, analysis?.summary_zh),
              documentKeys: scope === "composite" ? [] : documentKeys([analysis?.title_zh, material.title, frame?.title]),
              composite: scope === "composite",
              // The pool as the live engine saw it; a run with no live decision yet sees the graph as it is now.
              liveAt: live?.created_at ?? new Date(),
              mode,
            },
            db,
          );
          const found = await shadowCandidates(recall, db);
          return {
            recall,
            textsRead: found.textsRead + mine.size,
            decision: decideEvent({ ...query, ...own, recallComplete: recall.recallComplete, readingBackground: recall.readingBackground }, found.candidates),
          };
        })();
  const decision = judged ? judged.decision : gate;

  await db`INSERT INTO events.shadow_decisions(lane,article_id,article_revision,ruleset,verdict,rule,target_fact_id,target_story_id,similarity,
      candidates,would_call,live_verdict,live_fact_id,live_story_id,live_called,live_candidates)
    VALUES('news',${articleId},${revision},${ruleset},${decision.verdict},${decision.rule},${decision.targetFactId},${decision.targetStoryId},
      ${decision.similarity === null ? null : Number(decision.similarity)},${db.json(decision.candidates as never)},${decision.wouldCall},${live?.verdict ?? null},
      ${live?.fact_id ?? null},${live?.story_id ?? null},${live?.called ?? null},${live?.candidates == null ? null : db.json(live.candidates as never)})
    ON CONFLICT(article_id,article_revision,ruleset) DO UPDATE SET verdict=EXCLUDED.verdict,rule=EXCLUDED.rule,target_fact_id=EXCLUDED.target_fact_id,
      target_story_id=EXCLUDED.target_story_id,similarity=EXCLUDED.similarity,candidates=EXCLUDED.candidates,would_call=EXCLUDED.would_call,
      live_verdict=EXCLUDED.live_verdict,live_fact_id=EXCLUDED.live_fact_id,live_story_id=EXCLUDED.live_story_id,live_called=EXCLUDED.live_called,
      live_candidates=EXCLUDED.live_candidates,decided_at=pg_catalog.clock_timestamp()`;
  return {
    state: "decided",
    verdict: decision.verdict,
    rule: decision.rule,
    wouldCall: decision.wouldCall,
    confirmUpperBound: decision.confirmUpperBound,
    recall: judged?.recall.stats ?? null,
    textsRead: judged?.textsRead ?? 0,
  };
}

/** Drop shadow rows older than the retention (operations/retention.ts, daily). */
export async function pruneShadowDecisions(now = new Date(), db: Db = sql): Promise<number> {
  const deleted = await db`DELETE FROM events.shadow_decisions WHERE decided_at<${new Date(now.getTime() - SHADOW_RETENTION_DAYS * DAY)}`;
  return deleted.count;
}
