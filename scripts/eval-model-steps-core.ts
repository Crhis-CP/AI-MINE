// Pure parts of scripts/eval-model-steps.ts (TASK-0601): seeded sampling, the per-model token cap, comparison metrics
// against the stored DeepSeek results, automatic translation checks and the report. No database, network or clock.
import { createHash } from "node:crypto";
import { restoreTranslationText } from "../packages/backend/src/editorial/translation-readiness.ts";

export const STEPS = ["prefilter", "score", "structure", "translate"] as const;
export type Step = (typeof STEPS)[number];
export type Gold = "select" | "reject" | "either";
/** Rough tokens per call before the first measurement (design §2): shared rules plus material and output. */
export const CALL_ESTIMATE: Record<Step, number> = { prefilter: 13_800, score: 14_200, structure: 14_600, translate: 2_700 };

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** A fixed order for a seed that does not depend on the order the database returned the rows in. */
export function seededOrder<T>(items: readonly T[], seed: string | number, key: (item: T) => string): T[] {
  return items
    .map((item) => ({ item, k: sha(`${seed}:${key(item)}`) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .map((x) => x.item);
}

/** Takes `n` items: preferred ones first (higher `prefer`), then in seeded order; groups take turns when `groupOf` is given. */
export function draw<T>(
  items: readonly T[],
  n: number,
  opts: { seed: string | number; key: (item: T) => string; groupOf?: (item: T) => string; prefer?: (item: T) => number; exclude?: ReadonlySet<string> },
): T[] {
  const pool = seededOrder(
    items.filter((item) => !opts.exclude?.has(opts.key(item))),
    opts.seed,
    opts.key,
  ).sort((a, b) => (opts.prefer?.(b) ?? 0) - (opts.prefer?.(a) ?? 0));
  if (!opts.groupOf) return pool.slice(0, n);
  const groups = new Map<string, T[]>();
  for (const item of pool) groups.set(opts.groupOf(item), [...(groups.get(opts.groupOf(item)) ?? []), item]);
  const lanes = [...groups.keys()].sort().map((k) => groups.get(k)!);
  const out: T[] = [];
  for (let round = 0; out.length < n && lanes.some((lane) => lane.length > round); round++)
    for (const lane of lanes) if (lane[round] && out.length < n) out.push(lane[round]!);
  return out;
}

/** Wilson 95% interval for k of n (docs/05-quality/05-evaluation-sets.md §5). */
export function wilson(k: number, n: number, z = 1.96) {
  if (!n) return { k, n, rate: null, low: null, high: null };
  const p = k / n,
    d = 1 + (z * z) / n,
    c = p + (z * z) / (2 * n),
    m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { k, n, rate: r(p), low: r(Math.max(0, (c - m) / d)), high: r(Math.min(1, (c + m) / d)) };
}
/** Paired counts of problems on the same n cases: within max(2 points, 3 cases) is a tie. */
export function pairedVerdict(candidateBad: number, baselineBad: number, n: number): "持平" | "候选更好" | "候选更差" {
  const diff = candidateBad - baselineBad;
  return Math.abs(diff) < Math.max(0.02 * n, 3) ? "持平" : diff < 0 ? "候选更好" : "候选更差";
}

/**
 * The per-model token cap: a call starts only while what was spent (earlier runs of the same model included), what is
 * still in flight and one more call at the largest size seen so far stay within the cap.
 */
export class TokenBudget {
  readonly cap: number;
  spent: number;
  private inFlight = 0;
  private largest: number;
  constructor(cap: number, prior: number, estimate: number) {
    if (!Number.isSafeInteger(cap) || cap <= 0) throw new RangeError("--token-cap must be a positive integer");
    this.cap = cap;
    this.spent = prior;
    this.largest = estimate;
  }
  reserve(): number | null {
    const size = this.largest;
    if (this.spent + this.inFlight + size > this.cap) return null;
    this.inFlight += size;
    return size;
  }
  settle(reserved: number, actual: number) {
    this.inFlight -= reserved;
    this.spent += actual;
    if (actual > this.largest) this.largest = actual;
  }
  remainingCalls() {
    return Math.max(0, Math.floor((this.cap - this.spent) / this.largest));
  }
}

export interface Usage {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cached: number;
  reasoning: number;
  latencyMs: number;
  returnedModels: string[];
}
export const emptyUsage = (): Usage => ({ calls: 0, tokensIn: 0, tokensOut: 0, cached: 0, reasoning: 0, latencyMs: 0, returnedModels: [] });
const integer = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
/** One provider usage object (OpenAI-compatible; DeepSeek and Bailian name the cache hits differently). */
export function usageOf(usage: Record<string, unknown> | null, latencyMs: number, returnedModel: string | null): Usage {
  const prompt = (usage?.prompt_tokens_details ?? {}) as Record<string, unknown>,
    completion = (usage?.completion_tokens_details ?? {}) as Record<string, unknown>;
  return {
    calls: 1,
    tokensIn: integer(usage?.prompt_tokens ?? usage?.input_tokens),
    tokensOut: integer(usage?.completion_tokens ?? usage?.output_tokens),
    cached: integer(prompt.cached_tokens ?? usage?.prompt_cache_hit_tokens),
    reasoning: integer(completion.reasoning_tokens),
    latencyMs: integer(latencyMs),
    returnedModels: returnedModel ? [returnedModel] : [],
  };
}
export function addUsage(a: Usage, b: Usage): Usage {
  return {
    calls: a.calls + b.calls,
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
    cached: a.cached + b.cached,
    reasoning: a.reasoning + b.reasoning,
    latencyMs: a.latencyMs + b.latencyMs,
    returnedModels: [...new Set([...a.returnedModels, ...b.returnedModels])],
  };
}
export const usageTokens = (u: Usage) => u.tokensIn + u.tokensOut;

// ---- result files --------------------------------------------------------------------------------------------------

export interface Baseline {
  label: "PASS" | "BLOCK" | "UNKNOWN" | null;
  selected: boolean | null;
  firstScore: number | null;
  threshold: number | null;
  category: string | null;
  subjects: string[];
  countries: string[];
  hasFact: boolean | null;
  /** False when DeepSeek judged it with an older prompt version than the one evaluated now. */
  promptCurrent: boolean | null;
}
export interface SampleCase {
  articleId: string;
  revision: number;
  title: string;
  fingerprint: string;
  stratum: string;
  language: string | null;
  gold: Gold | null;
  baseline: Baseline;
}
export interface SegmentResult {
  index: number;
  language: string | null;
  source: string;
  candidate: string | null;
  baseline: string | null;
  finishReason: string | null;
  error?: string;
}
export interface Candidate {
  label?: "PASS" | "BLOCK" | "UNKNOWN";
  score?: number | null;
  selected?: boolean;
  category?: string | null;
  subjects?: string[];
  countries?: string[];
  hasFact?: boolean;
  segments?: SegmentResult[];
}
export interface CaseResult extends SampleCase {
  candidate: Candidate | null;
  error: string | null;
  receiptIds: number[];
  usage: Usage;
}
export interface ResultFile {
  format: "model-bakeoff-result-v1";
  step: Step;
  model: string;
  stopReason: string | null;
  tokenCap: number;
  priorTokens: number;
  startedAt: string;
  finishedAt: string | null;
  cases: CaseResult[];
  summary?: Record<string, unknown>;
}

// ---- translation checks --------------------------------------------------------------------------------------------

const ENTITY: Record<string, string> = { amp: "&", nbsp: " ", lt: "<", gt: ">", quot: '"', "#39": "'" };
export const visible = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|nbsp|lt|gt|quot|#39);/g, (_m, e: string) => ENTITY[e]!)
    .replace(/\b(?:https?:\/\/|www\.)\S+/g, " ")
    .replace(/⟦\d+⟧/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const SCALE: Array<[RegExp, number]> = [
  [/^(?:trillion|billones?|trilh(?:ão|ões))/i, 1e12],
  [/^(?:billion|bn|mil millones|bilh(?:ão|ões))/i, 1e9],
  [/^(?:million|mln|m\b|mill(?:ón|ones)|milh(?:ão|ões))/i, 1e6],
  [/^(?:thousand|mil\b)/i, 1e3],
];
const ZH_SCALE: Record<string, number> = { 万亿: 1e12, 亿: 1e8, 万: 1e4, 千: 1e3, 百万: 1e6 };
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(a) * 1e-6);
/** A source number may read “1,234.5” or (Spanish, Portuguese) “1.234,5”; both readings are kept. */
function readings(raw: string): number[] {
  const plain = Number(raw.replace(/,/g, "")),
    latin = Number(raw.replace(/\./g, "").replace(",", "."));
  return [...new Set([plain, latin].filter(Number.isFinite))];
}
/** Each number in the source text with every value it may stand for (a scale word after it multiplies it). */
export function sourceNumbers(text: string): Array<{ raw: string; values: number[] }> {
  return [...text.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => {
    const after = text.slice(m.index! + m[0].length).replace(/^\s+/, "");
    const scale = SCALE.find(([re]) => re.test(after))?.[1] ?? 1;
    const base = readings(m[0]);
    return { raw: m[0], values: [...base, ...(scale === 1 ? [] : base.map((v) => v * scale))] };
  });
}
/** The values written in the translation, “35亿” and “210万” read as whole numbers. */
export function translatedNumbers(text: string): number[] {
  return [...text.matchAll(/(\d+(?:[.,]\d+)*)\s*(万亿|百万|亿|万|千)?/g)].flatMap((m) => {
    const base = readings(m[1]!);
    return m[2] ? [...base, ...base.map((v) => v * ZH_SCALE[m[2]!]!)] : base;
  });
}
export function missingNumbers(source: string, translated: string): string[] {
  const found = translatedNumbers(translated);
  return sourceNumbers(source)
    .filter((n) => !translated.includes(n.raw) && !n.values.some((v) => found.some((f) => near(v, f))))
    .map((n) => n.raw);
}

const UNITS: Array<[string, RegExp, RegExp]> = [
  ["%", /%|\bper ?cent\b|\bpor ?ciento\b|\bpor ?cento\b/i, /%|％|百分之/],
  ["Mt", /\d\s*Mt\b|\bmillion (?:tonnes|tons|metric tons)\b/i, /百万吨|亿吨|万吨|Mt/],
  ["kt", /\d\s*kt\b|\bthousand (?:tonnes|tons)\b/i, /千吨|万吨|kt/],
  ["t", /\d\s*t\b|\b(?:tonnes?|tons?|toneladas?)\b/i, /吨/],
  ["g/t", /\bg\/t\b/i, /克\/吨|g\/t/],
  ["oz", /\d\s*oz\b|\bounces?\b|\bonzas?\b/i, /盎司/],
  ["lb", /\d\s*lbs?\b|\bpounds\b|\blibras\b/i, /磅/],
  ["US$", /US\$|\bUSD\b|\bdólares\b|(?<!Canadian |Australian )\bdollars?\b/i, /美元/],
  ["C$", /C\$|\bCAD\b/, /加元|加拿大元/],
  ["A$", /A\$|\bAUD\b/, /澳元/],
  ["km", /\d\s*km\b|\bkilomet(?:er|re|ro)s?\b/i, /公里|千米|km/i],
  ["ha", /\d\s*ha\b|\bhect(?:ares?|áreas?)\b/i, /公顷/],
  ["MW", /\d\s*MW\b|\bmegawatts?\b/i, /兆瓦|MW/],
];
export function missingUnits(source: string, translated: string): string[] {
  return UNITS.filter(([, src, zh]) => src.test(source) && !zh.test(translated)).map(([name]) => name);
}

/** “中文（原文）” pairs from industry/prompts/rules-domain-names*.md, as data. */
export function parseDomainNames(markdown: string): Map<string, string> {
  return new Map([...markdown.matchAll(/([\p{Script=Han}]+)（([^）]+)）/gu)].map((m) => [m[2]!.trim(), m[1]!]));
}
const STOP = new Set(
  "The A An In On At For But And Or Of To By As It Its This That These Those He She They We Our His Her Their Mr Ms Mrs Dr El La Los Las Lo Un Una En Del De Da Do Das Dos O Os As Em No Na Según Segun Sin Con Por Para Este Esta Esse Essa January February March April May June July August September October November December Monday Tuesday Wednesday Thursday Friday Saturday Sunday".split(
    " ",
  ),
);
const COMPANY = /\b(?:Mining|Mines|Minerals|Resources|Metals|Gold|Copper|Lithium|Silver|Nickel|Corp|Corporation|Inc|Ltd|Limited|Group|Project|Mine|S\.A\.)\b/;
const PLACES = new Set(
  "United States|United Kingdom|South Africa|North America|South America|Latin America|New South Wales|Western Australia|Northern Territory|British Columbia|Hong Kong|New York|European Union|Saudi Arabia|New Zealand|Democratic Republic".split(
    "|",
  ),
);
/** Capitalised company and project names of the source: multi-word names, names with a company word, and listed names. */
export function sourceEntities(text: string, names: ReadonlyMap<string, string>): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/[A-Z][\p{L}&'.-]*(?:\s+(?:de\s+|del\s+|do\s+|da\s+)?[A-Z][\p{L}&'.-]*)*/gu)) {
    const words = m[0].split(/\s+/);
    while (words.length && STOP.has(words[0]!)) words.shift();
    const name = words.join(" ").replace(/[.'-]+$/, "");
    if (name.length < 3 || PLACES.has(name)) continue;
    if (words.length > 1 || COMPANY.test(name) || names.has(name)) found.add(name);
  }
  return [...found];
}
/** A name must stay in its original script or use its listed Chinese name; anything else counts as transliterated. */
export function changedEntities(source: string, translated: string, names: ReadonlyMap<string, string>): string[] {
  return sourceEntities(source, names).filter((name) => {
    // A sentence's first word can run into the name (“Meanwhile Barrick Gold”), so the name without it also counts.
    const tail = name.split(" ").slice(1).join(" ");
    if (translated.includes(name) || (tail.length >= 3 && translated.includes(tail))) return false;
    const listed = [...names].find(([original]) => name.includes(original));
    return !(listed && translated.includes(listed[1]));
  });
}
/** A sentence with six or more English words in a row left untranslated. */
export const residualEnglish = (translated: string) => /(?:\b[A-Za-z][a-z'-]+\b[\s,;]+){5}\b[A-Za-z][a-z'-]+\b/.test(translated);

export interface SegmentCheck {
  structureKept: boolean;
  numbers: string[];
  units: string[];
  entities: string[];
  truncated: boolean;
  residualEnglish: boolean;
  lengthOutlier: boolean;
}
/** The design's automatic checks for one translated segment (the source HTML as shielded for the model). */
export function checkSegment(
  sourceHtml: string,
  translatedHtml: string,
  names: ReadonlyMap<string, string>,
  opts: { finishReason?: string | null; reference?: string | null } = {},
): SegmentCheck {
  const source = visible(sourceHtml),
    translated = visible(translatedHtml);
  const ratio = opts.reference ? translated.length / Math.max(1, visible(opts.reference).length) : 1;
  return {
    structureKept: restoreTranslationText(sourceHtml, { text: translatedHtml }) !== null,
    numbers: missingNumbers(source, translated),
    units: missingUnits(source, translated),
    entities: changedEntities(source, translated, names),
    truncated: opts.finishReason === "length",
    residualEnglish: residualEnglish(translated),
    lengthOutlier: ratio < 0.7 || ratio > 1.3,
  };
}

// ---- metrics -------------------------------------------------------------------------------------------------------

const rate = (k: number, n: number) => (n ? Math.round((k / n) * 1000) / 1000 : null);
const sameSet = (a: readonly string[] = [], b: readonly string[] = []) => [...new Set(a)].sort().join("|") === [...new Set(b)].sort().join("|");
const passOf = (label: string | null | undefined) => (label === "BLOCK" ? "BLOCK" : label ? "PASS" : null);

export function prefilterMetrics(cases: readonly CaseResult[]) {
  const done = cases.filter((c) => c.candidate?.label);
  const kept = done.filter((c) => c.stratum.startsWith("selected"));
  const compared = done.filter((c) => passOf(c.baseline.label));
  const dsPass = compared.filter((c) => passOf(c.baseline.label) === "PASS");
  return {
    falseReject: wilson(kept.filter((c) => c.candidate!.label === "BLOCK").length, kept.length),
    ownerSelectBlocked: done.filter((c) => c.gold === "select" && c.candidate!.label === "BLOCK").length,
    agreement: wilson(compared.filter((c) => passOf(c.candidate!.label) === passOf(c.baseline.label)).length, compared.length),
    blockedWhereDeepSeekPassed: wilson(dsPass.filter((c) => c.candidate!.label === "BLOCK").length, dsPass.length),
  };
}

export function scoreMetrics(cases: readonly CaseResult[]) {
  const done = cases.filter((c) => typeof c.candidate?.score === "number");
  const diffs = done.filter((c) => c.baseline.firstScore !== null).map((c) => Math.abs(c.candidate!.score! - c.baseline.firstScore!));
  const decided = done.filter((c) => c.baseline.selected !== null);
  const gold = done.filter((c) => c.gold === "select" || c.gold === "reject");
  const right = (selected: boolean | null | undefined, g: Gold | null) => selected === (g === "select");
  const goldDs = gold.filter((c) => c.baseline.selected !== null);
  return {
    meanAbsDiff: diffs.length ? Math.round((diffs.reduce((a, b) => a + b, 0) / diffs.length) * 10) / 10 : null,
    selectionAgreement: wilson(decided.filter((c) => c.candidate!.selected === c.baseline.selected).length, decided.length),
    ownerAccuracy: wilson(gold.filter((c) => right(c.candidate!.selected, c.gold)).length, gold.length),
    deepSeekOwnerAccuracy: wilson(goldDs.filter((c) => right(c.baseline.selected, c.gold)).length, goldDs.length),
    missed: gold.filter((c) => c.gold === "select" && !c.candidate!.selected).length,
    falselySelected: gold.filter((c) => c.gold === "reject" && c.candidate!.selected).length,
    staleBaseline: done.filter((c) => c.baseline.promptCurrent === false).length,
  };
}

export function structureMetrics(cases: readonly CaseResult[]) {
  const done = cases.filter((c) => c.candidate && "category" in c.candidate);
  const agree = (f: (c: CaseResult) => boolean) => wilson(done.filter(f).length, done.length);
  return {
    category: agree((c) => c.candidate!.category === c.baseline.category),
    subjects: agree((c) => sameSet(c.candidate!.subjects, c.baseline.subjects)),
    countries: agree((c) => sameSet(c.candidate!.countries, c.baseline.countries)),
    fact: agree((c) => c.candidate!.hasFact === c.baseline.hasFact),
    parseFailures: wilson(cases.filter((c) => c.error?.includes("unusable output")).length, cases.length),
  };
}

export function translationMetrics(cases: readonly CaseResult[], names: ReadonlyMap<string, string>) {
  const tally = (side: "candidate" | "baseline") => {
    const t = { segments: 0, failed: 0, structureKept: 0, numbers: 0, units: 0, entities: 0, truncated: 0, residualEnglish: 0, lengthOutliers: 0 };
    for (const s of cases.flatMap((c) => c.candidate?.segments ?? [])) {
      const text = s[side];
      if (s.baseline === null) continue;
      t.segments++;
      if (text === null) {
        t.failed++;
        continue;
      }
      const check = checkSegment(s.source, text, names, side === "candidate" ? { finishReason: s.finishReason, reference: s.baseline } : {});
      t.structureKept += +check.structureKept;
      t.numbers += check.numbers.length;
      t.units += check.units.length;
      t.entities += check.entities.length;
      t.truncated += +check.truncated;
      t.residualEnglish += +check.residualEnglish;
      t.lengthOutliers += +check.lengthOutlier;
    }
    return t;
  };
  const candidate = tally("candidate"),
    deepseek = tally("baseline");
  const per100 = (k: number, n: number) => (n ? Math.round((k / n) * 1000) / 10 : null);
  const keptGap = (rate(deepseek.structureKept, deepseek.segments) ?? 0) - (rate(candidate.structureKept, candidate.segments) ?? 0);
  const issueGap =
    (per100(candidate.numbers + candidate.entities, candidate.segments) ?? 0) - (per100(deepseek.numbers + deepseek.entities, deepseek.segments) ?? 0);
  return {
    candidate,
    deepseek,
    structureKept: wilson(candidate.structureKept, candidate.segments),
    numberAndEntityIssuesPer100: {
      candidate: per100(candidate.numbers + candidate.entities, candidate.segments),
      deepseek: per100(deepseek.numbers + deepseek.entities, deepseek.segments),
    },
    // Design §2.4 “质量相当”, before the blind review: structure within 1 point, at most 1 more issue per 100, no truncation.
    automaticChecksPass: candidate.segments > 0 && keptGap <= 0.01 && issueGap <= 1 && candidate.truncated === 0,
  };
}

export function summarize(file: ResultFile, names: ReadonlyMap<string, string> = new Map()) {
  const usage = file.cases.reduce((a, c) => addUsage(a, c.usage), emptyUsage());
  const n = file.cases.filter((c) => c.candidate).length;
  const metrics =
    file.step === "prefilter"
      ? prefilterMetrics(file.cases)
      : file.step === "score"
        ? scoreMetrics(file.cases)
        : file.step === "structure"
          ? structureMetrics(file.cases)
          : translationMetrics(file.cases, names);
  return {
    step: file.step,
    model: file.model,
    n,
    errors: file.cases.filter((c) => c.error).length,
    insufficient: n < 30,
    stopReason: file.stopReason,
    ...metrics,
    usage: {
      ...usage,
      avgTokensIn: usage.calls ? Math.round(usage.tokensIn / usage.calls) : null,
      avgTokensOut: usage.calls ? Math.round(usage.tokensOut / usage.calls) : null,
      cacheHitRate: rate(usage.cached, usage.tokensIn),
      avgLatencyMs: usage.calls ? Math.round(usage.latencyMs / usage.calls) : null,
    },
    tokensThisRun: usageTokens(usage),
    tokensWithEarlierRuns: file.priorTokens + usageTokens(usage),
  };
}

const show = (v: unknown): string => {
  if (v && typeof v === "object" && "rate" in v) {
    const w = v as ReturnType<typeof wilson>;
    return w.rate === null ? "—" : `${w.k}/${w.n}（${Math.round(w.rate * 1000) / 10}%，区间 ${w.low}–${w.high}）`;
  }
  return v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);
};
/** Markdown for docs/acceptance/model-bakeoff-20261109/README.md; it holds counts only, never article text. */
export function renderReport(summaries: ReadonlyArray<ReturnType<typeof summarize>>): string {
  const lines = ["# 模型比选运行结果（与 DeepSeek 库存结果对照，非人工金标）", ""];
  for (const step of STEPS) {
    const rows = summaries.filter((s) => s.step === step);
    if (!rows.length) continue;
    lines.push(`## ${step}`, "");
    for (const s of rows) {
      lines.push(`### ${s.model}${s.insufficient ? "（样本不足，n<30 不下结论）" : ""}`, "");
      for (const [key, value] of Object.entries(s)) if (!["step", "model", "insufficient"].includes(key)) lines.push(`- ${key}：${show(value)}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

// ---- blind review sheet --------------------------------------------------------------------------------------------

export interface SheetItem {
  articleId: string;
  index: number;
  kind: "numbers" | "names" | "es-pt" | "link";
  source: string;
  candidate: string;
  baseline: string;
}
/** Ten segments from different articles (4 number-heavy, 3 name-heavy, 2 Spanish/Portuguese, 1 with a link). */
export function pickSheet(cases: readonly CaseResult[], names: ReadonlyMap<string, string>, seed: string | number, total = 10): SheetItem[] {
  const quota: Array<[SheetItem["kind"], number]> = [
    ["numbers", Math.round(total * 0.4)],
    ["names", Math.round(total * 0.3)],
    ["es-pt", Math.round(total * 0.2)],
    ["link", 0],
  ];
  quota[3]![1] = total - quota.slice(0, 3).reduce((a, [, n]) => a + n, 0);
  const pool = cases.flatMap((c) =>
    (c.candidate?.segments ?? [])
      .filter((s) => s.candidate !== null && s.baseline !== null && restoreTranslationText(s.source, { text: s.candidate }) !== null)
      .map((s) => ({ c, s })),
  );
  const kindTest: Record<SheetItem["kind"], (x: (typeof pool)[number]) => boolean> = {
    numbers: (x) => sourceNumbers(visible(x.s.source)).length >= 3,
    names: (x) => sourceEntities(visible(x.s.source), names).length >= 2,
    "es-pt": (x) => /^(es|pt)/.test(x.s.language ?? ""),
    link: (x) => /<a\s/.test(x.s.source),
  };
  const used = new Set<string>(),
    out: SheetItem[] = [];
  const articles = (kind: SheetItem["kind"]) => new Set(pool.filter(kindTest[kind]).map((x) => x.c.articleId)).size;
  // The scarcest kind chooses first, so a few Spanish or Portuguese articles are not used up by the number quota.
  for (const [kind, n] of [...quota].sort((a, b) => articles(a[0]) - articles(b[0])))
    for (const x of draw(pool.filter(kindTest[kind]), pool.length, { seed: `${seed}:${kind}`, key: (x) => `${x.c.articleId}#${x.s.index}` })) {
      if (out.filter((o) => o.kind === kind).length >= n) break;
      if (used.has(x.c.articleId)) continue;
      used.add(x.c.articleId);
      out.push({ articleId: x.c.articleId, index: x.s.index, kind, source: x.s.source, candidate: x.s.candidate!, baseline: x.s.baseline! });
    }
  return quota.flatMap(([kind]) => out.filter((o) => o.kind === kind));
}
/** The sheet shows A and B in a seeded random order; the key that says which is which is written separately. */
export function blindSheet(items: readonly SheetItem[], candidateModel: string, seed: string | number) {
  const key: Array<{ n: number; articleId: string; index: number; kind: string; A: string; B: string }> = [];
  const lines = ["# 翻译盲评表", "", "每段选一项：A 好 / B 好 / 差不多。", ""];
  items.forEach((item, i) => {
    const swap = sha(`${seed}:${item.articleId}#${item.index}`).charCodeAt(0) % 2 === 1;
    const [a, b] = swap ? [item.candidate, item.baseline] : [item.baseline, item.candidate];
    key.push({
      n: i + 1,
      articleId: item.articleId,
      index: item.index,
      kind: item.kind,
      A: swap ? candidateModel : "deepseek",
      B: swap ? "deepseek" : candidateModel,
    });
    lines.push(
      `## 第 ${i + 1} 段`,
      "",
      `原文：${visible(item.source)}`,
      "",
      `译文 A：${visible(a)}`,
      "",
      `译文 B：${visible(b)}`,
      "",
      "选择：A 好 / B 好 / 差不多",
      "",
    );
  });
  return { markdown: lines.join("\n"), key };
}
