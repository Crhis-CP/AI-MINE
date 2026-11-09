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
import { COUNTRY_ALIASES, JURISDICTIONS } from "@amp/industry/jurisdictions";
import { promptText, promptVersion } from "../editorial/prompts.ts";

export const GROUP_BODY_CHARS = 10_000;
export const LEXICAL_RECALL_MIN = 0.25;
export const RECALL_TOP_FACTS = 10;
/** group_article judges at most this many candidate facts, in recall-similarity order (cost bound, Owner 2026-11). */
export const GROUP_ARTICLE_CANDIDATES = 5;
/** Only the most similar candidates (and their selected reports) carry the full original text into group_article. */
export const GROUP_FULL_TEXT_CANDIDATES = 2;
/** Other group_article reports carry title, stored summary and fact frame plus the head of the original, so verbatim quotes stay possible. */
export const GROUP_BRIEF_EXCERPT_CHARS = 600;
/** A brief report with no stored summary gets a longer original excerpt instead. */
export const GROUP_BRIEF_FALLBACK_CHARS = 1_500;
export const BATCH_PROMPT_VERSION = promptVersion("group-batch", "group-value");
export const RELATE_PROMPT_VERSION = promptVersion("group-batch", "group-pair", "group-signal");
/** Several independent review pairs that share one report A, asked in one request. */
export const PAIR_BATCH_PROMPT_VERSION = promptVersion("group-pair-batch");
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
export const PAIR_BATCH_SYSTEM = promptText("group-pair-batch");

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
// The same other names reader search knows (DRC, 澳洲, 印尼 …), so one country under two names is not a conflict.
for (const [country, names] of Object.entries(COUNTRY_ALIASES)) for (const name of names) countryByName.set(name.toLocaleLowerCase(), country);

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

export const PairBatchSchema = z.object({
  decisions: z.array(
    z.object({
      id: z.string().regex(/^C[1-9]\d*$/),
      relation: RelationSchema,
      difference: z.string().max(400).catch(""),
      evidence,
      confidence: z.number().min(0).max(1),
    }),
  ),
});

export const SignalSchema = z.object({
  decisions: z.array(z.object({ id: z.string().regex(/^C[1-9]\d*$/), relation: RelationSchema, confidence: z.number().min(0).max(1), evidence })),
});

function when(at: Date | null): string {
  if (!at) return "未知";
  return (at.getTime() + 8 * 3600_000) % 86400_000 === 0 ? beijingDate(at) : `${beijingDate(at)} ${beijingTime(at)}`;
}

/**
 * The original evidence line. A brief report keeps the head of its original (verbatim quotes stay
 * possible) and is labelled as an excerpt, so omitted detail is not read as absent.
 */
function originalEvidence(r: ReportView, brief: boolean): string {
  const text = r.originalText;
  if (!brief || text === undefined) return `原文证据：${text ?? "（无）"}`;
  const limit = (r.summary ?? "").trim() ? GROUP_BRIEF_EXCERPT_CHARS : GROUP_BRIEF_FALLBACK_CHARS;
  if (text.length <= limit) return `原文证据：${text}`;
  return `原文证据（节选前${limit}字，其余未随附；未随附的内容不等于原文没有）：${text.slice(0, limit)}`;
}

export function describeReport(r: ReportView, label: string, extra = "", brief = false): string {
  const f = r.frame;
  return [
    `【${label}】${extra}`,
    `标题：${r.title}`,
    r.scope ? `稿件范围：${r.scope === "single" ? "单一报道" : r.scope === "composite" ? "综合稿" : "未确认"}` : null,
    `来源：${r.source}${r.firstParty ? "（当事方/官方）" : ""}｜${r.sourceTimeLabel === undefined ? `发布时间：${when(r.at)}` : `时间信息：${r.sourceTimeLabel}`}`,
    originalEvidence(r, brief),
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

/**
 * The query always carries its full original. Candidates after the first `fullTextCandidates` (in
 * recall order) and the reading background are described briefly (describeReport).
 */
export function batchUser(
  query: ReportView,
  cands: CandidateView[],
  queryLabel = "新报道",
  reading: ReadingContext[] = [],
  fullTextCandidates = Number.POSITIVE_INFINITY,
): string {
  const briefReading = Number.isFinite(fullTextCandidates);
  const list = cands
    .map((c, i) =>
      [
        describeReport(c.report, `候选 ${candidateKey(i)}`, `（该事实已有 ${c.members} 篇报道；事实标题：${c.factTitle}）`, i >= fullTextCandidates),
        queryLabel !== "新报道"
          ? null
          : c.selected && c.selectedReport
            ? c.selectedReport.articleId && c.selectedReport.articleId === c.report.articleId
              ? "【已公开精选】以上代表报道已向读者展示，增量与该报道比较。"
              : describeReport(c.selectedReport, "已公开精选", "（增量只与这篇已展示的内容比较）", i >= fullTextCandidates)
            : "【尚无公开精选】此候选仅用于身份判断，不代表读者已经看过。",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  const background = reading
    .map(({ report }, i) => describeReport(report, `已公开精选阅读背景 R${i + 1}`, "（只比较信息覆盖，不是事实候选）", briefReading))
    .join("\n\n");
  const inventory = `事实候选数：${cands.length}\n事实候选编号：${JSON.stringify(cands.map((_, i) => candidateKey(i)))}`;
  return `${inventory}\n\n${describeReport(query, queryLabel)}\n\n${list}${background ? `\n\n${background}` : ""}\n\n${queryLabel}与每个候选的关系是什么？${reading.length ? "同时比较已公开精选的覆盖；无事实候选时 decisions=[]。" : ""}`;
}

export function pairUser(a: ReportView, b: ReportView): string {
  return `${describeReport(a, "报道 A")}\n\n${describeReport(b, "报道 B")}\n\n这两篇报道是什么关系？`;
}

/** Independent pairs that share report A, each B fully described, answered as one decision per candidate. */
export function pairBatchUser(a: ReportView, bs: ReportView[]): string {
  const inventory = `候选数：${bs.length}\n候选编号：${JSON.stringify(bs.map((_, i) => candidateKey(i)))}`;
  const list = bs.map((b, i) => describeReport(b, `候选 ${candidateKey(i)}（报道 B）`)).join("\n\n");
  return `${inventory}\n\n${describeReport(a, "报道 A")}\n\n${list}\n\n报道 A 与每个候选分别是什么关系？`;
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

/**
 * Confidence a discussion post needs to count as reacting to a fact (heat only). Kept apart from
 * TIE_MIN_CONFIDENCE on purpose: lowering the tie bar for reposts (TASK-0538) did not change heat attribution.
 */
export const REACTION_MIN_CONFIDENCE = 0.8;

/** A discussion post counts for a fact it reports, or one it clearly reacts to. */
export function signalTarget(cands: CandidateView[], verdicts: Map<number, Verdict>, minReactionConfidence = REACTION_MIN_CONFIDENCE): CandidateView | null {
  return (
    sameOccurrence(cands, verdicts)[0] ??
    cands
      .filter((c) => verdicts.get(c.factId)?.relation === "SAME_STORY" && verdicts.get(c.factId)!.confidence >= minReactionConfidence)
      .sort((a, b) => b.score - a.score)[0] ??
    null
  );
}

/**
 * How sure a relation must be before a report counts as evidence that two stories are one (consolidate),
 * before two stories list each other as related, before a composite mentions a fact, before a historical
 * (late-discovered) report attaches to an existing fact, and before the re-merge pass joins two facts.
 * Lowered from 0.8 on 2026-11-05: production runs one model for judge and review, and it answers
 * 0.7–0.75 for many reposts it agrees with, so 0.8 kept obvious same-event pairs apart.
 */
export const TIE_MIN_CONFIDENCE = 0.7;

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

/**
 * Two reports this alike, dated the same Beijing day and naming no conflicting country, need no second
 * (review) call before their stories merge: the first judgement stands on its own.
 */
export const SKIP_REVIEW_MIN_COSINE = 0.92;

/** A pair close enough that the review call is skipped (see SKIP_REVIEW_MIN_COSINE). */
export function reviewUnneeded(similarity: number, a: Pick<ReportView, "at" | "jurisdiction">, b: Pick<ReportView, "at" | "jurisdiction">): boolean {
  return (
    similarity >= SKIP_REVIEW_MIN_COSINE &&
    !!a.at &&
    !!b.at &&
    beijingDate(a.at) === beijingDate(b.at) &&
    !jurisdictionsConflict(a.jurisdiction, b.jurisdiction)
  );
}

// ---------------------------------------------------------------------------
// Document identity: a named document (《…》 law, regulation, notice, catalogue) keeps one identity
// however many sites repost it and however late. Its key recalls the facts that already carry it over a
// long window, beside the 14-day similarity recall; the judge still decides the relation.
// ---------------------------------------------------------------------------

/** Names shorter than this after normalising are too generic to identify a document (《通知》, 《实施方案》). */
export const DOCUMENT_KEY_MIN_CHARS = 5;
/** The endings of document names; a book title without one (a newspaper, a book, a film) is no document key. */
const DOCUMENT_SUFFIX =
  /(法|法典|条例|规定|办法|细则|决定|决议|通知|意见|方案|规划|目录|名录|清单|标准|公告|指南|纲要|准则|规则|计划|措施|法案|协定|协议|基准|要点|批复|章程|制度|令)$/u;
const BOOK_TITLE = /《([^《》]{1,120})》/gu;

/**
 * The normalised identity of a document name: width-folded, without spaces or punctuation, without a
 * leading 中华人民共和国/中国 and without trailing version notes such as （试行）（2025年修订）（征求意见稿）.
 * Null when the name is not document-like.
 */
export function documentKey(name: string): string | null {
  let key = name.normalize("NFKC").replace(/\s+/gu, "");
  for (let before = ""; before !== key; ) {
    before = key;
    key = key.replace(/\([^()]*\)$/u, "");
  }
  key = key.replace(/^(中华人民共和国|中国)/u, "").replace(/[·・\-—_"'“”‘’、，,。.:：;；!！?？<>〈〉]/gu, "");
  if ([...key].length < DOCUMENT_KEY_MIN_CHARS || !DOCUMENT_SUFFIX.test(key)) return null;
  return key;
}

/** Document keys named in book-title marks across the given titles, without duplicates. */
export function documentKeys(titles: Array<string | null | undefined>): string[] {
  const keys = new Set<string>();
  for (const title of titles)
    for (const match of (title ?? "").matchAll(BOOK_TITLE)) {
      const key = documentKey(match[1]!);
      if (key) keys.add(key);
    }
  return [...keys];
}

/**
 * A title names the document: one of its book titles has the same key, or it mentions the name without
 * book-title marks and none of its own book titles is a longer document built on that name (a local
 * 《某省生态环境法典实施办法》 does not name 《生态环境法典》).
 */
export function titleNamesDocument(title: string | null | undefined, key: string): boolean {
  const text = (title ?? "").normalize("NFKC").replace(/\s+/gu, "");
  const own = documentKeys([text]);
  if (own.includes(key)) return true;
  return text.includes(key) && !own.some((other) => other.includes(key));
}

/** A title for exact-duplicate checks: width-folded, without spaces, punctuation or a leading 「来源：」 label. */
export function titleKey(title: string): string {
  return title
    .normalize("NFKC")
    .replace(/^[^：:]{1,12}[：:]/u, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}
/** Exact-duplicate titles shorter than this are too generic to tie two reports without the judge. */
export const TITLE_KEY_MIN_CHARS = 8;

/**
 * A pair the code can tie without asking the model (cost design, Owner 2026-11-05: no model where the
 * code can decide): near-identical, same Beijing day, no conflicting country (reviewUnneeded), and either
 * the same normalised title or both naming the same document. Wire copies and same-day reposts of one
 * notice meet this; anything less certain still goes to the judge.
 */
export function certainDuplicate(
  similarity: number,
  a: Pick<ReportView, "at" | "jurisdiction" | "title">,
  b: Pick<ReportView, "at" | "jurisdiction" | "title">,
): boolean {
  if (!reviewUnneeded(similarity, a, b)) return false;
  const ka = titleKey(a.title);
  if ([...ka].length >= TITLE_KEY_MIN_CHARS && ka === titleKey(b.title)) return true;
  const keys = documentKeys([a.title]);
  return keys.length > 0 && keys.every((key) => titleNamesDocument(b.title, key)) && documentKeys([b.title]).every((key) => keys.includes(key));
}

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

// ---------------------------------------------------------------------------
// Key facts: the same company or named project with the same amount (TASK-0578)
// ---------------------------------------------------------------------------

/**
 * Words a capitalised Latin name in copy often is without naming anything in particular. A single
 * Latin word counts as a name only when it is long enough and not one of these.
 */
const NAME_STOPWORDS = new Set(
  [
    "mining",
    "mines",
    "minerals",
    "metals",
    "resources",
    "copper",
    "gold",
    "silver",
    "lithium",
    "nickel",
    "cobalt",
    "group",
    "limited",
    "company",
    "corporation",
    "holdings",
    "project",
    "projects",
    "energy",
    "global",
    "international",
    "national",
    "million",
    "billion",
    "update",
    "news",
    "report",
    "quarter",
    "first",
    "second",
    "third",
    "fourth",
  ].map((w) => w.toLowerCase()),
);
const MAGNITUDE: Record<string, number> = {
  万亿: 1e12,
  千亿: 1e11,
  百亿: 1e10,
  十亿: 1e9,
  亿: 1e8,
  千万: 1e7,
  百万: 1e6,
  十万: 1e5,
  万: 1e4,
  crore: 1e7,
  lakh: 1e5,
  thousand: 1e3,
  k: 1e3,
  million: 1e6,
  mn: 1e6,
  m: 1e6,
  billion: 1e9,
  bn: 1e9,
  b: 1e9,
};
const CURRENCY: Array<[RegExp, string]> = [
  [/^(?:美元|美金|usd|us\$|\$)$/i, "usd"],
  [/^(?:人民币|元|rmb|cny)$/i, "cny"],
  [/^(?:欧元|eur|€)$/i, "eur"],
  [/^(?:澳元|aud|a\$)$/i, "aud"],
  [/^(?:加元|cad|c\$)$/i, "cad"],
  [/^(?:英镑|gbp|£)$/i, "gbp"],
  [/^(?:卢比|rupees?|inr|rs\.?|₹)$/i, "inr"],
  [/^(?:兰特|zar|rand)$/i, "zar"],
  [/^(?:比索|pesos?)$/i, "peso"],
  [/^(?:雷亚尔|brl|reais)$/i, "brl"],
];
/** An amount: an optional currency sign or leading ISO code (USD 144 million), a number, an optional magnitude, an optional unit (currency, %, tonnes, ounces). */
const QUANTITY =
  /(us\$|a\$|c\$|\$|€|£|₹|\brs\.?|\b(?:usd|aud|cad|eur|gbp|cny|rmb|inr|zar|brl)(?=\s*\d))?\s*(\d+(?:[.,]\d+)*)\s*(万亿|千亿|百亿|十亿|亿|千万|百万|十万|万|crore|lakh|thousand|million|billion|mn|bn|[kmb](?![a-z]))?\s*(美元|美金|人民币|欧元|澳元|加元|英镑|卢比|兰特|比索|雷亚尔|元|usd|rmb|cny|eur|aud|cad|gbp|inr|zar|brl|rupees?|pesos?|reais|%|％|percent|吨|万吨|盎司|tonnes?|tons?|ounces?|oz)?/gi;

function currencyOf(sign: string | undefined, unit: string | undefined): string | null {
  for (const raw of [sign, unit]) {
    if (!raw) continue;
    const hit = CURRENCY.find(([pattern]) => pattern.test(raw));
    if (hit) return hit[1];
  }
  return null;
}

/** Three significant figures, so 1.44亿 and 144 million meet. */
function sig3(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return Number(value.toPrecision(3)).toString();
}

/**
 * The amounts a text states, normalised: money by currency and value, percentages, tonnes and ounces. A bare
 * number counts only with a magnitude (a 亿, a million); plain years, dates and counts do not.
 */
export function keyQuantities(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(QUANTITY)) {
    const [, sign, digits, magnitudeRaw, unitRaw] = m;
    if (!digits) continue;
    const magnitude = magnitudeRaw ? (MAGNITUDE[magnitudeRaw.toLowerCase()] ?? 1) : 1;
    const unit = unitRaw?.toLowerCase();
    // 1,000 or 1.44: a comma between groups of three is a thousands separator, otherwise a decimal point.
    const number = /,\d{3}(?!\d)/.test(digits) ? Number(digits.replace(/,/g, "")) : Number(digits.replace(",", "."));
    if (!Number.isFinite(number)) continue;
    const currency = currencyOf(sign, unit);
    if (currency) {
      out.add(`${currency}:${sig3(number * magnitude)}`);
      continue;
    }
    if (unit && /^(?:%|％|percent)$/.test(unit)) {
      out.add(`pct:${sig3(number)}`);
      continue;
    }
    if (unit && /^(?:吨|tonnes?|tons?)$/.test(unit)) {
      out.add(`t:${sig3(number * magnitude)}`);
      continue;
    }
    if (unit === "万吨") {
      out.add(`t:${sig3(number * 1e4 * magnitude)}`);
      continue;
    }
    if (unit && /^(?:盎司|ounces?|oz)$/.test(unit)) {
      out.add(`oz:${sig3(number * magnitude)}`);
      continue;
    }
    if (magnitudeRaw) out.add(`n:${sig3(number * magnitude)}`);
  }
  return out;
}

/**
 * The parties a text names: companies of the identity lexicon (guarded, in either language) and Latin proper
 * names the Chinese copy keeps as written (Resolution Copper, AngloGold Ashanti, Syerston).
 */
export function keyNames(text: string, lexicon: ReadonlyArray<{ id: string; patterns: RegExp[] }>): Set<string> {
  const out = new Set<string>();
  for (const entry of lexicon) if (entry.patterns.some((pattern) => pattern.test(text))) out.add(`co:${entry.id}`);
  for (const m of text.matchAll(/\b[A-Z][A-Za-z]+(?:[ -][A-Z][A-Za-z]+)*\b/g)) {
    const words = m[0].split(/[ -]/).filter((w) => !NAME_STOPWORDS.has(w.toLowerCase()));
    if (!words.length) continue;
    const phrase = words.join(" ").toLowerCase();
    if (words.length >= 2 || (words[0]!.length >= 5 && !/^[A-Z]+$/.test(words[0]!))) out.add(`nm:${phrase}`);
    // Each long word on its own too: "Resolution Copper Mining" and "Resolution Copper" share "resolution".
    for (const word of words) if (word.length >= 6 && !/^[A-Z]+$/.test(word)) out.add(`nm:${word.toLowerCase()}`);
  }
  return out;
}

export interface KeyFacts {
  names: Set<string>;
  quantities: Set<string>;
}

export function keyFacts(text: string, lexicon: ReadonlyArray<{ id: string; patterns: RegExp[] }>): KeyFacts {
  return { names: keyNames(text, lexicon), quantities: keyQuantities(text) };
}

/**
 * Two reports likely of one occurrence: they name the same party and state the same amount ("力拓批准1.44亿美元投资
 * Resolution Copper" and "Rio Tinto approves US$144 million for Resolution Copper"). Only a reason to put the pair
 * before the judge; it never merges on its own.
 */
export function sharesKeyFact(a: KeyFacts, b: KeyFacts): boolean {
  let name = false;
  for (const n of a.names)
    if (b.names.has(n)) {
      name = true;
      break;
    }
  if (!name) return false;
  for (const q of a.quantities) if (b.quantities.has(q)) return true;
  return false;
}
