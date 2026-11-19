// Body fingerprint for the event rules (package 2, step 2.4): tells a reprint or a re-collection of the same text
// from a report that only covers the same thing. The algorithm is the near-duplicate SimHash of TASK-0661 (unmerged
// branch, 2026-11-14), taken unchanged so its recipe and its measured thresholds carry over: 64 bits over overlapping
// 4-character shingles of the normalised body head, which works for Chinese and alphabetic text alike. A reprint with
// different page chrome stays within 6 bits; a different story lands far beyond (tests/shadow-rules.test.ts).
// Pure: nothing is stored, the caller passes the body.
import { createHash } from "node:crypto";

export const FINGERPRINT_RECIPE = "simhash64-char4-v1/head6000";
/** Shorter bodies are not fingerprinted: too few shingles, and an empty body would match every other empty body. */
export const FINGERPRINT_MIN_BODY_CHARS = 200;
/**
 * Two fingerprints at most this many bits apart are the same text. TASK-0661 raised its card's 3 to 6 after one added
 * line of chrome moved a 500-character wire story 9 bits; a short reprint can still fall outside, which only leaves
 * the pair to the relation step.
 */
export const FINGERPRINT_MAX_DISTANCE = 6;
/** Two reprints from different sites usually keep enough of the title: character-bigram Jaccard at least this. */
export const FINGERPRINT_TITLE_SIMILARITY = 0.5;
const BODY_CHARS = 6000;
const MASK64 = (1n << 64n) - 1n;

/** Letters and digits only, lower case: page chrome punctuation, spacing and full/half-width forms do not count. */
export function normaliseText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** 64-bit SimHash over the distinct 4-character shingles of the first 6,000 normalised characters. */
export function simhash(text: string): bigint {
  const chars = Array.from(normaliseText(text).slice(0, BODY_CHARS));
  const weights = new Array<number>(64).fill(0);
  const shingles = new Set<string>();
  for (let i = 0; i + 4 <= chars.length; i++) shingles.add(chars.slice(i, i + 4).join(""));
  for (const shingle of shingles) {
    // md5 only spreads shingles over 64 bits evenly; nothing here depends on it resisting collisions.
    const hash = createHash("md5").update(shingle).digest();
    for (let bit = 0; bit < 64; bit++) weights[bit]! += (hash[bit >> 3]! >> (bit & 7)) & 1 ? 1 : -1;
  }
  let value = 0n;
  for (let bit = 0; bit < 64; bit++) if (weights[bit]! > 0) value |= 1n << BigInt(bit);
  return value;
}

/** The body's fingerprint, or null when the body is too short to tell texts apart. */
export function bodyFingerprint(body: string | null | undefined): bigint | null {
  if (!body || normaliseText(body).length < FINGERPRINT_MIN_BODY_CHARS) return null;
  return simhash(body);
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

function bigrams(text: string): Set<string> {
  const chars = Array.from(text);
  const out = new Set<string>();
  for (let i = 0; i + 2 <= chars.length; i++) out.add(chars[i]! + chars[i + 1]!);
  if (!out.size && chars.length) out.add(chars.join(""));
  return out;
}

/** Jaccard similarity of the normalised titles' character bigrams. */
export function titleSimilarity(a: string, b: string): number {
  const x = bigrams(normaliseText(a).slice(0, 300)),
    y = bigrams(normaliseText(b).slice(0, 300));
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const gram of x) if (y.has(gram)) shared++;
  return shared / (x.size + y.size - shared);
}
