import { z } from "zod";
import { isValidDate } from "@amp/contracts/time";
import { newsRelationJurisdictions, readEventPublicationTimes } from "@amp/backend/publication/publish";
import {
  newsRelationMaterials,
  lockNewsModelMaterials,
  manualMaterialSnapshot,
  lockMaterialForGrouping,
  markMaterialGrouped,
} from "@amp/backend/content/materials";
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
import { dbOf, type Db, type Tx } from "../db.ts";
import { newShortId, newUuid, sha256 } from "../lib/ids.ts";
import { chatJson } from "../providers/llm.ts";
import { BudgetExceededError, ReceiptBusyError, completeReceipt, readStoredModelResponse } from "../providers/receipts.ts";
import { embeddingsAvailable, ensureEmbeddings } from "../providers/embeddings.ts";
import { isHistorical, STALE_ON_DISCOVERY_MS } from "../content/materials.ts";
import { enqueue, ensureQueue, QUEUES } from "../jobs/queue.ts";
import { publishArticle, publishArticleTx, articleWithdrawalHeld } from "../publication/publish.ts";
import { mergeStoryInto } from "./merge.ts";

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
  await markMaterialGrouped(tx, articleId, false);
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
    await enqueue(QUEUES.digest, { storyId: id, afterCorrection: true }, { singletonKey: `story:${id}:correction` }, db);
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
  BatchSchema,
  PAIR_SYSTEM,
  PairSchema,
  RELATE_PROMPT_VERSION,
  SIGNAL_SYSTEM,
  STORY_REVIEW_MIN_CONFIDENCE,
  SignalSchema,
  TIE_MIN_CONFIDENCE,
  batchUser,
  firmlyTied,
  lexicalSimilarity,
  looksLikeRoundup,
  pairUser,
  reportText,
  sameOccurrence,
  signalTarget,
  storyForDevelopment,
  verdictsByFact,
  validatedRelation,
  type CandidateView,
  type Relation,
  type ReportView,
  type Verdict,
} from "./relate.ts";

const sql = dbOf("events");
export const EVENT_CONTINUATIONS = { consolidate: "news.events.consolidate", rematch: "news.events.rematch" } as const;
export const EVENT_CONTINUATION_OPTIONS = { policy: "short" as const, retryLimit: 4, retryDelay: 60, expireInSeconds: 600 };

export const GROUP_PROMPT_VERSION = RELATE_PROMPT_VERSION;
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

interface PoolRow {
  article_id: string;
  fact_id: number;
  story_id: number;
  fact_title: string;
}

interface Recalled {
  factId: number;
  storyId: number;
  factTitle: string;
  score: number;
}

export function participantKey(source: { id: string }): string {
  return `source:${source.id}`;
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

/** Empty facts do not start a story; trusted report time wins, then fact ID. */
async function storyRootFacts(storyIds: number[], db: Db = sql): Promise<Map<number, number>> {
  if (!storyIds.length) return new Map();
  const members = await db<{ story_id: number; fact_id: number; article_id: string }[]>`
    SELECT y.story_id,y.id AS fact_id,z.article_id FROM facts y
    JOIN fact_articles z ON z.fact_id=y.id AND z.role IN ('primary','report')
    WHERE y.story_id=ANY(${storyIds}) AND (z.manual OR NOT EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id=z.article_id))`;
  const times = new Map(
    (
      await readEventPublicationTimes(
        members.map((m) => m.article_id),
        db,
      )
    ).map((p) => [p.article_id, BigInt(p.order_time)]),
  );
  const roots = new Map<number, { factId: number; at: bigint }>();
  for (const member of members) {
    const at = times.get(member.article_id);
    if (at === undefined) continue;
    const before = roots.get(member.story_id);
    if (!before || at < before.at || (at === before.at && member.fact_id < before.factId)) roots.set(member.story_id, { factId: member.fact_id, at });
  }
  return new Map([...roots].map(([story, root]) => [story, root.factId]));
}

/** Reports of the recall window that belong to a live fact; those waiting for a regroup only when asked for (the warm-up). */
async function recallPool(withWaiting = false): Promise<PoolRow[]> {
  return sql<PoolRow[]>`
    SELECT fa.article_id, fa.input_revision, fa.manual, fa.fact_id, f.story_id, f.title AS fact_title
    FROM fact_articles fa
    JOIN facts f ON f.id = fa.fact_id
    JOIN stories st ON st.id = f.story_id AND st.merged_into IS NULL
    JOIN articles a ON a.id = fa.article_id
    WHERE fa.role IN ('primary', 'report') AND (${withWaiting} OR fa.manual OR NOT EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id=fa.article_id)) AND a.discovered_at > now() - make_interval(days => ${RECALL_DAYS})`;
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
const vectorCache = new Map<string, { hash: string; vector: Float32Array }>();

async function vectorsFor(items: Array<{ id: string; text: string }>): Promise<Map<string, Float32Array>> {
  const out = new Map<string, Float32Array>();
  const missing: Array<{ id: string; text: string; hash: string }> = [];
  for (const it of items) {
    const hash = sha256(it.text);
    const cached = vectorCache.get(it.id);
    if (cached && cached.hash === hash) out.set(it.id, cached.vector);
    else missing.push({ ...it, hash });
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
      vectorCache.set(m.id, { hash: m.hash, vector });
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
      // Window members already in the cache keep their vector (a later revision of their text is
      // picked up when the cache turns over); only new members and the query are embedded now.
      // A missing or mismatched vector falls back to lexical overlap. A vector that exists and scores
      // under the cosine bar does not: a low cosine is a reject, not a missing measurement.
      const ids = [...new Set(pool.map((r) => r.article_id))];
      const uncached = ids.filter((id) => !vectorCache.has(id));
      const texts = await reportTexts(uncached);
      const fresh = await vectorsFor([{ id: queryId, text: queryText }, ...uncached.map((id) => ({ id, text: texts.get(id) ?? "" })).filter((x) => x.text)]);
      const mine = fresh.get(queryId);
      if (!mine) {
        await considerLexical();
      } else {
        const missing = new Set<string>();
        for (const r of pool) {
          const v = fresh.get(r.article_id) ?? vectorCache.get(r.article_id)?.vector;
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
async function candidateViews(recalled: Recalled[], db?: Db): Promise<CandidateView[]> {
  if (recalled.length === 0) return [];
  if (!db) return sql.begin("isolation level repeatable read read only", (tx) => candidateViews(recalled, tx));
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
      members: number;
    }[]
  >`
    SELECT DISTINCT ON (fa.fact_id) fa.article_id, fa.input_revision, fa.manual, fa.fact_id, f.story_id, f.title AS fact_title, f.subject, f.action, f.object, f.occurred_at,
           p.title, p.summary, s.name AS source, p.first_party, coalesce(p.published_at, p.discovered_at) AS at,
           (SELECT count(*) FROM fact_articles x WHERE x.fact_id = fa.fact_id AND x.role IN ('primary', 'report') AND ${trusted("x")}) AS members
    FROM fact_articles fa
    JOIN facts f ON f.id = fa.fact_id
    JOIN publications p ON p.article_id = fa.article_id
    JOIN sources s ON s.id = p.source_id
    WHERE fa.fact_id = ANY(${recalled.map((r) => r.factId)}) AND fa.role IN ('primary', 'report') AND ${trusted("fa")}
    ORDER BY fa.fact_id, (fa.role = 'primary') DESC, p.timeline_at ASC`;
  const materials = await newsRelationMaterials(
    rows.map((r) => r.article_id),
    db,
  );
  const byFact = new Map(
    rows.filter((r) => r.manual || materials.some((m) => m.id === r.article_id && m.revision === r.input_revision)).map((r) => [Number(r.fact_id), r]),
  );
  return recalled.flatMap((r) => {
    const row = byFact.get(r.factId);
    if (!row) return [];
    return [
      {
        factId: r.factId,
        storyId: Number(row.story_id),
        factTitle: row.fact_title,
        members: Number(row.members),
        storyRoot: roots.get(Number(row.story_id)) === r.factId,
        score: r.score,
        report: {
          articleId: row.article_id,
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

// ---------------------------------------------------------------------------
// Judgement
// ---------------------------------------------------------------------------

async function relationInput(reports: ReportView[], system: string, render: () => string) {
  const ids = [...new Set(reports.map((r) => r.articleId).filter((id): id is string => !!id))];
  if (ids.length !== reports.length) throw new Error("事件裁决缺少双方原材料身份");
  const read = async () => {
    const originals = await newsRelationMaterials(ids);
    const jurisdictions = await newsRelationJurisdictions(originals);
    return originals.map((m) => ({ ...m, jurisdiction: jurisdictions.find((j) => j.id === m.id)?.jurisdiction ?? null }));
  };
  const initial = await read();
  for (const report of reports) {
    const material = initial.find((m) => m.id === report.articleId);
    if (!material) throw new Error("事件原材料已缺失");
    report.revision = material.revision;
    report.at = material.published_at;
    report.originalText = material.original_text.slice(0, 12000);
    report.jurisdiction = material.jurisdiction;
  }
  const user = render();
  const permit = await prepareNewsFallback({ root: shutdownSignal.signal, expected: initial, current: read, articles: initial });
  if (!permit) throw new Error("事件原材料处理许可未证明");
  return { user, fallbackPermit: permit({ system, user }) };
}

async function judgeBatch(articleId: string, query: ReportView, cands: CandidateView[]): Promise<{ verdicts: Map<number, Verdict>; receiptId: number }> {
  query.articleId = articleId;
  const prepared = await relationInput([query, ...cands.map((c) => c.report)], BATCH_SYSTEM, () => batchUser(query, cands));
  const res = await chatJson({
    model: await modelFor("group"),
    purpose: "group_article",
    subject: `article:${articleId}@${query.revision}`,
    promptVersion: RELATE_PROMPT_VERSION,
    system: BATCH_SYSTEM,
    ...prepared,
    schema: BatchSchema,
    temperature: 0,
    // Each verdict now carries two source quotations and the shared action/stage evidence.
    maxTokens: 512 + 2048 * cands.length,
  });
  return { verdicts: verdictsByFact(res.data.decisions, cands, query), receiptId: res.receiptId };
}

/** The review model reads both reports on their own; a merge stands only when it agrees. */
async function confirmMerge(articleId: string, query: ReportView, cand: CandidateView): Promise<{ relation: Relation; receiptId: number }> {
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
  return { relation: validatedRelation(query, cand.report, res.data), receiptId: res.receiptId };
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
    schema: SignalSchema,
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
  await db`
    INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
    VALUES (${storyId}, ${articleId}, ${participantKey(source)}, ${source.id}, ${kind}, ${observedAt})
    ON CONFLICT (story_id, article_id) DO NOTHING`;
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
) {
  await db`INSERT INTO grouping_decisions (article_id, fact_id, story_id, verdict, candidates, receipt_id)
           VALUES (${articleId}, ${factId}, ${storyId}, ${verdict}, ${db.json(candidates as never)}, ${receiptId})`;
}

/** A manual membership, or "keep standalone": either wins over any model decision. */
async function manualDecision(db: Db, articleId: string): Promise<{ factId: number | undefined } | null> {
  const [manual] = await db<{ fact_id: number }[]>`SELECT fact_id FROM fact_articles WHERE article_id = ${articleId} AND manual LIMIT 1`;
  if (manual) return { factId: manual.fact_id };
  const [standalone] = await db`SELECT 1 FROM grouping_overrides WHERE article_id = ${articleId}`;
  return standalone ? { factId: undefined } : null;
}

/** The automatic membership a report already has (a revision keeps it). */
async function currentMembership(articleId: string, revision: number): Promise<{ factId: number; storyId: number } | null> {
  const [row] = await sql<{ fact_id: number; story_id: number; input_revision: number | null }[]>`
    SELECT fa.fact_id, fa.input_revision, f.story_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id JOIN stories st ON st.id = f.story_id
    WHERE fa.article_id = ${articleId} AND fa.role IN ('primary', 'report') AND st.merged_into IS NULL
    ORDER BY (fa.role = 'primary') DESC, fa.created_at LIMIT 1`;
  return row?.input_revision === revision ? { factId: Number(row.fact_id), storyId: Number(row.story_id) } : null;
}

/**
 * An explicit regroup starts from a clean slate: automatic memberships and heat evidence go, manual
 * ones stay. Returns the stories the report was a report of.
 */
async function resetAutomatic(articleId: string, control: RuntimeControlSnapshot): Promise<number[]> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
    await assertRuntimeControl(tx, control);
    await lockMaterialForGrouping(tx, articleId);
    await captureEventWithdrawal(tx, articleId);
    const left = await tx<{ story_id: number }[]>`
      SELECT DISTINCT f.story_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id
      WHERE fa.article_id = ${articleId} AND NOT fa.manual AND fa.role IN ('primary', 'report') AND f.story_id IS NOT NULL`;
    await tx`DELETE FROM fact_articles WHERE article_id = ${articleId} AND NOT manual`;
    await tx`DELETE FROM story_signals WHERE article_id = ${articleId}`;
    return left.map((r) => Number(r.story_id));
  });
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

async function markGrouped(articleId: string) {
  await sql`UPDATE articles SET grouped_at = coalesce(grouped_at, now()) WHERE id = ${articleId}`;
}

/** The live fact another report of the same page belongs to. */
async function sameUrlFact(a: ArticleRow): Promise<PoolRow | null> {
  const [sameUrl] = await sql<(PoolRow & { input_revision: number | null; manual: boolean })[]>`
    SELECT fa.article_id, fa.fact_id, f.story_id, f.title AS fact_title
    FROM articles b JOIN fact_articles fa ON fa.article_id = b.id AND fa.role IN ('primary', 'report')
    JOIN facts f ON f.id = fa.fact_id JOIN stories st ON st.id = f.story_id AND st.merged_into IS NULL
    WHERE b.url = ${a.url} AND b.id <> ${a.id} AND ${trusted("fa")} ORDER BY fa.created_at LIMIT 1`;
  if (!sameUrl || sameUrl.manual) return sameUrl ?? null;
  return (await newsRelationMaterials([sameUrl.article_id]))[0]?.revision === sameUrl.input_revision ? sameUrl : null;
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
            WHERE z.fact_id = f.id AND z.role IN ('primary', 'report') AND ${trusted("z")}) AS started_at,
           EXISTS (SELECT 1 FROM grouping_decisions d WHERE d.article_id = fa.article_id AND d.verdict = 'roundup') AS roundup
    FROM facts f
    JOIN fact_articles fa ON fa.fact_id = f.id AND fa.role IN ('primary', 'report') AND ${trusted("fa")}
    JOIN publications p ON p.article_id = fa.article_id
    JOIN sources s ON s.id = p.source_id
    WHERE f.id = ${root}
    ORDER BY (fa.role = 'primary') DESC, p.timeline_at ASC
    LIMIT 1`;
  if (!row || (!row.manual && (await newsRelationMaterials([row.article_id], db))[0]?.revision !== row.input_revision)) return null;
  return {
    storyId,
    at: row.started_at,
    roundup: row.roundup,
    report: {
      articleId: row.article_id,
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

function storedModelDecisions(response: unknown) {
  const content = (response as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) return null;
  try {
    return BatchSchema.parse(JSON.parse(content)).decisions;
  } catch {
    return null;
  }
}

/**
 * Join a report onto a fact the saved model answer already called the same event.
 * Manual membership and manual story titles stay put. No new model call.
 */
async function moveOntoStoredFact(
  articleId: string,
  targetFactId: number,
  decision: { relation: Relation; confidence: number; evidence?: Verdict["evidence"] },
): Promise<boolean> {
  const [current] = await sql<{ fact_id: number; manual: boolean; origin: string }[]>`
    SELECT fa.fact_id, fa.manual, st.origin FROM fact_articles fa
    JOIN facts f ON f.id = fa.fact_id JOIN stories st ON st.id = f.story_id
    WHERE fa.article_id = ${articleId} AND fa.role IN ('primary', 'report') AND st.merged_into IS NULL
    ORDER BY (fa.role = 'primary') DESC LIMIT 1`;
  if (!current || current.manual || current.origin === "manual" || Number(current.fact_id) === targetFactId) return false;
  const [target] = await sql<{ article_id: string; story_id: number }[]>`
    SELECT fa.article_id, f.story_id FROM fact_articles fa
    JOIN facts f ON f.id = fa.fact_id JOIN stories st ON st.id = f.story_id
    WHERE fa.fact_id = ${targetFactId} AND fa.role IN ('primary', 'report') AND NOT fa.manual
      AND st.merged_into IS NULL AND st.origin <> 'manual'
    ORDER BY (fa.role = 'primary') DESC, fa.created_at LIMIT 1`;
  if (!target) return false;
  const materials = await newsRelationMaterials([articleId, target.article_id]);
  const queryMat = materials.find((item) => item.id === articleId);
  const candidateMat = materials.find((item) => item.id === target.article_id);
  if (!queryMat || !candidateMat) return false;
  const jurisdictions = await newsRelationJurisdictions([
    { id: articleId, revision: queryMat.revision },
    { id: target.article_id, revision: candidateMat.revision },
  ]);
  const times = await readEventPublicationTimes([articleId, target.article_id], sql);
  const atOf = (id: string) => {
    const row = times.find((item) => item.article_id === id);
    return row?.published_at ?? row?.discovered_at ?? null;
  };
  const jurisdictionOf = (id: string, revision: number) => jurisdictions.find((item) => item.id === id && item.revision === revision)?.jurisdiction ?? null;
  const view = (id: string, material: typeof queryMat): ReportView => ({
    title: "",
    source: "",
    firstParty: false,
    at: atOf(id),
    summary: null,
    originalText: material.original_text,
    jurisdiction: jurisdictionOf(id, material.revision),
    frame: null,
  });
  if (validatedRelation(view(articleId, queryMat), view(target.article_id, candidateMat), decision) !== "SAME_OCCURRENCE") return false;
  const moved = await sql.begin(async (tx) => {
    if (await manualDecision(tx, articleId)) return false;
    const [updated] = await tx<{ article_id: string }[]>`
      UPDATE fact_articles SET fact_id = ${targetFactId},
        role = CASE WHEN EXISTS (
          SELECT 1 FROM fact_articles p WHERE p.fact_id = ${targetFactId} AND p.role = 'primary' AND p.article_id <> ${articleId}
        ) THEN 'report' ELSE role END
      WHERE article_id = ${articleId} AND NOT manual AND fact_id <> ${targetFactId}
      RETURNING article_id`;
    if (!updated) return false;
    await tx`UPDATE story_signals SET story_id = ${target.story_id} WHERE article_id = ${articleId}`;
    return true;
  });
  if (!moved) return false;
  await publishArticle(articleId);
  return true;
}

/** Re-apply saved same-event answers from the last two weeks. Does not call a model or rescore. */
export async function replayStoredRelations(since: Date): Promise<{ merged: number }> {
  const rows = await sql<{ article_id: string; receipt_id: number; candidates: Array<{ id: number }> | null }[]>`
    SELECT DISTINCT ON (article_id) article_id, receipt_id, candidates FROM grouping_decisions
    WHERE receipt_id IS NOT NULL AND created_at > ${since}
    ORDER BY article_id, id DESC`;
  let merged = 0;
  for (const row of rows) {
    if (!row.candidates?.length) continue;
    if (await manualDecision(sql, row.article_id)) continue;
    const decisions = storedModelDecisions(await readStoredModelResponse(Number(row.receipt_id)));
    if (!decisions) continue;
    const ranked = decisions
      .flatMap((decision) => {
        const index = Number(String(decision.id).trim().replace(/^C/i, ""));
        const factId = Number.isInteger(index) ? Number(row.candidates?.[index - 1]?.id) : Number.NaN;
        return Number.isInteger(factId) && factId > 0 ? [{ factId, decision }] : [];
      })
      .sort((a, b) => b.decision.confidence - a.decision.confidence);
    for (const pick of ranked) {
      if (await moveOntoStoredFact(row.article_id, pick.factId, pick.decision)) {
        merged += 1;
        break;
      }
    }
  }
  return { merged };
}

export async function groupArticle(articleId: string, opts: GroupOptions = {}): Promise<GroupResult> {
  const result = await decide(articleId, opts);
  // Decided under the current rules: the report is evidence for others again. A failed decision
  // throws before this, so the report keeps waiting and the retry decides it again.
  await sql`DELETE FROM regroup_pending WHERE article_id = ${articleId}`;
  return result;
}

async function decide(articleId: string, opts: GroupOptions): Promise<GroupResult> {
  const [a] = await sql<ArticleRow[]>`
    SELECT a.id, a.revision, a.title, a.url, a.published_at, a.discovered_at, a.grouped_at, a.body_text, a.backfill,
           EXISTS (SELECT 1 FROM fact_articles fa WHERE fa.article_id=a.id AND NOT fa.manual AND fa.input_revision IS DISTINCT FROM a.revision) AS stale_membership,
           s.id AS source_id, s.name AS source_name, s.first_party, s.participation_mode,
           EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id = a.id) AS regroup_pending
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!a) return { verdict: "skipped" };
  const observedAt = a.published_at ?? a.discovered_at;
  const source = { id: a.source_id };

  // Manual decisions win over any model decision: a manual membership, or "keep standalone".
  const manual = await manualDecision(sql, articleId);
  if (manual) {
    await markGrouped(articleId);
    await publishArticle(articleId);
    return { verdict: "manual", factId: manual.factId };
  }
  const publication = await requireRuntimeRunning("news", ["publication"]),
    processing = await runtimeControlSnapshot("news", ["processing"]);
  const left =
    opts.force || a.regroup_pending || a.stale_membership
      ? await resetAutomatic(articleId, await runtimeControlSnapshot("news", ["processing", "publication"]))
      : [];

  // History founds no event and adds no heat (isHistorical); a regroup takes it out of any it joined.
  if (isHistorical(a)) {
    await markGrouped(articleId);
    await publishArticle(articleId);
    return { verdict: "historical" };
  }

  if (opts.signalOnly || a.participation_mode !== "editorial") return groupSignal(a, source, observedAt);

  const kept = await currentMembership(articleId, a.revision);
  if (kept) {
    await markGrouped(articleId);
    await publishArticle(articleId);
    return { verdict: "kept", factId: kept.factId, storyId: kept.storyId };
  }

  const [an] = await sql<{ relevance: string | null; title_zh: string | null; summary_zh: string | null; output: unknown }[]>`
    SELECT relevance, title_zh, summary_zh, output FROM analyses WHERE article_id = ${articleId} AND input_revision=${a.revision} ORDER BY id DESC LIMIT 1`;
  const parsedOutput = z.object({ fact: FactFrame.optional() }).safeParse(an?.output);
  const frame = parsedOutput.success ? (parsedOutput.data.fact ?? null) : null;
  if (an?.relevance !== "pass") {
    await markGrouped(articleId);
    await publishArticle(articleId);
    return { verdict: "standalone" };
  }
  const title = an.title_zh || a.title;
  const query: ReportView = {
    articleId,
    revision: a.revision,
    title,
    source: a.source_name,
    firstParty: a.first_party,
    at: observedAt,
    summary: an.summary_zh,
    frame: frame ? { subject: frame.subject, action: frame.action, object: frame.object, occurredAt: frame.occurredAt } : null,
  };
  const newTitle = String(frame?.title || title).slice(0, 60);

  const sameUrl = await sameUrlFact(a);
  let verdict: GroupResult["verdict"] = "new-story";
  let factId: number | null = null;
  let storyId: number | null = null;
  let cands: CandidateView[] = [];
  let verdicts = new Map<number, Verdict>();
  const receipts: number[] = [];

  if (sameUrl) {
    verdict = "same-url";
    factId = sameUrl.fact_id;
    storyId = sameUrl.story_id;
  } else {
    try {
      cands = await candidateViews(await recallFacts(articleId, reportText(title, an.summary_zh), RECALL_MIN_COSINE, RECALL_TOP_FACTS));
      if (cands.length) {
        const judged = await judgeBatch(articleId, query, cands);
        verdicts = judged.verdicts;
        receipts.push(judged.receiptId);
        for (const pick of sameOccurrence(cands, verdicts)) {
          if (pick.score >= CONFIRM_BELOW_COSINE) {
            factId = pick.factId;
            break;
          }
          const review = await confirmMerge(articleId, query, pick);
          receipts.push(review.receiptId);
          if (review.relation === "SAME_OCCURRENCE") {
            factId = pick.factId;
            break;
          }
          if (review.relation === "SAME_STORY" && pick.storyRoot) {
            storyId = pick.storyId;
            break;
          }
        }
        if (factId) {
          verdict = "same-fact";
          storyId = cands.find((c) => c.factId === factId)!.storyId;
        } else if (storyId) {
          verdict = "new-fact-in-story";
        } else {
          const dev = storyForDevelopment(cands, verdicts);
          if (dev) {
            verdict = "new-fact-in-story";
            storyId = dev.storyId;
          } else if (looksLikeRoundup(cands, verdicts)) verdict = "roundup";
        }
      }
    } catch (error) {
      // A failed identity call must not block publication: the report stays standalone for now.
      await markGrouped(articleId);
      await publishArticle(articleId);
      throw error;
    }
  }

  const decisionCandidates: DecisionCandidate[] = cands.map((c) => ({
    id: c.factId,
    score: Math.round(c.score * 1000) / 1000,
    relation: verdicts.get(c.factId)?.relation,
    confidence: verdicts.get(c.factId)?.confidence,
  }));
  if (sameUrl) decisionCandidates.push({ id: sameUrl.fact_id, score: 1, relation: "SAME_OCCURRENCE", confidence: 1 });

  // Written under the article's row lock after reading the manual state again: a detach or other
  // manual decision made while the model was answering wins (detachFromFact takes the same lock).
  const written = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
    await assertRuntimeControl(tx, publication);
    if (receipts.length) {
      await assertRuntimeControl(tx, processing);
      const evidenceReports = [query, ...cands.map((c) => c.report)];
      await lockNewsProcessingPermissions(evidenceReports.map((r) => r.articleId!).filter(Boolean), tx);
      const current = await lockNewsModelMaterials(evidenceReports.map((r) => r.articleId!).filter(Boolean), tx);
      if (evidenceReports.some((r) => r.articleId && current.find((m) => m.id === r.articleId)?.revision !== r.revision))
        throw new Error("事件证据材料已修订，保持分开并重判");
    }
    const currentRevision = await manualMaterialSnapshot(articleId, tx);
    if (currentRevision?.revision !== a.revision) throw new Error("事件材料在裁决期间已修订");
    const late = await manualDecision(tx, articleId);
    if (late) {
      await markMaterialGrouped(tx, articleId, true);
      return { manual: late, factId: null, storyId: null };
    }
    const story = storyId ?? (await createStory(tx, newTitle, observedAt));
    const fact = factId ?? (await createFact(tx, story, newTitle, frame, observedAt));
    const [hasPrimary] = await tx<{ n: number }[]>`SELECT count(*) AS n FROM fact_articles WHERE fact_id = ${fact} AND role = 'primary'`;
    const role = a.first_party && Number(hasPrimary?.n ?? 0) === 0 ? "primary" : "report";
    // The public event title follows the first official report, not whichever reprint arrived first.
    if (role === "primary" && factId) {
      await tx`UPDATE stories SET title = ${newTitle}, updated_at = now() WHERE id = ${story} AND origin <> 'manual'`;
      await tx`UPDATE facts SET title = ${newTitle} WHERE id = ${fact}`;
    }
    await tx`INSERT INTO fact_articles (fact_id, article_id, role, created_at, input_revision) VALUES (${fact}, ${articleId}, ${role}, ${observedAt}, ${a.revision}) ON CONFLICT (fact_id, article_id) DO NOTHING`;
    await recordSignal(tx, story, articleId, source, "editorial", observedAt);
    await recordDecision(tx, articleId, fact, story, verdict, decisionCandidates, receipts[0] ?? null);
    await markMaterialGrouped(tx, articleId, true);
    return { manual: null, factId: fact, storyId: story };
  });
  for (const id of receipts) await completeReceipt(sql, id);
  await publishArticle(articleId);
  if (written.manual) return { verdict: "manual", factId: written.manual.factId };
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
          { storyIds: [...tied].sort((a, b) => a - b) },
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
        await enqueue(EVENT_CONTINUATIONS.rematch, { articleId }, { singletonKey: articleId, startAfter: 60 });
      }
    }
  }
  return result;
}

/** How far back discussion posts that found no story get another look when a new fact appears. */
const REMATCH_HOURS = 6;

/** Discussion posts not yet attached to any story (a post a person placed or detached is left alone). */
const unattachedSignal = sql`
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
    WHERE a.discovered_at > now() - make_interval(hours => ${REMATCH_HOURS}) AND ${unattachedSignal}`;
  const vectors = useVectors ? await vectorsFor(posts.map((p) => ({ id: p.id, text: signalText(p) }))) : new Map<string, Float32Array>();
  let close = 0;
  for (const p of posts) {
    const v = vectors.get(p.id);
    const similarity = useVectors ? (mine && v ? cosine32(mine, v) : 0) : lexicalSimilarity(queryText, signalText(p));
    if (similarity < SIGNAL_MIN_COSINE) continue;
    // A post still waiting in the queue keeps that job (same key): it will meet the new fact anyway.
    await enqueue(QUEUES.group, { articleId: p.id, signalOnly: true }, { singletonKey: p.id, priority: -1 });
    close += 1;
  }
  return close;
}

/**
 * Discussion evidence (hot_signal sources): clear candidates are judged, and a nearly identical
 * report attaches without a call.
 */
async function groupSignal(a: ArticleRow, source: { id: string }, observedAt: Date): Promise<GroupResult> {
  const publication = await requireRuntimeRunning("news", ["publication"]),
    processing = await runtimeControlSnapshot("news", ["processing"]);
  const recalled = await recallFacts(a.id, signalText(a), SIGNAL_MIN_COSINE, SIGNAL_TOP_FACTS);
  if (recalled.length === 0) {
    // Recorded, so a post that found nothing is told apart from one never decided.
    await recordDecision(sql, a.id, null, null, "signal-unmatched", [], null);
    return { verdict: "signal-unmatched" };
  }
  const asCandidates = (verdicts?: Map<number, Verdict>): DecisionCandidate[] =>
    recalled.map((r) => ({
      id: r.factId,
      score: Math.round(r.score * 1000) / 1000,
      relation: verdicts?.get(r.factId)?.relation,
      confidence: verdicts?.get(r.factId)?.confidence,
    }));
  const cands = await candidateViews(recalled);
  if (cands.length === 0) return { verdict: "signal-unmatched" };
  const query: ReportView = { title: a.title, source: a.source_name, firstParty: false, at: observedAt, summary: a.body_text?.slice(0, 300) ?? null };
  const { verdicts, receiptId } = await judgeSignal(a.id, query, cands);
  const target = signalTarget(cands, verdicts);
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
    await assertRuntimeControl(tx, publication);
    await assertRuntimeControl(tx, processing);
    if (target) await recordSignal(tx, target.storyId, a.id, source, "signal", observedAt);
    await recordDecision(tx, a.id, target?.factId ?? null, target?.storyId ?? null, target ? "signal" : "signal-unmatched", asCandidates(verdicts), receiptId);
    await completeReceipt(tx, receiptId);
  });
  return target ? { verdict: "signal", storyId: target.storyId } : { verdict: "signal-unmatched" };
}

/** Existing automatic memberships have no proven revision after the additive migration; rejudge in bounded batches. */
export async function repairUnboundEventMemberships(limit = 100) {
  const rows = await sql<{ article_id: string }[]>`SELECT DISTINCT article_id FROM fact_articles
    WHERE NOT manual AND input_revision IS NULL ORDER BY article_id LIMIT ${Math.max(1, Math.min(limit, 100))}`;
  let enqueued = 0;
  for (const row of rows)
    if (await enqueue(QUEUES.group, { articleId: row.article_id, lane: "news", force: true }, { singletonKey: row.article_id })) enqueued++;
  return { enqueued, pending: rows.length };
}
