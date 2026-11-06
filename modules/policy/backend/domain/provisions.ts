/**
 * Deterministic provisions (法规线重启设计 §3–§4, “结构化”段): split one document revision's text into numbered
 * provisions and compare two revisions provision by provision. Pure code: no database, no model, no network.
 *
 * Numbering families: Chinese 第X条 (with 编/章/节 context, Chinese or Arabic numerals, 之一), Spanish
 * Artículo N / Art. N° / ARTÍCULO N (bis, ter …, ordinal words, único) with Título/Capítulo/Sección context, and
 * English Article/Section N with Part/Chapter context. Annex headings (附件/ANEXO/Annex/Schedule) after the first
 * provision start their own numbering namespace. A number that does not move forward is a cross reference inside
 * the text, and a line that opens with a quotation mark is quoted amending text, never a provision of this document.
 */
import { createHash } from "node:crypto";

export const PROVISION_RECIPE = "provisions-1";
export type ProvisionNumbering = "zh" | "es" | "en";
export type Provision = {
  ordinal: number;
  /** Stable key used for alignment: number plus suffix, prefixed by the annex namespace inside an annex. */
  key: string;
  /** The number as the source writes it, e.g. 第十二条, Artículo 12 bis, Section 5. */
  label: string;
  /** Chapter context, outermost first (e.g. 第二章 矿业权, 第一节 探矿权). */
  path: string[];
  /** The provision's own short title, when the source gives one (“Artículo 3.- Definiciones”). */
  heading: string | null;
  text: string;
  hash: string;
};
export type ProvisionSplit = { numbering: ProvisionNumbering | null; provisions: Provision[]; preamble: string };

const ZH_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const ZH_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
/** Chinese or Arabic numerals (full-width digits included) to an integer; null when not a numeral. */
export function chineseNumber(value: string): number | null {
  const ascii = value.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  if (/^\d+$/.test(ascii)) return Number(ascii);
  if (!/^[零〇一二两三四五六七八九十百千]+$/.test(value)) return null;
  let total = 0,
    current = 0;
  for (const char of value) {
    if (char in ZH_DIGITS) current = ZH_DIGITS[char]!;
    else {
      total += (current || 1) * ZH_UNITS[char]!;
      current = 0;
    }
  }
  return total + current;
}
const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
function romanNumber(value: string) {
  if (!/^[IVXLC]+$/.test(value)) return null;
  let total = 0;
  for (let i = 0; i < value.length; i++) {
    const n = ROMAN[value[i]!]!,
      next = ROMAN[value[i + 1] ?? ""] ?? 0;
    total += n < next ? -n : n;
  }
  return total;
}
const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const ES_ORDINALS: Record<string, number> = {
  unico: 1,
  primero: 1,
  segundo: 2,
  tercero: 3,
  cuarto: 4,
  quinto: 5,
  sexto: 6,
  septimo: 7,
  setimo: 7,
  octavo: 8,
  noveno: 9,
  decimo: 10,
  undecimo: 11,
  decimoprimero: 11,
  duodecimo: 12,
  decimosegundo: 12,
  decimotercero: 13,
  decimocuarto: 14,
  decimoquinto: 15,
  decimosexto: 16,
  decimoseptimo: 17,
  decimoctavo: 18,
  decimonoveno: 19,
  vigesimo: 20,
};
/** Latin multiplicatives used for inserted articles: 5 bis comes after 5 and before 5 ter. */
const LATIN_SUFFIX: Record<string, number> = { bis: 2, ter: 3, quater: 4, quinquies: 5, sexies: 6, septies: 7, octies: 8, novies: 9, nonies: 9, decies: 10 };
/** Accent-tolerant alternation, longest first so “decimotercero” is not read as “decimo”. */
const accentAlternation = (words: string[]) =>
  [...words]
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/[aeiou]/g, (v) => ({ a: "[aá]", e: "[eé]", i: "[ií]", o: "[oó]", u: "[uúü]" })[v]!))
    .join("|");

type Heading = { number: number; rank: number; suffix: string; label: string; rest: string };
type Family = {
  numbering: ProvisionNumbering;
  provision(line: string): Heading | null;
  /** Chapter-like context line: level (0 outermost) and its display text. */
  context(line: string): { level: number; text: string } | null;
};

const SP = "[\\s\\u3000]";
const ZH_NUM = "[零〇一二两三四五六七八九十百千0-9０-９]+";
// After 第X条 comes a space, the end of the line, or text that is not a reference continuation (第X条规定的/第X条第二款).
const zhProvision = new RegExp(`^第${SP}*(${ZH_NUM})${SP}*条(?:之(${ZH_NUM}))?(?:${SP}+|$|(?![的规款项中至、，。；：及和或所前后第]))(.*)$`, "u");
const zhContext = new RegExp(`^第${SP}*(${ZH_NUM})${SP}*(编|章|节)(?:${SP}+|$)(.*)$`, "u");
const ZH_LEVEL: Record<string, number> = { 编: 0, 章: 1, 节: 2 };

// Capitalised headings only: a wrapped lower-case “artículo 5 de la Ley …” is a reference, not a new article.
const esProvision = new RegExp(
  `^(Art[íi]culo|ART[ÍI]CULO|Art\\.|ART\\.)${SP}*(?:N(?:[°º]|ro\\.?)${SP}*)?(\\d+|${accentAlternation(Object.keys(ES_ORDINALS))}|${accentAlternation(Object.keys(ES_ORDINALS)).toUpperCase()})${SP}*(?:[°º]|o\\b|\\.[°º])?${SP}*(?:[-_]?(${Object.keys(LATIN_SUFFIX).join("|")}|${Object.keys(LATIN_SUFFIX).join("|").toUpperCase()})\\b)?([\\s\\S]*)$`,
  "u",
);
const esContext =
  /^(T[ÍI]TULO|T[íi]tulo|CAP[ÍI]TULO|Cap[íi]tulo|SECCI[ÓO]N|Secci[óo]n)\s+([IVXLC]+|\d+|[A-Za-zÁÉÍÓÚáéíóú]+)(?![A-Za-zÁÉÍÓÚáéíóú])\s*[-–—.:]?\s*(.*)$/u;
const ES_LEVEL: Record<string, number> = { titulo: 0, capitulo: 1, seccion: 2 };

const enProvision = /^(Article|ARTICLE|Art\.|Section|SECTION|Sec\.|§)\s*(\d+)([A-Z])?(?![\d.]\d)\b([\s\S]*)$/u;
const enContext = /^(PART|Part|CHAPTER|Chapter|DIVISION|Division)\s+([IVXLC]+|\d+|[A-Z][a-z]+)\b\s*[-–—.:]?\s*(.*)$/u;
const EN_LEVEL: Record<string, number> = { part: 0, chapter: 1, division: 2 };

const annexLine =
  /^(附件|附表|ANEXO|Anexo|ANNEX|Annex|SCHEDULE|Schedule)(?:\s*([0-9０-９]+|[一二三四五六七八九十]+|[IVXLC]+|[A-Z])(?![A-Za-z]))?\s*([:：.\-–—]?)\s*(.{0,60})$/u;

/** Separators between the number and the text (“.-”, “:”, “—”, the Spanish “°.-”) are not part of the text. */
const separators = /^[\s　.:：\-–—_°º)]+/u;

const FAMILIES: Family[] = [
  {
    numbering: "zh",
    provision(line) {
      const m = zhProvision.exec(line);
      if (!m) return null;
      const number = chineseNumber(m[1]!),
        sub = m[2] ? chineseNumber(m[2]) : 0;
      if (number === null || sub === null || number <= 0) return null;
      const label = line.slice(0, line.length - m[3]!.length).replace(/[\s　]+/g, "");
      return { number, rank: sub, suffix: sub ? `-${sub}` : "", label, rest: m[3]!.replace(separators, "") };
    },
    context(line) {
      const m = zhContext.exec(line);
      if (!m || line.length > 40 || /[。；，]$/.test(line)) return null;
      return { level: ZH_LEVEL[m[2]!]!, text: line.replace(/[\s　]+/g, " ").trim() };
    },
  },
  {
    numbering: "es",
    provision(line) {
      const m = esProvision.exec(line);
      if (!m) return null;
      const raw = fold(m[2]!),
        number = /^\d+$/.test(raw) ? Number(raw) : (ES_ORDINALS[raw] ?? null);
      if (!number) return null;
      const suffix = m[3] ? fold(m[3]) : "";
      const word = /^art\./i.test(m[1]!) ? "Art." : "Artículo";
      const shown = /^\d+$/.test(raw) ? String(number) : raw === "unico" ? "único" : m[2]!.toLowerCase();
      return {
        number,
        rank: suffix ? LATIN_SUFFIX[suffix]! : 0,
        suffix,
        label: `${word} ${shown}${suffix ? ` ${suffix}` : ""}`,
        rest: m[4]!.replace(separators, ""),
      };
    },
    context(line) {
      const m = esContext.exec(line);
      if (!m || line.length > 160 || /[;,]$/.test(line)) return null;
      const n = fold(m[2]!);
      if (!/^\d+$/.test(n) && romanNumber(m[2]!.toUpperCase()) === null && !(n in ES_ORDINALS)) return null;
      return { level: ES_LEVEL[fold(m[1]!)]!, text: line.replace(/\s+/g, " ").trim() };
    },
  },
  {
    numbering: "en",
    provision(line) {
      const m = enProvision.exec(line);
      if (!m) return null;
      const number = Number(m[2]),
        letter = m[3] ?? "";
      const word = /^(sec|§)/i.test(m[1]!) ? "Section" : "Article";
      return {
        number,
        rank: letter ? letter.charCodeAt(0) - 64 : 0,
        suffix: letter,
        label: `${word} ${number}${letter}`,
        rest: m[4]!.replace(separators, ""),
      };
    },
    context(line) {
      const m = enContext.exec(line);
      if (!m || line.length > 160 || /[;,]$/.test(line)) return null;
      if (!/^\d+$/.test(m[2]!) && romanNumber(m[2]!) === null && !/^(One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)$/i.test(m[2]!)) return null;
      return { level: EN_LEVEL[m[1]!.toLowerCase()]!, text: line.replace(/\s+/g, " ").trim() };
    },
  },
];

const CJK_PUNCT = "\\p{Script=Han}，。；：、“”（）《》";
// The space after a 第X条/第X章 marker separates the number from the text and stays.
const layoutSpace = new RegExp(`(?<![第之]\\s*${ZH_NUM}\\s*[条章节编]?)(?<=[${CJK_PUNCT}])\\s+(?=[${CJK_PUNCT}])`, "gu");
/** Whitespace from HTML blocks and PDF text items: spaces between two CJK characters are layout, not text. */
export function normalizeProvisionText(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/[\t 　 ]+/g, " ")
        .replace(layoutSpace, "")
        .trim(),
    )
    .filter(Boolean)
    .join("\n");
}
const hashOf = (value: string) => createHash("sha256").update(value).digest("hex");
const QUOTED = /^["“”«'‘]/u;

function chooseFamily(lines: string[], language?: string | null): Family | null {
  const scores = FAMILIES.map((family) => lines.filter((line) => !QUOTED.test(line) && family.provision(line)).length);
  const best = Math.max(...scores);
  if (!best) return null;
  const hinted = language ? FAMILIES.findIndex((f) => language.toLowerCase().startsWith(f.numbering)) : -1;
  return FAMILIES[hinted >= 0 && scores[hinted] === best ? hinted : scores.indexOf(best)]!;
}

/** A short title line: no sentence punctuation or comma, at most eight words, and the body starts a new sentence. */
function titleOf(rest: string, next: string | undefined, numbering: ProvisionNumbering) {
  if (numbering === "zh" || !rest || !next || rest.length > 80 || /[.;:,。；：，]$/u.test(rest) || rest.includes(",")) return null;
  if (rest.split(/\s+/).length > 8 || !/^[\p{Lu}"“(¿¡0-9]/u.test(next)) return null;
  return rest;
}

/** Split one revision's text (string or ordered blocks) into provisions with stable keys. */
export function splitProvisions(input: string | readonly string[], options: { language?: string | null } = {}): ProvisionSplit {
  const lines = normalizeProvisionText(typeof input === "string" ? input : input.join("\n"))
    .split("\n")
    .filter(Boolean);
  return splitLines(lines, options.language).split;
}

/** The split plus, for every normalized line, the ordinal of the provision that owns it (-1: preamble/heading lines). */
function splitLines(lines: string[], language?: string | null): { split: ProvisionSplit; owners: number[] } {
  const owners: number[] = [];
  const family = chooseFamily(lines, language);
  if (!family) return { split: { numbering: null, provisions: [], preamble: lines.join("\n") }, owners: lines.map(() => -1) };
  const open: (Omit<Provision, "text" | "hash" | "heading"> & { lines: string[] })[] = [];
  const preamble: string[] = [];
  let path: { level: number; text: string }[] = [],
    annex = "",
    last: { number: number; rank: number } | null = null;
  const used = new Map<string, number>();
  // A chapter or annex number line may carry its title on the next line, in capitals (“CAPÍTULO II” / “RÉGIMEN …”).
  let titled: { level: number; text: string } | null = null;
  for (const line of lines) {
    const heading = QUOTED.test(line) ? null : family.provision(line);
    if (titled && !heading && line.length <= 100 && /\p{Lu}/u.test(line) && line === line.toUpperCase()) {
      titled.text = `${titled.text} ${line}`;
      titled = null;
      owners.push(-1);
      continue;
    }
    titled = null;
    const annexMatch = open.length ? annexLine.exec(line) : null;
    if (annexMatch && (annexMatch[2] || annexMatch[3] || !annexMatch[4]!.trim()) && !/[。；;.]$/.test(annexMatch[4]!)) {
      annex = `${fold(annexMatch[1]!).replace("附表", "附件")}${annexMatch[2] ? `-${annexMatch[2]}` : ""}`;
      path = [{ level: -1, text: line }];
      titled = annexMatch[4]!.trim() ? null : path[0]!;
      last = null;
      owners.push(-1);
      continue;
    }
    const context = family.context(line);
    if (context) {
      path = [...path.filter((p) => p.level < context.level), context];
      titled = context.text.split(/\s+/).length <= 2 ? context : null;
      owners.push(-1);
      continue;
    }
    if (heading && (!last || heading.number > last.number || (heading.number === last.number && heading.rank > last.rank))) {
      last = { number: heading.number, rank: heading.rank };
      let key = `${annex ? `${annex}/` : ""}${heading.number}${heading.suffix}`;
      const seen = used.get(key) ?? 0;
      used.set(key, seen + 1);
      if (seen) key = `${key}#${seen + 1}`;
      const rest = heading.rest.trim();
      owners.push(open.length);
      open.push({ ordinal: open.length, key, label: heading.label, path: path.map((p) => p.text), lines: rest ? [rest] : [] });
      continue;
    }
    const current = open.at(-1);
    owners.push(current ? current.ordinal : -1);
    if (current) current.lines.push(line);
    else preamble.push(line);
  }
  return {
    owners,
    split: {
      numbering: family.numbering,
      preamble: preamble.join("\n"),
      provisions: open.map(({ lines: body, ...p }) => {
        const heading = titleOf(body[0] ?? "", body[1], family.numbering);
        const text = (heading ? body.slice(1) : body).join("\n");
        return { ...p, heading, text, hash: hashOf(`${heading ?? ""}\n${text}`) };
      }),
    },
  };
}

/**
 * Split ordered source blocks (e.g. the parts of a processing plan, each one or more lines) with the very same rules
 * as splitProvisions, and say which provisions each block holds. A block that holds no provision line (preamble,
 * chapter or annex heading) maps to []. Lets code trace any block to 第X条/Artículo N without a model.
 */
export function locateProvisionBlocks(blocks: readonly string[], options: { language?: string | null } = {}) {
  const lines: string[] = [],
    lineBlock: number[] = [];
  blocks.forEach((block, index) => {
    for (const line of normalizeProvisionText(block).split("\n").filter(Boolean)) {
      lines.push(line);
      lineBlock.push(index);
    }
  });
  const { split, owners } = splitLines(lines, options.language);
  const byBlock = blocks.map(() => new Set<number>());
  owners.forEach((ordinal, line) => {
    if (ordinal >= 0) byBlock[lineBlock[line]!]!.add(ordinal);
  });
  return { split, blocks: byBlock.map((set) => [...set].sort((a, b) => a - b)) };
}

// ---------------------------------------------------------------------------------------------------------------
// Word/character diff (Myers, O((N+M)·D)) and provision alignment.
// ---------------------------------------------------------------------------------------------------------------

export type DiffSpan = { op: "equal" | "insert" | "delete"; text: string };

const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}";
const tokenPattern = new RegExp(`[${CJK}]|(?:(?![${CJK}])[\\p{L}\\p{N}\\p{M}])+|\\s+|[^\\s\\p{L}\\p{N}]`, "gu");
/** CJK characters one by one; Latin words, numbers, whitespace runs and punctuation each as one token. */
export function diffTokens(value: string) {
  return value.match(tokenPattern) ?? [];
}

const MAX_EDIT_DISTANCE = 1500;
/** Myers' shortest edit script; null when the texts differ by more than MAX_EDIT_DISTANCE tokens. */
function myers(a: string[], b: string[]): DiffSpan[] | null {
  const n = a.length,
    m = b.length,
    max = Math.min(n + m, MAX_EDIT_DISTANCE);
  // Frontier after d edits, diagonal k stored at k + d + 1; each frontier is kept for the walk back.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    const previous = trace[d - 1],
      at = (k: number) => previous![k + d]!;
    const next = new Int32Array(2 * d + 3);
    for (let k = -d; k <= d; k += 2) {
      let x = d === 0 ? 0 : k === -d || (k !== d && at(k - 1) < at(k + 1)) ? at(k + 1) : at(k - 1) + 1,
        y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[k + d + 1] = x;
      if (x >= n && y >= m) return walkBack(trace, a, b, d);
    }
    trace.push(next);
  }
  return null;
}
function walkBack(trace: Int32Array[], a: string[], b: string[], edits: number): DiffSpan[] {
  const spans: DiffSpan[] = [];
  // Collected from the end; prepend so merged spans keep their order.
  const push = (op: DiffSpan["op"], text: string) => {
    const last = spans.at(-1);
    if (last?.op === op) last.text = text + last.text;
    else spans.push({ op, text });
  };
  let x = a.length,
    y = b.length;
  for (let d = edits; d > 0; d--) {
    const v = trace[d - 1]!,
      at = (k: number) => v[k + d]!,
      k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(prevK),
      py = px - prevK;
    while (x > px && y > py) {
      push("equal", a[--x]!);
      y--;
    }
    if (x === px) push("insert", b[--y]!);
    else push("delete", a[--x]!);
  }
  while (x > 0 && y > 0) {
    push("equal", a[--x]!);
    y--;
  }
  return spans.reverse();
}

/**
 * Readable spans: each run of changes becomes one deletion then one insertion, and a short equal stretch between
 * two changes that are each at least as long is folded into them (the semantic clean-up of diff-match-patch),
 * so “行使国家对 → 代表国家行使” reads as one rewrite instead of four fragments.
 */
function cleanup(spans: DiffSpan[]) {
  let current = regroup(spans);
  for (let changed = true; changed; ) {
    changed = false;
    const size = (from: number, step: 1 | -1) => {
      let del = 0,
        ins = 0;
      for (let j = from; j >= 0 && j < current.length && current[j]!.op !== "equal"; j += step)
        if (current[j]!.op === "delete") del += [...current[j]!.text].length;
        else ins += [...current[j]!.text].length;
      return Math.max(del, ins);
    };
    for (let i = 1; i < current.length - 1; i++) {
      const span = current[i]!;
      if (span.op !== "equal") continue;
      const length = [...span.text].length,
        before = size(i - 1, -1),
        after = size(i + 1, 1);
      if (before && after && (length <= Math.min(before, after) || span.text.trim() === "")) {
        current = regroup([...current.slice(0, i), { op: "delete", text: span.text }, { op: "insert", text: span.text }, ...current.slice(i + 1)]);
        changed = true;
        break;
      }
    }
  }
  return current;
}
function regroup(out: DiffSpan[]) {
  const grouped: DiffSpan[] = [];
  for (let i = 0; i < out.length; ) {
    if (out[i]!.op === "equal") {
      const prev = grouped.at(-1);
      if (prev?.op === "equal") prev.text += out[i]!.text;
      else grouped.push({ ...out[i]! });
      i++;
      continue;
    }
    let del = "",
      ins = "";
    for (; i < out.length && out[i]!.op !== "equal"; i++) {
      if (out[i]!.op === "delete") del += out[i]!.text;
      else ins += out[i]!.text;
    }
    if (del) grouped.push({ op: "delete", text: del });
    if (ins) grouped.push({ op: "insert", text: ins });
  }
  return grouped;
}

/** Character diff for Chinese, word diff for Latin scripts (one tokenizer does both). */
export function diffText(from: string, to: string): DiffSpan[] {
  if (from === to) return from ? [{ op: "equal", text: from }] : [];
  const a = diffTokens(from),
    b = diffTokens(to);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const middle = myers(a.slice(start, endA), b.slice(start, endB)) ?? [
    ...(endA > start ? [{ op: "delete" as const, text: a.slice(start, endA).join("") }] : []),
    ...(endB > start ? [{ op: "insert" as const, text: b.slice(start, endB).join("") }] : []),
  ];
  return cleanup([
    ...(start ? [{ op: "equal" as const, text: a.slice(0, start).join("") }] : []),
    ...middle,
    ...(endA < a.length ? [{ op: "equal" as const, text: a.slice(endA).join("") }] : []),
  ]);
}

/** Dice coefficient over character bigrams (CJK) or words (Latin): 1 for identical text, 0 for nothing shared. */
export function textSimilarity(a: string, b: string) {
  if (a === b) return 1;
  const units = (value: string) => {
    const tokens = diffTokens(value.toLowerCase()).filter((t) => t.trim() && /[\p{L}\p{N}]/u.test(t));
    const cjk = tokens.filter((t) => /\p{Script=Han}/u.test(t)).length > tokens.length / 2;
    const list = cjk && tokens.length > 1 ? tokens.slice(1).map((t, i) => tokens[i]! + t) : tokens;
    const counts = new Map<string, number>();
    for (const unit of list) counts.set(unit, (counts.get(unit) ?? 0) + 1);
    return counts;
  };
  const x = units(a),
    y = units(b);
  let shared = 0,
    total = 0;
  for (const [unit, n] of x) {
    shared += Math.min(n, y.get(unit) ?? 0);
    total += n;
  }
  for (const n of y.values()) total += n;
  return total ? (2 * shared) / total : 0;
}

export type ProvisionChange = "added" | "modified" | "removed" | "unchanged";
export type ProvisionComparisonEntry = {
  change: ProvisionChange;
  from: Provision | null;
  to: Provision | null;
  /** The same or a modified provision under another number (e.g. 第五条 → 第六条 after an insertion). */
  renumbered: boolean;
  similarity: number | null;
  diff: DiffSpan[] | null;
};
export type ProvisionComparison = { entries: ProvisionComparisonEntry[]; counts: Record<ProvisionChange, number> };

/** Pairs below this similarity are a removal plus an addition, not one modified provision (half for the same number). */
export const MODIFIED_THRESHOLD = 0.45;
export const provisionBody = (p: Pick<Provision, "heading" | "text">) => `${p.heading ? `${p.heading}\n` : ""}${p.text}`;

/** Longest common subsequence of identical provisions: the anchors. Monotonic by construction. */
function hashAnchors(from: Provision[], to: Provision[]) {
  const n = from.length,
    m = to.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) table[i]![j] = from[i]!.hash === to[j]!.hash ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (from[i]!.hash === to[j]!.hash) pairs.push([i++, j++]);
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

/** Best monotonic pairing inside one gap between anchors; the same number earns a small bonus. */
function alignGap(from: Provision[], to: Provision[]): [number, number, number][] {
  const n = from.length,
    m = to.length;
  if (!n || !m) return [];
  const sim = from.map((f) => to.map((t) => textSimilarity(provisionBody(f), provisionBody(t))));
  const score = (i: number, j: number) => {
    const s = sim[i]![j]!,
      sameKey = from[i]!.key === to[j]!.key;
    return s >= MODIFIED_THRESHOLD || (sameKey && s >= MODIFIED_THRESHOLD / 2) ? s + (sameKey ? 0.2 : 0) : -1;
  };
  const best = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) {
      const s = score(i, j);
      best[i]![j] = Math.max(best[i + 1]![j]!, best[i]![j + 1]!, s >= 0 ? s + best[i + 1]![j + 1]! : -Infinity);
    }
  const pairs: [number, number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    const s = score(i, j);
    if (s >= 0 && best[i]![j] === s + best[i + 1]![j + 1]!) {
      pairs.push([i, j, sim[i]![j]!]);
      i++;
      j++;
    } else if (best[i]![j] === best[i + 1]![j]) i++;
    else j++;
  }
  return pairs;
}

/** Align two revisions' provisions (identical text first, then numbers and similarity) and classify each one. */
export function compareProvisions(from: Provision[], to: Provision[]): ProvisionComparison {
  const pairs: [number, number, number][] = [];
  let pi = 0,
    pj = 0;
  for (const [ai, aj] of [...hashAnchors(from, to), [from.length, to.length] as [number, number]]) {
    for (const [gi, gj, s] of alignGap(from.slice(pi, ai), to.slice(pj, aj))) pairs.push([pi + gi, pj + gj, s]);
    if (ai < from.length) pairs.push([ai, aj, 1]);
    pi = ai + 1;
    pj = aj + 1;
  }
  const entries: ProvisionComparisonEntry[] = [];
  let i = 0,
    j = 0;
  for (const [fi, tj, s] of [...pairs, [from.length, to.length, 0] as [number, number, number]]) {
    for (; i < fi; i++) entries.push({ change: "removed", from: from[i]!, to: null, renumbered: false, similarity: null, diff: null });
    for (; j < tj; j++) entries.push({ change: "added", from: null, to: to[j]!, renumbered: false, similarity: null, diff: null });
    if (fi >= from.length || tj >= to.length) break;
    const a = from[fi]!,
      b = to[tj]!,
      same = a.hash === b.hash;
    entries.push({
      change: same ? "unchanged" : "modified",
      from: a,
      to: b,
      renumbered: a.key !== b.key,
      similarity: same ? 1 : Math.round(s * 1000) / 1000,
      diff: same ? null : diffText(provisionBody(a), provisionBody(b)),
    });
    i = fi + 1;
    j = tj + 1;
  }
  const counts = { added: 0, modified: 0, removed: 0, unchanged: 0 };
  for (const entry of entries) counts[entry.change]++;
  return { entries, counts };
}

/** Hash of a revision's provision set, so readers and backfills can tell whether two revisions differ at all. */
export function provisionSetHash(provisions: readonly Pick<Provision, "key" | "hash">[]) {
  return hashOf(JSON.stringify([PROVISION_RECIPE, provisions.map((p) => [p.key, p.hash])]));
}
