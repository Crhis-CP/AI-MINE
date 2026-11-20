// Candidates for the event rules in shadow (package 2, step 2.4): the reports the live engine's recall would put before
// its judge for one grouped article, found without a model call and without creating a vector. The universe is the
// live one (events/group.ts recallPool, qualifiedReports, sameUrlFact, recallDocumentFacts, recallKeyFacts,
// recallSelectedBackground): members of live facts discovered in the 14 days before the live decision, qualified the
// same way (current revision and grouping confirmed unless tied by hand, not taken down, not a roundup, not waiting for
// a regroup), the other reports of the same address, named documents over 24 months and same-party-same-amount reports
// of the last 72 hours; and, which the live engine never looks for, the reports with the same stored content hash.
// Where this differs from live recall, the agreement report's recall hit rate measures the effect:
//  - vectors are only read: a missing or stale one falls back to the lexical overlap, as live recall does;
//  - before any vector is read the pool is cut to the VECTOR_LIMIT reports with the most lexical overlap (review of
//    design M, F11), and the selected background to BACKGROUND_VECTOR_LIMIT;
//  - a report whose grouping completed after the live decision is left out: a later report of the same event must not
//    answer for what the live engine could see;
//  - the window keeps at most WINDOW_LIMIT materials, the most recently discovered.
// Memory: at most VECTOR_CACHE_BYTES of vectors stay in the process between articles (least recently used dropped
// first); per article at most VECTOR_LIMIT + BACKGROUND_VECTOR_LIMIT vectors are scored and at most WINDOW_LIMIT window
// rows and their texts are held, all released when the article is done.
import { IDENTITY_LEXICON } from "@amp/industry/taxonomy";
import { newsDiscoveredWindow, newsDuplicateProbes, newsShadowMaterials } from "../../content/materials.ts";
import { sql, type Db } from "../../db.ts";
import { groupingFrames, groupingScopeInputs } from "../../enrichment/records.ts";
import {
  LEXICAL_RECALL_MIN,
  RECALL_TOP_FACTS,
  GROUP_ARTICLE_CANDIDATES,
  keyFacts,
  reportText,
  sharesKeyFact,
  titleNamesDocument,
} from "../../events/relate.ts";
import { sha256 } from "../../lib/ids.ts";
import { EMBEDDING_MODEL } from "../../providers/embeddings.ts";
import { readDocumentTitleMatches, readGroupingEvidencePublications, readGroupingReportTexts, readGroupingSelectionSnapshot } from "../../publication/items.ts";

// The live engine's recall values (events/group.ts; tests/event-shadow.test.ts keeps them equal).
export const RECALL_DAYS = 14;
export const RECALL_MIN_COSINE = 0.6;
export const DOCUMENT_RECALL_MONTHS = 24;
export const DOCUMENT_RECALL_TOP_FACTS = 3;
export const DOCUMENT_RECALL_ROWS = 400;
export const KEY_FACT_RECALL_HOURS = 72;
export const KEY_FACT_TOP_FACTS = 3;
/** The selected-background window of the live engine (publication/items.ts readGroupingSelectionSnapshot). */
const BACKGROUND_DAYS = 60;
// The shadow's own bounds.
export const WINDOW_LIMIT = 40_000;
export const VECTOR_LIMIT = 2_000;
export const BACKGROUND_VECTOR_LIMIT = 500;
export const VECTOR_CACHE_BYTES = 24 * 1024 * 1024;
export const PROBE_LIMIT = 50;
/** Reports handed to the rules; their bodies are read for the fingerprint. */
export const CANDIDATE_LIMIT = 60;
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
}
export interface RecallResult {
  candidates: RecallHit[];
  /** A stored vector matches the report's text: recall had its full reach. */
  hasVector: boolean;
  /** A visible selected report outside the judged facts is close enough that the live engine asks the value question. */
  readingBackground: boolean;
  stats: { window: number; pool: number; scored: number; vectorsRead: number; windowFull: boolean };
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

/** events/relate.ts lexicalSimilarity with the query's bigrams built once; the same number for every pair. */
export function lexicalScorer(query: string): (text: string) => number {
  const grams = (s: string) => {
    const chars = [...s.replace(/\s+/g, "")];
    return new Set(chars.map((_c, i) => chars.slice(i, i + 2).join("")).filter((g) => g.length === 2));
  };
  const g = grams(query);
  return (text) => {
    if (!g.size) return 0;
    const h = grams(text);
    if (!h.size) return 0;
    let inter = 0;
    for (const x of g) if (h.has(x)) inter++;
    return inter / Math.min(g.size, h.size);
  };
}

/** The `limit` items with the highest score, ties by id: the prefilter that bounds the vectors read (review F11). */
export function topByScore<T extends { id: string; score: number }>(items: readonly T[], limit: number): T[] {
  return [...items].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
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

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Stored vectors whose hash matches the given text; never creates one (no paid call). */
async function storedVectors(items: ReadonlyArray<{ id: string; text: string }>, db: Db): Promise<{ vectors: Map<string, Float32Array>; read: number }> {
  const vectors = new Map<string, Float32Array>();
  const wanted = new Map<string, string>();
  for (const item of items) {
    const hash = sha256(item.text);
    const hit = cache.get(item.id, hash);
    if (hit) vectors.set(item.id, hit);
    else wanted.set(item.id, hash);
  }
  let read = 0;
  const ids = [...wanted.keys()];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const rows = await db<{ ref_id: string; text_hash: string; vector: number[] }[]>`
      SELECT e.ref_id,e.text_hash,e.vector FROM embeddings e
      JOIN unnest(${part}::text[],${part.map((id) => wanted.get(id)!)}::text[]) AS w(id,hash) ON w.id=e.ref_id AND w.hash=e.text_hash
      WHERE e.kind='article' AND e.model=${EMBEDDING_MODEL}`;
    for (const row of rows) {
      const vector = Float32Array.from(row.vector);
      cache.set(row.ref_id, row.text_hash, vector);
      vectors.set(row.ref_id, vector);
    }
    read += rows.length;
    await yieldToLoop();
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

/** events/group.ts qualifiedReports, plus: a report grouped after the live decision was not yet evidence then. */
async function qualify<T extends Membership>(rows: T[], states: ReadonlyMap<string, MaterialState>, liveAt: Date, db: Db): Promise<T[]> {
  const ids = [...new Set(rows.map((row) => row.article_id))];
  if (!ids.length) return [];
  const withdrawn = new Set<string>(),
    composite = new Set<string>();
  for (let i = 0; i < ids.length; i += 5000) {
    const part = ids.slice(i, i + 5000);
    const [publications, scopes] = await Promise.all([readGroupingEvidencePublications(part, db), groupingScopeInputs(part, db)]);
    for (const p of publications) if (p.withdrawn) withdrawn.add(p.article_id);
    for (const s of scopes) if (s.scope === "composite") composite.add(s.article_id);
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
  for (let i = 0; i < ids.length; i += 5000) {
    const part = ids.slice(i, i + 5000);
    const published = new Map((await readGroupingReportTexts(part, db)).map((p) => [p.article_id, p]));
    const thin = part.filter((id) => published.get(id)?.summary == null);
    const frames = new Map((await groupingFrames(thin, db)).map((f) => [f.article_id, f]));
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
      if (title === undefined) continue;
      out.set(id, { title, text: reportText(title, p?.summary ?? f?.summary_zh ?? "") });
    }
    await yieldToLoop();
  }
  return out;
}

/** Best report per fact, the `top` facts with the best scores (the live engine scores a fact by its best report). */
function topFacts<T extends { fact_id: number; article_id: string; score: number }>(rows: readonly T[], top: number): T[] {
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

export async function recallCandidates(input: RecallInput, db: Db = sql): Promise<RecallResult> {
  const { articleId, liveAt } = input;
  const score = lexicalScorer(input.text);
  const window = await newsDiscoveredWindow(new Date(liveAt.getTime() - RECALL_DAYS * DAY), liveAt, WINDOW_LIMIT, db);
  const states = new Map<string, MaterialState>(window.map((w) => [w.id, w]));
  const discovered = new Map(window.map((w) => [w.id, w.discovered_at]));
  const pool = await qualify(
    await liveMemberships(
      window.map((w) => w.id).filter((id) => id !== articleId),
      db,
    ),
    states,
    liveAt,
    db,
  );

  // The other reports of the same address or the same stored hash, any age (events/group.ts sameUrlFact for the address).
  const probes = await newsDuplicateProbes(articleId, PROBE_LIMIT, db);
  const twinIds = probes.map((p) => p.id);
  // Facts naming one of the query's documents over 24 months (events/group.ts recallDocumentFacts).
  const docMembers: Membership[] = [];
  if (input.documentKeys.length && !input.composite) {
    const since = new Date(liveAt.getTime() - DOCUMENT_RECALL_MONTHS * 30 * DAY);
    const patterns = input.documentKeys.map((key) => `%${key.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const names = (title: string | null | undefined) => input.documentKeys.some((key) => titleNamesDocument(title, key));
    const published = (await readDocumentTitleMatches(patterns, since, DOCUMENT_RECALL_ROWS, db)).filter(
      (row) => row.article_id !== articleId && (names(row.title) || names(row.original_title)),
    );
    const named = new Set(published.map((row) => row.article_id));
    const rows = await db<Membership[]>`SELECT fa.article_id,fa.fact_id,f.story_id,f.title AS fact_title,fa.input_revision,fa.manual
      FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id JOIN stories st ON st.id=f.story_id AND st.merged_into IS NULL
      WHERE fa.role IN ('primary','report') AND fa.article_id<>${articleId}
        AND (fa.manual OR NOT EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id=fa.article_id))
        AND (fa.article_id=ANY(${[...named]}::text[]) OR (f.created_at>${since} AND f.title LIKE ANY(${patterns}::text[])))
      LIMIT ${DOCUMENT_RECALL_ROWS}`;
    docMembers.push(...rows.filter((row) => named.has(row.article_id) || names(row.fact_title)));
  }
  const outside = [...new Set([...twinIds, ...docMembers.map((m) => m.article_id)])].filter((id) => !states.has(id));
  for (const m of await newsShadowMaterials(outside, 0, db)) states.set(m.id, m);
  const twins = await qualify(await liveMemberships(twinIds, db), states, liveAt, db);
  const documents = await qualify(docMembers, states, liveAt, db);

  // Lexical overlap for everything, vectors only for the best of the pool (the prefilter) and for the few found otherwise.
  const texts = await reportTexts([...new Set([...pool, ...twins, ...documents].map((m) => m.article_id))], db);
  const lexical = new Map<string, number>();
  const mine = keyFacts(input.text, IDENTITY_LEXICON);
  const keyedIds = new Set<string>();
  const keySince = liveAt.getTime() - KEY_FACT_RECALL_HOURS * 3_600_000;
  const keyable = !input.composite && mine.names.size > 0 && mine.quantities.size > 0;
  let n = 0;
  for (const [id, t] of texts) {
    lexical.set(id, score(t.text));
    // Same party and same amount in the last 72 hours (events/group.ts recallKeyFacts): judged however worded.
    if (keyable && (discovered.get(id)?.getTime() ?? 0) > keySince && sharesKeyFact(mine, keyFacts(t.text, IDENTITY_LEXICON))) keyedIds.add(id);
    if (++n % 2000 === 0) await yieldToLoop();
  }
  const poolIds = [...new Set(pool.map((m) => m.article_id))].filter((id) => texts.has(id));
  const prefiltered = new Set(
    topByScore(
      poolIds.map((id) => ({ id, score: lexical.get(id)! })),
      VECTOR_LIMIT,
    ).map((x) => x.id),
  );
  const keyed = pool.filter((m) => keyedIds.has(m.article_id));
  const scoredIds = new Set([...prefiltered, ...twins.map((m) => m.article_id), ...documents.map((m) => m.article_id), ...keyed.map((m) => m.article_id)]);
  const { vectors, read } = await storedVectors(
    [{ id: articleId, text: input.text }, ...[...scoredIds].filter((id) => texts.has(id)).map((id) => ({ id, text: texts.get(id)!.text }))],
    db,
  );
  const query = vectors.get(articleId);
  const cosineOf = (id: string) => {
    const v = vectors.get(id);
    return query && v && v.length === query.length ? cosine(query, v) : null;
  };
  // The live engine's recall score: cosine when both vectors are current, else the lexical overlap.
  const similarity = (id: string) => cosineOf(id) ?? lexical.get(id) ?? 0;
  const withScore = <T extends Membership>(rows: T[]) => rows.filter((m) => texts.has(m.article_id)).map((m) => ({ ...m, score: similarity(m.article_id) }));

  const recalled = topFacts(
    withScore(pool.filter((m) => prefiltered.has(m.article_id))).filter((m) =>
      cosineOf(m.article_id) !== null ? m.score >= RECALL_MIN_COSINE : (lexical.get(m.article_id) ?? 0) >= LEXICAL_RECALL_MIN,
    ),
    RECALL_TOP_FACTS,
  );
  const hits = new Map<string, RecallHit & { order: number }>();
  const sameUrl = new Set(probes.filter((p) => p.same === "url").map((p) => p.id)),
    sameHash = new Set(probes.filter((p) => p.same === "hash").map((p) => p.id));
  const add = (rows: Array<Membership & { score: number }>, order: number, documentKey = false) => {
    for (const m of rows) {
      const before = hits.get(m.article_id);
      hits.set(m.article_id, {
        articleId: m.article_id,
        factId: m.fact_id,
        storyId: m.story_id,
        title: texts.get(m.article_id)!.title,
        cosine: cosineOf(m.article_id),
        lexical: lexical.get(m.article_id) ?? 0,
        sameUrl: sameUrl.has(m.article_id),
        sameHash: sameHash.has(m.article_id),
        documentKey: documentKey || !!before?.documentKey,
        selected: false,
        order: Math.min(order, before?.order ?? order),
      });
    }
  };
  add(withScore(twins), 0);
  add(topFacts(withScore(keyed), KEY_FACT_TOP_FACTS), 1);
  add(topFacts(withScore(documents), DOCUMENT_RECALL_TOP_FACTS), 1, true);
  add(recalled, 2);
  const candidates = [...hits.values()]
    .sort((a, b) => a.order - b.order || (b.cosine ?? b.lexical) - (a.cosine ?? a.lexical) || a.articleId.localeCompare(b.articleId))
    .slice(0, CANDIDATE_LIMIT);

  // Selection: a fact counts as selected when a visible pick is one of its qualified members; the picks of the last 60
  // days outside the judged facts are the reading background the live engine compares the report with.
  const factIds = [...new Set(candidates.map((c) => c.factId))];
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
  const background = picks.filter(
    (p) =>
      (p.fact_id === null || !judged.includes(p.fact_id)) &&
      p.discovered_at.getTime() > now - BACKGROUND_DAYS * DAY &&
      (p.fact_id === null || p.discovered_at.getTime() <= now - RECALL_DAYS * DAY),
  );
  const backgroundTexts = new Map(background.map((p) => [p.article_id, reportText(p.title, p.summary)]));
  const near = topByScore(
    background.map((p) => ({ id: p.article_id, score: score(backgroundTexts.get(p.article_id)!) })),
    BACKGROUND_VECTOR_LIMIT,
  );
  const extra = query
    ? await storedVectors(
        near.map((n) => ({ id: n.id, text: backgroundTexts.get(n.id)! })),
        db,
      )
    : { vectors: new Map<string, Float32Array>(), read: 0 };
  const readingBackground = near.some((n) => {
    const v = extra.vectors.get(n.id);
    const value = query && v && v.length === query.length ? cosine(query, v) : n.score;
    return value >= (query && v ? RECALL_MIN_COSINE : LEXICAL_RECALL_MIN);
  });

  return {
    candidates: candidates.map(({ order: _order, ...hit }) => hit),
    hasVector: !!query,
    readingBackground,
    stats: { window: window.length, pool: pool.length, scored: scoredIds.size, vectorsRead: read + extra.read, windowFull: window.length >= WINDOW_LIMIT },
  };
}

/** The facts the rules will judge (pipeline/events/rules.ts recallOrder, judgedFacts): same address, same hash, score. */
export function judgedFactIds(candidates: readonly RecallHit[]): number[] {
  const ordered = [...candidates].sort(
    (a, b) =>
      Number(b.sameUrl) - Number(a.sameUrl) ||
      Number(b.sameHash) - Number(a.sameHash) ||
      (b.cosine ?? b.lexical) - (a.cosine ?? a.lexical) ||
      a.articleId.localeCompare(b.articleId),
  );
  return [...new Set(ordered.map((c) => c.factId))].slice(0, GROUP_ARTICLE_CANDIDATES);
}
