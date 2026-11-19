// Which companies an article names, found without a model. Latin spellings match whole words, longest first, so
// "Proyecto Riotinto" is not Rio Tinto, "southern Copperbelt" is not Southern Copper and a longer registered name
// wins over its prefix. Chinese spellings match as substrings, and for the companies the identity lexicon guards
// (industry/taxonomy.ts) a Chinese hit only counts where the lexicon also matches a Han character, so 大力拓展 is
// not 力拓. The lexicon's Latin alternatives are not used: as plain regexes they match "Vale lembrar" and
// "Former Barrick executive", which the scope rules and passing patterns below exist to tell apart.
import { IDENTITY_LEXICON } from "@amp/industry/taxonomy";
import type { AliasScope, EntityLink, EntityRow, StatementRow } from "./model.ts";
import { aliasKey, hasHan, lookupKey, tokenize } from "./normalize.ts";

interface AliasEntry {
  entityId: string;
  scope: AliasScope;
  caseSensitive: boolean;
  /** Latin aliases: the folded words and the words as written. */
  keys: readonly string[];
  raws: readonly string[];
  /** A full stop the spelling ends with (Vale S.A.): taken into the hit when the text has it, so none is left over. */
  tail: string;
  /** Chinese aliases: the pattern that finds them, and the lexicon entry whose Han matches must confirm a hit. */
  han: RegExp | null;
  guard: string | null;
}

export interface EntityIndex {
  /** Active entities that are not merged away, by id. */
  readonly entities: ReadonlyMap<string, EntityRow>;
  /** The active entity an id stands for after merges; null for unknown or retired ids. */
  resolve(id: string): string | null;
  readonly latin: ReadonlyMap<string, readonly AliasEntry[]>;
  readonly han: readonly AliasEntry[];
  readonly tickers: ReadonlyArray<{ entityId: string; pattern: RegExp }>;
  readonly domains: ReadonlyArray<{ entityId: string; domain: string }>;
  readonly owners: ReadonlyMap<string, string>;
  /** `lookupKey` of every spelling and name → the entities it may stand for. */
  readonly lookup: ReadonlyMap<string, ReadonlySet<string>>;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const globalOf = (pattern: RegExp) => new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
const LEXICON = new Map(IDENTITY_LEXICON.map((entry) => [entry.id, entry.patterns.map(globalOf)]));

/** The stretches of `text` where the lexicon of `entityId` matches something that contains a Han character. */
function lexiconHanSpans(entityId: string, text: string): Array<[number, number]> {
  return (LEXICON.get(entityId) ?? []).flatMap((pattern) =>
    [...text.matchAll(pattern)].filter((m) => hasHan(m[0])).map((m): [number, number] => [m.index, m.index + m[0].length]),
  );
}

/** Whether a Chinese spelling is one the entity's lexicon recognises, so its hits are checked against the lexicon. */
export function guardedByLexicon(entityId: string, value: string): boolean {
  return hasHan(value) && lexiconHanSpans(entityId, value).length > 0;
}

/** A Chinese alias as a pattern: the separators aliasKey drops may appear between its Han characters. */
function hanPattern(value: string): RegExp {
  const chars = [...aliasKey(value)];
  const body = chars.map((c, i) => escapeRegExp(c) + (i < chars.length - 1 && hasHan(c) && hasHan(chars[i + 1]!) ? "[\\s\\-·・]?" : "")).join("");
  const before = /[\p{L}\p{N}]/u.test(chars[0]!) && !hasHan(chars[0]!) ? "(?<![A-Za-z0-9])" : "";
  const after = /[\p{L}\p{N}]/u.test(chars.at(-1)!) && !hasHan(chars.at(-1)!) ? "(?![A-Za-z0-9])" : "";
  return new RegExp(`${before}${body}${after}`, "gi");
}

function tickerPattern(value: string): RegExp | null {
  const m = /^([A-Z]+)\s*:\s*([A-Z0-9.]+)$/.exec(value.trim());
  return m ? new RegExp(`\\b${escapeRegExp(m[1]!)}\\s*[:：]\\s*${escapeRegExp(m[2]!)}(?![A-Za-z0-9])`, "g") : null;
}

export function buildIndex(entities: readonly EntityRow[], statements: readonly StatementRow[]): EntityIndex {
  const rows = new Map(entities.map((row) => [row.id, row]));
  const resolve = (id: string): string | null => {
    let row = rows.get(id);
    // Follow merge pointers; a chain longer than the table is a cycle.
    for (let steps = 0; row?.mergedInto && steps <= rows.size; steps++) row = rows.get(row.mergedInto);
    return row && !row.mergedInto && row.status === "active" ? row.id : null;
  };
  const active = new Map(entities.flatMap((row) => (resolve(row.id) === row.id ? [[row.id, row] as const] : [])));

  const latin = new Map<string, AliasEntry[]>();
  const han: AliasEntry[] = [];
  const tickers: Array<{ entityId: string; pattern: RegExp }> = [];
  const domains: Array<{ entityId: string; domain: string }> = [];
  const owners = new Map<string, string>();
  const lookup = new Map<string, Set<string>>();
  const remember = (spelling: string, entityId: string) => {
    const key = lookupKey(spelling);
    if (!key) return;
    if (!lookup.has(key)) lookup.set(key, new Set());
    lookup.get(key)!.add(entityId);
  };
  // A merged entity's names stay findable and answer with the winner.
  for (const row of entities) {
    const target = resolve(row.id);
    if (!target) continue;
    remember(row.nameOriginal, target);
    if (row.nameZh) remember(row.nameZh, target);
  }

  for (const statement of statements) {
    const target = statement.status === "active" ? resolve(statement.entityId) : null;
    if (!target) continue;
    if (statement.property === "alias") {
      remember(statement.value, target);
      const scope = statement.scope ?? "text";
      if (scope === "lookup") continue;
      if (hasHan(statement.value)) {
        const guard = LEXICON.has(statement.entityId) && guardedByLexicon(statement.entityId, statement.value) ? statement.entityId : null;
        han.push({ entityId: target, scope, caseSensitive: false, keys: [], raws: [], tail: "", han: hanPattern(statement.value), guard });
        continue;
      }
      const words = tokenize(statement.value);
      if (!words.length) continue;
      const entry = {
        entityId: target,
        scope,
        caseSensitive: statement.caseSensitive,
        keys: words.map((w) => w.key),
        raws: words.map((w) => w.raw),
        tail: /^\.?/.exec(statement.value.slice(words.at(-1)!.end).trim())![0],
        han: null,
        guard: null,
      };
      const first = entry.keys[0]!;
      if (!latin.has(first)) latin.set(first, []);
      latin.get(first)!.push(entry);
    } else if (statement.property === "ticker") {
      const pattern = tickerPattern(statement.value);
      if (pattern) tickers.push({ entityId: target, pattern });
      remember(statement.value.split(":").at(-1)!, target);
    } else if (statement.property === "domain") {
      domains.push({
        entityId: target,
        domain: statement.value
          .trim()
          .toLowerCase()
          .replace(/^www\./, ""),
      });
    } else if (statement.property === "source_owner") {
      owners.set(aliasKey(statement.value), target);
    }
  }
  return { entities: active, resolve, latin, han, tickers, domains, owners, lookup };
}

export interface Hit {
  entityId: string;
  /** The spelling as written in the text. */
  alias: string;
  start: number;
  end: number;
  /** A ticker hit is a qualified listing symbol: as strong as a `text` alias, and never rewritten. */
  scope: "text" | "anchored" | "ticker";
}

// Between the words of one name: a space, hyphen, dot or apostrophe, nothing else ("Rio, Tinto" is two words).
const NAME_GAP = /^[\s\-‐‑‒–—.'’·・]{1,3}$/;

/**
 * Every spelling of a known entity in `text`, overlaps settled longest first. `lookup` aliases never match;
 * `anchored` hits are returned and the caller decides whether the article anchors them.
 */
export function findHits(index: EntityIndex, text: string): Hit[] {
  const found: Hit[] = [];
  const words = tokenize(text);
  for (let i = 0; i < words.length; i++) {
    for (const entry of index.latin.get(words[i]!.key) ?? []) {
      const n = entry.keys.length;
      if (i + n > words.length) continue;
      let same = true;
      for (let j = 0; j < n && same; j++) {
        const word = words[i + j]!;
        same =
          word.key === entry.keys[j] &&
          (!entry.caseSensitive || word.raw.normalize("NFKC") === entry.raws[j]) &&
          (j === 0 || NAME_GAP.test(text.slice(words[i + j - 1]!.end, word.start)));
      }
      if (!same) continue;
      const start = words[i]!.start;
      const end = words[i + n - 1]!.end + (entry.tail && text.startsWith(entry.tail, words[i + n - 1]!.end) ? entry.tail.length : 0);
      found.push({ entityId: entry.entityId, alias: text.slice(start, end), start, end, scope: entry.scope === "anchored" ? "anchored" : "text" });
    }
  }
  const guards = new Map<string, Array<[number, number]>>();
  for (const entry of index.han) {
    for (const m of text.matchAll(entry.han!)) {
      const start = m.index;
      const end = start + m[0].length;
      if (entry.guard) {
        if (!guards.has(entry.guard)) guards.set(entry.guard, lexiconHanSpans(entry.guard, text));
        if (!guards.get(entry.guard)!.some(([s, e]) => s < end && start < e)) continue;
      }
      // Short Chinese names are also ordinary words; an unguarded one needs an anchor even if it was stored as text.
      const scope = entry.scope === "anchored" || (!entry.guard && [...m[0]].length < 3) ? "anchored" : "text";
      found.push({ entityId: entry.entityId, alias: m[0], start, end, scope });
    }
  }
  for (const ticker of index.tickers) {
    for (const m of text.matchAll(ticker.pattern))
      found.push({ entityId: ticker.entityId, alias: m[0], start: m.index, end: m.index + m[0].length, scope: "ticker" });
  }

  found.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: Hit[] = [];
  for (const hit of found) if (!kept.some((k) => k.start < hit.end && hit.start < k.end)) kept.push(hit);
  return kept.sort((a, b) => a.start - b.start);
}

/** The roles that make 前 mean "former" in Chinese (前高管), not "before" (前三季度). */
const ZH_ROLES = "(?:高管|首席执行官|CEO|总裁|董事|员工|雇员|负责人|主席|总经理)";

/**
 * Wordings that name a company in passing (one explicit list per language): a former employee, a backer, a rival.
 * `before` must end right before the name, `after` start right after it; an entry with both needs both.
 */
const PASSING: Readonly<Record<string, ReadonlyArray<{ before?: RegExp; after?: RegExp }>>> = {
  en: [
    { before: /\b(?:former|formerly(?:\s+(?:of|with|at))?|ex)[\s-]*$/i },
    { before: /\bcompet(?:es|ed|ing|e)\s+with\s+$/i },
    { after: /^[\s-]*backed\b/i },
    { after: /^\s+veterans?\b/i },
  ],
  zh: [
    { before: /曾(?:任|在|供职于|就职于)$/ },
    // 前力拓高管, 前任力拓高管, 力拓前首席执行官, 力拓前任董事; 此前力拓宣布 and 力拓前三季度 are the company's own news.
    { before: /(?<![此之以目提当日年月面向事])前任?$/, after: new RegExp(`^${ZH_ROLES}`) },
    { after: new RegExp(`^前任?${ZH_ROLES}`) },
  ],
  es: [{ before: /\bex[\s-]*(?:(?:ejecutiv|directiv|emplead)[oa]s?|director(?:a|es)?|gerente|president[ea]|CEO)?\s*(?:de(?:\s+la)?\s+)?$/i }],
  pt: [{ before: /\bex[\s-]*(?:(?:executiv|funcionári)[oa]s?|diretor(?:a|es)?|presidente|CEO)?\s*(?:d[aeo]s?\s+)?$/i }],
};
const ALL_PASSING = Object.values(PASSING).flat();

function inPassing(text: string, span: { start: number; end: number }, language: string | null): boolean {
  const base = (language ?? "").toLowerCase().split(/[-_]/)[0]!;
  const rules = PASSING[base] ?? ALL_PASSING;
  const before = text.slice(Math.max(0, span.start - 40), span.start);
  const after = text.slice(span.end, span.end + 30);
  return rules.some((rule) => (!rule.before || rule.before.test(before)) && (!rule.after || rule.after.test(after)));
}

/** A bracket right after a name: （…） or (…), short, not nested. */
export const BRACKET = /^\s*[（(]([^（()）]{1,40})[）)]/;

/**
 * One entity's hits in one text, sorted, grouped into mentions: a name and the bracket right after it that holds
 * another spelling of the same entity (前力拓（Rio Tinto）高管, Former Barrick (巴里克) executive) are one mention,
 * so the wording around the whole decides whether it is named in passing.
 */
function mentionsOf<T extends Hit>(text: string, hits: readonly T[]): Array<{ start: number; end: number; hits: T[] }> {
  const mentions: Array<{ start: number; end: number; hits: T[] }> = [];
  for (const hit of hits) {
    const last = mentions.at(-1);
    const m = last ? BRACKET.exec(text.slice(last.end)) : null;
    const close = last && m ? last.end + m[0].length : -1;
    if (last && hit.start > last.end && hit.end < close) {
      last.hits.push(hit);
      last.end = close;
    } else if (last && hit.end <= last.end) last.hits.push(hit);
    else mentions.push({ start: hit.start, end: hit.end, hits: [hit] });
  }
  return mentions;
}

/** Where the first sentence of a body ends: a full stop before a capital (not "Nov. 18"), or a Chinese stop. */
function firstSentenceEnd(body: string): number {
  const m = /[.!?](?=\s+["“‘(]?\p{Lu})|[。！？]/u.exec(body);
  return m ? m.index + 1 : body.length;
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The entities an article names. An `anchored` spelling counts only when the article also names the entity by a
 * `text` alias or a qualified ticker, is published by it, or the structure step named it in `modelSubjects`.
 * Role: `subject` when the structure step named it, or, with no model answer, when its first hit outside a passing
 * wording is in the title or the first sentence; otherwise `mention`. The model's subjects are never edited, and
 * only ids present in the index are returned.
 */
export function linkText(
  index: EntityIndex,
  input: { title: string; body: string; language: string | null; url?: string; sourceOwner?: string | null; modelSubjects?: readonly string[] },
): EntityLink[] {
  const publishers: EntityLink[] = [];
  const host = hostOf(input.url);
  if (host) {
    for (const { entityId, domain } of index.domains) {
      if ((host === domain || host.endsWith(`.${domain}`)) && !publishers.some((p) => p.entityId === entityId)) {
        publishers.push({ entityId, role: "publisher", method: "publisher_domain", alias: domain, segment: "source", position: null, hits: 1 });
      }
    }
  }
  if (input.sourceOwner) {
    const owner = index.resolve(input.sourceOwner) ?? index.owners.get(aliasKey(input.sourceOwner)) ?? null;
    if (owner)
      publishers.push({ entityId: owner, role: "publisher", method: "source_owner", alias: input.sourceOwner, segment: "source", position: null, hits: 1 });
  }
  const named = input.modelSubjects ? new Set(input.modelSubjects.map((id) => index.resolve(id)).filter((id): id is string => id !== null)) : null;

  const segments = [
    { segment: "title" as const, text: input.title },
    { segment: "body" as const, text: input.body },
  ];
  const hits = segments.flatMap(({ segment, text }) => findHits(index, text).map((hit) => ({ ...hit, segment, text })));
  const anchors = new Set([...publishers.map((p) => p.entityId), ...(named ?? []), ...hits.filter((h) => h.scope !== "anchored").map((h) => h.entityId)]);
  const leadEnd = firstSentenceEnd(input.body);

  const links: EntityLink[] = [];
  const byEntity = new Map<string, typeof hits>();
  for (const hit of hits) {
    if (hit.scope === "anchored" && !anchors.has(hit.entityId)) continue;
    if (!byEntity.has(hit.entityId)) byEntity.set(hit.entityId, []);
    byEntity.get(hit.entityId)!.push(hit);
  }
  for (const [entityId, own] of byEntity) {
    const plain = (["title", "body"] as const).flatMap((segment) => {
      const inSegment = own.filter((hit) => hit.segment === segment);
      return inSegment.length ? mentionsOf(inSegment[0]!.text, inSegment).filter((m) => !inPassing(inSegment[0]!.text, m, input.language)) : [];
    });
    const subject = named ? named.has(entityId) && plain.length > 0 : plain.some(({ hits: [hit] }) => hit!.segment === "title" || hit!.start < leadEnd);
    const first = own[0]!;
    links.push({
      entityId,
      role: subject ? "subject" : "mention",
      method: "text",
      alias: first.alias,
      segment: first.segment,
      position: first.start,
      hits: own.length,
    });
  }
  return [...links, ...publishers];
}
