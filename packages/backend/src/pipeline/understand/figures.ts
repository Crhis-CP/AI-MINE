// Numbers and dates in the Chinese copy must come from the source. The writer sometimes turns "2.5 billion" into
// 2.5亿, or a source's November 18 into 11月8日; nothing checked that until now. This is a program-side check: every
// figure in the title, summary and reason, and the fact's date, must have a counterpart in the source texts.
// A mismatch is a flag for counting and labelling, not an action: no item is held or rewritten because of it. Even
// the `hard` class is a report until a labelled sample shows how often it is right (design L, G4). Pure.
import { MONTH_PATTERN, monthNumber, RELATIVE_DAY, RELATIVE_YEAR } from "./calendar.ts";

/** Names this check by what it does and when it last changed; stored beside each result. */
export const FIGURES_RECIPE = "figures-v1";

export type FigureKind = "amount" | "number" | "percent" | "date" | "year";
export interface FigureFinding {
  field: "title" | "summary" | "reason" | "fact";
  /** The figure as the copy writes it. */
  token: string;
  kind: FigureKind;
  /** absent: nothing in the source supports it; scale_mismatch: the source has the same digits at another scale. */
  problem: "absent" | "scale_mismatch";
  /** hard: probably wrong; soft: unsupported, but the source may hold it in a form this check cannot read. */
  class: "soft" | "hard";
  /** The closest figure the source does have, as the source writes it. */
  nearest?: string;
}
export interface FigureCheck {
  verdict: "ok" | "soft" | "hard";
  findings: FigureFinding[];
}

export interface FigureCopy {
  titleZh: string;
  summaryZh: string;
  reasonZh: string | null;
  /** The fact's date as the structure step gave it (YYYY, YYYY-MM or YYYY-MM-DD, a time may follow). */
  occurredAt?: string | null;
}
export interface FigureSource {
  /** Everything the model was given: title, the whole body (not only the part the model read), excerpt, post text. */
  texts: readonly string[];
  /** The source's language code; digits are compared in any language, words only in zh, en, es, pt and fr. */
  language: string | null;
  /** The article's own date (YYYY-MM-DD, a time may follow), as the model's date line showed it. */
  sourceDate: string | null;
  /** Whether the body was extracted whole; a figure may sit in a part that was not. */
  complete: boolean;
  /** Whether the writer was also sent an image; a figure may come from a chart. */
  hasImage: boolean;
}

// ---- Reading numbers ------------------------------------------------------------------------------------------

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_SMALL: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

/** A number written in Chinese numerals (两千万, 一千二百, 三亿五千万), or null when the run is not one. */
export function chineseNumber(text: string): number | null {
  let total = 0,
    section = 0,
    digit: number | null = null;
  for (const c of text) {
    if (c in CN_DIGIT) {
      // Two digits in a row (十四五, 三一) are a name or a list, not a number; 零 only fills a gap.
      if (digit !== null && CN_DIGIT[c] !== 0) return null;
      digit = CN_DIGIT[c] === 0 ? null : CN_DIGIT[c]!;
    } else if (c in CN_SMALL) {
      section += (digit ?? 1) * CN_SMALL[c]!;
      digit = null;
    } else if (c === "万" || c === "亿") {
      section += digit ?? 0;
      if (!section && !total) return null;
      total = c === "亿" ? (total + section) * 1e8 : total + section * 1e4;
      section = 0;
      digit = null;
    } else return null;
  }
  return total + section + (digit ?? 0);
}

/** Every value a source's digit string can mean: 1,234.5 and 1.234,5 are both 1234.5; 1,234 may be 1234 or 1.234. */
export function readingsOf(token: string): number[] {
  const commas = token.split(",").length - 1,
    dots = token.split(".").length - 1;
  if (!commas && !dots) return [Number(token)];
  if (commas && dots) {
    const decimal = token.lastIndexOf(",") > token.lastIndexOf(".") ? "," : ".";
    const grouping = decimal === "," ? "." : ",";
    return [Number(token.split(grouping).join("").replace(decimal, "."))];
  }
  const parts = token.split(commas ? "," : ".");
  const out: number[] = [];
  if (parts.length === 2) out.push(Number(parts.join(".")));
  if (parts[0]!.length <= 3 && parts.slice(1).every((p) => p.length === 3)) out.push(Number(parts.join("")));
  return out.filter(Number.isFinite);
}

/** Scale words and letters after a source's number, most specific first. `also` keeps the unscaled reading too. */
const SCALES: { pattern: RegExp; scale: number; also?: boolean }[] = [
  { pattern: /^\s?(?:mil millones|mil milhões|mil milhoes|millardos?)(?![\p{L}])/iu, scale: 1e9 },
  { pattern: /^\s?(?:trillions?|billón|billones|trilhão|trilhões|trilhoes)(?![\p{L}])/iu, scale: 1e12 },
  { pattern: /^\s?(?:billions?|bn|bln|milliards?|bilhão|bilhões|bilhoes|млрд)(?![\p{L}])/iu, scale: 1e9 },
  { pattern: /^\s?(?:millions?|mn|mln|millón|millon|millones|milhão|milhões|milhoes|млн)(?![\p{L}])/iu, scale: 1e6 },
  { pattern: /^\s?(?:thousands?|mil|mille|тыс)(?![\p{L}])/iu, scale: 1e3 },
  // Units that carry the scale letter: 1.2Mt, 250koz, 30Mlb, 2.5Mtpa. Lower-case mt is often metric tonnes.
  { pattern: /^\s?M(?:t|tpa|tpy|oz|lbs?|wmt|dmt|bbl)(?![\p{L}])/u, scale: 1e6 },
  { pattern: /^\s?m(?:t|tpa|tpy)(?![\p{L}])/u, scale: 1e6, also: true },
  { pattern: /^\s?k(?:t|tpa|tpy|oz|lbs?|wmt|dmt|bbl)(?![\p{L}])/u, scale: 1e3 },
  // A letter alone: $300M, US$2.5B, 40k. Without a currency, m may be metres; the plain reading stays.
  { pattern: /^(?:B|b)(?![\p{L}])/u, scale: 1e9 },
  { pattern: /^(?:M|MM|m|mm)(?![\p{L}])/u, scale: 1e6, also: true },
  { pattern: /^(?:k|K)(?![\p{L}])/u, scale: 1e3 },
];

/** Number words a scale word may follow: two million tonnes, half a billion, dos millones, deux milliards. */
const NUMBER_WORDS: Record<string, number> = {};
for (const [value, words] of [
  [0.5, "half|half a|medio|media|meio|meia|demi|un demi"],
  [1, "a|an|one|un|una|uno|um|uma|une"],
  [2, "two|dos|dois|duas|deux"],
  [3, "three|tres|três|trois"],
  [4, "four|cuatro|quatro|quatre"],
  [5, "five|cinco|cinq"],
  [6, "six|seis"],
  [7, "seven|siete|sete|sept"],
  [8, "eight|ocho|oito|huit"],
  [9, "nine|nueve|nove|neuf"],
  [10, "ten|diez|dez|dix"],
  [12, "twelve|a dozen|doce|doze|douze"],
  [20, "twenty|veinte|vinte|vingt"],
  [100, "a hundred|one hundred|cien|cem|cent"],
] as const)
  for (const word of words.split("|")) NUMBER_WORDS[word] = value;
const WORDED = new RegExp(
  `(?<![\\p{L}])(${Object.keys(NUMBER_WORDS)
    .sort((a, b) => b.length - a.length)
    .join(
      "|",
    )})(?=\\s(?:mil millones|mil milhões|billions?|millions?|thousands?|milliards?|millions?|millones|millón|milhões|milhão|bilhões|bilhão)(?![\\p{L}]))`,
  "giu",
);

// ---- Reading the copy -----------------------------------------------------------------------------------------

const CURRENCY = "美元|美金|人民币|元|澳元|加元|欧元|英镑|雷亚尔|比索|兰特|卢布|日元|港元|索尔|坚戈|图格里克";
const METRIC = "公吨|吨|千克|公斤|克|公里|千米|米|公顷|平方公里|平方米|升|立方米";
const PHYSICAL = `${METRIC}|盎司|磅|桶|兆瓦|吉瓦|千瓦|瓦|英亩|英里|英尺`;
const ARABIC = "\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?";
const CN_RUN = "[零〇一二两三四五六七八九十百千万亿]{2,}";
const CN_SCALE = "[十百千]?万亿|[十百千]?[万亿]|千";
const COPY_NUMBER = new RegExp(
  `(?<![A-Za-z\\d.,:：])(?<a>${ARABIC}|${CN_RUN})(?<as>${CN_SCALE})?(?:\\s*(?:-|—|–|~|～|至|到)\\s*(?<b>${ARABIC}|${CN_RUN})(?<bs>${CN_SCALE})?)?\\s*(?<pct>%|％|个百分点)?(?<unit>(?:${CURRENCY}|${PHYSICAL})(?:/(?:吨|年|天|盎司|磅))?)?`,
  "gu",
);
const APPROX_BEFORE = /(?:约|近|逾|超过|超|大约|将近|接近|至少|不到|不足|高达|约合|多达)\s*$/;
const APPROX_AFTER = /^(?:多|余|以上|以下|左右|上下|出头)/;
const CN_SCALES: Record<string, number> = { 千: 1e3, 万: 1e4, 十万: 1e5, 百万: 1e6, 千万: 1e7, 亿: 1e8, 十亿: 1e9, 百亿: 1e10, 千亿: 1e11, 万亿: 1e12 };
const CURRENCY_EVIDENCE: Record<string, RegExp> = {
  美元: /US\$|USD|\$|dollars?|dólar(?:es)?|美元/i,
  美金: /US\$|USD|\$|dollars?|dólar(?:es)?|美元/i,
  加元: /C\$|CA\$|CAD|\$|dollars?|加元/i,
  澳元: /A\$|AU\$|AUD|\$|dollars?|澳元/i,
  人民币: /RMB|CNY|yuan|renminbi|元|¥/i,
  元: /RMB|CNY|yuan|renminbi|元|¥/i,
  欧元: /€|EUR|euros?/i,
  英镑: /£|GBP|sterling|pounds?/i,
  雷亚尔: /R\$|BRL|reais|real/i,
  比索: /pesos?|\$|COP|CLP|MXN|ARS/i,
  兰特: /rand|ZAR|R\s?\d/i,
  卢布: /rubles?|roubles?|RUB|руб/i,
  日元: /yen|JPY|¥/i,
  港元: /HK\$|HKD/i,
  索尔: /soles|PEN|S\//i,
  坚戈: /tenge|KZT/i,
  图格里克: /tugriks?|MNT|₮/i,
};
const ANY_CURRENCY =
  /US\$|[CAR]\$|HK\$|\$|€|£|¥|₮|\b(?:USD|CAD|AUD|EUR|GBP|CNY|RMB|BRL|ZAR|RUB|JPY|HKD|PEN|KZT|MNT|COP|CLP|MXN|ARS)\b|dollars?|dólar|euros?|yuan|pesos?|reais|rand\b|rubles?|roubles?|soles|tenge|元/i;
const IMPERIAL = /\b(?:short tons?|long tons?|pounds?|lbs?|miles?|feet|foot|ft|acres?|gallons?|yards?|opt)\b/i;

interface CopyFigure {
  field: FigureFinding["field"];
  token: string;
  kind: FigureKind;
  value?: number;
  /** The value's own precision: 约25亿 is precise to one 亿. */
  step?: number;
  /** A bare four-digit number from 1900 to 2100: a count, or a year written without 年. */
  yearLike?: boolean;
  approx?: boolean;
  /** Written with a Chinese scale (万, 亿): a misread source scale shows up as the same digits elsewhere. */
  scaled?: boolean;
  currency?: string;
  metric?: boolean;
  date?: { y: number | null; m: number | null; d: number | null; quarter?: number; half?: number };
}

/**
 * The round part of a whole number: its trailing zeros, but never more than leave two leading digits. 3000 may stand
 * for 2,980, and 1000万 for 10.4 million, but not for 5 million: a round figure is still near its source.
 */
const roundUnit = (value: number) => {
  if (!Number.isInteger(value) || value < 100) return 1;
  const digits = String(value);
  return 10 ** Math.min(digits.match(/0*$/)![0].length, digits.length - 2);
};
/** Precision of a figure the copy writes: its last decimal, or the round part of a whole number. */
function precision(digits: string, scale: number, percent: boolean): number {
  const decimals = digits.includes(".") ? digits.split(".")[1]!.length : 0;
  if (decimals) return 10 ** -decimals * scale;
  return percent ? scale : roundUnit(Number(digits.replace(/,/g, ""))) * scale;
}

/** Blank out a matched span so later patterns do not read its digits again. */
const blank = (text: string, start: number, length: number) => text.slice(0, start) + " ".repeat(length) + text.slice(start + length);
const QUARTER: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, "1": 1, "2": 2, "3": 3, "4": 4 };

/** The dates and figures of one field of the copy. */
function copyFigures(field: FigureFinding["field"], original: string, mask: readonly string[]): CopyFigure[] {
  let text = original;
  for (const name of mask) if (name) text = text.split(name).join(" ".repeat(name.length));
  const out: CopyFigure[] = [];
  const take = (pattern: RegExp, make: (m: RegExpExecArray) => CopyFigure | CopyFigure[] | null) => {
    for (const m of [...text.matchAll(pattern)]) {
      const made = make(m as RegExpExecArray);
      if (!made) continue;
      out.push(...(Array.isArray(made) ? made : [made]));
      text = blank(text, m.index!, m[0].length);
    }
  };
  const num = (s: string | undefined) => (s === undefined ? null : Number(s));
  take(/(\d{4})年(\d{1,2})月(\d{1,2})日/g, (m) => ({ field, token: m[0], kind: "date", date: { y: num(m[1]), m: num(m[2]), d: num(m[3]) } }));
  take(/(?<!\d)(\d{1,2})月(\d{1,2})日/g, (m) => ({ field, token: m[0], kind: "date", date: { y: null, m: num(m[1]), d: num(m[2]) } }));
  take(/(\d{4})年(\d{1,2})月(?!\d)/g, (m) => ({ field, token: m[0], kind: "date", date: { y: num(m[1]), m: num(m[2]), d: null } }));
  take(/(?<![\d.])(\d{4})\s*(?:-|—|–|~|～|至|到)\s*(\d{4})年(?!代)/g, (m) => [
    { field, token: m[1]!, kind: "year", value: Number(m[1]) },
    { field, token: `${m[2]}年`, kind: "year", value: Number(m[2]) },
  ]);
  take(/(?<![\d.])(\d{4})(?:财)?年(?!代)/g, (m) => ({ field, token: m[0], kind: "year", value: Number(m[1]) }));
  take(/(?<![A-Za-z])FY\s?'?(\d{2}|\d{4})(?!\d)/g, (m) => ({
    field,
    token: m[0],
    kind: "year",
    value: m[1]!.length === 2 ? 2000 + Number(m[1]) : Number(m[1]),
  }));
  take(/第?([一二三四1-4])季度|(?<![A-Za-z])Q([1-4])(?!\d)/g, (m) => ({
    field,
    token: m[0],
    kind: "date",
    date: { y: null, m: null, d: null, quarter: QUARTER[m[1] ?? m[2]!]! },
  }));
  take(/([上下])半年|(?<![A-Za-z])H([12])(?!\d)/g, (m) => ({
    field,
    token: m[0],
    kind: "date",
    date: { y: null, m: null, d: null, half: m[1] ? (m[1] === "上" ? 1 : 2) : Number(m[2]) },
  }));
  take(/(?<![\d.])(\d{1,2})月(?!\d)/g, (m) => ({ field, token: m[0], kind: "date", date: { y: null, m: num(m[1]), d: null } }));
  take(/百分之([零〇一二两三四五六七八九十百]+(?:点[零〇一二三四五六七八九]+)?|\d+(?:\.\d+)?)/g, (m) => {
    const [whole, fraction] = m[1]!.split("点");
    const base = /\d/.test(whole!) ? Number(whole) : chineseNumber(whole!);
    if (base === null) return null;
    const value = fraction ? Number(`${base}.${[...fraction].map((c) => CN_DIGIT[c]).join("")}`) : base;
    return { field, token: m[0], kind: "percent", value, step: fraction ? 10 ** -fraction.length : 1 };
  });
  take(COPY_NUMBER, (m) => {
    const g = m.groups!;
    const after = text.slice(m.index! + m[0].length);
    // A time of day (10:30), an enumeration (1、) or a numeral inside a word is not a figure.
    if (/^[:：]\d/.test(after) || (/^、/.test(after) && !g.unit && !g.pct)) return null;
    const approx = APPROX_BEFORE.test(text.slice(Math.max(0, m.index! - 4), m.index!)) || APPROX_AFTER.test(after);
    const percent = !!g.pct;
    const unit = g.unit?.replace(/\/.*$/, "");
    const kind: FigureKind = percent ? "percent" : unit ? "amount" : "number";
    const currency = unit && new RegExp(`^(?:${CURRENCY})$`).test(unit) ? unit : undefined;
    const metric = !!unit && new RegExp(`^(?:${METRIC})$`).test(unit);
    // In a range the scale and unit written once belong to both ends: 10至12亿美元.
    const ends = [{ digits: g.a!, scale: g.as ?? g.bs }, ...(g.b ? [{ digits: g.b, scale: g.bs }] : [])];
    const figures: CopyFigure[] = [];
    for (const end of ends) {
      const scale = end.scale ? CN_SCALES[end.scale]! : 1;
      const arabic = /\d/.test(end.digits);
      const base = arabic ? Number(end.digits.replace(/,/g, "")) : chineseNumber(end.digits);
      // A numeral run with no digit in it (千万不要, 万一) is a word, not a number.
      if (base === null || (!arabic && !/[一二两三四五六七八九]/.test(end.digits))) continue;
      const value = base * scale;
      if (!percent && !unit && !end.scale && Number.isInteger(value) && value <= 10) continue;
      // Only 年 (read above) makes a year; a bare 2000 is as often a count ("裁员2000人" for "2,000 jobs").
      const yearLike = kind === "number" && !end.scale && arabic && /^\d{4}$/.test(end.digits) && value >= 1900 && value <= 2100;
      figures.push({
        field,
        token: m[0].trim(),
        kind,
        ...(yearLike ? { yearLike } : {}),
        value,
        step: arabic ? precision(end.digits, scale, percent) : roundUnit(value),
        approx,
        scaled: !!end.scale || (!arabic && /[万亿]/.test(end.digits)),
        ...(currency ? { currency } : {}),
        metric,
      });
    }
    return figures;
  });
  return out;
}

// ---- Reading the source ---------------------------------------------------------------------------------------

interface SourceDate {
  y: number | null;
  m: number;
  d: number;
}
interface SourceFigures {
  numbers: { value: number; scaled: boolean; text: string }[];
  years: Set<number>;
  dates: SourceDate[];
  months: Set<number>;
  quarters: Set<number>;
  halves: Set<number>;
  text: string;
}

const MONTH = `(?:${MONTH_PATTERN})`;
const ORDINAL: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  primer: 1,
  primero: 1,
  primeiro: 1,
  premier: 1,
  segundo: 2,
  deuxième: 2,
  tercer: 3,
  tercero: 3,
  terceiro: 3,
  troisième: 3,
  cuarto: 4,
  quarto: 4,
  quatrième: 4,
};
const validDate = (m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= 31;
const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

function sourceFigures(texts: readonly string[], sourceDate: SourceDate | null, mask: readonly string[]): SourceFigures {
  let text = texts.join("\n").normalize("NFKC");
  for (const name of mask) if (name) text = text.split(name.normalize("NFKC")).join(" ".repeat(name.normalize("NFKC").length));
  const out: SourceFigures = { numbers: [], years: new Set(), dates: [], months: new Set(), quarters: new Set(), halves: new Set(), text };
  const date = (y: number | null, m: number | null, d: number) => {
    if (m !== null && validDate(m, d)) out.dates.push({ y, m, d });
    if (y) out.years.add(y);
  };
  for (const m of text.matchAll(/(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/g)) date(Number(m[1]), Number(m[2]), Number(m[3]));
  for (const m of text.matchAll(new RegExp(`(?<![\\p{L}])(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s+(\\d{4}))?`, "giu")))
    date(m[3] ? Number(m[3]) : null, monthNumber(m[1]!), Number(m[2]));
  for (const m of text.matchAll(
    new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th|er|º|°)?\\s+(?:de\\s+)?(${MONTH})(?![\\p{L}])\\.?(?:,?\\s+(?:de\\s+)?(\\d{4}))?`, "giu"),
  ))
    date(m[3] ? Number(m[3]) : null, monthNumber(m[2]!), Number(m[1]));
  for (const m of text.matchAll(/(?<![\d.])(\d{1,2})[/.](\d{1,2})[/.](\d{4}|\d{2})(?![\d.])/g)) {
    const y = fullYear(m[3]!);
    date(y, Number(m[2]), Number(m[1]));
    date(y, Number(m[1]), Number(m[2]));
  }
  for (const m of text.matchAll(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/g)) date(m[1] ? Number(m[1]) : null, Number(m[2]), Number(m[3]));
  // A short name alone is too often a word (mar, set, out, ago, the verb may): it counts as a month when it is at least
  // four letters, is May or mai, or is followed by a full stop or a year (Dec. , Mar 2026).
  for (const m of text.matchAll(new RegExp(`(?<![\\p{L}])(${MONTH})(?![\\p{L}])(\\.|\\s+\\d{4}(?!\\d))?`, "giu")))
    if (m[1]!.length >= 4 || m[1] === "May" || m[1]!.toLowerCase() === "mai" || m[2]) out.months.add(monthNumber(m[1]!)!);
  for (const m of text.matchAll(/(?<![\d.])(\d{1,2})月/g)) out.months.add(Number(m[1]));
  for (const m of text.matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)/g)) out.years.add(Number(m[1]));
  for (const m of text.matchAll(/(?<!\d)(20\d{2})[/-](\d{2})(?!\d)/g)) out.years.add(2000 + Number(m[2]));
  for (const m of text.matchAll(
    /(?<![A-Za-z])FY\s?'?(\d{4}|\d{2})(?!\d)|\b(?:fiscal|financial) (?:year )?(\d{4})\b|(?<![A-Za-z])[1-4]Q(\d{2})(?!\d)|(?<![A-Za-z])[HQ][1-4]\s?'?(\d{2})(?!\d)/gi,
  ))
    out.years.add(fullYear((m[1] ?? m[2] ?? m[3] ?? m[4])!));
  for (const m of text.matchAll(/(?<![A-Za-z])(?:Q([1-4])|([1-4])Q|T([1-4])|([1-4])T)(?![A-Za-z])/g)) out.quarters.add(Number(m[1] ?? m[2] ?? m[3] ?? m[4]));
  for (const m of text.matchAll(/(?<![\p{L}])(\p{L}+)[- ](?:quarter|trimestre)(?![\p{L}])|第?([一二三四1-4])季度/giu)) {
    const q = m[1] ? ORDINAL[m[1].toLowerCase()] : QUARTER[m[2]!];
    if (q) out.quarters.add(q);
  }
  for (const m of text.matchAll(/(?<![A-Za-z])(?:H([12])|([12])H)(?![A-Za-z])|(?<![\p{L}])(\p{L}+)[- ](?:half|semestre)(?![\p{L}])|([上下])半年/giu)) {
    const digit = m[1] ?? m[2];
    const half = digit ? Number(digit) : m[4] ? (m[4] === "上" ? 1 : 2) : ORDINAL[m[3]!.toLowerCase()];
    if (half === 1 || half === 2) out.halves.add(half);
  }
  if (/six months ended (?:june|30 june)|semestre terminado|premier semestre/i.test(text)) out.halves.add(1);
  if (sourceDate) {
    out.dates.push(sourceDate);
    out.months.add(sourceDate.m);
    if (sourceDate.y) out.years.add(sourceDate.y);
  }
  // Digit strings, each read every way it can be, with the scale words or letters that follow it.
  for (const m of text.matchAll(/(?<![\p{L}\d])(\d+(?:[.,]\d+)*)/gu)) {
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 24);
    const before = text.slice(Math.max(0, m.index! - 4), m.index!);
    const currency = /(?:US|[CAR]|HK)?\$\s?$|[€£¥]\s?$/.test(before);
    const scale = SCALES.find((s) => s.pattern.test(after));
    const scaleText = scale ? after.match(scale.pattern)![0] : "";
    for (const reading of readingsOf(m[1]!)) {
      if (scale) out.numbers.push({ value: reading * scale.scale, scaled: true, text: m[0] + scaleText });
      if (!scale || (scale.also && !currency)) out.numbers.push({ value: reading, scaled: false, text: m[0] });
      if (/^\s?(?:basis points|bps)\b/i.test(after)) out.numbers.push({ value: reading / 100, scaled: false, text: m[0] + after.split(/\s(?=\S*$)/)[0] });
    }
  }
  for (const m of text.matchAll(WORDED)) {
    const after = text.slice(m.index! + m[0].length);
    const scale = SCALES.find((s) => s.pattern.test(after))!;
    out.numbers.push({ value: NUMBER_WORDS[m[1]!.toLowerCase()]! * scale.scale, scaled: true, text: m[0] + after.match(scale.pattern)![0] });
  }
  // A Chinese source is also read the way the copy is (25亿, 两千万). Only then: in a Latin text it would add the
  // unscaled digits of "2.5 billion" back as a reading.
  if (/\p{Script=Han}/u.test(text))
    for (const figure of copyFigures("summary", text, []))
      if (figure.value !== undefined && figure.kind !== "year") out.numbers.push({ value: figure.value, scaled: !!figure.scaled, text: figure.token });
  return out;
}

// ---- Comparing ------------------------------------------------------------------------------------------------

/** A source value supports a copy value when it rounds or truncates to it at the copy's own precision. */
function supports(source: number, copy: number, unit: number, approx: boolean): boolean {
  const wanted = Math.round(copy / unit),
    q = source / unit;
  if (Math.round(q) === wanted || Math.trunc(q + 1e-9) === wanted) return true;
  return approx && Math.abs(source - copy) <= 0.1 * Math.abs(copy);
}
const dayNumber = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 86_400_000;
const parseDate = (value: string | null | undefined): { y: number; m: number | null; d: number | null } | null => {
  const m = value?.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/);
  return m ? { y: Number(m[1]), m: m[2] ? Number(m[2]) : null, d: m[3] ? Number(m[3]) : null } : null;
};
const isoDate = (d: SourceDate) => `${d.y ?? "????"}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;

const WORD_LANGUAGES = new Set(["zh", "en", "es", "pt", "fr"]);

/**
 * Check the copy's figures against the source. A figure matches a source candidate when they agree to the copy's own
 * precision (约25亿 matches 2.47 billion); the same digits at another scale is a scale_mismatch (2.5亿 against "2.5
 * billion"). A date matches a source date ±1 day, and a date up to seven days before the article's own date when the
 * source speaks of today, yesterday or a weekday; a year matches the article's year ±1 when the source says next or
 * last year. `mask` holds names with digits in them (South32, 南32, G20) found by the entity linker.
 * Kept low on false alarms: integers 0–10 without a unit are not checked; everything is at most soft when the body is
 * incomplete, an image was sent, or the language is one whose words are not read; an amount is soft when the copy
 * converted it (another currency, or metric units where the source has imperial). hard = scale_mismatch, or an amount
 * with a unit, a full date or a year written with 年 that is absent.
 */
export function checkFigures(copy: FigureCopy, source: FigureSource, mask: readonly string[] = []): FigureCheck {
  const own = parseDate(source.sourceDate);
  const sourceDate = own?.m && own.d ? { y: own.y, m: own.m, d: own.d } : null;
  const found = sourceFigures(source.texts, sourceDate, mask);
  const relativeDay = RELATIVE_DAY.test(found.text);
  const relativeYear = RELATIVE_YEAR.test(found.text);
  const language = source.language?.toLowerCase().split(/[-_]/)[0] ?? "";
  const capped = !source.complete || source.hasImage || !WORD_LANGUAGES.has(language);
  const sourceCurrency = ANY_CURRENCY.test(found.text);
  const imperial = IMPERIAL.test(found.text);
  const yearSupported = (y: number) => found.years.has(y) || (relativeYear && !!own && Math.abs(y - own.y) <= 1);

  const figures = [
    ...copyFigures("title", copy.titleZh, mask),
    ...copyFigures("summary", copy.summaryZh, mask),
    ...(copy.reasonZh ? copyFigures("reason", copy.reasonZh, mask) : []),
  ];
  const fact = parseDate(copy.occurredAt);
  if (fact)
    figures.push(
      fact.m
        ? { field: "fact", token: copy.occurredAt!, kind: "date", date: { y: fact.y, m: fact.m, d: fact.d } }
        : { field: "fact", token: copy.occurredAt!, kind: "year", value: fact.y },
    );

  const findings: FigureFinding[] = [];
  for (const f of figures) {
    let problem: FigureFinding["problem"] | null = "absent";
    let nearest: string | undefined;
    let fullDate = false;
    if (f.kind === "year") {
      if (yearSupported(f.value!)) problem = null;
    } else if (f.kind === "date") {
      const d = f.date!;
      if (d.quarter) problem = found.quarters.has(d.quarter) ? null : "absent";
      else if (d.half) problem = found.halves.has(d.half) ? null : "absent";
      else if (d.d === null) problem = found.months.has(d.m!) || found.dates.some((s) => s.m === d.m) ? null : "absent";
      else {
        fullDate = true;
        const year = d.y ?? sourceDate?.y ?? 2001;
        const day = dayNumber(year, d.m!, d.d);
        const close = found.dates.filter((s) => (d.y === null || s.y === null || s.y === d.y) && Math.abs(dayNumber(s.y ?? year, s.m, s.d) - day) <= 1);
        const before = sourceDate ? dayNumber(sourceDate.y ?? year, sourceDate.m, sourceDate.d) - day : -1;
        if (close.length || (relativeDay && before >= 0 && before <= 7)) problem = null;
        else {
          const closest = found.dates.map((s) => ({ s, gap: Math.abs(dayNumber(s.y ?? year, s.m, s.d) - day) })).sort((a, b) => a.gap - b.gap)[0];
          if (closest) nearest = isoDate(closest.s);
        }
      }
    } else {
      const value = f.value!;
      if (found.numbers.some((n) => supports(n.value, value, f.step!, !!f.approx)) || (f.yearLike && yearSupported(value))) problem = null;
      else {
        // The same digits at another scale, both sides written with a scale word: a misread scale.
        const misread = f.scaled
          ? found.numbers.find((n) => {
              if (!n.scaled || n.value <= 0 || value <= 0) return false;
              const k = Math.round(Math.log10(n.value / value));
              return k !== 0 && supports(n.value / 10 ** k, value, f.step!, false);
            })
          : undefined;
        if (misread) {
          problem = "scale_mismatch";
          nearest = misread.text;
        } else {
          const closest = found.numbers
            .filter((n) => n.value > 0 && value > 0)
            .map((n) => ({ n, gap: Math.abs(Math.log(n.value / value)) }))
            .sort((a, b) => a.gap - b.gap)[0];
          if (closest) nearest = closest.n.text;
        }
      }
    }
    if (!problem) continue;
    const converted = f.kind === "amount" && ((f.currency && sourceCurrency && !CURRENCY_EVIDENCE[f.currency]!.test(found.text)) || (f.metric && imperial));
    const hard = problem === "scale_mismatch" || f.kind === "amount" || f.kind === "year" || fullDate;
    findings.push({
      field: f.field,
      token: f.token,
      kind: f.kind,
      problem,
      class: hard && !capped && !converted ? "hard" : "soft",
      ...(nearest ? { nearest } : {}),
    });
  }
  const verdict = findings.some((f) => f.class === "hard") ? "hard" : findings.length ? "soft" : "ok";
  return { verdict, findings };
}
