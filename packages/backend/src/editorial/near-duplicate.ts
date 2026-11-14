// Near-identical reprints (TASK-0661). The same wire story republished by several sites is now analysed once per
// site (prefilter, score, summary) and only merged at grouping. Before analysis, each article revision with a body of
// at least MIN_BODY_CHARS gets a 64-bit SimHash of its text and the closest earlier article from another source in the
// last WINDOW_DAYS whose SimHash is at most MAX_DISTANCE bits away and whose title is alike. Record only: nothing is
// skipped and grouping is unchanged. scripts/near-duplicate-report.ts measures the matches against the events they
// later landed in; skipping is a separate card the Owner decides on.
import { createHash } from "node:crypto";
import { sql } from "../db.ts";
import type { AnalyzeInputArticle } from "./input.ts";

export const NEAR_DUPLICATE_RECIPE = "simhash64-char4-v1/head6000/hamming6-bands7/title0.5/days14";
export const MIN_BODY_CHARS = 200;
export const MAX_DISTANCE = 6;
export const TITLE_SIMILARITY = 0.5;
export const WINDOW_DAYS = 14;
const BODY_CHARS = 6000;
const MASK64 = (1n << 64n) - 1n;

/** Letters and digits only, lower case: page chrome punctuation, spacing and full/half-width forms do not count. */
export function normaliseText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** 64-bit SimHash over overlapping 4-character shingles (works for Chinese and alphabetic text alike). */
export function simhash(text: string): bigint {
  const chars = Array.from(normaliseText(text).slice(0, BODY_CHARS));
  const weights = new Array<number>(64).fill(0);
  const shingles = new Set<string>();
  for (let i = 0; i + 4 <= chars.length; i++) shingles.add(chars.slice(i, i + 4).join(""));
  for (const shingle of shingles) {
    const hash = createHash("md5").update(shingle).digest();
    for (let bit = 0; bit < 64; bit++) weights[bit]! += (hash[bit >> 3]! >> (bit & 7)) & 1 ? 1 : -1;
  }
  let value = 0n;
  for (let bit = 0; bit < 64; bit++) if (weights[bit]! > 0) value |= 1n << BigInt(bit);
  return value;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = (a ^ b) & MASK64,
    count = 0;
  while (x) {
    x &= x - 1n;
    count++;
  }
  return count;
}

/** Band widths: seven bands over 64 bits, so two hashes at most MAX_DISTANCE (6) bits apart share one (pigeonhole). */
const BAND_BITS = [10, 9, 9, 9, 9, 9, 9];
/** The seven bands, each as position × 1024 + value, so one array overlap finds a shared band at the same position. */
export function bands(value: bigint): number[] {
  let v = value & MASK64;
  return BAND_BITS.map((bits, position) => {
    const band = Number(v & ((1n << BigInt(bits)) - 1n));
    v >>= BigInt(bits);
    return position * 1024 + band;
  });
}

/** Stored as a signed bigint. */
const signed = (value: bigint) => BigInt.asIntN(64, value);

function bigrams(text: string): Set<string> {
  const chars = Array.from(text);
  const out = new Set<string>();
  for (let i = 0; i + 2 <= chars.length; i++) out.add(chars[i]! + chars[i + 1]!);
  if (!out.size && chars.length) out.add(chars.join(""));
  return out;
}

/** Jaccard similarity of the normalised titles' character bigrams. */
export function titleSimilarity(a: string, b: string): number {
  const x = bigrams(a),
    y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const gram of x) if (y.has(gram)) shared++;
  return shared / (x.size + y.size - shared);
}

export interface NearDuplicateMatch {
  articleId: string;
  distance: number;
  titleSimilarity: number;
}

/**
 * Records this revision's fingerprint and its closest earlier near-duplicate from another source, once per
 * revision. Bodies shorter than MIN_BODY_CHARS, posts and articles without a source are not fingerprinted.
 * Returns the match (or null) for logging; never changes the analysis.
 */
export async function recordNearDuplicate(
  a: Pick<AnalyzeInputArticle, "id" | "revision" | "sourceId" | "title" | "bodyText" | "xPost">,
): Promise<NearDuplicateMatch | null> {
  if (!a.sourceId || a.xPost || !a.bodyText || normaliseText(a.bodyText).length < MIN_BODY_CHARS) return null;
  const hash = simhash(a.bodyText),
    keys = bands(hash),
    titleKey = normaliseText(a.title).slice(0, 300);
  const candidates = await sql<{ article_id: string; simhash: string; title_key: string }[]>`
    SELECT DISTINCT ON (article_id) article_id, simhash::text AS simhash, title_key FROM enrichment.near_duplicates
    WHERE computed_at > pg_catalog.clock_timestamp() - make_interval(days => ${WINDOW_DAYS})
      AND source_id <> ${a.sourceId} AND article_id <> ${a.id}
      AND bands && ${keys}::integer[]
    ORDER BY article_id, input_revision DESC
    LIMIT 500`;
  let match: NearDuplicateMatch | null = null;
  for (const c of candidates) {
    const distance = hammingDistance(hash, BigInt(c.simhash));
    if (distance > MAX_DISTANCE) continue;
    const similarity = titleSimilarity(titleKey, c.title_key);
    if (similarity < TITLE_SIMILARITY) continue;
    if (!match || distance < match.distance || (distance === match.distance && similarity > match.titleSimilarity))
      match = { articleId: c.article_id, distance, titleSimilarity: Math.round(similarity * 1000) / 1000 };
  }
  await sql`INSERT INTO enrichment.near_duplicates
      (article_id, input_revision, source_id, simhash, bands, title_key, recipe, match_article_id, match_distance, match_title_similarity)
    VALUES (${a.id}, ${a.revision}, ${a.sourceId}, ${signed(hash).toString()}, ${keys}::integer[], ${titleKey}, ${NEAR_DUPLICATE_RECIPE},
      ${match?.articleId ?? null}, ${match?.distance ?? null}, ${match?.titleSimilarity ?? null})
    ON CONFLICT (article_id, input_revision) DO NOTHING`;
  return match;
}
