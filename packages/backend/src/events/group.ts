import { invalidateHistoricalBackgrounds } from "./historical-background-store.ts";
import { participantIdentity, sourceParticipants, type SourceParticipant } from "../sources/participants.ts";
export { recoverPendingGroupings } from "./recovery.ts";
export type { HistoricalBackgroundReferencesReader } from "@amp/contracts/site";
export { readHistoricalBackgroundReferences } from "./historical-background-store.ts";
import { readGroupingAnalysis, groupingAnalysisHash, groupingScopeInputs } from "../enrichment/records.ts";
import {
  readMaterialGrouping,
  beginMaterialGrouping,
  completeMaterialGrouping,
  failMaterialGrouping,
  confirmedGroupingMaterials,
  resumeCompletedGroupingRecipe,
} from "../content/grouping.ts";
import { isModelRouteWaiting } from "../providers/model-fallback.ts";
import { z } from "zod";
import { isValidDate } from "@amp/contracts/time";
import {
  newsRelationJurisdictions,
  readGroupingEvidencePublications,
  readGroupingSelectionSnapshot,
  readConfirmedGroupingItems,
  groupingSelectionCandidate,
  type GroupingSelectionSnapshot,
} from "@amp/backend/publication/publish";
import { newsRelationMaterials, newsMaterialBindings, lockNewsModelMaterials, lockMaterialForGrouping } from "@amp/backend/content/materials";
import { prepareNewsFallback, lockNewsProcessingPermissions } from "../providers/news-fallback.ts";
import { shutdownSignal } from "../jobs/queue.ts";
// Event grouping. A report attaches to a fact, the same real-world occurrence, and
// facts hang on a story, an occurrence with its direct developments. Recall: the same title-and-
// summary embedding on both sides over the reports of the last 14 days, plus the same URL.
// Identity: one three-way relation judgement over the candidate facts with their representative
// reports fully described (relate.ts); a merge that is not obvious from similarity is confirmed by a
// second vendor before it is written; a development attaches only to the fact that started its
// story, so stories do not grow by chaining. Manual corrections are never overwritten; a revision
// keeps its membership unless an editor asks for a regroup. When a report is firmly tied to two
// stories, their roots are compared directly and the stories merge
// when both models see one story (consolidate); stories that stay apart though reports keep tying
// them list each other as related (linkRelatedStories). A story a regrouped report leaves without
// reports merges into where it went, so its address keeps working. A report waiting for a regroup
// (regroup_pending) is not evidence for others until it is decided again, so a regroup in discovery
// order sees what live grouping would have seen. Discussion posts that found no story get another
// look when a report founds a fact close to them (rematchSignals); history (isHistorical) founds no
// event. Runs serially (queue concurrency 1).
import { modelFor } from "../editorial/models.ts";
import { sql, type Db, type Tx } from "../db.ts";
import { newShortId, newUuid, sha256 } from "../lib/ids.ts";
import { chatJson, ModelPostReceiptGuardError } from "../providers/llm.ts";
import { BudgetExceededError, ReceiptBusyError, ReceiptUnknownError, completeReceipt } from "../providers/receipts.ts";
import { embeddingsAvailable, ensureEmbeddings } from "../providers/embeddings.ts";
import { isHistorical, STALE_ON_DISCOVERY_MS } from "../content/materials.ts";
import { ensureQueue, QUEUES } from "../jobs/queue.ts";
import { enqueueJob as enqueue } from "../jobs/module-queues.ts";
import { publishArticleTx, articleWithdrawalHeld } from "../publication/publish.ts";
import { mergeStoryInto } from "./merge.ts";
import { pickRepresentative } from "../publication/representative.ts";

/** Called under the membership lock, before a regroup can erase an active target association. */
export async function captureEventWithdrawal(db: Db, articleId: string) {
  const memberships = await db<
    { fact_public_id: string | null; story_public_id: string | null }[]
  >`SELECT f.public_id AS fact_public_id,s.public_id::text AS story_public_id
    FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id LEFT JOIN stories s ON s.id=f.story_id WHERE fa.article_id=${articleId}
    UNION SELECT NULL,s.public_id::text FROM story_signals ss JOIN stories s ON s.id=ss.story_id WHERE ss.article_id=${articleId}`;
  let held = false;
  for (const member of memberships) held = (await articleWithdrawalHeld(db, articleId, member.fact_public_id, member.story_public_id)) || held;
  if (held) await publishArticleTx(db as Tx, articleId);
}

/** Human standalone decision and membership removal share the caller's editorial transaction. */
export async function detachArticleFromFactTx(tx: Tx, articleId: string, reason: string, actor: string) {
  await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
  await captureEventWithdrawal(tx, articleId);
  await lockMaterialForGrouping(tx, articleId);
  const removed = await tx<{ fact_id: number }[]>`DELETE FROM fact_articles WHERE article_id=${articleId} RETURNING fact_id`;
  const facts = removed.map((row) => row.fact_id);
  const storyRows = facts.length ? await tx<{ story_id: number }[]>`SELECT DISTINCT story_id FROM facts WHERE id=ANY(${facts}) AND story_id IS NOT NULL` : [];
  const stories = storyRows.map((row) => row.story_id);
  if (stories.length) await tx`DELETE FROM story_signals WHERE article_id=${articleId} AND story_id=ANY(${stories})`;
  await tx`INSERT INTO grouping_overrides(article_id,reason,actor) VALUES(${articleId},${reason},${actor})
    ON CONFLICT(article_id) DO UPDATE SET reason=EXCLUDED.reason,actor=EXCLUDED.actor,created_at=now()`;
  const material = await readMaterialGrouping(articleId, tx);
  if (material) {
    await beginMaterialGrouping(articleId, material.revision, true, tx);
    await completeMaterialGrouping(articleId, material.revision, { addsValue: true, reason: "人工确认独立报道" }, null, tx);
  }
  await tx`DELETE FROM regroup_pending WHERE article_id=${articleId}`;
  await invalidateHistoricalBackgrounds([articleId], tx);
  return { facts, stories };
}
export async function factArticleIds(factIds: number[], db: Db = sql): Promise<string[]> {
  if (!factIds.length) return [];
  return (await db<{ article_id: string }[]>`SELECT DISTINCT article_id FROM fact_articles WHERE fact_id=ANY(${factIds})`).map((row) => row.article_id);
}

/** All members, including individually hidden items, form the editorial withdrawal snapshot. */
export async function withdrawalEventMembers(type: "event" | "story", publicId: string, db: Db = sql): Promise<string[] | null> {
  if (type === "event") {
    const [fact] = await db<{ id: number }[]>`SELECT id FROM facts WHERE public_id=${publicId}`;
    if (!fact) return null;
    return (await db<{ article_id: string }[]>`SELECT article_id FROM fact_articles WHERE fact_id=${fact.id} ORDER BY article_id`).map((r) => r.article_id);
  }
  const [story] = await db<{ id: number }[]>`SELECT id FROM stories WHERE public_id::text=${publicId}`;
  if (!story) return null;
  return (
    await db<
      { article_id: string }[]
    >`SELECT fa.article_id FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id WHERE f.story_id=${story.id} UNION SELECT article_id FROM story_signals WHERE story_id=${story.id} ORDER BY article_id`
  ).map((r) => r.article_id);
}

/** Withdrawn facts cannot remain embedded in a development line's old synthesized wording. */
export async function invalidateWithdrawalStories(target: { type: "event" | "story"; id: string }, memberIds: string[], db: Db) {
  await invalidateHistoricalBackgrounds(memberIds, db, target.type === "story" ? [target.id] : []);
  const rows = await db<
    { story_id: number | null }[]
  >`SELECT f.story_id FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id WHERE fa.article_id=ANY(${memberIds}::text[])
    UNION SELECT story_id FROM story_signals WHERE article_id=ANY(${memberIds}::text[])`;
  const targetRows =
    target.type === "event"
      ? await db<{ story_id: number | null }[]>`SELECT story_id FROM facts WHERE public_id=${target.id}`
      : await db<{ story_id: number | null }[]>`SELECT id AS story_id FROM stories WHERE public_id::text=${target.id}`;
  for (const id of [...new Set([...rows, ...targetRows].flatMap((r) => (r.story_id === null ? [] : [r.story_id])))].sort((a, b) => a - b)) {
    await db`UPDATE stories SET version=version+1,updated_at=pg_catalog.clock_timestamp() WHERE id=${id}`;
    await enqueue(QUEUES.digest, { lane: "news", storyId: id, afterCorrection: true }, { singletonKey: `story:${id}:correction` }, db);
  }
}
import {
  assertRuntimeControl,
  requireRuntimeRunning,
  runtimeControlSnapshot,
  RuntimeControlPaused,
  RuntimeControlStale,
  type RuntimeControlSnapshot,
} from "../operations/lane-controls.ts";
import {
  BATCH_SYSTEM,
  BATCH_PROMPT_VERSION,
  GROUP_BODY_CHARS,
  ValueBatchSchema,
  NO_SELECTED_COVERAGE,
  type SelectionValue,
  type ReadingContext,
  completeDecisions,
  PAIR_SYSTEM,
  PairSchema,
  RELATE_PROMPT_VERSION,
  FACT_CONVERGENCE_VERSION,
  SIGNAL_SYSTEM,
  STORY_REVIEW_MIN_CONFIDENCE,
  SignalSchema,
  TIE_MIN_CONFIDENCE,
  batchUser,
  firmlyTied,
  lexicalSimilarity,
  pairUser,
  reportText,
  sameOccurrence,
  sameOccurrenceForGrouping,
  signalTarget,
  storyForDevelopment,
  verdictsByFact,
  validatedRelation,
  type CandidateView,
  type Relation,
  type ReportView,
  type Verdict,
} from "./relate.ts";

import { EVENT_CONTINUATIONS, EVENT_CONTINUATION_OPTIONS } from "./queues.ts";
export { EVENT_CONTINUATIONS, EVENT_CONTINUATION_OPTIONS } from "./queues.ts";

export const GROUP_PROMPT_VERSION = BATCH_PROMPT_VERSION;
/** Reports discovered this recently are candidates (keyed on discovery, so an old page found today still meets its peers). */
const RECALL_DAYS = 14;
const RECALL_MIN_COSINE = 0.6;
const LEXICAL_RECALL_MIN = 0.25;
const RECALL_TOP_FACTS = 10;
/** A merge with a candidate less similar than this is confirmed by the review model before it is written. */
const CONFIRM_BELOW_COSINE = 0.85;
/** Discussion posts are judged only against clear candidates, and attach without a call when nearly identical. */
const SIGNAL_MIN_COSINE = 0.72;
const SIGNAL_TOP_FACTS = 4;

interface ArticleRow {
  id: string;
  revision: number;
  stale_membership: boolean;
  title: string;
  url: string;
  published_at: Date | null;
  discovered_at: Date;
  grouped_at: Date | null;
  body_text: string | null;
  source_id: string;
  source_name: string;
  first_party: boolean;
  participation_mode: string;
  regroup_pending: boolean;
  backfill: boolean;
}

interface ReportMembership {
  article_id: string;
  input_revision: number | null;
  manual: boolean;
}

interface PoolRow extends ReportMembership {
  fact_id: number;
  story_id: number;
  fact_title: string;
  publication_revision: number;
}

interface Recalled {
  factId: number;
  storyId: number;
  factTitle: string;
  score: number;
}

export function participantKey(source: SourceParticipant): string {
  return participantIdentity(source);
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

/** A membership is evidence unless its report waits for a regroup; a manual one always is. */
function trusted(alias: "x" | "z" | "fa") {
  if (alias === "x") return sql`(x.manual OR NOT EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id=x.article_id))`;
  if (alias === "z") return sql`(z.manual OR NOT EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id=z.article_id))`;
  return sql`(fa.manual OR NOT EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id=fa.article_id))`;
}

/** Qualify before ranking or choosing a representative, so obsolete members cannot consume candidate slots. */
async function qualifiedReports<T extends ReportMembership>(rows: T[], db: Db = sql, withWaiting = false) {
  const ids = [...new Set(rows.map((row) => row.article_id))];
  const [materials, confirmations, publications, scopes] = await Promise.all([
    newsMaterialBindings(ids, db),
    withWaiting ? [] : confirmedGroupingMaterials(ids, db),
    readGroupingEvidencePublications(ids, db),
    groupingScopeInputs(ids, db),
  ]);
  const current = new Map(materials.map((row) => [row.id, row.revision]));
  const confirmed = new Map(confirmations.map((row) => [row.id, row.revision]));
  const published = new Map(publications.map((row) => [row.article_id, row]));
  const composite = new Set(scopes.filter((row) => row.scope === "composite").map((row) => row.article_id));
  return rows.flatMap((row) => {
    const revision = current.get(row.article_id);
    const publication = published.get(row.article_id);
    if (revision === undefined || publication?.withdrawn || composite.has(row.article_id)) return [];
    if (!row.manual && (revision !== row.input_revision || (!withWaiting && confirmed.get(row.article_id) !== revision))) return [];
    return [{ ...row, material_revision: revision, publication_revision: publication?.revision ?? 0, order_time: publication?.order_time ?? null }];
  });
}

/** Empty facts do not start a story; trusted report time wins, then fact ID. */
async function storyRootFacts(storyIds: number[], db: Db = sql): Promise<Map<number, number>> {
  if (!storyIds.length) return new Map();
  const rows = await db<(ReportMembership & { story_id: number; fact_id: number })[]>`
    SELECT y.story_id,y.id AS fact_id,z.article_id,z.input_revision,z.manual FROM facts y
    JOIN fact_articles z ON z.fact_id=y.id AND z.role IN ('primary','report')
    WHERE y.story_id=ANY(${storyIds}) AND (z.manual OR NOT EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id=z.article_id))`;
  const members = await qualifiedReports(rows, db);
  const roots = new Map<number, { factId: number; at: bigint }>();
  for (const member of members) {
    if (member.order_time === null) continue;
    const at = BigInt(member.order_time);
    const before = roots.get(member.story_id);
    if (!before || at < before.at || (at === before.at && member.fact_id < before.factId)) roots.set(member.story_id, { factId: member.fact_id, at });
  }
  return new Map([...roots].map(([story, root]) => [story, root.factId]));
}

/** Reports of the recall window that belong to a live fact; those waiting for a regroup only when asked for (the warm-up). */
async function recallPool(withWaiting = false): Promise<PoolRow[]> {
  return qualifiedReports(
    await sql<Omit<PoolRow, "publication_revision">[]>`
    SELECT fa.article_id, fa.input_revision, fa.manual, fa.fact_id, f.story_id, f.title AS fact_title
    FROM fact_articles fa
    JOIN facts f ON f.id = fa.fact_id
    JOIN stories st ON st.id = f.story_id AND st.merged_into IS NULL
    JOIN articles a ON a.id = fa.article_id
    WHERE fa.role IN ('primary', 'report') AND (${withWaiting} OR fa.manual OR NOT EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id=fa.article_id)) AND a.discovered_at > now() - make_interval(days => ${RECALL_DAYS})`,
    sql,
    withWaiting,
  );
}

/** The public title and summary of reports (the analysis when a report has no publication yet). */
async function reportTexts(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<{ id: string; title: string; summary: string | null }[]>`
    SELECT a.id, coalesce(p.title, an.title_zh, a.title) AS title, coalesce(p.summary, an.summary_zh, '') AS summary
    FROM articles a
    LEFT JOIN publications p ON p.article_id = a.id
    LEFT JOIN LATERAL (SELECT title_zh, summary_zh FROM analyses x WHERE x.article_id = a.id ORDER BY input_revision DESC, id DESC LIMIT 1) an ON true
    WHERE a.id = ANY(${ids})`;
  return new Map(rows.map((r) => [r.id, reportText(r.title, r.summary)]));
}

// Vectors of the recall window stay in the worker process; only new or changed texts are embedded
// (and stored) again. Grouping is serial, so one process holds the whole window.
const vectorCache = new Map<string, { revision: number | undefined; hash: string; vector: Float32Array }>();

async function vectorsFor(items: Array<{ id: string; text: string; revision?: number }>): Promise<Map<string, Float32Array>> {
  const out = new Map<string, Float32Array>();
  const missing: Array<{ id: string; text: string; revision?: number; hash: string }> = [];
  for (const it of items) {
    const hash = sha256(it.text);
    const cached = vectorCache.get(it.id);
    if (cached && cached.hash === hash) {
      if (it.revision !== undefined) cached.revision = it.revision;
      out.set(it.id, cached.vector);
    } else missing.push({ ...it, hash });
  }
  if (missing.length) {
    const got = await ensureEmbeddings(
      "article",
      missing.map((m) => ({ id: m.id, text: m.text })),
    );
    for (const m of missing) {
      const v = got.get(m.id);
      if (!v) continue;
      const vector = Float32Array.from(v);
      vectorCache.set(m.id, { revision: m.revision, hash: m.hash, vector });
      out.set(m.id, vector);
    }
  }
  if (vectorCache.size > 30_000) vectorCache.clear();
  return out;
}

/**
 * Embeds every report of the recall window that has no stored vector yet, within the embedding
 * budget (waiting when it is exhausted). Run before a deploy that changes the embedded text or
 * before a regroup, so the first grouping job does not spend its retries on the backlog.
 */
export async function warmRecallWindow(onProgress?: (done: number, total: number) => void): Promise<{ total: number; embedded: number }> {
  if (!embeddingsAvailable()) return { total: 0, embedded: 0 };
  // Reports waiting for a regroup included: each counts again once its turn comes.
  const ids = [...new Set((await recallPool(true)).map((r) => r.article_id))];
  const texts = await reportTexts(ids);
  const items = ids.map((id) => ({ id, text: texts.get(id) ?? "" })).filter((x) => x.text);
  const stored = new Set(
    (
      await sql<{ ref_id: string; text_hash: string }[]>`
    SELECT ref_id, text_hash FROM embeddings WHERE kind = 'article' AND ref_id = ANY(${items.map((i) => i.id)})`
    ).map((r) => `${r.ref_id}:${r.text_hash}`),
  );
  const missing = items.filter((i) => !stored.has(`${i.id}:${sha256(i.text)}`));
  let done = 0;
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    for (;;) {
      try {
        await ensureEmbeddings("article", batch);
        break;
      } catch (error) {
        // The worker may be embedding the same texts for a live grouping job: that batch is covered.
        if (error instanceof ReceiptBusyError) break;
        if (!(error instanceof BudgetExceededError)) throw error;
        await new Promise((r) => setTimeout(r, (error.retryAfterSeconds + 1) * 1000));
      }
    }
    done += batch.length;
    onProgress?.(done, missing.length);
  }
  return { total: items.length, embedded: missing.length };
}

function cosine32(a: Float32Array, b: Float32Array): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Facts whose reports are similar to the query text: the best report of each fact counts. */
async function recallFacts(queryId: string, queryText: string, minScore: number, top: number): Promise<Recalled[]> {
  const pool = (await recallPool()).filter((r) => r.article_id !== queryId);
  const best = new Map<number, Recalled>();
  const consider = (r: PoolRow, score: number) => {
    const prev = best.get(r.fact_id);
    if (!prev || score > prev.score) best.set(r.fact_id, { factId: r.fact_id, storyId: r.story_id, factTitle: r.fact_title, score });
  };
  const considerLexical = async (only?: Set<string>) => {
    const ids = [...new Set(pool.map((r) => r.article_id))].filter((id) => !only || only.has(id));
    if (!ids.length) return;
    const texts = await reportTexts(ids);
    const wanted = new Set(ids);
    for (const r of pool) {
      if (!wanted.has(r.article_id)) continue;
      const s = lexicalSimilarity(queryText, texts.get(r.article_id) ?? "");
      if (s >= LEXICAL_RECALL_MIN) consider(r, s);
    }
  };
  if (pool.length) {
    if (!embeddingsAvailable()) {
      await considerLexical();
    } else {
      // Publication changes reload the current text; unchanged text still reuses its vector.
      // A missing or mismatched vector falls back to lexical overlap. A vector that exists and scores
      // under the cosine bar does not: a low cosine is a reject, not a missing measurement.
      const ids = [...new Set(pool.map((r) => r.article_id))];
      const revisions = new Map(pool.map((row) => [row.article_id, row.publication_revision]));
      const cached = new Map<string, Float32Array>();
      for (const id of ids) {
        const hit = vectorCache.get(id);
        if (hit && hit.revision === revisions.get(id)) cached.set(id, hit.vector);
      }
      const uncached = ids.filter((id) => !cached.has(id));
      const texts = await reportTexts(uncached);
      const fresh = await vectorsFor([
        { id: queryId, text: queryText },
        ...uncached.map((id) => ({ id, text: texts.get(id) ?? "", revision: revisions.get(id) })).filter((x) => x.text),
      ]);
      const mine = fresh.get(queryId);
      if (!mine) {
        await considerLexical();
      } else {
        const missing = new Set<string>();
        for (const r of pool) {
          const v = fresh.get(r.article_id) ?? cached.get(r.article_id);
          if (!v || v.length !== mine.length) {
            missing.add(r.article_id);
            continue;
          }
          const s = cosine32(mine, v);
          if (s >= minScore) consider(r, s);
        }
        if (missing.size) await considerLexical(missing);
      }
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, top);
}

/**
 * What the judge sees of a candidate fact: its representative report (first-party first, else the
 * earliest), its size, and whether it started its story (rootFactOf).
 */
async function candidateViews(recalled: Recalled[], db?: Db, excludeArticleId = ""): Promise<CandidateView[]> {
  if (recalled.length === 0) return [];
  if (!db) return sql.begin("isolation level repeatable read read only", (tx) => candidateViews(recalled, tx, excludeArticleId));
  const roots = await storyRootFacts(
    recalled.map((r) => r.storyId),
    db,
  );
  const rows = await db<
    {
      article_id: string;
      input_revision: number | null;
      manual: boolean;
      fact_id: number;
      story_id: number;
      fact_title: string;
      subject: string | null;
      action: string | null;
      object: string | null;
      occurred_at: Date | null;
      title: string;
      summary: string | null;
      source: string;
      first_party: boolean;
      at: Date;
    }[]
  >`
    SELECT fa.article_id, fa.input_revision, fa.manual, fa.fact_id, f.story_id, f.title AS fact_title, f.subject, f.action, f.object, f.occurred_at,
           p.title, p.summary, s.name AS source, p.first_party, coalesce(p.published_at, p.discovered_at) AS at
    FROM fact_articles fa
    JOIN facts f ON f.id = fa.fact_id
    JOIN publications p ON p.article_id = fa.article_id
    JOIN sources s ON s.id = p.source_id
    WHERE fa.fact_id = ANY(${recalled.map((r) => r.factId)}) AND fa.article_id<>${excludeArticleId} AND fa.role IN ('primary', 'report') AND ${trusted("fa")}
    ORDER BY fa.fact_id, (fa.role = 'primary') DESC, p.timeline_at ASC`;
  const qualified = await qualifiedReports(rows, db);
  const byFact = new Map<number, (typeof qualified)[number]>();
  for (const row of qualified) if (!byFact.has(Number(row.fact_id))) byFact.set(Number(row.fact_id), row);
  const selected = await readGroupingSelectionSnapshot(
    "",
    recalled.map((r) => r.factId),
    db,
  );
  return recalled.flatMap((r) => {
    const row = byFact.get(r.factId);
    if (!row) return [];
    const visible = selected.filter((item) => item.fact_id === r.factId && qualified.some((member) => member.article_id === item.article_id));
    const selectedReport = visible.length ? selectionReport(pickRepresentative(visible)) : null;
    return [
      {
        factId: r.factId,
        storyId: Number(row.story_id),
        factTitle: row.fact_title,
        members: qualified.filter((member) => Number(member.fact_id) === r.factId).length,
        storyRoot: roots.get(Number(row.story_id)) === r.factId,
        score: r.score,
        selected: selectedReport !== null,
        selectedReport,
        report: {
          articleId: row.article_id,
          revision: row.material_revision,
          title: row.title,
          source: row.source,
          firstParty: row.first_party,
          at: row.at,
          summary: row.summary,
          frame: {
            subject: row.subject,
            action: row.action,
            object: row.object,
            occurredAt: row.occurred_at ? row.occurred_at.toISOString().slice(0, 10) : null,
          },
        },
      },
    ];
  });
}

function selectionReport(row: GroupingSelectionSnapshot): ReportView {
  return {
    articleId: row.article_id,
    revision: row.material_revision,
    publicationRevision: row.publication_revision,
    title: row.title,
    summary: row.summary,
    source: row.source_name,
    firstParty: row.first_party,
    at: row.published_at,
  };
}

// ---------------------------------------------------------------------------
// Judgement
// ---------------------------------------------------------------------------

export async function relationInput(reports: ReportView[], system: string, render: () => string, checkContext?: () => Promise<void>) {
  const ids = [...new Set(reports.map((r) => r.articleId).filter((id): id is string => !!id))];
  if (reports.some((report) => !report.articleId)) throw new Error("事件裁决缺少双方原材料身份");
  const read = async () => {
    await checkContext?.();
    const originals = await newsRelationMaterials(ids);
    const jurisdictions = await newsRelationJurisdictions(originals);
    const reading = reports.filter((r) => r.publicationRevision !== undefined);
    const selected = reading.length ? await readConfirmedGroupingItems(reading.map((r) => r.articleId!)) : [];
    for (const r of reading) {
      const current = selected.find((p) => p.article_id === r.articleId);
      if (!current || current.publication_revision !== r.publicationRevision || current.material_revision !== r.revision)
        throw new Error("已公开精选背景已变化，须重新判断");
    }
    return originals.map((m) => ({
      ...m,
      jurisdiction: jurisdictions.find((j) => j.id === m.id)?.jurisdiction ?? null,
      ...(selected.some((p) => p.article_id === m.id) ? { publication: selected.find((p) => p.article_id === m.id) } : {}),
    }));
  };
  const initial = await read();
  for (const report of reports) {
    const material = initial.find((m) => m.id === report.articleId);
    if (!material) throw new Error("事件原材料已缺失");
    if (report.revision !== undefined && report.revision !== material.revision) throw new Error("事件原材料已修订，须重新读取候选");
    report.revision = material.revision;
    report.dateVersion = material.source_date_version;
    report.at = material.published_at;
    report.sourceTimeLabel = material.source_time_label;
    report.originalText = material.original_text.slice(0, GROUP_BODY_CHARS);
    report.jurisdiction = material.jurisdiction;
  }
  const user = render();
  const permit = await prepareNewsFallback({ root: shutdownSignal.signal, expected: initial, current: read, articles: initial });
  if (!permit) throw new Error("事件原材料处理许可未证明");
  return { user, fallbackPermit: permit({ system, user }) };
}

async function judgeBatch(articleId: string, query: ReportView, cands: CandidateView[], reading: ReadingContext[]) {
  query.articleId = articleId;
  const checkContext = () => assertReadingContext(articleId, cands, reading);
  const prepared = await relationInput(
    [query, ...cands.flatMap((c) => [c.report, ...(c.selectedReport ? [c.selectedReport] : [])]), ...reading.map((r) => r.report)],
    BATCH_SYSTEM,
    () => batchUser(query, cands, "新报道", reading),
    checkContext,
  );
  const res = await chatJson({
    model: await modelFor("group"),
    purpose: "group_article",
    subject: `article:${articleId}@${query.revision}`,
    promptVersion: BATCH_PROMPT_VERSION,
    system: BATCH_SYSTEM,
    ...prepared,
    schema: ValueBatchSchema.refine(
      (answer) => completeDecisions(answer.decisions, cands.length) && (query.scope !== "unknown" || answer.queryScope !== undefined),
      "Every candidate and any unknown query scope require an explicit answer",
    ),
    temperature: 0,
    maxTokens: 768 + 2048 * cands.length,
  });
  return {
    verdicts: verdictsByFact(res.data.decisions, cands, query),
    selection: cands.some((c) => c.selected) || reading.length ? res.data.selection : NO_SELECTED_COVERAGE,
    queryScope: res.data.queryScope,
    receiptId: res.receiptId,
  };
}

async function recallSelectedBackground(articleId: string, text: string, candidateFacts: number[]): Promise<ReadingContext[]> {
  const pool = (await readGroupingSelectionSnapshot(articleId, [])).filter((row) => row.fact_id === null || !candidateFacts.includes(row.fact_id));
  const useVectors = embeddingsAvailable();
  const vectors =
    useVectors && pool.length
      ? await vectorsFor([{ id: articleId, text }, ...pool.map((r) => ({ id: r.article_id, text: reportText(r.title, r.summary) }))])
      : null;
  const mine = vectors?.get(articleId);
  const seen = new Set<number>();
  return pool
    .map((row) => {
      const vector = vectors?.get(row.article_id);
      const score = mine && vector && mine.length === vector.length ? cosine32(mine, vector) : lexicalSimilarity(text, reportText(row.title, row.summary));
      return { row, score, threshold: mine && vector ? RECALL_MIN_COSINE : LEXICAL_RECALL_MIN };
    })
    .filter((r) => r.score >= r.threshold)
    .sort((a, b) => b.score - a.score || a.row.article_id.localeCompare(b.row.article_id))
    .filter(({ row }) => {
      if (row.fact_id === null) return true;
      if (seen.has(row.fact_id)) return false;
      seen.add(row.fact_id);
      return true;
    })
    .slice(0, 3)
    .map(({ row }) => ({ report: selectionReport(row) }));
}

async function assertReadingContext(articleId: string, cands: CandidateView[], reading: ReadingContext[], db: Db = sql) {
  const current = await readGroupingSelectionSnapshot(
    articleId,
    cands.map((c) => c.factId),
    db,
  );
  for (const candidate of cands) {
    const rows = current.filter((row) => row.fact_id === candidate.factId);
    const representative = rows.length ? pickRepresentative(rows) : null;
    const before = candidate.selectedReport;
    if (
      (!before && representative) ||
      (before &&
        (!representative ||
          representative.article_id !== before.articleId ||
          representative.material_revision !== before.revision ||
          representative.publication_revision !== before.publicationRevision))
    )
      throw new GroupingSupersededError("候选事实的公开精选背景已经变化");
  }
  const selected = await readConfirmedGroupingItems(
    reading.map((r) => r.report.articleId!),
    db,
  );
  for (const { report } of reading)
    if (
      !selected.some(
        (row) => row.article_id === report.articleId && row.material_revision === report.revision && row.publication_revision === report.publicationRevision,
      )
    )
      throw new GroupingSupersededError("已公开精选阅读背景已经变化");
}

/** The review model reads both reports on their own; a merge stands only when it agrees. */
async function confirmMerge(articleId: string, query: ReportView, cand: CandidateView): Promise<{ relation: Relation; confidence: number; receiptId: number }> {
  query.articleId = articleId;
  const prepared = await relationInput([query, cand.report], PAIR_SYSTEM, () => pairUser(query, cand.report));
  const res = await chatJson({
    model: await modelFor("groupReview"),
    purpose: "group_review",
    subject: `article:${articleId}@${query.revision}:fact:${cand.factId}`,
    promptVersion: RELATE_PROMPT_VERSION,
    system: PAIR_SYSTEM,
    ...prepared,
    schema: PairSchema,
    temperature: 0,
    maxTokens: 2560,
  });
  return { relation: validatedRelation(query, cand.report, res.data), confidence: res.data.confidence, receiptId: res.receiptId };
}

async function judgeSignal(articleId: string, query: ReportView, cands: CandidateView[]): Promise<{ verdicts: Map<number, Verdict>; receiptId: number }> {
  query.articleId = articleId;
  const prepared = await relationInput([query, ...cands.map((c) => c.report)], SIGNAL_SYSTEM, () => batchUser(query, cands, "帖子"));
  const res = await chatJson({
    model: await modelFor("group"),
    purpose: "group_signal",
    subject: `article:${articleId}@${query.revision}`,
    promptVersion: RELATE_PROMPT_VERSION,
    system: SIGNAL_SYSTEM,
    ...prepared,
    schema: SignalSchema.refine((answer) => completeDecisions(answer.decisions, cands.length), "Each candidate requires exactly one answer"),
    temperature: 0,
    maxTokens: 512 + 2048 * cands.length,
  });
  return { verdicts: verdictsByFact(res.data.decisions, cands, query), receiptId: res.receiptId };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function createStory(db: Db, title: string, at: Date): Promise<number> {
  const [row] = await db<{ id: number }[]>`
    INSERT INTO stories (public_id, title, status, first_report_at, latest_at, origin)
    VALUES (${newUuid()}, ${title}, 'active', ${at}, ${at}, 'model') RETURNING id`;
  return row!.id;
}

const FactFrame = z
  .object({
    title: z.string().max(80).nullish(),
    subject: z.string().max(80).nullish(),
    action: z.string().max(80).nullish(),
    object: z.string().max(160).nullish(),
    occurredAt: z.string().nullish(),
  })
  .nullable()
  .catch(null);
async function createFact(db: Db, storyId: number, title: string, frame: z.infer<typeof FactFrame>, at: Date): Promise<number> {
  const occurred = typeof frame?.occurredAt === "string" && isValidDate(frame.occurredAt) ? new Date(`${frame.occurredAt}T00:00:00+08:00`) : null;
  const [row] = await db<{ id: number }[]>`
    INSERT INTO facts (public_id, story_id, title, subject, action, object, occurred_at, created_at)
    VALUES (${`f${newShortId(8)}`}, ${storyId}, ${title}, ${frame?.subject ?? null}, ${frame?.action ?? null}, ${frame?.object ?? null}, ${occurred}, ${at})
    RETURNING id`;
  return row!.id;
}

async function recordSignal(db: Db, storyId: number, articleId: string, source: { id: string }, kind: "editorial" | "signal", observedAt: Date) {
  const [identity] = await sourceParticipants([source.id], db);
  const participant = participantKey(identity ?? source);
  await db`
    INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
    VALUES (${storyId}, ${articleId}, ${participant}, ${source.id}, ${kind}, ${observedAt})
    ON CONFLICT (story_id, article_id) DO UPDATE SET participant_key=EXCLUDED.participant_key
    WHERE story_signals.participant_key<>EXCLUDED.participant_key`;
  await captureEventWithdrawal(db, articleId);
  await db`UPDATE stories SET latest_at = GREATEST(coalesce(latest_at, ${observedAt}), ${observedAt}),
              first_report_at = LEAST(coalesce(first_report_at, ${observedAt}), ${observedAt}), updated_at = now()
            WHERE id = ${storyId}`;
}

type DecisionCandidate = { id: number; score: number; relation?: Relation; confidence?: number };

async function recordDecision(
  db: Db,
  articleId: string,
  factId: number | null,
  storyId: number | null,
  verdict: string,
  candidates: DecisionCandidate[],
  receiptId: number | null,
  input?: { revision: number; manifest: unknown },
) {
  await db`INSERT INTO grouping_decisions (article_id,fact_id,story_id,verdict,candidates,receipt_id,input_revision,input_manifest)
    VALUES(${articleId},${factId},${storyId},${verdict},${db.json(candidates as never)},${receiptId},${input?.revision ?? null},${input ? db.json(input.manifest as never) : null})`;
}

/** A manual membership, or "keep standalone": either wins over any model decision. */
async function manualDecision(db: Db, articleId: string): Promise<{ factId: number | undefined } | null> {
  const [manual] = await db<{ fact_id: number }[]>`SELECT fact_id FROM fact_articles WHERE article_id = ${articleId} AND manual LIMIT 1`;
  if (manual) return { factId: manual.fact_id };
  const [standalone] = await db`SELECT 1 FROM grouping_overrides WHERE article_id = ${articleId}`;
  return standalone ? { factId: undefined } : null;
}

/** The automatic membership a report already has (a revision keeps it). */
async function currentMembership(articleId: string, revision: number, db: Db = sql): Promise<{ factId: number; storyId: number } | null> {
  const [row] = await db<{ fact_id: number; story_id: number; input_revision: number | null }[]>`
    SELECT fa.fact_id, fa.input_revision, f.story_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id JOIN stories st ON st.id = f.story_id
    WHERE fa.article_id = ${articleId} AND fa.role IN ('primary', 'report') AND st.merged_into IS NULL
    ORDER BY (fa.role = 'primary') DESC, fa.created_at LIMIT 1`;
  return row?.input_revision === revision ? { factId: Number(row.fact_id), storyId: Number(row.story_id) } : null;
}

/**
 * An explicit regroup starts from a clean slate: automatic memberships and heat evidence go, manual
 * ones stay. Returns the stories the report was a report of.
 */
async function resetAutomatic(articleId: string, control: RuntimeControlSnapshot, input: GroupRunInput): Promise<number[]> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
    await assertRuntimeControl(tx, control);
    await assertGroupingInput(articleId, input, tx);
    if (await manualDecision(tx, articleId)) return [];
    return (await removeAutomaticDateMembership(articleId, tx)) ?? [];
  });
}

/** Date corrections may archive automatic membership; human grouping is never discarded. */
export async function removeAutomaticDateMembership(articleId: string, tx: Db): Promise<number[] | null> {
  const [manual] = await tx`SELECT 1 FROM grouping_overrides WHERE article_id=${articleId}
    UNION ALL SELECT 1 FROM fact_articles WHERE article_id=${articleId} AND manual LIMIT 1`;
  if (manual) return null;
  await captureEventWithdrawal(tx, articleId);
  const left = await tx<{ story_id: number }[]>`
      SELECT DISTINCT f.story_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id
      WHERE fa.article_id = ${articleId} AND NOT fa.manual AND fa.role IN ('primary', 'report') AND f.story_id IS NOT NULL`;
  await tx`DELETE FROM fact_articles WHERE article_id = ${articleId} AND NOT manual`;
  await tx`DELETE FROM story_signals WHERE article_id = ${articleId}`;
  for (const row of left) {
    await tx`UPDATE stories SET digest=NULL,latest=NULL,digest_updated_at=NULL,version=version+1,updated_at=now()
        WHERE id=${row.story_id} AND NOT EXISTS(SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id=f.id
          WHERE f.story_id=${row.story_id} AND fa.role IN ('primary','report'))`;
    await enqueue(QUEUES.digest, { lane: "news", storyId: row.story_id, afterCorrection: true }, { singletonKey: `story:${row.story_id}:correction` }, tx);
  }
  return left.map((r) => Number(r.story_id));
}

/**
 * Stories the report sat in before (its reset, or an earlier decision) that hold no report now keep
 * their address: each merges into the report's story, so its public id redirects there.
 */
async function redirectEmptiedStories(articleId: string, left: number[], storyId: number, control: RuntimeControlSnapshot): Promise<number[]> {
  const emptied = await sql<{ id: number }[]>`
    SELECT st.id FROM stories st
    WHERE (st.id = ANY(${left}::bigint[]) OR st.id IN (SELECT d.story_id FROM grouping_decisions d WHERE d.article_id = ${articleId}))
      AND st.id <> ${storyId} AND st.merged_into IS NULL
      AND NOT EXISTS (SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id WHERE f.story_id = st.id AND fa.role IN ('primary', 'report'))`;
  const redirected: number[] = [];
  for (const { id } of emptied) {
    if (
      await mergeStoryInto(Number(id), storyId, `报道已全部移走，旧地址跳到报道所在事件（最后一篇 ${articleId}）`, "grouping", (tx) =>
        assertRuntimeControl(tx, control),
      )
    )
      redirected.push(Number(id));
  }
  return redirected;
}

/** The live fact another report of the same page belongs to. */
async function sameUrlFact(a: ArticleRow): Promise<PoolRow | null> {
  const [sameUrl] = await qualifiedReports(
    await sql<Omit<PoolRow, "publication_revision">[]>`
    SELECT fa.article_id, fa.fact_id, fa.input_revision, fa.manual, f.story_id, f.title AS fact_title
    FROM articles b JOIN fact_articles fa ON fa.article_id = b.id AND fa.role IN ('primary', 'report')
    JOIN facts f ON f.id = fa.fact_id JOIN stories st ON st.id = f.story_id AND st.merged_into IS NULL
    WHERE b.url = ${a.url} AND b.id <> ${a.id} AND (fa.manual OR fa.input_revision=b.revision) AND ${trusted("fa")} ORDER BY fa.created_at`,
  );
  return sameUrl ?? null;
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

interface StoryRoot {
  storyId: number;
  at: Date;
  /** The story started as a multi-topic digest: never merged. */
  roundup: boolean;
  report: ReportView;
}

/** A story's root (rootFactOf), when it started, and the report that stands for it. */
async function storyRoot(storyId: number, db?: Db): Promise<StoryRoot | null> {
  if (!db) return sql.begin("isolation level repeatable read read only", (tx) => storyRoot(storyId, tx));
  const root = (await storyRootFacts([storyId], db)).get(storyId);
  if (root === undefined) return null;
  const members = await db<ReportMembership[]>`SELECT article_id,input_revision,manual FROM fact_articles fa
    WHERE fact_id=${root} AND role IN ('primary','report') AND ${trusted("fa")}`;
  const qualified = await qualifiedReports(members, db);
  const ids = qualified.map((member) => member.article_id);
  const [row] = await db<
    {
      article_id: string;
      input_revision: number | null;
      manual: boolean;
      subject: string | null;
      action: string | null;
      object: string | null;
      occurred_at: Date | null;
      title: string;
      summary: string | null;
      source: string;
      first_party: boolean;
      at: Date;
      started_at: Date;
      roundup: boolean;
    }[]
  >`
    SELECT fa.article_id,fa.input_revision,fa.manual, f.subject, f.action, f.object, f.occurred_at, p.title, p.summary, s.name AS source, p.first_party,
           coalesce(p.published_at, p.discovered_at) AS at,
           (SELECT min(coalesce(q.published_at, q.discovered_at)) FROM fact_articles z JOIN publications q ON q.article_id = z.article_id
            WHERE z.fact_id = f.id AND z.role IN ('primary', 'report') AND z.article_id=ANY(${ids}::text[]) AND ${trusted("z")}) AS started_at,
           EXISTS (SELECT 1 FROM grouping_decisions d WHERE d.article_id = fa.article_id AND d.verdict = 'roundup') AS roundup
    FROM facts f
    JOIN fact_articles fa ON fa.fact_id = f.id AND fa.role IN ('primary', 'report') AND ${trusted("fa")}
    JOIN publications p ON p.article_id = fa.article_id
    JOIN sources s ON s.id = p.source_id
    WHERE f.id = ${root} AND fa.article_id=ANY(${ids}::text[])
    ORDER BY (fa.role = 'primary') DESC, p.timeline_at ASC LIMIT 1`;
  if (!row) return null;
  return {
    storyId,
    at: row.started_at,
    roundup: row.roundup,
    report: {
      articleId: row.article_id,
      revision: qualified.find((member) => member.article_id === row.article_id)!.material_revision,
      title: row.title,
      source: row.source,
      firstParty: row.first_party,
      at: row.at,
      summary: row.summary,
      frame: { subject: row.subject, action: row.action, object: row.object, occurredAt: row.occurred_at ? row.occurred_at.toISOString().slice(0, 10) : null },
    },
  };
}

async function judgeStories(
  capability: "group" | "groupReview",
  a: StoryRoot,
  b: StoryRoot,
): Promise<{ relation: Relation; confidence: number; difference: string; receiptId: number }> {
  const prepared = await relationInput([a.report, b.report], PAIR_SYSTEM, () => pairUser(a.report, b.report));
  const res = await chatJson({
    model: await modelFor(capability),
    purpose: capability === "group" ? "group_story" : "group_story_review",
    subject: `story:${a.storyId}:${b.storyId}`,
    promptVersion: RELATE_PROMPT_VERSION,
    system: PAIR_SYSTEM,
    ...prepared,
    schema: PairSchema,
    temperature: 0,
    maxTokens: 2560,
  });
  const e = res.data.evidence;
  const verdict =
    res.data.relation === "SAME_STORY" && a.report.at && b.report.at && a.report.at < b.report.at && e
      ? validatedRelation(b.report, a.report, {
          ...res.data,
          evidence: {
            ...e,
            queryQuote: e.candidateQuote,
            candidateQuote: e.queryQuote,
            queryAction: e.candidateAction,
            candidateAction: e.queryAction,
            queryStage: e.candidateStage,
            candidateStage: e.queryStage,
          },
        })
      : validatedRelation(a.report, b.report, res.data);
  return { relation: verdict, confidence: res.data.confidence, difference: res.data.difference, receiptId: res.receiptId };
}

async function liveStory(id: number): Promise<number | null> {
  let current = id;
  for (let hops = 0; hops < 20; hops++) {
    const [st] = await sql<{ merged_into: number | null }[]>`SELECT merged_into FROM stories WHERE id = ${current}`;
    if (!st) return null;
    if (st.merged_into === null) return current;
    current = Number(st.merged_into);
  }
  return null;
}

export interface Consolidation {
  from: number;
  into: number;
  /** Both models see one story (in a dry run: would merge). */
  merge: boolean;
  first: Relation;
  second: Relation | null;
  fromTitle: string;
  intoTitle: string;
  difference: string;
}

/**
 * Stories a report is firmly tied to may be one story that grew two roots. Their roots are compared
 * directly, the earliest against each of the others, and a story merges into the earliest only when
 * the judge and then the review model both see one occurrence or a direct development: a report tied
 * to two different events (a comparison, a roundup) cannot fuse them on its own.
 */
export async function consolidate(storyIds: number[], opts: { dryRun?: boolean } = {}): Promise<Consolidation[]> {
  const live = new Set<number>();
  for (const id of storyIds) {
    const s = await liveStory(id);
    if (s !== null) live.add(s);
  }
  if (live.size < 2) return [];
  const roots = (await Promise.all([...live].map((id) => storyRoot(id)))).filter((r): r is StoryRoot => !!r && !r.roundup);
  if (roots.length < 2) return [];
  await requireRuntimeRunning("news", ["publication"]);
  const control = await runtimeControlSnapshot("news", ["processing", "publication"]);
  roots.sort((x, y) => x.at.getTime() - y.at.getTime() || x.storyId - y.storyId);
  const [anchor, ...others] = roots as [StoryRoot, ...StoryRoot[]];
  const out: Consolidation[] = [];
  for (const other of others) {
    const base = { from: other.storyId, into: anchor.storyId, fromTitle: other.report.title, intoTitle: anchor.report.title };
    const first = await judgeStories("group", anchor, other);
    await completeReceipt(sql, first.receiptId);
    if (!firmlyTied(first.relation, first.confidence)) {
      out.push({ ...base, merge: false, first: first.relation, second: null, difference: first.difference });
      continue;
    }
    // The review model reads the pair the other way round.
    const second = await judgeStories("groupReview", other, anchor);
    await completeReceipt(sql, second.receiptId);
    const merge = firmlyTied(second.relation, second.confidence, STORY_REVIEW_MIN_CONFIDENCE);
    if (merge && !opts.dryRun) {
      await mergeStoryInto(
        other.storyId,
        anchor.storyId,
        `同一事件（${first.relation}，复核 ${second.relation}）：${other.report.title}｜${anchor.report.title}`,
        "grouping",
        (tx) => assertRuntimeControl(tx, control),
      );
    }
    out.push({ ...base, merge, first: first.relation, second: second.relation, difference: first.difference || second.difference });
  }
  return out;
}

/** Reports that must tie two stories that stay apart before each lists the other as a related event. */
const RELATED_MIN_REPORTS = 2;

/**
 * Stories that stay apart although reports tie them (a reaction, a development of a later fact, a
 * comparison) list each other as related events: at least two reports decided in the recall window,
 * each firmly tied to a fact of the other story, none of them a roundup, neither story started by
 * one. A single tie is too often a stray answer about one candidate among many. Links are only
 * added; a merged story drops out where links are read.
 */
export async function linkRelatedStories(): Promise<{ added: number }> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
    await requireRuntimeRunning("news", ["publication"], tx);
    const pairs = await tx<{ x: number; y: number }[]>`
    WITH latest AS (
      SELECT DISTINCT ON (article_id) article_id, verdict, candidates FROM grouping_decisions
      WHERE created_at > now() - make_interval(days => ${RECALL_DAYS}) ORDER BY article_id, id DESC),
    ties AS (
      SELECT DISTINCT l.article_id, own.story_id AS a, other.story_id AS b
      FROM latest l
      JOIN fact_articles fa ON fa.article_id = l.article_id AND fa.role IN ('primary', 'report')
      JOIN facts own ON own.id = fa.fact_id
      CROSS JOIN LATERAL jsonb_array_elements(l.candidates) c
      JOIN facts other ON other.id = (c->>'id')::bigint
      WHERE l.verdict IN ('same-fact', 'same-url', 'new-fact-in-story', 'new-story')
        AND c->>'relation' IN ('SAME_OCCURRENCE', 'SAME_STORY') AND (c->>'confidence')::numeric >= ${TIE_MIN_CONFIDENCE}
        AND other.story_id <> own.story_id),
    pairs AS (
      SELECT least(a, b) AS x, greatest(a, b) AS y FROM ties GROUP BY 1, 2 HAVING count(DISTINCT article_id) >= ${RELATED_MIN_REPORTS}),
    linked AS (
      SELECT p.x,p.y FROM pairs p
      JOIN stories sx ON sx.id=p.x AND sx.merged_into IS NULL
      JOIN stories sy ON sy.id=p.y AND sy.merged_into IS NULL)
    SELECT x,y FROM linked`;
    const roots = await storyRootFacts([...new Set(pairs.flatMap((p) => [p.x, p.y]))], tx);
    const roundup = await tx<{ fact_id: number }[]>`
      SELECT DISTINCT r.fact_id FROM fact_articles r JOIN grouping_decisions d ON d.article_id=r.article_id AND d.verdict='roundup'
      WHERE r.fact_id=ANY(${[...roots.values()]})`;
    const excluded = new Set(roundup.map((r) => r.fact_id));
    const linked = pairs.filter((p) => !excluded.has(roots.get(p.x)!) && !excluded.has(roots.get(p.y)!));
    const left = linked.map((p) => p.x),
      right = linked.map((p) => p.y);
    const [row] = await tx<{ added: number }[]>`
      WITH pairs AS (SELECT * FROM unnest(${left}::bigint[],${right}::bigint[]) AS p(x,y)),
      added AS (INSERT INTO story_links(story_id,other_id,relation)
        SELECT x,y,'related' FROM pairs UNION ALL SELECT y,x,'related' FROM pairs
        ON CONFLICT(story_id,other_id) DO NOTHING RETURNING 1)
      SELECT count(*)::int AS added FROM added`;
    return { added: row?.added ?? 0 };
  });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export interface GroupResult {
  verdict:
    | "same-fact"
    | "same-url"
    | "new-fact-in-story"
    | "new-story"
    | "roundup"
    | "kept"
    | "standalone"
    | "manual"
    | "skipped"
    | "signal"
    | "signal-unmatched"
    | "historical";
  factId?: number;
  storyId?: number;
  /** Stories compared because this report tied them together (see consolidate). */
  consolidated?: Consolidation[];
  consolidationError?: string;
  /** Stories left without reports when this report moved: merged into its story, their public ids redirect. */
  redirected?: number[];
  /** Earlier discussion posts close to the fact this report founded, grouped again (rematchSignals). */
  rematched?: number;
  rematchError?: string;
}

export interface GroupOptions {
  /** Discussion evidence only (hot_signal sources): attach to a story, never create one. */
  signalOnly?: boolean;
  /** An explicit regroup: drop the automatic membership and decide again (manual decisions still win). A report waiting in regroup_pending is regrouped the same way. */
  force?: boolean;
}

/** A newly nominated archive needs the formal coverage path, while human grouping remains authoritative. */
export async function deferHistoricalSelection(articleId: string, revision: number, analysisHash: string, db: Db) {
  if (await manualDecision(db, articleId)) return false;
  const [decision] = await db<{ input_revision: number | null; verdict: string; input_manifest: Record<string, unknown> | null }[]>`
    SELECT input_revision,verdict,input_manifest FROM grouping_decisions WHERE article_id=${articleId} ORDER BY id DESC LIMIT 1`;
  const manifest = decision?.input_manifest;
  if (
    decision?.input_revision === revision &&
    decision.verdict === "historical" &&
    manifest?.materialRevision === revision &&
    manifest.analysisHash === analysisHash &&
    Array.isArray(manifest.reports) &&
    Array.isArray(manifest.candidates)
  )
    return false;
  // Only a model-free completion is resumed. An unproved paid pointer cannot admit a selected seat.
  // The existing pending sweep enqueues this CAS; the old decision and any paid receipt stay intact.
  await resumeCompletedGroupingRecipe({ id: articleId, revision, receipt_id: null }, db);
  return true;
}

export async function requestArticleRegroup(articleId: string, db: Db = sql): Promise<boolean> {
  if (db === sql) return sql.begin((tx) => requestArticleRegroup(articleId, tx));
  await db`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
  const material = await readMaterialGrouping(articleId, db);
  if (!material) return false;
  await captureEventWithdrawal(db, articleId);
  await db`DELETE FROM grouping_overrides WHERE article_id=${articleId}`;
  await db`INSERT INTO regroup_pending(article_id,requested_at) VALUES(${articleId},pg_catalog.clock_timestamp())
    ON CONFLICT(article_id) DO UPDATE SET requested_at=greatest(EXCLUDED.requested_at,regroup_pending.requested_at+interval '1 microsecond')`;
  await beginMaterialGrouping(articleId, material.revision, true, db);
  await invalidateHistoricalBackgrounds([articleId], db);
  await publishArticleTx(db as Tx, articleId);
  return true;
}

export class GroupingSupersededError extends Error {}
interface GroupRunInput {
  revision: number;
  dateVersion: number;
  requestStamp: string | null;
}
async function regroupStamp(articleId: string, db: Db) {
  const [row] = await db<{ stamp: string }[]>`SELECT extract(epoch from requested_at)::text AS stamp FROM regroup_pending WHERE article_id=${articleId}`;
  return row?.stamp ?? null;
}
async function assertGroupingInput(articleId: string, input: GroupRunInput, db: Db, analysisHash?: string) {
  const current = await readMaterialGrouping(articleId, db);
  if (
    !current ||
    current.revision !== input.revision ||
    current.source_date_version !== input.dateVersion ||
    (await regroupStamp(articleId, db)) !== input.requestStamp
  )
    throw new GroupingSupersededError("归组材料或重新归组请求已经变化");
  if (analysisHash !== undefined && groupingAnalysisHash(await readGroupingAnalysis(articleId, input.revision, db)) !== analysisHash)
    throw new GroupingSupersededError("归组使用的内容分析已经变化");
  return current;
}
async function finishGroupingTx(tx: Tx, articleId: string, input: GroupRunInput, selection: SelectionValue, receiptId: number | null) {
  await completeMaterialGrouping(articleId, input.revision, selection, receiptId, tx);
  if (input.requestStamp !== null)
    await tx`DELETE FROM regroup_pending WHERE article_id=${articleId} AND extract(epoch from requested_at)::text=${input.requestStamp}`;
}
async function finishGrouping(articleId: string, input: GroupRunInput, selection: SelectionValue, result: GroupResult, analysisHash?: string) {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
    await assertGroupingInput(articleId, input, tx, analysisHash);
    const manual = await manualDecision(tx, articleId);
    if (!manual)
      await recordDecision(tx, articleId, result.factId ?? null, result.storyId ?? null, result.verdict, [], null, {
        revision: input.revision,
        manifest: {
          version: 1,
          recipe: BATCH_PROMPT_VERSION,
          factConvergenceVersion: FACT_CONVERGENCE_VERSION,
          materialRevision: input.revision,
          analysisHash: analysisHash ?? null,
          selection,
        },
      });
    await finishGroupingTx(tx, articleId, input, manual ? { addsValue: true, reason: "人工确认的归属" } : selection, null);
    await publishArticleTx(tx, articleId);
    return manual ? ({ verdict: "manual", factId: manual.factId } as GroupResult) : result;
  });
}

export async function groupArticle(articleId: string, opts: GroupOptions = {}): Promise<GroupResult> {
  const start = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
    await requireRuntimeRunning("news", ["processing", "publication"], tx);
    const current = await readMaterialGrouping(articleId, tx);
    if (!current) return null;
    const input = { revision: current.revision, dateVersion: current.source_date_version, requestStamp: await regroupStamp(articleId, tx) };
    const manual = await manualDecision(tx, articleId);
    if (manual) {
      await beginMaterialGrouping(articleId, current.revision, true, tx);
      await finishGroupingTx(tx, articleId, input, { addsValue: true, reason: "人工确认的归属" }, null);
      await publishArticleTx(tx, articleId);
      return { input, reuse: { verdict: "manual", factId: manual.factId } as GroupResult };
    }
    if (
      !opts.force &&
      !opts.signalOnly &&
      input.requestStamp === null &&
      current.grouping_status === "complete" &&
      current.grouping_input_revision === current.revision
    ) {
      const membership = await currentMembership(articleId, current.revision, tx);
      await publishArticleTx(tx, articleId);
      return { input, reuse: { verdict: "kept", ...membership } as GroupResult };
    }
    await beginMaterialGrouping(articleId, current.revision, true, tx);
    await publishArticleTx(tx, articleId);
    return { input, reuse: null };
  });
  if (!start) return { verdict: "skipped" };
  if (start.reuse) return start.reuse;
  try {
    return await decide(articleId, opts, start.input);
  } catch (error) {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
      try {
        await assertGroupingInput(articleId, start.input, tx);
      } catch (changed) {
        if (changed instanceof GroupingSupersededError) return;
        throw changed;
      }
      const receiptId = error && typeof error === "object" && "receiptId" in error && typeof error.receiptId === "number" ? error.receiptId : null;
      const waiting =
        shutdownSignal.signal.aborted ||
        error instanceof GroupingSupersededError ||
        error instanceof ModelPostReceiptGuardError ||
        error instanceof BudgetExceededError ||
        error instanceof ReceiptBusyError ||
        error instanceof ReceiptUnknownError ||
        error instanceof RuntimeControlPaused ||
        error instanceof RuntimeControlStale ||
        isModelRouteWaiting(error);
      await failMaterialGrouping(articleId, start.input.revision, { waiting, receiptId, error: String(error) }, tx);
    });
    throw error;
  }
}

async function assertReportInputs(reports: ReportView[], tx: Tx) {
  const ids = [...new Set(reports.map((r) => r.articleId!).filter(Boolean))];
  await lockNewsProcessingPermissions(ids, tx);
  await lockNewsModelMaterials(ids, tx);
  const current = await newsRelationMaterials(ids, tx);
  for (const report of reports) {
    const row = current.find((r) => r.id === report.articleId);
    if (
      !row ||
      row.revision !== report.revision ||
      (report.dateVersion !== undefined && row.source_date_version !== report.dateVersion) ||
      (report.sourceTimeLabel !== undefined && row.source_time_label !== report.sourceTimeLabel) ||
      (report.originalText !== undefined && row.original_text.slice(0, GROUP_BODY_CHARS) !== report.originalText) ||
      (row.published_at?.getTime() ?? null) !== (report.at?.getTime() ?? null)
    )
      throw new GroupingSupersededError("事件证据材料已修订，保持分开并重判");
  }
}

async function decide(articleId: string, opts: GroupOptions, input: GroupRunInput): Promise<GroupResult> {
  const [a] = await sql<ArticleRow[]>`
    SELECT a.id,a.revision,a.title,a.url,a.published_at,a.discovered_at,a.grouped_at,a.body_text,a.backfill,
      EXISTS(SELECT 1 FROM fact_articles fa WHERE fa.article_id=a.id AND NOT fa.manual AND fa.input_revision IS DISTINCT FROM a.revision) AS stale_membership,
      s.id AS source_id,s.name AS source_name,s.first_party,s.participation_mode,
      EXISTS(SELECT 1 FROM regroup_pending rp WHERE rp.article_id=a.id) AS regroup_pending
    FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.id=${articleId}`;
  if (!a) return { verdict: "skipped" };
  if (a.revision !== input.revision) throw new GroupingSupersededError("归组前材料已变化");
  const observedAt = a.published_at ?? a.discovered_at;
  const source = { id: a.source_id };
  const publication = await requireRuntimeRunning("news", ["publication"]),
    processing = await runtimeControlSnapshot("news", ["processing"]);
  const historical = isHistorical(a);
  const mustReset = !!opts.force || a.regroup_pending || a.stale_membership || historical || !!(await currentMembership(articleId, a.revision));
  let left = mustReset ? await resetAutomatic(articleId, await runtimeControlSnapshot("news", ["processing", "publication"]), input) : [];
  if (opts.signalOnly || a.participation_mode !== "editorial") {
    if (historical) return finishGrouping(articleId, input, { addsValue: true, reason: "历史资料按原文时间归档" }, { verdict: "historical" });
    return groupSignal(a, source, observedAt, input);
  }
  const an = await readGroupingAnalysis(articleId, a.revision);
  if (!an) throw new GroupingSupersededError("当前材料仍在等待内容分析");
  const analysisHash = groupingAnalysisHash(an);
  if (historical && !an.selected && !(await groupingSelectionCandidate(articleId, an.id)))
    return finishGrouping(articleId, input, { addsValue: true, reason: "历史资料按原文时间归档" }, { verdict: "historical" }, analysisHash);
  const parsed = z.object({ scope: z.enum(["single", "composite", "unknown"]).catch("unknown"), fact: FactFrame.optional() }).safeParse(an.output);
  let composite = parsed.success && parsed.data.scope === "composite";
  let unresolved = false;
  const frame = parsed.success && !composite ? (parsed.data.fact ?? null) : null;
  const raw = an.output && typeof an.output === "object" ? (an.output as Record<string, unknown>) : {};
  if (an.origin === "model" && an.relevance !== "block" && !("scores" in raw)) throw new GroupingSupersededError("当前材料仍在等待完整内容分析");
  if ((an.relevance !== "pass" || composite || (raw.scope === "unknown" && !frame)) && !mustReset)
    left = await resetAutomatic(articleId, await runtimeControlSnapshot("news", ["processing", "publication"]), input);
  if (an.relevance !== "pass") return finishGrouping(articleId, input, { addsValue: false, reason: "未通过内容分析" }, { verdict: "standalone" }, analysisHash);
  if (raw.scope === "unknown" && !frame)
    return finishGrouping(articleId, input, { addsValue: false, reason: "材料不足以确认当前消息" }, { verdict: "standalone" }, analysisHash);
  const kept = composite ? null : await currentMembership(articleId, a.revision);
  const title = an.title_zh || a.title;
  const query: ReportView = {
    articleId,
    revision: a.revision,
    title,
    source: a.source_name,
    firstParty: a.first_party,
    at: a.published_at,
    summary: an.summary_zh,
    scope: composite ? "composite" : parsed.success ? parsed.data.scope : "unknown",
    frame: frame ? { subject: frame.subject, action: frame.action, object: frame.object, occurredAt: frame.occurredAt } : null,
  };
  const newTitle = String(frame?.title || title).slice(0, 60);
  const sameUrl = composite ? null : await sameUrlFact(a);
  const exact = sameUrl ? [{ factId: sameUrl.fact_id, storyId: sameUrl.story_id, factTitle: sameUrl.fact_title, score: 1 }] : [];
  const exactViews = await candidateViews(exact, undefined, articleId);
  const selectedSameUrl = exactViews.some((c) => c.selected);
  const recalled = selectedSameUrl ? exact : await recallFacts(articleId, reportText(title, an.summary_zh), RECALL_MIN_COSINE, RECALL_TOP_FACTS);
  if (sameUrl && !recalled.some((r) => r.factId === sameUrl.fact_id)) recalled.unshift(exact[0]!);
  const cands = selectedSameUrl ? exactViews : await candidateViews(recalled, undefined, articleId);
  const reading = selectedSameUrl
    ? []
    : await recallSelectedBackground(
        articleId,
        reportText(title, an.summary_zh),
        cands.map((c) => c.factId),
      );
  let verdicts = new Map<number, Verdict>(),
    selection = NO_SELECTED_COVERAGE;
  const receipts: number[] = [];
  const needsJudgement =
    query.scope === "unknown" ||
    (historical && (reading.length || cands.some((c) => c.selected))) ||
    ((!sameUrl || (!selectedSameUrl && (reading.length || cands.some((c) => c.selected)))) && (cands.length || reading.length));
  if (needsJudgement) {
    const judged = await judgeBatch(articleId, query, cands, reading);
    verdicts = judged.verdicts;
    selection = judged.selection;
    receipts.push(judged.receiptId);
    if (query.scope === "unknown") {
      composite = judged.queryScope === "composite";
      unresolved = judged.queryScope === "unknown";
      if ((composite || unresolved) && !mustReset)
        left = await resetAutomatic(articleId, await runtimeControlSnapshot("news", ["processing", "publication"]), input);
      if (unresolved) selection = { addsValue: false, reason: "材料不足以确认当前消息" };
    }
  }
  let verdict: GroupResult["verdict"] = historical
    ? "historical"
    : unresolved
      ? "standalone"
      : composite
        ? "roundup"
        : kept
          ? "kept"
          : sameUrl
            ? "same-url"
            : "new-story";
  let factId: number | null = historical ? null : (kept?.factId ?? sameUrl?.fact_id ?? null);
  let storyId: number | null = historical ? null : (kept?.storyId ?? sameUrl?.story_id ?? null);
  const reviewedSameOccurrence = new Set<number>();
  const reviewCandidate = async (candidate: CandidateView) => {
    const review = await confirmMerge(articleId, query, candidate);
    receipts.push(review.receiptId);
    verdicts.set(candidate.factId, { ...verdicts.get(candidate.factId)!, relation: review.relation, confidence: review.confidence });
    if (review.relation === "SAME_OCCURRENCE") reviewedSameOccurrence.add(candidate.factId);
    return review.relation;
  };
  if (!historical && !composite && !unresolved && !kept && !sameUrl) {
    for (const pick of sameOccurrenceForGrouping(cands, verdicts)) {
      if (pick.score >= CONFIRM_BELOW_COSINE) {
        factId = pick.factId;
        break;
      }
      const relation = await reviewCandidate(pick);
      if (relation === "SAME_OCCURRENCE") {
        factId = pick.factId;
        break;
      }
      if (relation === "SAME_STORY" && pick.storyRoot && !storyId) storyId = pick.storyId;
    }
    if (factId) {
      verdict = "same-fact";
      storyId = cands.find((c) => c.factId === factId)!.storyId;
    } else if (storyId) verdict = "new-fact-in-story";
    else {
      const development = storyForDevelopment(cands, verdicts);
      if (development) {
        verdict = "new-fact-in-story";
        storyId = development.storyId;
      }
    }
    if (factId) {
      const peers = sameOccurrenceForGrouping(cands, verdicts).filter((c) => c.storyId === storyId && c.factId !== factId);
      // One extra pair at most establishes durable evidence for the existing bounded member repair.
      // An unreviewed low-similarity match never authorizes a peer's recovery.
      if (peers.length && !peers.some((c) => c.score >= CONFIRM_BELOW_COSINE || reviewedSameOccurrence.has(c.factId))) await reviewCandidate(peers[0]!);
    }
  }
  if (!composite && !unresolved && factId && cands.some((c) => c.factId === factId && c.selected))
    selection = { addsValue: true, reason: "同一新闻的代表报道候选" };
  if (historical && (selectedSameUrl || sameOccurrence(cands, verdicts).some((candidate) => candidate.selected)))
    selection = { addsValue: false, reason: "同一次发生已有公开精选，历史资料按原文时间归档" };
  const decisionCandidates: DecisionCandidate[] = cands.map((c) => ({
    id: c.factId,
    score: Math.round(c.score * 1000) / 1000,
    relation: verdicts.get(c.factId)?.relation,
    confidence: verdicts.get(c.factId)?.confidence,
  }));
  if (sameUrl) {
    const exactCandidate = decisionCandidates.find((c) => c.id === sameUrl.fact_id);
    if (exactCandidate) Object.assign(exactCandidate, { relation: "SAME_OCCURRENCE", confidence: 1 });
    else decisionCandidates.push({ id: sameUrl.fact_id, score: 1, relation: "SAME_OCCURRENCE", confidence: 1 });
  }
  const evidenceReports = [query, ...cands.flatMap((c) => [c.report, ...(c.selectedReport ? [c.selectedReport] : [])]), ...reading.map((r) => r.report)];
  const convergingFacts = sameOccurrence(cands, verdicts)
    .filter((c) => c.storyId === storyId && (c.score >= CONFIRM_BELOW_COSINE || reviewedSameOccurrence.has(c.factId)))
    .map((c) => c.factId)
    .sort((a, b) => a - b);
  const manifest = {
    version: 1,
    recipe: BATCH_PROMPT_VERSION,
    factConvergenceVersion: FACT_CONVERGENCE_VERSION,
    factConvergence:
      !historical && !composite && !unresolved && convergingFacts.length > 1 && factId === convergingFacts[0]
        ? { version: FACT_CONVERGENCE_VERSION, storyId, canonicalFactId: factId, factIds: convergingFacts }
        : null,
    materialRevision: a.revision,
    analysisHash,
    scope: unresolved ? "unknown" : composite ? "composite" : "single",
    requestStamp: input.requestStamp,
    reports: evidenceReports.map((r) => ({
      articleId: r.articleId,
      revision: r.revision,
      publicationRevision: r.publicationRevision ?? null,
      dateVersion: r.dateVersion ?? null,
      textHash: r.originalText === undefined ? null : sha256(r.originalText),
      at: r.at?.toISOString() ?? null,
    })),
    candidates: cands.map((c) => ({ factId: c.factId, storyId: c.storyId, articleId: c.report.articleId, revision: c.report.revision })),
    selection,
  };
  const written = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
    await assertRuntimeControl(tx, publication);
    if (receipts.length) {
      await assertRuntimeControl(tx, processing);
      await assertReportInputs(evidenceReports, tx);
    }
    await assertGroupingInput(articleId, input, tx, analysisHash);
    await assertReadingContext(articleId, cands, reading, tx);
    const late = await manualDecision(tx, articleId);
    if (late) {
      await finishGroupingTx(tx, articleId, input, { addsValue: true, reason: "人工确认的归属" }, null);
      for (const id of receipts) await completeReceipt(tx, id);
      await publishArticleTx(tx, articleId);
      return { manual: late, factId: null, storyId: null };
    }
    const members = await tx<(ReportMembership & { fact_id: number; story_id: number })[]>`
      SELECT fa.article_id,fa.input_revision,fa.manual,fa.fact_id,f.story_id
      FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id JOIN stories st ON st.id=f.story_id
      WHERE fa.article_id=ANY(${cands.map((c) => c.report.articleId!)}::text[]) AND fa.role IN ('primary','report')
        AND st.merged_into IS NULL AND ${trusted("fa")}`;
    const currentCandidates = await qualifiedReports(members, tx);
    for (const candidate of cands) {
      if (
        !currentCandidates.some(
          (row) =>
            row.fact_id === candidate.factId &&
            row.story_id === candidate.storyId &&
            row.article_id === candidate.report.articleId &&
            row.material_revision === candidate.report.revision,
        )
      )
        throw new GroupingSupersededError("事件候选归属已经变化");
    }
    if (historical || composite || unresolved) {
      for (const candidate of composite && !historical ? cands : []) {
        const relation = verdicts.get(candidate.factId);
        if (!relation || relation.relation === "UNRELATED" || relation.confidence < TIE_MIN_CONFIDENCE) continue;
        await tx`INSERT INTO fact_articles(fact_id,article_id,role,created_at,input_revision)
          VALUES(${candidate.factId},${articleId},'mention',${observedAt},${a.revision}) ON CONFLICT(fact_id,article_id) DO NOTHING`;
      }
      await captureEventWithdrawal(tx, articleId);
      for (const oldStory of left) {
        await tx`UPDATE stories SET digest=NULL,latest=NULL,digest_updated_at=NULL,version=version+1,updated_at=now()
          WHERE id=${oldStory} AND NOT EXISTS(SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id=f.id WHERE f.story_id=${oldStory} AND fa.role IN ('primary','report'))`;
        await enqueue(QUEUES.digest, { lane: "news", storyId: oldStory, afterCorrection: true }, { singletonKey: `story:${oldStory}:correction` }, tx);
      }
      await recordDecision(
        tx,
        articleId,
        null,
        null,
        historical ? "historical" : unresolved ? "standalone" : "roundup",
        decisionCandidates,
        receipts[0] ?? null,
        {
          revision: a.revision,
          manifest,
        },
      );
      await finishGroupingTx(tx, articleId, input, selection, receipts[0] ?? null);
      for (const id of receipts) await completeReceipt(tx, id);
      await publishArticleTx(tx, articleId);
      return { manual: null, factId: null, storyId: null };
    }
    const story = storyId ?? (await createStory(tx, newTitle, observedAt));
    const fact = factId ?? (await createFact(tx, story, newTitle, frame, observedAt));
    const [hasPrimary] = await tx<{ n: number }[]>`SELECT count(*) AS n FROM fact_articles WHERE fact_id=${fact} AND role='primary'`;
    const role = a.first_party && Number(hasPrimary?.n ?? 0) === 0 ? "primary" : "report";
    if (role === "primary" && factId && !kept) {
      await tx`UPDATE stories SET title=${newTitle},updated_at=now() WHERE id=${story} AND origin<>'manual'`;
      await tx`UPDATE facts SET title=${newTitle} WHERE id=${fact}`;
    }
    await tx`INSERT INTO fact_articles(fact_id,article_id,role,created_at,input_revision) VALUES(${fact},${articleId},${role},${observedAt},${a.revision}) ON CONFLICT(fact_id,article_id) DO NOTHING`;
    await recordSignal(tx, story, articleId, source, "editorial", observedAt);
    await recordDecision(tx, articleId, fact, story, verdict, decisionCandidates, receipts[0] ?? null, { revision: a.revision, manifest });
    await finishGroupingTx(tx, articleId, input, selection, receipts[0] ?? null);
    for (const id of receipts) await completeReceipt(tx, id);
    await publishArticleTx(tx, articleId);
    return { manual: null, factId: fact, storyId: story };
  });
  if (written.manual) return { verdict: "manual", factId: written.manual.factId };
  if (historical) return { verdict: "historical" };
  if (composite || unresolved) return { verdict: unresolved ? "standalone" : "roundup" };
  const result: GroupResult = { verdict, factId: written.factId!, storyId: written.storyId! };

  // Other stories this report is firmly tied to: one story may have grown two roots. Best effort:
  // the report's own decision is written; a failed comparison is reported in the job's result.
  const tied = new Set<number>([written.storyId!]);
  for (const c of cands) if (firmlyTied(verdicts.get(c.factId)?.relation, verdicts.get(c.factId)?.confidence)) tied.add(c.storyId);
  if (tied.size > 1) {
    try {
      result.consolidated = await consolidate([...tied]);
      result.storyId = (await liveStory(written.storyId!)) ?? written.storyId!;
    } catch (error) {
      result.consolidationError = String(error).slice(0, 300);
      if (error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale) {
        await ensureQueue(EVENT_CONTINUATIONS.consolidate, EVENT_CONTINUATION_OPTIONS);
        await enqueue(
          EVENT_CONTINUATIONS.consolidate,
          { lane: "news", storyIds: [...tied].sort((a, b) => a - b) },
          { singletonKey: [...tied].sort((a, b) => a - b).join(":"), startAfter: 60 },
        );
      }
    }
  }
  const redirected = await redirectEmptiedStories(articleId, left, result.storyId!, publication);
  if (redirected.length) result.redirected = redirected;
  // A new fact may be what discussion posts of the last hours were about before any report came.
  if (verdict === "new-story" || verdict === "new-fact-in-story") {
    try {
      result.rematched = await rematchSignals(articleId, reportText(title, an.summary_zh));
    } catch (error) {
      result.rematchError = String(error).slice(0, 300);
      if (error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale) {
        await ensureQueue(EVENT_CONTINUATIONS.rematch, EVENT_CONTINUATION_OPTIONS);
        await enqueue(EVENT_CONTINUATIONS.rematch, { lane: "news", articleId }, { singletonKey: articleId, startAfter: 60 });
      }
    }
  }
  return result;
}

/** How far back discussion posts that found no story get another look when a new fact appears. */
const REMATCH_HOURS = 6;

/** Discussion posts not yet attached to any story (a post a person placed or detached is left alone). */
const unattachedSignal = () => sql`
  s.participation_mode = 'hot_signal' AND a.processing_state = 'skipped'
  AND (NOT a.backfill OR a.discovered_at - a.published_at <= make_interval(secs => ${STALE_ON_DISCOVERY_MS / 1000}))
  AND NOT EXISTS (SELECT 1 FROM story_signals ss WHERE ss.article_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM grouping_decisions d WHERE d.article_id = a.id AND d.verdict <> 'signal-unmatched')
  AND NOT EXISTS (SELECT 1 FROM grouping_overrides o WHERE o.article_id = a.id)`;

/** The text a discussion post is recalled by: its title and the start of its body. */
const signalText = (a: { title: string; body_text: string | null }) => reportText(a.title, a.body_text?.slice(0, 300) ?? null);

/** Resume matching from the current stored text; queue payloads do not cache old titles or bodies. */
export async function resumeSignalRematch(articleId: string) {
  const current = (await reportTexts([articleId])).get(articleId);
  return current ? rematchSignals(articleId, current) : 0;
}

/**
 * Discussion posts often come before the first report (Techmeme, reactions): they found no story
 * then and were left. When a report founds a fact, the recent unattached posts close to it are
 * grouped again; each is judged the usual way, against all candidates.
 */
async function rematchSignals(articleId: string, queryText: string): Promise<number> {
  await requireRuntimeRunning("news", ["publication"]);
  const useVectors = embeddingsAvailable();
  const mine = useVectors ? (await vectorsFor([{ id: articleId, text: queryText }])).get(articleId) : null;
  if (useVectors && !mine) return 0;
  const posts = await sql<{ id: string; title: string; body_text: string | null }[]>`
    SELECT a.id, a.title, a.body_text FROM articles a JOIN sources s ON s.id = a.source_id
    WHERE a.discovered_at > now() - make_interval(hours => ${REMATCH_HOURS}) AND ${unattachedSignal()}`;
  const vectors = useVectors ? await vectorsFor(posts.map((p) => ({ id: p.id, text: signalText(p) }))) : new Map<string, Float32Array>();
  let close = 0;
  for (const p of posts) {
    const v = vectors.get(p.id);
    const similarity = useVectors ? (mine && v ? cosine32(mine, v) : 0) : lexicalSimilarity(queryText, signalText(p));
    if (similarity < SIGNAL_MIN_COSINE) continue;
    // A post still waiting in the queue keeps that job (same key): it will meet the new fact anyway.
    await enqueue(QUEUES.group, { lane: "news", articleId: p.id, signalOnly: true }, { singletonKey: p.id, priority: -1 });
    close += 1;
  }
  return close;
}

/**
 * Discussion evidence (hot_signal sources): clear candidates are judged, and a nearly identical
 * report attaches without a call.
 */
async function groupSignal(a: ArticleRow, source: { id: string }, observedAt: Date, input: GroupRunInput): Promise<GroupResult> {
  const publication = await requireRuntimeRunning("news", ["publication"]),
    processing = await runtimeControlSnapshot("news", ["processing"]);
  const recalled = await recallFacts(a.id, signalText(a), SIGNAL_MIN_COSINE, SIGNAL_TOP_FACTS);
  if (recalled.length === 0) {
    // Recorded, so a post that found nothing is told apart from one never decided.
    return finishGrouping(a.id, input, { addsValue: false, reason: "讨论线索不进入精选" }, { verdict: "signal-unmatched" });
  }
  const asCandidates = (verdicts?: Map<number, Verdict>): DecisionCandidate[] =>
    recalled.map((r) => ({
      id: r.factId,
      score: Math.round(r.score * 1000) / 1000,
      relation: verdicts?.get(r.factId)?.relation,
      confidence: verdicts?.get(r.factId)?.confidence,
    }));
  const cands = await candidateViews(recalled, undefined, a.id);
  if (cands.length === 0) return finishGrouping(a.id, input, { addsValue: false, reason: "讨论线索不进入精选" }, { verdict: "signal-unmatched" });
  const query: ReportView = { title: a.title, source: a.source_name, firstParty: false, at: observedAt, summary: a.body_text?.slice(0, 300) ?? null };
  const { verdicts, receiptId } = await judgeSignal(a.id, query, cands);
  const target = signalTarget(cands, verdicts);
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
    await assertRuntimeControl(tx, publication);
    await assertRuntimeControl(tx, processing);
    await assertReportInputs([query, ...cands.map((c) => c.report)], tx);
    await assertGroupingInput(a.id, input, tx);
    const manual = await manualDecision(tx, a.id);
    if (manual) {
      await finishGroupingTx(tx, a.id, input, { addsValue: true, reason: "人工确认的归属" }, null);
      await completeReceipt(tx, receiptId);
      await publishArticleTx(tx, a.id);
      return { verdict: "manual", factId: manual.factId } as GroupResult;
    }
    if (target) {
      const candidate = cands.find((c) => c.factId === target.factId)!;
      const confirmed = (await confirmedGroupingMaterials([candidate.report.articleId!], tx)).some((r) => r.revision === candidate.report.revision);
      const [current] = await tx`SELECT 1 FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id JOIN stories st ON st.id=f.story_id
        WHERE fa.fact_id=${target.factId} AND fa.article_id=${candidate.report.articleId!} AND f.story_id=${target.storyId}
          AND fa.role IN ('primary','report') AND (fa.manual OR (fa.input_revision=${candidate.report.revision!} AND ${confirmed})) AND st.merged_into IS NULL AND ${trusted("fa")}`;
      if (!current) throw new GroupingSupersededError("讨论线索对应的事件已变化");
    }
    if (target) await recordSignal(tx, target.storyId, a.id, source, "signal", observedAt);
    await recordDecision(tx, a.id, target?.factId ?? null, target?.storyId ?? null, target ? "signal" : "signal-unmatched", asCandidates(verdicts), receiptId);
    await completeReceipt(tx, receiptId);
    await finishGroupingTx(tx, a.id, input, { addsValue: false, reason: "讨论线索不进入精选" }, receiptId);
    await publishArticleTx(tx, a.id);
    return (target ? { verdict: "signal", storyId: target.storyId } : { verdict: "signal-unmatched" }) as GroupResult;
  });
}
