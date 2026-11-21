// Candidates for the event rules in shadow (package 2, step 2.4): the facts the live engine's recall would put before its
// judge for one grouped article, found without a model call and without creating a vector. The universe is the live one
// (events/group.ts recallPool, qualifiedReports, sameUrlFact, recallDocumentFacts, recallKeyFacts,
// recallSelectedBackground): members of live facts discovered in the 14 days before the live decision, qualified the
// same way (current revision and grouping confirmed unless tied by hand, not taken down, not a roundup, not waiting for
// a regroup), the other reports of the same address, named documents over 24 months and same-party-same-amount reports
// of the last 72 hours; and, which the live engine never looks for, the reports with the same stored content hash.
// Like the live engine it ranks facts, not reports: the facts in live order (the same address or hash first, then
// key-fact matches, then by their best report's score), each with a few of its best reports, so one large fact of
// wire copies cannot crowd the others out.
// It runs in the mode the live engine runs in (recallMode: embeddingsAvailable, a configuration check, no call):
//  - lexical (no embeddings: the default, DEC-29): no vector is read; every report of the pool is compared by the
//    live engine's own character-pair overlap (events/relate.ts lexicalScorer) against the live floor
//    LEXICAL_RECALL_MIN, the whole pool as live recall compares it, so recall is complete while the window
//    stays within its bound;
//  - vector (EMBEDDINGS_ENABLED=true): vectors are only read, a missing or stale one falls back to the lexical overlap
//    as live recall does; at most `vectors` reports get a vector per article: the reports found by address, hash,
//    document or key fact first, then the pool's best by lexical overlap (review of design M, F11); the others of the
//    pool are not compared, the selected background likewise at most `background`; recall counts as complete only
//    when the report's own vector was read.
// The mode is part of the stored ruleset, so rows of the two modes are never pooled.
// Where this differs from live recall:
//  - a report whose grouping completed after the live decision is left out: a later report of the same event must not
//    answer for what the live engine could see;
//  - the window keeps at most `window` materials whose grouping is confirmed, archive history last, and the members a
//    person bound by hand (which live counts whatever their grouping state) at most `manual`, the newest first; a window
//    that reaches either bound is reported.
// Memory: per article at most `window` window rows with their titles and summaries are held, and one score per report
// (tests/event-shadow-load.test.ts measures 3,000 and 6,000 reports), all released when the article is done. Vector
// mode only: at most VECTOR_CACHE_BYTES of vectors stay in the process between articles (least recently used dropped
// first), and per article at most 1 + vectors + background vectors are read (2,501 by default: about 10 MB as
// 1,024-dimension Float32Arrays, more while their text form is parsed). Long loops yield to the event loop once SLICE_MS have passed (the
// longest single step, a 12,000-character text's fingerprint and day, takes about 3 ms), and queries run one after
// another, so the worker's other jobs keep their turns and their connections.
import { IDENTITY_LEXICON } from "@amp/industry/taxonomy";
import { newsDiscoveredWindow, newsDuplicateProbes, newsShadowMaterials } from "../../content/materials.ts";
import { sql, type Db } from "../../db.ts";
import { groupingFrames, groupingScopeInputs } from "../../enrichment/records.ts";
import {
  GROUP_ARTICLE_CANDIDATES,
  keyFacts,
  LEXICAL_RECALL_MIN,
  lexicalScorer,
  RECALL_TOP_FACTS,
  reportText,
  sharesKeyFact,
  titleNamesDocument,
} from "../../events/relate.ts";
import { sha256 } from "../../lib/ids.ts";
import { EMBEDDING_MODEL, embeddingsAvailable } from "../../providers/embeddings.ts";
import { readDocumentTitleMatches, readGroupingEvidencePublications, readGroupingReportTexts, readGroupingSelectionSnapshot } from "../../publication/items.ts";

// The live engine's recall values (events/group.ts and publication/items.ts; tests/event-shadow.test.ts keeps them equal).
export const RECALL_DAYS = 14;
export const RECALL_MIN_COSINE = 0.6;
export const DOCUMENT_RECALL_MONTHS = 24;
export const DOCUMENT_RECALL_TOP_FACTS = 3;
export const DOCUMENT_RECALL_ROWS = 400;
export const KEY_FACT_RECALL_HOURS = 72;
export const KEY_FACT_TOP_FACTS = 3;
/** The selected-background window of the live engine (publication/items.ts readGroupingSelectionSnapshot). */
export const BACKGROUND_DAYS = 60;

/** The shadow's own bounds per article. */
export interface RecallLimits {
  /** Window materials read (discovered in the 14 days, grouping confirmed), archive history last. */
  window: number;
  /** Members bound to a live fact by hand looked at, the newest first; those discovered in the 14 days join the window. */
  manual: number;
  /** Vectors read for candidates (vector mode; lexical mode compares the whole pool). */
  vectors: number;
  /** Vectors read for the selected background (vector mode), and its best by lexical overlap compared. */
  background: number;
  /** Facts handed to the rules, in live order, and best reports kept per fact (besides its address and hash twins). */
  facts: number;
  membersPerFact: number;
  /** Address and hash twins looked at. */
  probes: number;
}
export const RECALL_LIMITS: RecallLimits = { window: 40_000, manual: 2_000, vectors: 2_000, background: 500, facts: 20, membersPerFact: 3, probes: 50 };
/** lexical: the live engine runs without embeddings and so does recall; vector: EMBEDDINGS_ENABLED=true. */
export type RecallMode = "lexical" | "vector";
/** The mode the live engine runs in: a configuration check, never a call. */
export function recallMode(): RecallMode {
  return embeddingsAvailable() ? "vector" : "lexical";
}
/**
 * Part of the stored ruleset (shadow.ts shadowRuleset), so rows decided in another mode or under other bounds are never
 * pooled. v4: the mode (lexical rows compare the whole pool, no vector cap).
 */
export function recallRuleset(mode: RecallMode, limits: RecallLimits = RECALL_LIMITS): string {
  const common = `window${limits.window}+manual${limits.manual}/facts${limits.facts}x${limits.membersPerFact}/probes${limits.probes}`;
  return mode === "lexical"
    ? `recall-v4:lexical/pool-all-min${LEXICAL_RECALL_MIN}+background${limits.background}/${common}`
    : `recall-v4:vector/vectors${limits.vectors}+${limits.background}-min${RECALL_MIN_COSINE}/${common}`;
}
export const VECTOR_CACHE_BYTES = 24 * 1024 * 1024;
/** Longest stretch of computation between two turns of the event loop. */
export const SLICE_MS = 15;
const DAY = 86_400_000;

/** One recalled report, with the evidence the rules read. */
export interface RecallHit {
  articleId: string;
  factId: number;
  storyId: number;
  /** The title it is compared by: its public title, else its analysis title, else its own. */
  title: string;
  cosine: number | null;
  lexical: number;
  sameUrl: boolean;
  sameHash: boolean;
  documentKey: boolean;
  /** Its fact has a visible selected report among the fact's qualified members. */
  selected: boolean;
}
export interface RecallInput {
  articleId: string;
  /** reportText of the analysis title and summary, as the live engine embeds the arriving report. */
  text: string;
  /** Document keys of the report's titles; empty for a roundup. */
  documentKeys: string[];
  /** A roundup takes no key-fact or document recall (events/group.ts decide). */
  composite: boolean;
  /** When the live engine decided; recall sees the graph as of then as far as stored times allow. */
  liveAt: Date;
  /** The live engine's mode (recallMode() when absent). */
  mode?: RecallMode;
}
export interface RecallStats {
  window: number;
  windowFull: boolean;
  pool: number;
  /** Candidate reports compared: all of them in lexical mode, those given a vector lookup (at most `vectors`) in vector mode. */
  scored: number;
  /** Vectors read from the database (cached ones aside), background included. */
  vectorsRead: number;
  facts: number;
}
export interface RecallResult {
  candidates: RecallHit[];
  mode: RecallMode;
  /**
   * Recall compared the pool as the live engine does: in lexical mode whenever the window stayed within its bound; with
   * vectors only when, besides, the report's own vector was read.
   */
  recallComplete: boolean;
  /** A visible selected report outside the judged facts is close enough that the live engine asks the value question. */
  readingBackground: boolean;
  stats: RecallStats;
}

interface Membership {
  article_id: string;
  fact_id: number;
  story_id: number;
  fact_title: string;
  input_revision: number | null;
  manual: boolean;
}
interface MaterialState {
  revision: number;
  confirmed: boolean;
  grouped_at: Date | null;
}

/** Vectors kept between articles, the least recently used dropped first, bounded by their bytes. */
export class VectorCache {
  readonly maxBytes: number;
  #entries = new Map<string, { hash: string; vector: Float32Array }>();
  #bytes = 0;
  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }
  get bytes() {
    return this.#bytes;
  }
  get(id: string, hash: string): Float32Array | undefined {
    const hit = this.#entries.get(id);
    if (!hit || hit.hash !== hash) return undefined;
    this.#entries.delete(id);
    this.#entries.set(id, hit);
    return hit.vector;
  }
  set(id: string, hash: string, vector: Float32Array) {
    const old = this.#entries.get(id);
    if (old) {
      this.#entries.delete(id);
      this.#bytes -= old.vector.byteLength;
    }
    if (vector.byteLength > this.maxBytes) return;
    this.#entries.set(id, { hash, vector });
    this.#bytes += vector.byteLength;
    for (const [key, entry] of this.#entries) {
      if (this.#bytes <= this.maxBytes) break;
      this.#entries.delete(key);
      this.#bytes -= entry.vector.byteLength;
    }
  }
}
const cache = new VectorCache(VECTOR_CACHE_BYTES);

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** The `limit` items with the highest score, ties by id: the prefilter that bounds the vectors read (review F11). */
export function topByScore<T extends { id: string; score: number }>(items: readonly T[], limit: number): T[] {
  return [...items].sort((a, b) => b.score - a.score || byId(a.id, b.id)).slice(0, limit);
}

/**
 * topByScore for long lists without one long sort: scores (0 to 1) are counted in 1,001 bands while yielding, and only
 * the band where the cut falls is sorted, in pieces that keep the best so far (a crowd of equal scores is one band);
 * the answer is exactly topByScore's.
 */
export async function topByScoreSliced<T extends { id: string; score: number }>(items: readonly T[], limit: number, turn: () => Promise<void>): Promise<T[]> {
  if (items.length <= limit) return topByScore(items, limit);
  const band = (score: number) => Math.min(1000, Math.max(0, Math.floor(score * 1000)));
  const counts = new Array<number>(1001).fill(0);
  for (const item of items) {
    counts[band(item.score)]!++;
    await turn();
  }
  let floor = 1000,
    above = 0;
  while (floor > 0 && above + counts[floor]! < limit) above += counts[floor--]!;
  const sure: T[] = [],
    edge: T[] = [];
  for (const item of items) {
    const b = band(item.score);
    if (b > floor) sure.push(item);
    else if (b === floor) edge.push(item);
    await turn();
  }
  let best: T[] = [];
  for (let i = 0; i < edge.length; i += 2000) {
    best = topByScore([...best, ...edge.slice(i, i + 2000)], limit - sure.length);
    await turn();
  }
  return topByScore([...sure, ...best], limit);
}

function cosine(a: Float32Array, b: Float32Array): number {
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

/** Call between units of work: yields to the event loop once SLICE_MS have passed since the last turn. */
export function slicer() {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < SLICE_MS) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    since = performance.now();
  };
}

/** Stored vectors whose hash matches the given text; never creates one (no paid call). */
async function storedVectors(items: ReadonlyArray<{ id: string; text: string }>, db: Db): Promise<{ vectors: Map<string, Float32Array>; read: number }> {
  const vectors = new Map<string, Float32Array>();
  const wanted = new Map<string, string>();
  const turn = slicer();
  for (const item of items) {
    const hash = sha256(item.text);
    const hit = cache.get(item.id, hash);
    if (hit) vectors.set(item.id, hit);
    else wanted.set(item.id, hash);
    await turn();
  }
  let read = 0;
  const ids = [...wanted.keys()];
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    const rows = await db<{ ref_id: string; text_hash: string; vector: number[] }[]>`
      SELECT e.ref_id,e.text_hash,e.vector FROM embeddings e
      JOIN unnest(${part}::text[],${part.map((id) => wanted.get(id)!)}::text[]) AS w(id,hash) ON w.id=e.ref_id AND w.hash=e.text_hash
      WHERE e.kind='article' AND e.model=${EMBEDDING_MODEL}`;
    for (const row of rows) {
      const vector = Float32Array.from(row.vector);
      cache.set(row.ref_id, row.text_hash, vector);
      vectors.set(row.ref_id, vector);
      await turn();
    }
    read += rows.length;
    await turn();
  }
  return { vectors, read };
}

/** Members of live facts among these reports (events/group.ts trusted: a report waiting for a regroup only when tied by hand). */
async function liveMemberships(ids: string[], db: Db): Promise<Membership[]> {
  const out: Membership[] = [];
  for (let i = 0; i < ids.length; i += 5000) {
    const part = ids.slice(i, i + 5000);
    out.push(
      ...(await db<Membership[]>`SELECT fa.article_id,fa.fact_id,f.story_id,f.title AS fact_title,fa.input_revision,fa.manual
        FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id JOIN stories st ON st.id=f.story_id AND st.merged_into IS NULL
        WHERE fa.article_id=ANY(${part}::text[]) AND fa.role IN ('primary','report')
          AND (fa.manual OR NOT EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id=fa.article_id))`),
    );
  }
  return out;
}

/**
 * Members a person bound to a live fact, the newest first, at most `limit`. Live recall counts such a member whatever its
 * report's revision or grouping state (events/group.ts trusted and qualifiedReports), so its report may be outside the
 * window of confirmed materials (say, a new revision waiting for its regroup). No index serves `manual`: this reads the
 * membership table, about 30 ms per million memberships.
 */
async function manualMemberships(limit: number, db: Db): Promise<Membership[]> {
  return db<Membership[]>`SELECT fa.article_id,fa.fact_id,f.story_id,f.title AS fact_title,fa.input_revision,fa.manual
    FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id JOIN stories st ON st.id=f.story_id AND st.merged_into IS NULL
    WHERE fa.manual AND fa.role IN ('primary','report') ORDER BY fa.created_at DESC,fa.article_id LIMIT ${limit}`;
}

/**
 * events/group.ts qualifiedReports: a member bound by hand needs only its report to exist, not be taken down and not be a
 * roundup; any other also its current revision with grouping confirmed. Plus, for the others only: a report grouped
 * after the live decision was not yet evidence then.
 */
async function qualify<T extends Membership>(rows: T[], states: ReadonlyMap<string, MaterialState>, liveAt: Date, db: Db): Promise<T[]> {
  const ids = [...new Set(rows.map((row) => row.article_id))];
  if (!ids.length) return [];
  const withdrawn = new Set<string>(),
    composite = new Set<string>();
  for (let i = 0; i < ids.length; i += 5000) {
    const part = ids.slice(i, i + 5000);
    for (const p of await readGroupingEvidencePublications(part, db)) if (p.withdrawn) withdrawn.add(p.article_id);
    for (const s of await groupingScopeInputs(part, db)) if (s.scope === "composite") composite.add(s.article_id);
  }
  return rows.filter((row) => {
    const state = states.get(row.article_id);
    if (!state || withdrawn.has(row.article_id) || composite.has(row.article_id)) return false;
    if (row.manual) return true;
    return row.input_revision === state.revision && state.confirmed && (!state.grouped_at || state.grouped_at.getTime() <= liveAt.getTime());
  });
}

/** The text each report is compared by (events/group.ts reportTexts): public title and summary, else its analysis', else its own title. */
async function reportTexts(ids: string[], db: Db): Promise<Map<string, { title: string; text: string }>> {
  const out = new Map<string, { title: string; text: string }>();
  const turn = slicer();
  for (let i = 0; i < ids.length; i += 5000) {
    const part = ids.slice(i, i + 5000);
    const published = new Map((await readGroupingReportTexts(part, db)).map((p) => [p.article_id, p]));
    const frames = new Map(
      (
        await groupingFrames(
          part.filter((id) => published.get(id)?.summary == null),
          db,
        )
      ).map((f) => [f.article_id, f]),
    );
    const own = new Map(
      (
        await newsShadowMaterials(
          part.filter((id) => !published.has(id)),
          0,
          db,
        )
      ).map((m) => [m.id, m.title]),
    );
    for (const id of part) {
      const p = published.get(id),
        f = frames.get(id);
      const title = p?.title ?? f?.title_zh ?? own.get(id);
      if (title !== undefined) out.set(id, { title, text: reportText(title, p?.summary ?? f?.summary_zh ?? "") });
      await turn();
    }
  }
  return out;
}

/** The `top` facts with the best scores, each scored by its best report as the live engine scores a fact. */
function topFacts<T extends { fact_id: number; score: number }>(rows: readonly T[], top: number): T[] {
  const best = new Map<number, number>();
  for (const row of rows) best.set(row.fact_id, Math.max(best.get(row.fact_id) ?? -Infinity, row.score));
  const keep = new Set(
    [...best]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, top)
      .map(([fact]) => fact),
  );
  return rows.filter((row) => keep.has(row.fact_id));
}

/** Facts naming one of the query's documents over 24 months (events/group.ts recallDocumentFacts), read once, by index. */
async function documentMembers(input: RecallInput, db: Db): Promise<Membership[]> {
  if (!input.documentKeys.length || input.composite) return [];
  const since = new Date(input.liveAt.getTime() - DOCUMENT_RECALL_MONTHS * 30 * DAY);
  const patterns = input.documentKeys.map((key) => `%${key.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const names = (title: string | null | undefined) => input.documentKeys.some((key) => titleNamesDocument(title, key));
  const published = (await readDocumentTitleMatches(patterns, since, DOCUMENT_RECALL_ROWS, db)).filter(
    (row) => row.article_id !== input.articleId && (names(row.title) || names(row.original_title)),
  );
  const named = new Set(published.map((row) => row.article_id));
  // The live query asks for both in one OR, which no index serves; the two halves each take one.
  const byTitle = await db<Membership[]>`SELECT fa.article_id,fa.fact_id,f.story_id,f.title AS fact_title,fa.input_revision,fa.manual
    FROM facts f JOIN stories st ON st.id=f.story_id AND st.merged_into IS NULL
    JOIN fact_articles fa ON fa.fact_id=f.id AND fa.role IN ('primary','report')
    WHERE f.created_at>${since} AND f.title LIKE ANY(${patterns}::text[]) AND fa.article_id<>${input.articleId}
      AND (fa.manual OR NOT EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id=fa.article_id))
    LIMIT ${DOCUMENT_RECALL_ROWS}`;
  const rows = [...(await liveMemberships([...named], db)), ...byTitle];
  const seen = new Set<string>();
  return rows
    .filter((row) => {
      const key = `${row.fact_id}:${row.article_id}`;
      if (seen.has(key) || !(named.has(row.article_id) || names(row.fact_title))) return false;
      seen.add(key);
      return true;
    })
    .slice(0, DOCUMENT_RECALL_ROWS);
}

export async function recallCandidates(input: RecallInput, db: Db = sql, limits: RecallLimits = RECALL_LIMITS): Promise<RecallResult> {
  const { articleId, liveAt } = input;
  const mode = input.mode ?? recallMode();
  const score = lexicalScorer(input.text);
  const turn = slicer();
  const since = new Date(liveAt.getTime() - RECALL_DAYS * DAY);
  const window = await newsDiscoveredWindow(since, liveAt, limits.window, db);
  const states = new Map<string, MaterialState>(window.map((w) => [w.id, { revision: w.revision, confirmed: true, grouped_at: w.grouped_at }]));
  const discovered = new Map(window.map((w) => [w.id, w.discovered_at]));
  // Members bound by hand whose reports, discovered in the same 14 days, the window left out: they count as in live.
  const manual = await manualMemberships(limits.manual, db);
  const windowFull = window.length >= limits.window || manual.length >= limits.manual;
  const bound = new Set(manual.map((m) => m.article_id).filter((id) => id !== articleId && !states.has(id)));
  for (const m of await newsShadowMaterials([...bound], 0, db))
    if (m.discovered_at.getTime() > since.getTime() && m.discovered_at.getTime() <= liveAt.getTime()) {
      states.set(m.id, m);
      discovered.set(m.id, m.discovered_at);
    }
  const pool = await qualify(
    [
      ...(await liveMemberships(
        window.map((w) => w.id).filter((id) => id !== articleId),
        db,
      )),
      ...manual.filter((m) => bound.has(m.article_id) && states.has(m.article_id)),
    ],
    states,
    liveAt,
    db,
  );

  // The other reports of the same address or the same stored hash, any age (events/group.ts sameUrlFact for the address).
  const probes = await newsDuplicateProbes(articleId, limits.probes, db);
  const docMembers = await documentMembers(input, db);
  const outside = [...new Set([...probes.map((p) => p.id), ...docMembers.map((m) => m.article_id)])].filter((id) => !states.has(id));
  for (const m of await newsShadowMaterials(outside, 0, db)) states.set(m.id, m);
  const twins = await qualify(
    await liveMemberships(
      probes.map((p) => p.id),
      db,
    ),
    states,
    liveAt,
    db,
  );
  const documents = await qualify(docMembers, states, liveAt, db);

  // Lexical overlap for everything; same party and same amount in the last 72 hours (events/group.ts recallKeyFacts).
  const texts = await reportTexts([...new Set([...pool, ...twins, ...documents].map((m) => m.article_id))], db);
  const lexical = new Map<string, number>();
  const mine = keyFacts(input.text, IDENTITY_LEXICON);
  const keyable = !input.composite && mine.names.size > 0 && mine.quantities.size > 0;
  const keySince = liveAt.getTime() - KEY_FACT_RECALL_HOURS * 3_600_000;
  const keyedIds = new Set<string>();
  for (const [id, t] of texts) {
    lexical.set(id, score(t.text));
    if (keyable && (discovered.get(id)?.getTime() ?? 0) > keySince && sharesKeyFact(mine, keyFacts(t.text, IDENTITY_LEXICON))) keyedIds.add(id);
    await turn();
  }
  const keyed = pool.filter((m) => keyedIds.has(m.article_id));
  // Vector mode: one budget of vectors, what address, hash, document and key fact found, then the pool's best by lexical
  // overlap. Lexical mode: every report found is compared, as live lexical recall compares the whole pool.
  const byLexical = async (rows: Membership[]) =>
    (
      await topByScoreSliced(
        [...new Set(rows.map((m) => m.article_id))].filter((id) => texts.has(id)).map((id) => ({ id, score: lexical.get(id)! })),
        limits.vectors,
        turn,
      )
    ).map((x) => x.id);
  const scoredIds =
    mode === "lexical"
      ? [...texts.keys()]
      : [...new Set([...(await byLexical(twins)), ...(await byLexical(documents)), ...(await byLexical(keyed)), ...(await byLexical(pool))])].slice(
          0,
          limits.vectors,
        );
  const scored = new Set(scoredIds);
  const { vectors, read } =
    mode === "lexical"
      ? { vectors: new Map<string, Float32Array>(), read: 0 }
      : await storedVectors([{ id: articleId, text: input.text }, ...scoredIds.map((id) => ({ id, text: texts.get(id)!.text }))], db);
  const query = vectors.get(articleId);
  const cosineOf = (id: string) => {
    const v = vectors.get(id);
    return query && v && v.length === query.length ? cosine(query, v) : null;
  };
  // The live engine's recall score: cosine when both vectors are current, else the lexical overlap.
  const withScore = async <T extends Membership>(rows: T[]) => {
    const out: Array<T & { score: number }> = [];
    for (const m of rows) {
      if (!texts.has(m.article_id)) continue;
      out.push({ ...m, score: cosineOf(m.article_id) ?? lexical.get(m.article_id) ?? 0 });
      await turn();
    }
    return out;
  };
  // Pool recall compares the reports scored (all in lexical mode); a low cosine is a reject, a missing vector falls back.
  const recalled = topFacts(
    (await withScore(pool.filter((m) => scored.has(m.article_id)))).filter((m) =>
      cosineOf(m.article_id) !== null ? m.score >= RECALL_MIN_COSINE : (lexical.get(m.article_id) ?? 0) >= LEXICAL_RECALL_MIN,
    ),
    RECALL_TOP_FACTS,
  );

  // Facts in live order (address or hash twin first, then key-fact matches, then by best score), a few reports each.
  const sameUrl = new Set(probes.filter((p) => p.same === "url").map((p) => p.id)),
    sameHash = new Set(probes.filter((p) => p.same === "hash").map((p) => p.id));
  const facts = new Map<number, { rank: number; best: number; storyId: number; members: Map<string, { score: number; twin: boolean; doc: boolean }> }>();
  const add = (rows: Array<Membership & { score: number }>, rank: number, how: { twin?: boolean; doc?: boolean } = {}) => {
    for (const m of rows) {
      const f = facts.get(m.fact_id) ?? { rank, best: m.score, storyId: m.story_id, members: new Map() };
      f.rank = Math.min(f.rank, rank);
      f.best = Math.max(f.best, m.score);
      const before = f.members.get(m.article_id);
      f.members.set(m.article_id, { score: m.score, twin: !!how.twin || !!before?.twin, doc: !!how.doc || !!before?.doc });
      facts.set(m.fact_id, f);
    }
  };
  add(await withScore(twins), 0, { twin: true });
  add(topFacts(await withScore(keyed), KEY_FACT_TOP_FACTS), 1);
  add(topFacts(await withScore(documents), DOCUMENT_RECALL_TOP_FACTS), 2, { doc: true });
  add(recalled, 2);
  const ordered = [...facts].sort((a, b) => a[1].rank - b[1].rank || b[1].best - a[1].best || a[0] - b[0]).slice(0, limits.facts);
  const candidates: RecallHit[] = ordered.flatMap(([factId, f]) => {
    const members = [...f.members].sort((a, b) => b[1].score - a[1].score || byId(a[0], b[0]));
    // Every address or hash twin stays (rules 1 and 2 take the earliest), plus the fact's best few reports.
    const kept = [...members.filter(([, m]) => m.twin), ...members.filter(([, m]) => !m.twin).slice(0, limits.membersPerFact)];
    return kept.map(([id, m]) => ({
      articleId: id,
      factId,
      storyId: f.storyId,
      title: texts.get(id)!.title,
      cosine: cosineOf(id),
      lexical: lexical.get(id) ?? 0,
      sameUrl: sameUrl.has(id),
      sameHash: sameHash.has(id),
      documentKey: m.doc,
      selected: false,
    }));
  });

  // Selection: a fact counts as selected when a visible pick is one of its qualified members; the picks of the last 60
  // days outside the judged facts are the reading background the live engine compares the report with.
  const factIds = ordered.map(([factId]) => factId);
  const picks = await readGroupingSelectionSnapshot(articleId, factIds, db);
  const memberPicks = await qualify(
    (await liveMemberships([...new Set(picks.filter((p) => p.fact_id !== null && factIds.includes(p.fact_id)).map((p) => p.article_id))], db)).filter((m) =>
      picks.some((p) => p.article_id === m.article_id && p.fact_id === m.fact_id),
    ),
    new Map(picks.map((p) => [p.article_id, { revision: p.material_revision, confirmed: true, grouped_at: null }])),
    liveAt,
    db,
  );
  const selectedFacts = new Set(memberPicks.map((m) => m.fact_id));
  for (const c of candidates) c.selected = selectedFacts.has(c.factId);
  const judged = judgedFactIds(candidates);
  const now = Date.now();
  const near: Array<{ id: string; score: number; text: string }> = [];
  for (const p of picks) {
    if (p.fact_id !== null && judged.includes(p.fact_id)) continue;
    if (p.discovered_at.getTime() <= now - BACKGROUND_DAYS * DAY || (p.fact_id !== null && p.discovered_at.getTime() > now - RECALL_DAYS * DAY)) continue;
    const text = reportText(p.title, p.summary);
    near.push({ id: p.article_id, score: score(text), text });
    await turn();
  }
  const background = await topByScoreSliced(near, limits.background, turn);
  const extra = query ? await storedVectors(background, db) : { vectors: new Map<string, Float32Array>(), read: 0 };
  let readingBackground = false;
  for (const n of background) {
    const v = extra.vectors.get(n.id);
    const value = query && v && v.length === query.length ? cosine(query, v) : n.score;
    if (value >= (query && v ? RECALL_MIN_COSINE : LEXICAL_RECALL_MIN)) {
      readingBackground = true;
      break;
    }
    await turn();
  }

  return {
    candidates,
    mode,
    // A window at its bound may have left the live engine's match out: never complete then.
    recallComplete: !windowFull && (mode === "lexical" || !!query),
    readingBackground,
    stats: {
      window: window.length,
      windowFull,
      pool: pool.length,
      scored: scoredIds.length,
      vectorsRead: read + extra.read,
      facts: ordered.length,
    },
  };
}

/** The facts the rules will judge (pipeline/events/rules.ts recallOrder, judgedFacts): same address, same hash, score. */
export function judgedFactIds(candidates: readonly RecallHit[]): number[] {
  const ordered = [...candidates].sort(
    (a, b) =>
      Number(b.sameUrl) - Number(a.sameUrl) ||
      Number(b.sameHash) - Number(a.sameHash) ||
      (b.cosine ?? b.lexical) - (a.cosine ?? a.lexical) ||
      byId(a.articleId, b.articleId),
  );
  return [...new Set(ordered.map((c) => c.factId))].slice(0, GROUP_ARTICLE_CANDIDATES);
}
