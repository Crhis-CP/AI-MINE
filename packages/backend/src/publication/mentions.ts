// One alias index for reader search and for 全部矿业动态 / 精选 filters.
// A country, mineral or company hits when the stored tag says so, or when the title,
// summary, source name or display tags (publications.search_text) say so.
// Full article bodies are not a filter hit. Withdrawn and ineligible rows stay out
// because every caller still applies its own visibility condition.
import { JURISDICTIONS, jurisdictionDescendants } from "@amp/industry/jurisdictions";
import { ENTITIES, MINERAL_TAGS, TAG_SYNONYMS } from "@amp/industry/taxonomy";
const FOLD_DROP = /[\s（）()【】[\]「」『』·・,，.。\-‐‑–—_/]/g;
const SHORT_LATIN = new Set(["drc", "uk", "eu", "un"]);
/** Single-character minerals that also sit inside unrelated words. Strip those words, then look. */
const CHAR_GUARDS: Record<string, string[]> = {
  金: ["刚果（金）", "刚果(金)", "金属", "资金", "基金", "紫金"],
  银: ["银行"],
  铁: ["地铁", "铁路"],
};
const COUNTRY_EXTRAS: Record<string, string[]> = {
  US: ["USA", "U.S.A.", "United States of America"],
  GB: ["UK", "U.K.", "Britain"],
  CN: ["中华人民共和国"],
  CD: ["DRC", "DR Congo", "Congo-Kinshasa", "刚果民主共和国"],
  AU: ["澳洲"],
  ID: ["印尼"],
  KG: ["吉尔吉斯"],
  KZ: ["哈萨克"],
  TJ: ["塔吉克"],
  UZ: ["乌兹别克"],
  RU: ["俄罗斯联邦"],
  MN: ["蒙古国"],
};
const MINERAL_ENGLISH: Record<string, string[]> = {
  铜: ["copper"],
  金: ["gold"],
  银: ["silver"],
  锌: ["zinc"],
  // Bare "lead" is the English verb. Only the metal phrase counts; 铅 and 铅锭 still match the Chinese name.
  铅: ["lead metal"],
  锂: ["lithium"],
  镍: ["nickel"],
  钴: ["cobalt"],
  钼: ["molybdenum"],
  铁矿石: ["iron ore"],
  铁: ["iron"],
  铝土矿: ["bauxite"],
  铝: ["aluminium", "aluminum"],
  稀土: ["rare earth", "rare earths"],
  钨: ["tungsten"],
  锑: ["antimony"],
  锡: ["tin"],
  锰: ["manganese"],
  铬: ["chromium"],
  铂族金属: ["platinum", "palladium", "pgm"],
};

export type MentionKind = "country" | "mineral" | "company";
type Needle = { kind: "like" | "latin" | "guarded"; text: string; blockers: string[] };
export type Mention = { kind: MentionKind; id: string; label: string; needles: Needle[]; aliases: string[] };

type Draft = { kind: MentionKind; id: string; label: string; aliases: Set<string> };

export function foldMention(value: string): string {
  return value.toLowerCase().replace(FOLD_DROP, "");
}

function unescapeLike(value: string) {
  return value.replace(/\\([\\%_])/g, "$1");
}

function likePattern(value: string) {
  return `%${value.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

function escapeReg(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function usable(alias: string, kind: MentionKind, id: string) {
  const text = alias.trim();
  if (!text) return false;
  if (/[\u3400-\u9fff]/.test(text)) return [...text].length >= 2 || (kind === "mineral" && text === id);
  const compact = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  return compact.length >= 3 || SHORT_LATIN.has(compact);
}

function addAlias(draft: Draft, alias: string) {
  if (usable(alias, draft.kind, draft.id)) draft.aliases.add(alias.trim());
}

const drafts: Draft[] = [];
const countryById = new Map<string, Draft>();
const countryByName = new Map<string, Draft>();
for (const row of JURISDICTIONS) {
  const draft: Draft = { kind: "country", id: row.id, label: row.name_zh, aliases: new Set() };
  addAlias(draft, row.name_zh);
  addAlias(draft, row.name_en);
  if (row.kind === "subdivision") addAlias(draft, row.name_zh.replace(/(?:省|(?:维吾尔)?自治区)$/, ""));
  if (row.kind === "organization") addAlias(draft, row.id);
  for (const extra of COUNTRY_EXTRAS[row.id] ?? []) addAlias(draft, extra);
  drafts.push(draft);
  countryById.set(row.id, draft);
  countryByName.set(row.name_zh, draft);
}
const mineralByName = new Map<string, Draft>();
for (const name of MINERAL_TAGS) {
  const draft: Draft = { kind: "mineral", id: name, label: name, aliases: new Set() };
  addAlias(draft, name);
  for (const extra of MINERAL_ENGLISH[name] ?? []) addAlias(draft, extra);
  drafts.push(draft);
  mineralByName.set(name, draft);
}
const companyById = new Map<string, Draft>();
const companyByName = new Map<string, Draft>();
for (const [id, entity] of Object.entries(ENTITIES)) {
  const draft: Draft = { kind: "company", id, label: entity.displayTag ?? entity.name, aliases: new Set() };
  addAlias(draft, entity.name);
  if (entity.displayTag) addAlias(draft, entity.displayTag);
  for (const alias of entity.aliases) addAlias(draft, alias);
  drafts.push(draft);
  companyById.set(id, draft);
  if (entity.displayTag) companyByName.set(entity.displayTag, draft);
  companyByName.set(entity.name, draft);
}
for (const [from, to] of Object.entries(TAG_SYNONYMS)) {
  const draft = countryByName.get(to) ?? mineralByName.get(to) ?? companyByName.get(to);
  if (draft) addAlias(draft, from);
}

function blockersFor(draft: Draft, alias: string) {
  const blockers = new Set(CHAR_GUARDS[alias] ?? []);
  if ([...alias].length < 2 || isLatin(alias)) return [...blockers];
  for (const other of drafts) {
    if (other === draft) continue;
    for (const name of other.aliases) {
      if (name.length <= alias.length || !name.includes(alias)) continue;
      const at = name.indexOf(alias);
      // 蒙古 is a suffix of 内蒙古 and still must not match. A mineral word only
      // gets that treatment when it sits inside another name, so 金矿 does not
      // fire on 紫金矿业, while 黄金 at the end of 山东黄金 still counts.
      const internal = at > 0 && at + [...alias].length < [...name].length;
      if (draft.kind === "country" || internal) blockers.add(name);
    }
  }
  return [...blockers];
}

function isLatin(alias: string) {
  return !/[\u3400-\u9fff]/.test(alias);
}

const mentions: Mention[] = drafts.map((draft) => {
  const aliases = [...draft.aliases];
  const needles: Needle[] = aliases.map((alias) => {
    const blockers = blockersFor(draft, alias);
    if (blockers.length > 0 && !isLatin(alias)) return { kind: "guarded", text: alias, blockers };
    if (isLatin(alias)) return { kind: "latin", text: alias, blockers: [] };
    return { kind: "like", text: alias, blockers: [] };
  });
  return { kind: draft.kind, id: draft.id, label: draft.label, needles, aliases };
});

const byExact = new Map<string, Mention>();
const byFold = new Map<string, Mention | null>();
function indexAlias(mention: Mention, alias: string) {
  const key = alias.toLowerCase();
  const previous = byExact.get(key);
  if (!previous) byExact.set(key, mention);
  else if (previous !== mention) byExact.set(key, previous);
  const folded = foldMention(alias);
  if (!folded) return;
  const existing = byFold.get(folded);
  if (existing === undefined) byFold.set(folded, mention);
  else if (existing !== mention) byFold.set(folded, null);
}
for (const mention of mentions) {
  byExact.set(mention.label, mention);
  byExact.set(`entity:${mention.id}`, mention);
  for (const alias of mention.aliases) indexAlias(mention, alias);
}

export function mentionByTag(tag: string): Mention | null {
  const exact = byExact.get(tag) ?? byExact.get(tag.toLowerCase());
  if (exact) return exact;
  return byFold.get(foldMention(tag)) ?? null;
}

export function mentionByFold(folded: string): Mention | null {
  if (!folded) return null;
  return byFold.get(folded) ?? null;
}

/** Country codes named by title / summary / source / tags text. Not ancestors. */
export function jurisdictionCodesInText(searchText: string): string[] {
  if (!searchText) return [];
  const codes: string[] = [];
  for (const mention of mentions) if (mention.kind === "country" && textHits(searchText, mention.needles)) codes.push(mention.id);
  return codes;
}

export function textHits(searchText: string, needles: Needle[]): boolean {
  if (!searchText) return false;
  const hay = searchText.toLowerCase();
  for (const needle of needles) {
    if (needle.kind === "latin") {
      const body = escapeReg(needle.text.toLowerCase());
      if (new RegExp(`(^|[^a-z0-9])${body}([^a-z0-9]|$)`).test(hay)) return true;
      continue;
    }
    let stripped = hay;
    if (needle.kind === "guarded") {
      for (const blocker of [...needle.blockers].sort((a, b) => b.length - a.length)) stripped = stripped.split(blocker.toLowerCase()).join("");
    }
    if (stripped.includes(needle.text.toLowerCase())) return true;
  }
  return false;
}

/** Only a single-country topic changes geography scope; mixed business/company topics keep their meanings. */
export function topicJurisdiction(topicTags: string[] | null | undefined): string | null {
  const mention = topicTags?.length === 1 ? mentionByTag(topicTags[0]!) : null;
  return mention?.kind === "country" && JURISDICTIONS.some((row) => row.id === mention.id && row.kind === "country") ? mention.id : null;
}

export function matchesTopicTags(tags: string[], searchText: string, topicTags: string[], jurisdictions: string[] | null = null): boolean {
  const country = topicJurisdiction(topicTags);
  if (country) return jurisdictionDescendants(country).some((code) => jurisdictions?.includes(code));
  if (topicTags.some((tag) => tags.includes(tag))) return true;
  return topicTags.some((tag) => {
    const mention = mentionByTag(tag);
    return !!mention && textHits(searchText, mention.needles);
  });
}

function preferredAliases(mention: Mention) {
  return [...mention.aliases].sort((a, b) => Number(isLatin(a)) - Number(isLatin(b)) || a.length - b.length).slice(0, 12);
}

function foldMap(value: string) {
  const map: number[] = [];
  for (let i = 0; i < value.length; i++) if (!/[\s（）()【】[\]「」『』·・,，.。\-‐‑–—_/]/.test(value[i]!)) map.push(i);
  return map;
}

/** "刚果金矿业部" also has to hit a title written "刚果（金）矿业部". Latin aliases only match a whole term. */
function rewriteTerm(term: string): string[] {
  const folded = foldMention(term);
  const map = foldMap(term);
  let best: { mention: Mention; start: number; length: number } | null = null;
  for (const mention of mentions) {
    for (const alias of mention.aliases) {
      if (isLatin(alias)) continue;
      const key = foldMention(alias);
      if (key.length < 2 || key.length >= folded.length) continue;
      const at = folded.indexOf(key);
      if (at < 0) continue;
      if (!best || key.length > best.length) best = { mention, start: at, length: key.length };
    }
  }
  if (!best) return [];
  const start = map[best.start] ?? 0;
  const end = map[best.start + best.length] ?? term.length;
  const prefix = term.slice(0, start);
  const suffix = term.slice(end);
  return [...new Set([term, ...preferredAliases(best.mention).map((alias) => prefix + alias + suffix)])];
}

export function termExpands(term: string) {
  const plain = unescapeLike(term);
  if (mentionByFold(foldMention(plain))) return true;
  return rewriteTerm(plain).length > 1;
}

/** Bound pattern values for fixed SQL predicates; preserves the existing alias and guarded-character rules. */
export interface TextMatchValues {
  active: boolean;
  likes: string[];
  latin: string[];
  guardRemovals: string[];
  guardLikes: string[];
  hasGuards: boolean;
  bodyPrefix: string | null;
}
function needleValues(needles: Needle[]): TextMatchValues {
  return {
    active: needles.length > 0,
    bodyPrefix: null,
    likes: needles.filter((n) => n.kind === "like").map((n) => likePattern(n.text)),
    latin: needles.filter((n) => n.kind === "latin").map((n) => `(^|[^a-z0-9])${escapeReg(n.text.toLowerCase())}([^a-z0-9]|$)`),
    guardRemovals: needles
      .filter((n) => n.kind === "guarded")
      .map((n) =>
        [...n.blockers]
          .sort((a, b) => b.length - a.length)
          .map(escapeReg)
          .join("|"),
      ),
    guardLikes: needles.filter((n) => n.kind === "guarded").map((n) => likePattern(n.text)),
    hasGuards: needles.some((n) => n.kind === "guarded"),
  };
}
export function readMatcherValues(tag: string | null | undefined, topicTags: string[] | null | undefined, codes: string[], terms: string[], topicRecipe = "") {
  const tagMention = tag ? mentionByTag(tag) : null;
  const country = topicJurisdiction(topicTags);
  const labels = codes.flatMap((code) => countryById.get(code)?.label ?? []);
  const termValues = terms.map((term) => {
    const plain = unescapeLike(term),
      exact = mentionByFold(foldMention(plain));
    if (exact) return needleValues(exact.needles);
    const forms = rewriteTerm(plain);
    return {
      ...needleValues([]),
      active: true,
      likes: (forms.length > 1 ? forms : [plain]).map(likePattern),
      bodyPrefix: /^[a-z0-9]+$/.test(plain) ? `(^|[^a-z0-9])${plain}` : null,
    };
  });
  return {
    tagTags: tag ? (tagMention?.kind === "company" ? [tagMention.label, `entity:${tagMention.id}`] : [tag]) : null,
    tagText: needleValues(tagMention?.needles ?? []),
    topicTags: topicTags?.length ? topicTags : null,
    topicJurisdiction: country,
    topicJurisdictionCodes: jurisdictionDescendants(country ?? ""),
    topicRecipe,
    topicText: needleValues((topicTags ?? []).flatMap((label) => mentionByTag(label)?.needles ?? [])),
    jurisdictionTags: labels,
    jurisdictionText: needleValues(labels.flatMap((label) => mentionByTag(label)?.needles ?? [])),
    term0: termValues[0] ?? needleValues([]),
    term1: termValues[1] ?? needleValues([]),
    term2: termValues[2] ?? needleValues([]),
    term3: termValues[3] ?? needleValues([]),
    term4: termValues[4] ?? needleValues([]),
    term5: termValues[5] ?? needleValues([]),
  };
}
export type ReadMatcherValues = ReturnType<typeof readMatcherValues>;

/** Literal LIKE terms used for the established ranking weights; matching still expands aliases separately. */
export function searchScoreValues(terms: string[]) {
  const patterns = terms.map((term) => `%${term}%`);
  return {
    term0: patterns[0] ?? null,
    term1: patterns[1] ?? null,
    term2: patterns[2] ?? null,
    term3: patterns[3] ?? null,
    term4: patterns[4] ?? null,
    term5: patterns[5] ?? null,
  };
}
export type SearchScoreValues = ReturnType<typeof searchScoreValues>;
