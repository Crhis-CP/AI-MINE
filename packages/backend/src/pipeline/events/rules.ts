// The event rules of package 2 (step 2.4), run in shadow beside the live grouping engine: for one report and the
// candidates recall found, say without a model whether it is the same fact as one of them, certainly a new event,
// or a question the relation step must still answer. Pure: the caller reads the report, its candidates and their
// stored vectors, and stores the decision next to what the live engine did (events.shadow_decisions).
//
// Rules in order, the first that fires wins:
//   0  a person placed or split it, archive history, not passed or too thin, not editorial, a roundup → not_judged
//   1  another report of the same address has a live fact                                     → same_fact
//   2  another report with the same stored content hash has a live fact                        → same_fact
//   3  near-identical body and alike title (fingerprint.ts), no country or occurrence-day conflict → same_fact
//   4  certainDuplicate as the live re-merge uses it (events/relate.ts), no occurrence-day conflict → same_fact
//      Vectors only: its 0.92 bar is a cosine, and a character-pair overlap of 0.92 is a different, weaker claim
//      (a short text inside a long one scores 1). Without stored vectors (none in production so far: M2b) it never fires.
//   5  every candidate's trusted occurrence day is more than DATE_APART_DAYS from the report's → undecided
//      Not the same fact, but a later development of the same story is exactly this, and only the relation step
//      can say so: founding a new event here would split stories (review of design M, F4).
//   6  no candidate at all, and recall was complete                                            → new_event
//      Complete: recall compared the whole pool the way the live engine does: in lexical mode (no embeddings, the
//      default) whenever the window stayed within its bound; with vectors only when, besides, the report's
//      own vector was read (recall.ts).
//   7  anything else                                                                           → undecided
//      Recorded as vector_missing when recall was not complete (vector mode without the report's vector, or the
//      window reached its bound), else similar_unsure. Both cost the relation call for certain; the review calls that
//      may follow depend on the judge's answers and are only bounded (confirmUpperBound).
// Scores come in two kinds: a cosine of stored vectors, or the character-pair overlap (events/relate.ts
// lexicalSimilarity) where a vector is missing or embeddings are off. Each bar is named for its kind
// (CONFIRM_BELOW_COSINE, CONFIRM_BELOW_LEXICAL; certainDuplicate's 0.92 is a cosine and is applied to cosines only).
// Only rule 6 founds a new event without the model; events.shadow_decisions enforces the same with a CHECK.
// Like the live engine, the rules judge facts, not reports: the candidates of one fact count once (judgedFacts).
import { beijingDate } from "@amp/contracts/time";
import {
  GROUP_ARTICLE_CANDIDATES,
  SKIP_REVIEW_MIN_COSINE,
  TITLE_KEY_MIN_CHARS,
  certainDuplicate,
  jurisdictionsConflict,
  titleKey,
} from "../../events/relate.ts";
import {
  FINGERPRINT_MAX_DISTANCE,
  FINGERPRINT_MIN_BODY_CHARS,
  FINGERPRINT_RECIPE,
  FINGERPRINT_TITLE_SIMILARITY,
  hammingDistance,
  titleSimilarity,
} from "./fingerprint.ts";

/** Trusted occurrence days further apart than this cannot be one happening. Start value; fixed after measurement 5. */
export const DATE_APART_DAYS = 7;
/** The live engine asks a second (review) call before a merge whose cosine is under this (events/group.ts CONFIRM_BELOW_COSINE). */
export const CONFIRM_BELOW_COSINE = 0.85;
/**
 * The same question when the candidate's score is the character-pair overlap (no vectors). Not a calibration: the live
 * engine in lexical mode compares that overlap with its cosine bar (events/group.ts `pick.score >= CONFIRM_BELOW_COSINE`),
 * and the forecast counts the calls the live engine makes, so this must be the bar the live engine applies to the
 * overlap. It is named apart so the forecast follows the score kind and a later lexical bar in live changes only this;
 * tests/event-shadow.test.ts holds it to the live source.
 */
export const CONFIRM_BELOW_LEXICAL = 0.85;
/**
 * Every threshold is part of the ruleset, so rows decided under different values are never counted together. A change
 * of policy rather than of a number (which rule fires, what a guard compares) bumps the leading version instead.
 */
export const EVENT_RULESET = [
  "event-rules-v2",
  FINGERPRINT_RECIPE,
  `body${FINGERPRINT_MIN_BODY_CHARS}`,
  `fp${FINGERPRINT_MAX_DISTANCE}-title${FINGERPRINT_TITLE_SIMILARITY}`,
  `key${TITLE_KEY_MIN_CHARS}`,
  `certain${SKIP_REVIEW_MIN_COSINE}`,
  `apart${DATE_APART_DAYS}`,
  `top${GROUP_ARTICLE_CANDIDATES}`,
  `confirm${CONFIRM_BELOW_COSINE}`,
  `lexconfirm${CONFIRM_BELOW_LEXICAL}`,
  "calls-certain+review-bound",
].join("/");

export type EventVerdict = "same_fact" | "new_event" | "undecided" | "not_judged";
export type EventRule =
  | "same_url"
  | "content_hash"
  | "fingerprint"
  | "certain_duplicate"
  | "no_candidate"
  | "date_apart"
  | "similar_unsure"
  | "vector_missing"
  | "composite"
  | "not_passed"
  | "manual"
  | "historical";

/** What the rules compare on either side of a pair. */
export interface EventReport {
  articleId: string;
  sourceId: string;
  /** The title the engine compares: the Chinese reader title when there is one, else the original. */
  title: string;
  /** The report's own publication time (articles.published_at); null when the source gave none. */
  at: Date | null;
  jurisdiction: string | null;
  /** bodyFingerprint of the original body; null when it is too short. */
  fingerprint: bigint | null;
  /** A trusted occurrence day (YYYY-MM-DD): found in the text or agreed by two reports. A bare model claim is not trusted. */
  occurredOn: string | null;
}

export interface EventQuery extends EventReport {
  /** The source takes part editorially; signal posts are grouped another way. */
  editorial: boolean;
  /** The latest analysis' relevance; only "pass" is judged. */
  relevance: string | null;
  scope: "single" | "composite" | "unknown";
  /** The analysis carries a fact frame; an undetermined scope without one is too thin to judge (live: standalone). */
  frame: boolean;
  /** A person placed or split this report (a manual membership or a grouping_overrides row). */
  manual: boolean;
  /** Archive history placed by source time. */
  historical: boolean;
  /**
   * Recall compared the whole pool as the live engine does, so no candidate means none exists for the live engine
   * either: in lexical mode whenever the window stayed within its bound; with vectors only when, besides, the report's
   * own vector was read (recall.ts).
   */
  recallComplete: boolean;
  /** Selected coverage of the subject exists, so the live engine still asks whether this report adds value. */
  readingBackground: boolean;
}

export interface EventCandidate extends EventReport {
  factId: number;
  storyId: number;
  /** Cosine of stored vectors whose text hashes match the current texts; null when either is missing or stale. */
  cosine: number | null;
  /** The lexical bigram overlap (events/relate.ts lexicalSimilarity), always available. */
  lexical: number;
  sameUrl: boolean;
  sameHash: boolean;
  /** Recalled because both name the same 《…》 document. */
  documentKey: boolean;
  /**
   * The candidate's fact has a visible selected (public pick) report, whichever report of the fact this is: the live
   * engine reads selection per fact (events/group.ts candidateViews), and so must the caller.
   */
  selected: boolean;
}

/** One candidate as the decision records it (events.shadow_decisions.candidates): JSON-safe, no bigint. */
export interface CandidateEvidence {
  factId: number;
  storyId: number;
  articleId: string;
  cosine: number | null;
  lexical: number;
  sameUrl: boolean;
  sameHash: boolean;
  titleKeyEqual: boolean;
  documentKey: boolean;
  /** Bits between the two body fingerprints; null when either body is too short. */
  fingerprint: number | null;
  countryConflict: boolean;
  sameDay: boolean;
  occurredGapDays: number | null;
  /**
   * Undecided rows only: this judged fact costs the live engine a review call if its judge calls it the same occurrence,
   * because its best report is under the confirm bar of its score kind (events/group.ts decide). Absent elsewhere.
   */
  confirmIfSame?: boolean;
}

export interface EventDecision {
  ruleset: string;
  verdict: EventVerdict;
  rule: EventRule;
  targetFactId: number | null;
  targetStoryId: number | null;
  /** The target's recall score, else the best candidate's; null without candidates. */
  similarity: number | null;
  candidates: CandidateEvidence[];
  /**
   * Model calls the live path makes for this report whatever its judge answers (0 to 6): the relation call when the
   * relation step runs (it also answers the scope and value questions), else the value or scope question a decided
   * report still needs. Never more than the live engine makes for the same candidates.
   */
  wouldCall: number;
  /** Review calls that may come on top, depending on the judge's answers (confirmUpperBound): at most, never certain. */
  confirmUpperBound: number;
}

/**
 * The most review calls the live engine can add after its relation call (events/group.ts decide): it reviews merge
 * picks the judge called the same occurrence, under the confirm bar, one after another until one is confirmed, then at
 * most one more for a peer of the chosen fact. So at most one per judged fact under the bar, plus one. Which of them
 * happen depends on the judge's answers, which the rules cannot know: this bounds them, it does not forecast them.
 */
export function confirmUpperBound(candidates: ReadonlyArray<Pick<CandidateEvidence, "confirmIfSame">>): number {
  const under = candidates.filter((c) => c.confirmIfSame === true).length;
  return under ? under + 1 : 0;
}

/** Recall score as the live engine orders and confirms by it: cosine when both vectors are current, else the lexical overlap. */
const score = (c: EventCandidate) => c.cosine ?? c.lexical;
/** The confirm bar for the kind of score a candidate has (cosine or character-pair overlap). */
const confirmBar = (c: EventCandidate) => (c.cosine !== null ? CONFIRM_BELOW_COSINE : CONFIRM_BELOW_LEXICAL);

function dayNumber(day: string | null): number | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms / 86_400_000;
}

function occurredGapDays(a: EventReport, b: EventReport): number | null {
  const x = dayNumber(a.occurredOn),
    y = dayNumber(b.occurredOn);
  return x === null || y === null ? null : Math.abs(x - y);
}

const titleKeyEqual = (a: EventReport, b: EventReport) => {
  const key = titleKey(a.title);
  return [...key].length >= TITLE_KEY_MIN_CHARS && key === titleKey(b.title);
};

function fingerprintDistance(a: EventReport, b: EventReport): number | null {
  return a.fingerprint === null || b.fingerprint === null ? null : hammingDistance(a.fingerprint, b.fingerprint);
}

const sameBeijingDay = (a: EventReport, b: EventReport) => !!a.at && !!b.at && beijingDate(a.at) === beijingDate(b.at);

/**
 * The same text: near-identical bodies, no conflicting country or trusted occurrence day, and titles that agree. Within
 * one source the title must be the same, because a page whose extraction kept only the site's chrome fingerprints like
 * every other such page of that site; and so must the publication day, because a recurring column (a daily price or
 * output bulletin) repeats its title and template every day, while a re-collected page keeps its source's date. Across
 * sources a reprint often gets a new headline and a later date, so an alike title is enough.
 */
function nearCopy(q: EventReport, c: EventReport): boolean {
  const distance = fingerprintDistance(q, c);
  if (distance === null || distance > FINGERPRINT_MAX_DISTANCE || jurisdictionsConflict(q.jurisdiction, c.jurisdiction)) return false;
  if ((occurredGapDays(q, c) ?? 0) > 0) return false;
  return q.sourceId === c.sourceId ? titleKeyEqual(q, c) && sameBeijingDay(q, c) : titleSimilarity(q.title, c.title) >= FINGERPRINT_TITLE_SIMILARITY;
}

/** Live recall order (events/group.ts decide): the same address first, then similarity; the hash twin sits with it. */
function recallOrder(a: EventCandidate, b: EventCandidate): number {
  return Number(b.sameUrl) - Number(a.sameUrl) || Number(b.sameHash) - Number(a.sameHash) || score(b) - score(a) || a.articleId.localeCompare(b.articleId);
}

/** The earliest report wins among twins, as the live same-address lookup takes the oldest membership. */
function earliest(cands: EventCandidate[]): EventCandidate | undefined {
  return [...cands].sort((a, b) => (a.at?.getTime() ?? Infinity) - (b.at?.getTime() ?? Infinity) || a.articleId.localeCompare(b.articleId))[0];
}

function notJudged(q: EventQuery): EventRule | null {
  // Manual corrections come first (rule 7 of AGENTS.md): the rules never second-guess a person.
  if (q.manual) return "manual";
  if (q.historical) return "historical";
  if (!q.editorial || q.relevance !== "pass" || (q.scope === "unknown" && !q.frame)) return "not_passed";
  if (q.scope === "composite") return "composite";
  return null;
}

function evidence(q: EventQuery, c: EventCandidate): CandidateEvidence {
  return {
    factId: c.factId,
    storyId: c.storyId,
    articleId: c.articleId,
    cosine: c.cosine,
    lexical: c.lexical,
    sameUrl: c.sameUrl,
    sameHash: c.sameHash,
    titleKeyEqual: titleKeyEqual(q, c),
    documentKey: c.documentKey,
    fingerprint: fingerprintDistance(q, c),
    countryConflict: jurisdictionsConflict(q.jurisdiction, c.jurisdiction),
    sameDay: sameBeijingDay(q, c),
    occurredGapDays: occurredGapDays(q, c),
  };
}

const dateApart = (q: EventReport, c: EventReport) => {
  const gap = occurredGapDays(q, c);
  return gap !== null && gap > DATE_APART_DAYS;
};

/**
 * The pool as the live engine judges it: one entry per fact, in recall order, at most GROUP_ARTICLE_CANDIDATES facts.
 * Each fact's reports are in recall order, so the first stands for it in the record.
 */
function judgedFacts(pool: readonly EventCandidate[]): EventCandidate[][] {
  const facts = new Map<number, EventCandidate[]>();
  for (const c of pool) facts.set(c.factId, [...(facts.get(c.factId) ?? []), c]);
  return [...facts.values()].slice(0, GROUP_ARTICLE_CANDIDATES);
}

export function decideEvent(query: EventQuery, candidates: readonly EventCandidate[]): EventDecision {
  const pool = candidates.filter((c) => c.articleId !== query.articleId).sort(recallOrder);
  const facts = judgedFacts(pool);
  // The record keeps one report per judged fact, the same number the live engine judges, the target always among them.
  const judged = facts.map((reports) => reports[0]!);
  // A judged fact whose best report is under the confirm bar of its score kind: a review call if the judge says same.
  const underBar = new Set(facts.filter((reports) => !reports.some((c) => score(c) >= confirmBar(c))).map((reports) => reports[0]!.factId));
  const decision = (verdict: EventVerdict, rule: EventRule, target: EventCandidate | null, wouldCall: number): EventDecision => {
    // The target stands in for its own fact's entry when that fact is judged, else for the last one.
    const shown =
      !target || judged.includes(target)
        ? judged
        : judged.some((c) => c.factId === target.factId)
          ? judged.map((c) => (c.factId === target.factId ? target : c))
          : [...judged.slice(0, GROUP_ARTICLE_CANDIDATES - 1), target];
    const best = target ?? pool[0];
    const candidates = shown.map((c) => (verdict === "undecided" ? { ...evidence(query, c), confirmIfSame: underBar.has(c.factId) } : evidence(query, c)));
    return {
      ruleset: EVENT_RULESET,
      verdict,
      rule,
      targetFactId: target?.factId ?? null,
      targetStoryId: target?.storyId ?? null,
      similarity: best ? score(best) : null,
      candidates,
      wouldCall: Math.min(6, wouldCall),
      confirmUpperBound: confirmUpperBound(candidates),
    };
  };

  const gate = notJudged(query);
  // Outside the rules the live path stays as it is, so these rows carry no forecast.
  if (gate) return decision("not_judged", gate, null, 0);

  // A decided report still costs one call when selected coverage exists: the value question is not a rule's to answer.
  // An undetermined scope costs it too: the live engine always asks whether the report is one event or a roundup
  // (events/group.ts decide, needsJudgement), and that answer may still turn a decided report into a roundup.
  const scopeCall = query.scope === "unknown" ? 1 : 0;
  // The fact a rule ties the report to counts too, even where recall ranked it below the judged five.
  const valueCall = (target?: EventCandidate) => Math.max(scopeCall, query.readingBackground || target?.selected || judged.some((c) => c.selected) ? 1 : 0);
  const sameUrl = earliest(pool.filter((c) => c.sameUrl));
  // A same-address fact with a selected report short-cuts the live engine without any call (events/group.ts decide).
  if (sameUrl) return decision("same_fact", "same_url", sameUrl, sameUrl.selected ? scopeCall : valueCall(sameUrl));
  // A hash over a short generic title and no body ties unrelated notices; require a body or a specific title.
  const hashSpecific = query.fingerprint !== null || [...titleKey(query.title)].length >= TITLE_KEY_MIN_CHARS;
  const sameHash = hashSpecific ? earliest(pool.filter((c) => c.sameHash)) : undefined;
  if (sameHash) return decision("same_fact", "content_hash", sameHash, valueCall(sameHash));
  const copy = pool.filter((c) => nearCopy(query, c)).sort((a, b) => fingerprintDistance(query, a)! - fingerprintDistance(query, b)! || recallOrder(a, b))[0];
  if (copy) return decision("same_fact", "fingerprint", copy, valueCall(copy));
  // The live re-merge compares publication days only; two trusted occurrence days that differ are two happenings
  // however alike the reports, as for rule 3, so such a pair goes on to rule 5 or the relation step. A cosine only:
  // the lexical overlap is never held to the 0.92 cosine bar here.
  const certain = pool.find((c) => c.cosine !== null && (occurredGapDays(query, c) ?? 0) === 0 && certainDuplicate(c.cosine, query, c));
  if (certain) return decision("same_fact", "certain_duplicate", certain, valueCall(certain));

  // From here on the relation step decides: one batch call, which also answers the scope and value questions. Review
  // calls may follow, depending on its answers: they are bounded per row (confirmUpperBound), not forecast. The live
  // engine does not know trusted days, so a date-apart fact under the bar still counts in that bound.
  if (pool.length && pool.every((c) => dateApart(query, c))) return decision("undecided", "date_apart", null, 1);
  if (!query.recallComplete) return decision("undecided", "vector_missing", null, 1);
  if (!pool.length)
    // An undetermined scope (one event or a roundup) is a question for the model even with nothing to compare.
    return query.scope === "unknown" ? decision("undecided", "no_candidate", null, 1) : decision("new_event", "no_candidate", null, valueCall());
  return decision("undecided", "similar_unsure", null, 1);
}
