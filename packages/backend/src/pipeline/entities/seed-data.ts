// What the library starts from beyond the lists already in code (industry/taxonomy.ts, industry/name-glossary.ts):
// ids for the glossary companies, the three companies that only the scoring and prompt name lists carry, Chinese
// variants the identity lexicon already accepts, short forms with the scope they deserve, and listing symbols.
// Every Chinese name here is one the code already uses (rule 15: no invented names). After the first load the
// production database is the truth; this list only fills what is absent.
import type { AliasScope } from "./model.ts";

export interface AliasSpec {
  value: string;
  scope?: AliasScope;
  caseSensitive?: boolean;
}

export interface SeedCompany {
  id: string;
  nameZh: string;
  nameOriginal: string;
  /** Chinese companies are written with their official Chinese name and no bracketed original. */
  chinese: boolean;
  aliases: ReadonlyArray<string | AliasSpec>;
}

/** Ids of the glossary companies that have no tag-vocabulary entry, by their Chinese name. */
export const GLOSSARY_IDS: Readonly<Record<string, string>> = {
  泰克资源: "teck",
  安托法加斯塔: "antofagasta",
  福蒂斯丘: "fortescue",
  南32: "south32",
  诺里尔斯克镍业: "nornickel",
  金田: "gold-fields",
  盎格鲁黄金阿散蒂: "anglogold-ashanti",
  金罗斯: "kinross",
  "西班耶-斯蒂尔沃特": "sibanye-stillwater",
  托克: "trafigura",
  摩科瑞: "mercuria",
};

/** Named by the scoring list (industry/selection.ts MAJOR_COMPANIES) or the prompt's name list only. */
export const EXTRA_COMPANIES: readonly SeedCompany[] = [
  { id: "china-baowu", nameZh: "中国宝武", nameOriginal: "China Baowu", chinese: true, aliases: ["中国宝武", "China Baowu", "Baowu"] },
  { id: "agnico-eagle", nameZh: "伊格尔矿业", nameOriginal: "Agnico Eagle", chinese: false, aliases: ["伊格尔矿业", "Agnico Eagle", "Agnico Eagle Mines"] },
  {
    id: "tongling-nonferrous",
    nameZh: "铜陵有色",
    nameOriginal: "Tongling Nonferrous Metals",
    chinese: true,
    aliases: ["铜陵有色", "Tongling Nonferrous", "Tongling Nonferrous Metals"],
  },
];

/**
 * Further spellings of companies already listed. The Chinese variants are those the identity lexicon accepts
 * (industry/taxonomy.ts IDENTITY_LEXICON), so a digest that writes them is rewritten to the one name. Each long
 * variant is listed with and without its 公司 so the longer one wins and no 公司 is left doubled.
 */
export const EXTRA_ALIASES: Readonly<Record<string, ReadonlyArray<string | AliasSpec>>> = {
  codelco: ["智利国营铜业公司", "智利国营铜业", "科德尔科"],
  albemarle: ["雅保"],
  sqm: ["智利矿业化工", "智利化学矿业", "Sociedad Química y Minera"],
  "shandong-gold": ["山东黄金矿业"],
  freeport: ["自由港迈克墨伦", { value: "Freeport", scope: "anchored" }],
  vale: [
    { value: "Vale S.A.", caseSensitive: true },
    { value: "Vale SA", caseSensitive: true },
  ],
  antofagasta: ["Antofagasta plc"],
  chalco: ["Aluminum Corporation of China", "Aluminium Corporation of China"],
  cmoc: ["Luoyang Molybdenum"],
};

/**
 * Scope and case of spellings that are also places or ordinary words. Vale is a Portuguese verb and an English
 * valley (Vale of Belvoir); Antofagasta, in either script, a Chilean region; Kinross a Scottish town; Freeport a port
 * town; Teck too short to trust alone; 南32 is also "south 32" in 以南32公里. Barrick is left `text`: it is no place
 * or word, and the passing-mention wordings tell "Former Barrick executive" apart. Upper-case abbreviations only
 * count in upper case, and "gold fields" or "southern copper" in lower case is just a landscape. A bare FCX is a
 * ticker without its exchange, which running text does not link (only "NYSE: FCX" does); it still answers lookups.
 */
export const ALIAS_RULES: Readonly<Record<string, Omit<AliasSpec, "value">>> = {
  Vale: { scope: "anchored", caseSensitive: true },
  Antofagasta: { scope: "anchored" },
  安托法加斯塔: { scope: "anchored" },
  Kinross: { scope: "anchored" },
  Teck: { scope: "anchored" },
  南32: { scope: "anchored" },
  BHP: { caseSensitive: true },
  MMG: { caseSensitive: true },
  SQM: { caseSensitive: true },
  CMOC: { caseSensitive: true },
  FCX: { scope: "lookup", caseSensitive: true },
  "Gold Fields": { caseSensitive: true },
  "Southern Copper": { caseSensitive: true },
};

/** Listing symbols as `EXCHANGE:SYMBOL`; text links them only in that qualified form, as in “(NYSE: FCX)”. */
export const TICKERS: Readonly<Record<string, readonly string[]>> = {
  bhp: ["ASX:BHP", "NYSE:BHP", "LSE:BHP"],
  "rio-tinto": ["ASX:RIO", "NYSE:RIO", "LSE:RIO"],
  glencore: ["LSE:GLEN"],
  vale: ["NYSE:VALE"],
  "anglo-american": ["LSE:AAL"],
  freeport: ["NYSE:FCX"],
  newmont: ["NYSE:NEM"],
  "first-quantum": ["TSX:FM"],
  ivanhoe: ["TSX:IVN"],
  albemarle: ["NYSE:ALB"],
  sqm: ["NYSE:SQM"],
  "southern-copper": ["NYSE:SCCO"],
  teck: ["NYSE:TECK"],
  antofagasta: ["LSE:ANTO"],
  fortescue: ["ASX:FMG"],
  south32: ["ASX:S32"],
  "gold-fields": ["NYSE:GFI"],
  "anglogold-ashanti": ["NYSE:AU"],
  kinross: ["NYSE:KGC"],
  "sibanye-stillwater": ["NYSE:SBSW"],
  "agnico-eagle": ["NYSE:AEM"],
};
