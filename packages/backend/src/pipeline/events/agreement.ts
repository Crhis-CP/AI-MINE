// How far the event rules in shadow agree with the live engine (package 2, step 2.4). Read-only: it reads the shadow rows
// of a window, the memberships as they are now and the people's corrections of those reports, and writes nothing. With
// no shadow row in the window it reads nothing else. Pairs are (report, candidate report) of a judged row:
//  - the rules say "same" when the row is same_fact and the candidate's fact is the target;
//  - the live engine says "same" when both reports are members of one fact now (re-merges and manual moves included).
// Same-fact agreement is the share of same_fact rows whose target report shares a fact with the report now.
// The call forecast of a switch, in two parts. Certain: the calls the live path makes for the reports the rules judge
// whatever the judge answers (would_call: an undecided report's relation call, a decided one's value or scope question),
// plus one call for each report outside the rules on which the live engine called (those keep the live path). Bounded,
// for the judged rows only: the review calls an undecided report may add, depending on the judge's answers (rules.ts
// confirmUpperBound over its stored candidates), so the judged rows cost at most would_call plus the bound. Rows outside
// the rules keep the live path and may cost the live engine more than one call (archive history: the relation call and
// a review); their count is not recorded, so they enter only as "at least one" and the total has no upper bound.
// Which rows: the ruleset given, else the current rules in the mode the worker last recorded (its newest row), never
// the mode of the shell the report runs in.
// The recall hit rate looks only at rows where the live engine joined an existing fact, and only at the at most five
// candidates a row stores; selection and background were read when the shadow ran, not when the live engine decided.
// People's corrections label pairs, and both engines are scored against them: a "keep standalone" (grouping_overrides)
// or a detach after the decision makes the report's pairs with the named facts "different"; a person's story merge
// after it makes the report's story and the other story "same event" (the more specific "different" wins when both
// apply); rows decided before a regroup the editor asked for are left out. Run by scripts/shadow-agreement.ts and, for
// the headline, by the daily reconciliation.
import { groupingAuditTrail } from "../../admin/auth.ts";
import { sql, type Db } from "../../db.ts";
import { shadowJobsWithFullWindow } from "../../jobs/module-queues.ts";
import type { RecallMode } from "./recall.ts";
import { type CandidateEvidence, confirmUpperBound } from "./rules.ts";
import { shadowRuleset } from "./shadow.ts";

/** Corrections read per report window, newest first; more are reported as truncated, never silently dropped. */
export const AUDIT_LIMIT = 5000;
/** Live verdicts that put a report into a fact that existed before it (events/group.ts GroupResult). */
const JOINED_FACT = new Set(["same-fact", "same-url", "historical-attached"]);

export interface ShadowAgreement {
  from: string;
  to: string;
  ruleset: string;
  rows: number;
  /** Rows the rules judge (verdict other than not_judged), less those superseded by a regroup an editor asked for. */
  judged: number;
  /** Rows outside the rules (not_judged), less those superseded the same way. */
  outside: number;
  /** Same fact or new event without the model (rules 1–4 and 6). */
  decided: number;
  undecided: number;
  /** Rows per verdict/rule, judged or not. */
  byRule: Record<string, number>;
  calls: {
    /** Sum of would_call over the judged rows: the calls the live path makes for them whatever the judge answers. */
    wouldCall: number;
    /** Review calls the undecided rows may add on top, depending on the judge's answers: at most this many. */
    confirmUpperBound: number;
    /** Rows outside the rules on which the live engine called: they keep the live path, counted as one call each (at least). */
    outsideCalled: number;
    /** wouldCall + outsideCalled: the model calls a switch would make for these reports at least. */
    forecast: number;
    /** wouldCall + confirmUpperBound: the judged rows' calls after a switch, at most. Rows outside the rules have no bound. */
    judgedUpperBound: number;
    /** Rows (judged or outside) on which the live engine called at least once. */
    liveCalled: number;
  };
  sameFact: { rows: number; agree: number };
  pairs: { total: number; shadowSame: number; liveSame: number; both: number };
  /** New events the live engine put into an existing fact, or as a new fact into an existing story. */
  newEvent: { rows: number; liveJoinedFact: number; liveJoinedStory: number };
  /** Rows where the live engine joined an existing fact, and among them those whose fact was among the stored candidates. */
  recallHit: { eligible: number; hit: number };
  human: { pairs: number; shadowRight: number; shadowWrong: number; liveRight: number; liveWrong: number; truncated: boolean };
  /** Shadow jobs whose recall reached its window bound, as far as the queue keeps completed jobs. */
  windowFull: number;
}

interface Row {
  article_id: string;
  verdict: string;
  rule: string;
  target_fact_id: number | null;
  target_story_id: number | null;
  candidates: CandidateEvidence[];
  would_call: number;
  live_verdict: string | null;
  live_fact_id: number | null;
  live_story_id: number | null;
  live_called: boolean | null;
  decided_at: Date;
}

/** The live facts each of these reports is a member of now. */
async function currentFacts(ids: string[], db: Db): Promise<Map<string, Set<number>>> {
  const out = new Map<string, Set<number>>();
  for (let i = 0; i < ids.length; i += 5000) {
    const part = ids.slice(i, i + 5000);
    const rows = await db<{ article_id: string; fact_id: number }[]>`SELECT fa.article_id,fa.fact_id FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id
      JOIN stories st ON st.id=f.story_id AND st.merged_into IS NULL WHERE fa.article_id=ANY(${part}::text[]) AND fa.role IN ('primary','report')`;
    for (const row of rows) out.set(row.article_id, (out.get(row.article_id) ?? new Set()).add(row.fact_id));
  }
  return out;
}

const subjectId = (subject: string | null, prefix: string) => (subject?.startsWith(prefix) ? subject.slice(prefix.length) : null);
const numbers = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is number => typeof v === "number") : []);

function empty(from: Date, to: Date, ruleset: string, rows: number): ShadowAgreement {
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    ruleset,
    rows,
    judged: 0,
    outside: 0,
    decided: 0,
    undecided: 0,
    byRule: {},
    calls: { wouldCall: 0, confirmUpperBound: 0, outsideCalled: 0, forecast: 0, judgedUpperBound: 0, liveCalled: 0 },
    sameFact: { rows: 0, agree: 0 },
    pairs: { total: 0, shadowSame: 0, liveSame: 0, both: 0 },
    newEvent: { rows: 0, liveJoinedFact: 0, liveJoinedStory: 0 },
    recallHit: { eligible: 0, hit: 0 },
    human: { pairs: 0, shadowRight: 0, shadowWrong: 0, liveRight: 0, liveWrong: 0, truncated: false },
    windowFull: 0,
  };
}

/**
 * The ruleset of the current rules in the mode the worker last recorded: the newest shadow row among the two current
 * rulesets (by the decided_at index, newest first), lexical when there is none yet. The worker decides the mode from its
 * own environment, which a report run elsewhere does not share.
 */
export async function recordedShadowRuleset(db: Db = sql): Promise<string> {
  const current = [shadowRuleset("lexical"), shadowRuleset("vector")];
  const [row] = await db<{ ruleset: string }[]>`SELECT ruleset FROM events.shadow_decisions WHERE ruleset=ANY(${current}::text[])
    ORDER BY decided_at DESC LIMIT 1`;
  return row?.ruleset ?? current[0]!;
}

export async function shadowAgreement(
  from: Date,
  to: Date,
  opts: { ruleset?: string; mode?: RecallMode; auditLimit?: number } = {},
  db: Db = sql,
): Promise<ShadowAgreement> {
  const ruleset = opts.ruleset ?? (opts.mode ? shadowRuleset(opts.mode) : await recordedShadowRuleset(db)),
    auditLimit = opts.auditLimit ?? AUDIT_LIMIT;
  const rows = await db<Row[]>`SELECT article_id,verdict,rule,target_fact_id,target_story_id,candidates,would_call,live_verdict,live_fact_id,
      live_story_id,live_called,decided_at
    FROM events.shadow_decisions WHERE decided_at>=${from} AND decided_at<${to} AND ruleset=${ruleset} ORDER BY decided_at,article_id`;
  const out = empty(from, to, ruleset, rows.length);
  if (!rows.length) return out;
  const articles = [...new Set(rows.map((r) => r.article_id))];
  const stories = [...new Set(rows.flatMap((r) => [...(r.live_story_id === null ? [] : [r.live_story_id]), ...r.candidates.map((c) => c.storyId)]))];
  // Only the corrections of these reports and stories, by subject; a correction counts when made after the decision.
  // The rows come oldest first, so the first one says from when.
  const since = rows[0]!.decided_at;
  const trail = await groupingAuditTrail([...articles.map((id) => `content:${id}`), ...stories.map((id) => `story:${id}`)], since, auditLimit, db);
  out.human.truncated = trail.length >= auditLimit;
  const overrides = await db<{ article_id: string; created_at: Date }[]>`SELECT article_id,created_at FROM grouping_overrides
    WHERE article_id=ANY(${articles}::text[])`;
  const facts = await currentFacts([...new Set([...articles, ...rows.flatMap((r) => r.candidates.map((c) => c.articleId))])], db);
  out.windowFull = await shadowJobsWithFullWindow(from, to, db);
  const reruns = new Map<string, Date[]>(),
    detaches = new Map<string, Array<{ at: Date; facts: number[] }>>(),
    merges = new Map<number, Array<{ at: Date; other: number }>>();
  for (const entry of trail) {
    const content = subjectId(entry.subject, "content:");
    if (entry.action === "content.rerun.group" && content) reruns.set(content, [...(reruns.get(content) ?? []), entry.created_at]);
    if (entry.action === "content.detach" && content)
      detaches.set(content, [...(detaches.get(content) ?? []), { at: entry.created_at, facts: numbers((entry.before as { facts?: unknown } | null)?.facts) }]);
    const into = (entry.after as { into?: unknown } | null)?.into;
    const fromStory = Number(subjectId(entry.subject, "story:"));
    if (entry.action === "story.merge" && Number.isSafeInteger(fromStory) && typeof into === "number" && fromStory !== into) {
      merges.set(fromStory, [...(merges.get(fromStory) ?? []), { at: entry.created_at, other: into }]);
      merges.set(into, [...(merges.get(into) ?? []), { at: entry.created_at, other: fromStory }]);
    }
  }
  const standalone = new Map(overrides.map((o) => [o.article_id, o.created_at]));
  const shared = (a: string, b: string) => [...(facts.get(a) ?? [])].some((fact) => facts.get(b)?.has(fact));

  for (const r of rows) {
    out.byRule[`${r.verdict}/${r.rule}`] = (out.byRule[`${r.verdict}/${r.rule}`] ?? 0) + 1;
    if ((reruns.get(r.article_id) ?? []).some((at) => at > r.decided_at)) continue;
    if (r.live_called) out.calls.liveCalled++;
    if (r.verdict === "not_judged") {
      out.outside++;
      if (r.live_called) out.calls.outsideCalled++;
      continue;
    }
    out.judged++;
    if (r.verdict === "undecided") out.undecided++;
    else out.decided++;
    out.calls.wouldCall += r.would_call;
    out.calls.confirmUpperBound += confirmUpperBound(r.candidates);
    if (r.verdict === "same_fact") {
      out.sameFact.rows++;
      const target = r.candidates.find((c) => c.factId === r.target_fact_id);
      if (target && shared(r.article_id, target.articleId)) out.sameFact.agree++;
    }
    if (r.verdict === "new_event") {
      out.newEvent.rows++;
      if (r.live_verdict && JOINED_FACT.has(r.live_verdict)) out.newEvent.liveJoinedFact++;
      if (r.live_verdict === "new-fact-in-story") out.newEvent.liveJoinedStory++;
    }
    if (r.live_verdict && JOINED_FACT.has(r.live_verdict) && r.live_fact_id !== null) {
      out.recallHit.eligible++;
      if (r.candidates.some((c) => c.factId === r.live_fact_id)) out.recallHit.hit++;
    }
    const alone = standalone.get(r.article_id);
    const detached = (detaches.get(r.article_id) ?? []).filter((d) => d.at > r.decided_at).flatMap((d) => d.facts);
    for (const c of r.candidates) {
      const shadowSame = r.verdict === "same_fact" && c.factId === r.target_fact_id;
      const liveSame = shared(r.article_id, c.articleId);
      out.pairs.total++;
      if (shadowSame) out.pairs.shadowSame++;
      if (liveSame) out.pairs.liveSame++;
      if (shadowSame && liveSame) out.pairs.both++;
      // A person's label: "different" at fact level, "same event" at story level; an undecided row is not scored.
      const different = (alone !== undefined && alone > r.decided_at) || detached.includes(c.factId);
      const sameEvent =
        r.live_story_id !== null &&
        r.live_story_id !== c.storyId &&
        (merges.get(r.live_story_id) ?? []).some((m) => m.at > r.decided_at && m.other === c.storyId);
      if (!different && !sameEvent) continue;
      // The more specific label wins: a pair a person separated is "different" even if its stories were merged later.
      const truth = !different;
      out.human.pairs++;
      const liveSaid = different ? r.live_fact_id === c.factId : r.live_story_id === c.storyId;
      if (liveSaid === truth) out.human.liveRight++;
      else out.human.liveWrong++;
      if (r.verdict === "undecided") continue;
      const shadowSaid = different ? shadowSame : r.verdict === "same_fact" && r.target_story_id === c.storyId;
      if (shadowSaid === truth) out.human.shadowRight++;
      else out.human.shadowWrong++;
    }
  }
  out.calls.forecast = out.calls.wouldCall + out.calls.outsideCalled;
  out.calls.judgedUpperBound = out.calls.wouldCall + out.calls.confirmUpperBound;
  return out;
}

/** The numbers of the daily reconciliation line (rows superseded by an editor's regroup left out throughout). */
export interface ShadowHeadline {
  /** Shadow rows of the day: judged by the rules or outside them. */
  rows: number;
  judged: number;
  sameFact: number;
  agree: number;
  undecided: number;
  /** calls.forecast: the model calls a switch would make for these rows at least. */
  forecast: number;
  /** calls.confirmUpperBound: review calls that may come on top, depending on the judge's answers. Absent in days stored before it existed. */
  confirmUpperBound?: number;
  /** Rows on which the live engine called at least once. */
  liveCalled: number;
}
export async function shadowHeadline(from: Date, to: Date, db: Db = sql): Promise<ShadowHeadline> {
  const a = await shadowAgreement(from, to, {}, db);
  return {
    rows: a.judged + a.outside,
    judged: a.judged,
    sameFact: a.sameFact.rows,
    agree: a.sameFact.agree,
    undecided: a.undecided,
    forecast: a.calls.forecast,
    confirmUpperBound: a.calls.confirmUpperBound,
    liveCalled: a.calls.liveCalled,
  };
}
