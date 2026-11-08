// A company or mineral tag must be written in the material itself (TASK-0584, Owner 2026-11-07: choosing 紫金矿业
// showed 《比尔·盖茨私人访问智利 Chuquicamata 铜矿》, whose original never names Zijin). The structure step may
// only pick tags from a whitelist, but nothing checked that the material names what it picked; the company and
// mineral filters read the stored tags and search text built from them. Here every company and mineral tag the
// analysis gave is kept only when the original title, body, excerpt or source name contains one of its aliases
// (companies by the guarded identity lexicon, minerals by the filter aliases plus other-language wordings).
// Category tags, country tags (country filters read the quoted geography assignments, not tags) and tags a person
// set are left as they are.
import { IDENTITY_LEXICON } from "@amp/industry/taxonomy";
import { filterHits, mentionByTag, textHits } from "./mentions.ts";

/**
 * Other wordings that name a mineral, used to keep a tag and never to add one. The filter's own aliases are Chinese
 * and English, and deliberately narrow (bare "lead" is the English verb); many sources write in Spanish or
 * Portuguese. Languages not listed here cannot prove a mineral absent, so their mineral tags are kept.
 */
const MINERAL_EVIDENCE: Record<string, RegExp> = {
  铜: /\bcobre\b/i,
  金: /\boro\b|\bouro\b|\baur[ií]fer/i,
  银: /\bplata\b|\bprata\b/i,
  锌: /\bzinco?\b/i,
  铅: /\blead[\s-](?:zinc|concentrate|ore|smelter|smelting|price|prices|production|output|mine|mines|metal|ingot|acid)\b|\bzinc[\s-]lead\b|\b(?:zinc|silver|copper|gold)(?:\s*,\s*|\s+(?:and|&)\s+)lead\b|\blead(?:\s*,\s*|\s+(?:and|&)\s+)(?:zinc|silver|copper)\b|\bpb\b|\bplomo\b|\bchumbo\b/i,
  锂: /\bl[ií]tio\b|\bspodumene\b|锂辉石|\bespodumeno\b/i,
  镍: /\bn[ií]quel\b/i,
  钴: /\bcobalto\b/i,
  钼: /\bmolibd[eê]nio\b|\bmolibdeno\b/i,
  铁矿石: /\bmineral de hierro\b|\bmin[eé]rio de ferro\b|\bhierro\b|\bferro\b/i,
  // Steel is how the iron trade is mostly written about (dry run 2026-11-08: SSAB, World Steel); iron ore stays strict.
  铁: /\bhierro\b|\bferro\b|\bsteel(?:s|making|maker|makers)?\b|钢|\bacero\b|\baço\b/i,
  铝土矿: /\bbauxita\b/i,
  铝: /\balum[ií]nio\b|\balumina\b|氧化铝|\balúmina\b/i,
  稀土: /\btierras raras\b|\bterras raras\b|\brare[\s-]earths?\b/i,
  钨: /\btungsteno\b|\bwolframio\b|\btungst[eê]nio\b/i,
  锑: /\bantimonio\b|\bantim[oô]nio\b/i,
  锡: /\bestaño\b|\bestanho\b/i,
  锰: /\bmanganeso\b|\bmangan[eê]s\b/i,
  铬: /\bcromo\b|\bchrome\b|\bferrochrome\b|铬铁/i,
  铂族金属: /\bplatino\b|\bpaladio\b|\bplatina\b|\bpal[aá]dio\b/i,
};
/**
 * Companies that are, by name or business, one commodity's producers: a story about one of them is about that
 * commodity even when the text never names it (dry run 2026-11-08: “Codelco desvincula a ocho ejecutivos” lost 铜).
 * Only companies the material itself names count, so this never brings back an unnamed company's metals.
 */
const COMPANY_MINERALS: Record<string, readonly string[]> = {
  codelco: ["铜"],
  "southern-copper": ["铜"],
  "jiangxi-copper": ["铜"],
  "first-quantum": ["铜"],
  freeport: ["铜", "金"],
  barrick: ["金"],
  newmont: ["金"],
  "shandong-gold": ["金"],
  ganfeng: ["锂"],
  tianqi: ["锂"],
  albemarle: ["锂"],
  sqm: ["锂"],
  huayou: ["钴"],
  chalco: ["铝"],
  cmoc: ["钼", "铜", "钴"],
};
/** Languages whose mineral wordings are covered (filter aliases plus MINERAL_EVIDENCE). */
const MINERAL_LANGUAGES = new Set(["zh", "en", "es", "pt"]);

/** The text a tag must be found in: what the source wrote, never the model's own copy. */
export function groundingText(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0).join("\n");
}

/**
 * Whether a tag stays: anything that is not a company or mineral stays; those two need evidence in the text. A
 * company is found with the identity lexicon (the guarded patterns that also check AI copy: 力拓 inside 大力拓展 is
 * not Rio Tinto). `language` is the material's language; a mineral in an uncovered language is kept.
 */
export function tagGrounded(tag: string, text: string, language?: string | null): boolean {
  const mention = mentionByTag(tag);
  if (!mention || mention.kind === "country") return true;
  if (mention.kind === "company") {
    const lexicon = IDENTITY_LEXICON.find((entry) => entry.id === mention.id);
    return lexicon ? lexicon.patterns.some((pattern) => pattern.test(text)) : textHits(text, mention.needles);
  }
  const base = (language ?? "").toLowerCase().split(/[-_]/)[0]!;
  if (base && !MINERAL_LANGUAGES.has(base)) return true;
  if (textHits(text, mention.needles) || MINERAL_EVIDENCE[mention.label]?.test(text)) return true;
  return Object.entries(COMPANY_MINERALS).some(([company, minerals]) => minerals.includes(mention.label) && tagGrounded(`entity:${company}`, text));
}

/** The analysed tags that the material supports, in their original order. */
export function groundTags(tags: readonly string[], text: string, language?: string | null): string[] {
  return tags.filter((tag) => tagGrounded(tag, text, language));
}

/**
 * The companies and minerals whose filter shows this item (a stored tag, or a hit in the search text, which also
 * holds the AI title and summary) although the material never names them (TASK-0589, Owner 2026-11-07: “这一类的问题
 * 希望都不要再犯……还有可能没有我抽到的”). Grounded tags are fixed at publish time; this finds the same mistake
 * arriving through the AI copy instead. Read-only: it is counted, not changed.
 */
export function ungroundedFilterHits(searchText: string, tags: readonly string[], text: string, language?: string | null): string[] {
  return filterHits(tags, searchText)
    .filter((mention) => !tagGrounded(mention.kind === "company" ? `entity:${mention.id}` : mention.label, text, language))
    .map((mention) => mention.label);
}
