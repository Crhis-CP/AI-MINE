// The relation between a report and candidate facts: prompts, schemas, candidate
// descriptions and the pure decision rules. group.ts does the reading and writing around them.
//
// A judgement is three-way. SAME_OCCURRENCE: the same real-world happening (one launch with its
// models, prices and details; the same ruling, report, incident or interview from any outlet).
// SAME_STORY: a direct development of that happening (teaser and launch, launch and a review or a
// third-party listing, an incident and the response). UNRELATED: a different happening, even for the
// same product or company. ROUNDUP: one side is a multi-topic digest. Asking for the three-way
// relation with both reports fully described is what makes the judge usable: a yes/no question with
// "prefer no" refused half of the true merges (measured 2026-09-28 on 370 labelled pairs).
import { z } from "zod";
import { beijingDate, beijingTime } from "@amp/contracts/time";
import { JURISDICTIONS } from "@amp/industry/jurisdictions";
import { promptText, promptVersion } from "../editorial/prompts.ts";

export const GROUP_BODY_CHARS = 10_000;
export const LEXICAL_RECALL_MIN = 0.25;
export const RECALL_TOP_FACTS = 10;
export const BATCH_PROMPT_VERSION = promptVersion("group-batch", "group-value");
export const RELATE_PROMPT_VERSION = promptVersion("group-batch", "group-pair", "group-signal");
export const FACT_CONVERGENCE_VERSION = "same-occurrence-canonical-v1";

export const RELATIONS = ["SAME_OCCURRENCE", "SAME_STORY", "UNRELATED", "ROUNDUP"] as const;
export type Relation = (typeof RELATIONS)[number];

export interface ReportView {
  scope?: "single" | "composite" | "unknown";
  articleId?: string;
  revision?: number;
  publicationRevision?: number;
  dateVersion?: number;
  sourceTimeLabel?: string;
  originalText?: string;
  jurisdiction?: string | null;
  title: string;
  source: string;
  firstParty: boolean;
  at: Date | null;
  summary: string | null;
  frame?: { subject?: string | null; action?: string | null; object?: string | null; occurredAt?: string | null } | null;
}

export interface CandidateView {
  factId: number;
  storyId: number;
  factTitle: string;
  /** Reports already attached to the fact. */
  members: number;
  /** The fact that started its story: developments attach only here (no chaining through developments). */
  storyRoot: boolean;
  /** Recall similarity with the query (cosine, or the lexical fallback's overlap). */
  score: number;
  report: ReportView;
  selected?: boolean;
  selectedReport?: ReportView | null;
}

export interface ReadingContext {
  report: ReportView;
}
export const SelectionValueSchema = z.object({ addsValue: z.boolean(), reason: z.string().trim().min(1).max(400) });
export type SelectionValue = z.infer<typeof SelectionValueSchema>;
export const NO_SELECTED_COVERAGE: SelectionValue = { addsValue: true, reason: "没有已公开精选的相关报道" };

export interface Verdict {
  relation: Relation;
  confidence: number;
  note: string;
  evidence?: RelationEvidence | null;
}

/** The relation prompts (industry/prompts/group-*.md): a new report against candidate facts, a pair, a signal post. */
export const BATCH_SYSTEM = `${promptText("group-batch")}\n\n${promptText("group-value")}`;
export const PAIR_SYSTEM = promptText("group-pair");
export const SIGNAL_SYSTEM = promptText("group-signal");

const RelationSchema = z.enum(RELATIONS);

const RelationEvidenceSchema = z.object({
  queryQuote: z.string().min(12).max(600),
  candidateQuote: z.string().min(12).max(600),
  anchor: z.string().min(2).max(120),
  queryAction: z.string().min(1).max(120),
  candidateAction: z.string().min(1).max(120),
  queryStage: z.enum(["proposed", "approved", "stopped", "resumed", "other"]),
  candidateStage: z.enum(["proposed", "approved", "stopped", "resumed", "other"]),
  change: z.string().max(300),
});
export type RelationEvidence = z.infer<typeof RelationEvidenceSchema>;
const evidence = RelationEvidenceSchema.nullable().catch(null);

const jurisdictionById = new Map(JURISDICTIONS.map((row) => [row.id, row]));

function countryOf(row: (typeof JURISDICTIONS)[number]): string {
  let current = row;
  const seen = new Set<string>();
  while (current.parent && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = jurisdictionById.get(current.parent);
    if (!parent) break;
    current = parent;
    if (current.kind === "country") return current.id;
  }
  return current.kind === "country" ? current.id : current.id;
}

const countryByName = new Map<string, string>();
for (const row of JURISDICTIONS) {
  const country = countryOf(row);
  for (const name of [row.id, row.name_zh, row.name_en]) countryByName.set(name.toLocaleLowerCase(), country);
}
for (const [name, country] of [
  ["中国", "CN"],
  ["中华人民共和国", "CN"],
  ["china", "CN"],
] as const)
  countryByName.set(name.toLocaleLowerCase(), country);

/** Country of a stored code or a plain name. A province and its country are the same country. */
export function countryKey(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  return countryByName.get(raw.toLocaleLowerCase()) ?? countryByName.get(raw.toUpperCase().toLocaleLowerCase()) ?? raw.toUpperCase();
}

/** Both sides name a country, and those countries differ. A blank side is not a conflict. */
export function jurisdictionsConflict(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = countryKey(left),
    b = countryKey(right);
  return !!a && !!b && a !== b;
}

/** Descriptive tags do not overrule a whole-report identity decision or invent a different relation. */
export function validatedRelation(_a: ReportView, _b: ReportView, verdict: Pick<Verdict, "relation" | "confidence" | "evidence">): Relation {
  return verdict.relation;
}

/** Stored identity-only answers remain readable without inventing a later value judgement. */
export const LegacyIdentityAnswerSchema = z.object({
  decisions: z.array(
    z.object({
      id: z.string(),
      relation: RelationSchema,
      confidence: z.coerce.number().min(0).max(1),
      note: z.string().max(400).catch(""),
      evidence,
    }),
  ),
});

export const BatchSchema = z.object({
  query: z.string().max(400).catch(""),
  decisions: z.array(
    z.object({
      id: z.string().regex(/^C[1-9]\d*$/),
      relation: RelationSchema,
      confidence: z.number().min(0).max(1),
      note: z.string().max(400).catch(""),
      evidence,
    }),
  ),
});

export const ValueBatchSchema = BatchSchema.extend({ selection: SelectionValueSchema, queryScope: z.enum(["single", "composite", "unknown"]).optional() });

export const PairSchema = z.object({
  a: z.string().max(400).catch(""),
  b: z.string().max(400).catch(""),
  relation: RelationSchema,
  difference: z.string().max(400).catch(""),
  evidence,
  confidence: z.number().min(0).max(1),
});

export const SignalSchema = z.object({
  decisions: z.array(z.object({ id: z.string().regex(/^C[1-9]\d*$/), relation: RelationSchema, confidence: z.number().min(0).max(1), evidence })),
});

function when(at: Date | null): string {
  if (!at) return "未知";
  return (at.getTime() + 8 * 3600_000) % 86400_000 === 0 ? beijingDate(at) : `${beijingDate(at)} ${beijingTime(at)}`;
}

export function describeReport(r: ReportView, label: string, extra = ""): string {
  const f = r.frame;
  return [
    `【${label}】${extra}`,
    `标题：${r.title}`,
    r.scope ? `稿件范围：${r.scope === "single" ? "单一报道" : r.scope === "composite" ? "综合稿" : "未确认"}` : null,
    `来源：${r.source}${r.firstParty ? "（当事方/官方）" : ""}｜${r.sourceTimeLabel === undefined ? `发布时间：${when(r.at)}` : `时间信息：${r.sourceTimeLabel}`}`,
    `原文证据：${r.originalText ?? "（无）"}`,
    `法域：${r.jurisdiction ?? "未知"}`,
    `摘要：${(r.summary ?? "").slice(0, 360) || "（无）"}`,
    f && (f.subject || f.action || f.object)
      ? `事实要素：主体=${f.subject || "?"}；动作=${f.action || "?"}；对象=${f.object || "?"}；日期=${f.occurredAt || "未知"}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export const candidateKey = (index: number) => `C${index + 1}`;

export function batchUser(query: ReportView, cands: CandidateView[], queryLabel = "新报道", reading: ReadingContext[] = []): string {
  const list = cands
    .map((c, i) =>
      [
        describeReport(c.report, `候选 ${candidateKey(i)}`, `（该事实已有 ${c.members} 篇报道；事实标题：${c.factTitle}）`),
        queryLabel !== "新报道"
          ? null
          : c.selected && c.selectedReport
            ? c.selectedReport.articleId && c.selectedReport.articleId === c.report.articleId
              ? "【已公开精选】以上代表报道已向读者展示，增量与该报道比较。"
              : describeReport(c.selectedReport, "已公开精选", "（增量只与这篇已展示的内容比较）")
            : "【尚无公开精选】此候选仅用于身份判断，不代表读者已经看过。",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  const background = reading.map(({ report }, i) => describeReport(report, `已公开精选阅读背景 R${i + 1}`, "（只比较信息覆盖，不是事实候选）")).join("\n\n");
  const inventory = `事实候选数：${cands.length}\n事实候选编号：${JSON.stringify(cands.map((_, i) => candidateKey(i)))}`;
  return `${inventory}\n\n${describeReport(query, queryLabel)}\n\n${list}${background ? `\n\n${background}` : ""}\n\n${queryLabel}与每个候选的关系是什么？${reading.length ? "同时比较已公开精选的覆盖；无事实候选时 decisions=[]。" : ""}`;
}

export function pairUser(a: ReportView, b: ReportView): string {
  return `${describeReport(a, "报道 A")}\n\n${describeReport(b, "报道 B")}\n\n这两篇报道是什么关系？`;
}

/** Missing, duplicate and unknown candidate IDs are incomplete answers, never unrelatedness. */
export function completeDecisions(decisions: Array<{ id: string }>, count: number): boolean {
  const ids = new Set(decisions.map((d) => d.id));
  return decisions.length === count && ids.size === count && Array.from({ length: count }, (_, i) => `C${i + 1}`).every((id) => ids.has(id));
}

/** Only complete identity decisions become event relationships. */
export function verdictsByFact(
  decisions: Array<{ id: string; relation: Relation; confidence: number; note?: string; evidence?: RelationEvidence | null }>,
  cands: CandidateView[],
  query?: ReportView,
): Map<number, Verdict> {
  if (!completeDecisions(decisions, cands.length)) throw new Error("Identity answer must cover every candidate exactly once");
  const out = new Map<number, Verdict>();
  for (const d of decisions) {
    const n = Number(String(d.id).trim().replace(/^C/i, ""));
    const c = Number.isInteger(n) ? cands[n - 1] : undefined;
    if (c && !out.has(c.factId))
      out.set(c.factId, {
        relation: query ? validatedRelation(query, c.report, d) : d.relation,
        confidence: d.confidence,
        note: d.note ?? "",
        evidence: d.evidence,
      });
  }
  return out;
}

/** Candidates the model calls the same occurrence, most confident first (recall similarity breaks ties). */
export function sameOccurrence(cands: CandidateView[], verdicts: Map<number, Verdict>): CandidateView[] {
  return cands
    .filter((c) => verdicts.get(c.factId)?.relation === "SAME_OCCURRENCE")
    .sort((a, b) => verdicts.get(b.factId)!.confidence - verdicts.get(a.factId)!.confidence || b.score - a.score);
}

/** Keep the preferred story, but converge its confirmed duplicate facts toward one stable identity. */
export function sameOccurrenceForGrouping(cands: CandidateView[], verdicts: Map<number, Verdict>): CandidateView[] {
  const matches = sameOccurrence(cands, verdicts);
  return [...new Set(matches.map((c) => c.storyId))].flatMap((storyId) => matches.filter((c) => c.storyId === storyId).sort((a, b) => a.factId - b.factId));
}

/** The story a development joins: the most similar candidate that is its story's root occurrence. */
export function storyForDevelopment(cands: CandidateView[], verdicts: Map<number, Verdict>): CandidateView | null {
  return cands.filter((c) => c.storyRoot && verdicts.get(c.factId)?.relation === "SAME_STORY").sort((a, b) => b.score - a.score)[0] ?? null;
}

export function looksLikeRoundup(cands: CandidateView[], verdicts: Map<number, Verdict>): boolean {
  return cands.length > 0 && cands.every((c) => verdicts.get(c.factId)?.relation === "ROUNDUP");
}

/** A discussion post counts for a fact it reports, or one it clearly reacts to. */
export function signalTarget(cands: CandidateView[], verdicts: Map<number, Verdict>, minReactionConfidence = 0.8): CandidateView | null {
  return (
    sameOccurrence(cands, verdicts)[0] ??
    cands
      .filter((c) => verdicts.get(c.factId)?.relation === "SAME_STORY" && verdicts.get(c.factId)!.confidence >= minReactionConfidence)
      .sort((a, b) => b.score - a.score)[0] ??
    null
  );
}

/** How sure a relation must be before a report counts as evidence that two stories are one. */
export const TIE_MIN_CONFIDENCE = 0.8;

/** A report is firmly tied to a candidate it calls the same occurrence or a direct development of. */
export function firmlyTied(relation: string | undefined, confidence: number | undefined, minConfidence = TIE_MIN_CONFIDENCE): boolean {
  return (relation === "SAME_OCCURRENCE" || relation === "SAME_STORY") && (confidence ?? 0) >= minConfidence;
}

/**
 * The review model's bar for merging two stories. It reports 0.75 for most developments it agrees
 * with: on the 370 reference pairs (2026-09-29) story-level precision is 0.944 and recall 0.962 at
 * 0.75, against 0.964 and 0.896 at 0.8, and on 170 real root pairs the extra merges read as right.
 */
export const STORY_REVIEW_MIN_CONFIDENCE = 0.75;

/** The text a report is embedded with: title and the start of the summary, the same on both sides of a comparison. */
export function reportText(title: string, summary: string | null | undefined): string {
  return `${title}。${(summary ?? "").slice(0, 300)}`;
}

/** Lexical stand-in for cosine when embeddings are off (tests, development without a key): shared character bigrams. */
export function lexicalSimilarity(a: string, b: string): number {
  const grams = (s: string) => {
    const chars = [...s.replace(/\s+/g, "")];
    return new Set(chars.map((_c, i) => chars.slice(i, i + 2).join("")).filter((g) => g.length === 2));
  };
  const g = grams(a),
    h = grams(b);
  if (!g.size || !h.size) return 0;
  let inter = 0;
  for (const x of g) if (h.has(x)) inter++;
  return inter / Math.min(g.size, h.size);
}
