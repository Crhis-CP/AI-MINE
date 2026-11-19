// The dateline at the top of an article ("VANCOUVER, Canada, Nov. 18, 2026 --", "新华社北京11月18日电") names where the
// text was issued, not where the news happened. The structure step sometimes files a report under the dateline's
// country (Owner 2026-11-19: a release from Vancouver about an Argentine project was filed under Canada). The step's
// prompt is not changed for this (every receipt would be re-keyed); its answer is corrected afterwards instead.
// Pure: nothing here reads the database or changes what readers see. The projection that would apply the correction
// comes later, behind a switch the deployer sets at release.
import { COUNTRY_ALIASES, JURISDICTIONS } from "@amp/industry/jurisdictions";
import { MONTH_PATTERN } from "./calendar.ts";

/**
 * Who issued the text. A press-release wire (PRNewswire, GLOBE NEWSWIRE) carries the company's own office as the
 * dateline, which is often not where the project is. A news agency (Reuters, EFE, Xinhua) datelines where its
 * reporter is, which is often where the news happened. Unmarked: a place and date with no wire or agency named.
 */
export type DatelineKind = "release_wire" | "news_agency" | "unmarked";

export interface Dateline {
  /** Characters from the start of the text to the end of the dateline and its separator. */
  end: number;
  kind: DatelineKind;
  /** The wire or agency named, as written; null when none is. */
  marker: string | null;
}

/** Datelines are short: one that would run past this many characters is something else. */
const DATELINE_LIMIT = 200;

const RELEASE_WIRES = [
  "PR ?Newswire",
  "CNW",
  "GLOBE ?NEWSWIRE",
  "Business ?Wire",
  "ACCESS ?(?:WIRE|Newswire)",
  "Newsfile(?: Corp\\.?)?",
  "Marketwired",
  "EQS(?:[- ]Newswire)?",
  "Cision",
  "PRWeb",
  "EIN Presswire",
];
const NEWS_AGENCIES = [
  "Reuters",
  "AP",
  "AFP",
  "EFE",
  "Bloomberg",
  "Xinhua",
  "dpa",
  "ANSA",
  "Lusa",
  "TASS",
  "Interfax",
  "Kyodo",
  "Yonhap",
  "Bernama",
  "Antara",
  "PTI",
  "IANS",
  "AAP",
  "Europa Press",
  "Prensa Latina",
  "Notimex",
  "Télam",
  "Andina",
  "Agência Brasil",
  "Sputnik",
  "RIA Novosti",
];
const CHINESE_AGENCIES = ["新华社", "中新社", "中新网", "中国新闻社", "路透社", "法新社", "美联社", "彭博社", "塔斯社", "共同社", "埃菲社"];
const CHINESE_WIRES = ["美通社", "环球新闻通讯社"];

const RELEASE_WIRE = new RegExp(`^(?:${RELEASE_WIRES.join("|")})$`, "iu");
const NEWS_AGENCY = new RegExp(`^(?:${NEWS_AGENCIES.join("|")})$`, "iu");

/** The rest of a word after its first letter: letters, marks, and the dots, apostrophes and hyphens of place names. */
const REST = "[\\p{L}\\p{M}.'’-]*";
/** An upper-case place of one to four words: VANCOUVER, NEW YORK, ST. JOHN'S, SÃO PAULO. */
const UPPER_PLACE = "\\p{Lu}[\\p{Lu}\\p{M}.'’-]*(?: \\p{Lu}[\\p{Lu}\\p{M}.'’-]*){0,3}";
/** A place written in ordinary case: Lima, Rio de Janeiro, São Paulo. Only a dateline when a date or marker follows. */
const MIXED_PLACE = `\\p{Lu}${REST}(?: (?:de |do |da |del |la |los |las )?\\p{Lu}${REST}){0,3}`;
/** A further comma part naming a province or country: Canada, British Columbia, B.C., Newfoundland and Labrador. */
const PART = `\\p{Lu}${REST}(?: (?:and |y |e |et )?\\p{Lu}${REST}){0,3}`;
const MONTH = `(?i:${MONTH_PATTERN})`;
const DATE = [
  `${MONTH}\\.? \\d{1,2}(?:, ?\\d{4})?`,
  `\\d{1,2}(?: de)? ${MONTH}\\.?(?:(?: de)? \\d{4})?`,
  "\\d{4}-\\d{2}-\\d{2}",
  "\\d{1,2}[/.]\\d{1,2}[/.]\\d{2,4}",
].join("|");
const MARKER = "/(?<slash>[^/\\n]{2,30})/|\\((?<paren>[^()\\n]{2,60})\\)";
const SEPARATOR = "\\s*(?:--|—|–)|\\s-|\\.-|\\s*:";
/** ACCESS Newswire's form puts the wire, then the date, between slashes: "VANCOUVER, BC / ACCESS Newswire / November 18, 2026 / ". */
const SLASHED = `\\s*/(?<slashedWire>[^/\\n]{2,30})/\\s*(?<slashedDate>${DATE})\\s*/`;

// Case matters (an upper-case place is evidence), so the expression is case-sensitive except for month names.
const LATIN = new RegExp(
  `^\\s*(?<place>${UPPER_PLACE}|${MIXED_PLACE})(?<parts>(?:, ?${PART}){0,2}?)(?:(?:,? (?:le )?(?<date>${DATE}))?(?:(?:\\s*(?:--|—|–))?\\s*(?:${MARKER}))?(?:${SEPARATOR})|${SLASHED})\\s*(?=[\\p{L}\\p{N}"“'‘(])`,
  "u",
);
/** Upper-case labels that open a text with a colon or dash but name no place. */
const NOT_A_PLACE = /^(?:NOTE|EDITOR'S NOTE|UPDATE(?: \d)?|BREAKING|EXCLUSIVE|ANALYSIS|COMMENT|OPINION|CORRECTION|WATCH|PHOTO|VIDEO|FILE|SOURCE)$/;
const CHINESE_NUMBER = "[0-9０-９一二三四五六七八九十]{1,3}";
const CHINESE_DATE = `[\\p{Script=Han}·]{0,10}?${CHINESE_NUMBER}月${CHINESE_NUMBER}日(?:电|讯)`;
// After a named agency or wire the 电 or 讯 is the dateline's, whatever follows. Without one, ordinary words begin with
// 电 (电话, 电价, 电力, 电解铝: "智利11月18日电力中断"), so the dateline must end there: no Han character may follow.
const CHINESE = new RegExp(
  `^\\s*(?:【(?<inner>[^】\\n]{2,40}?(?:电|讯))】|(?<lead>(?:${[...CHINESE_AGENCIES, ...CHINESE_WIRES, "本报"].join("|")})${CHINESE_DATE}|${CHINESE_DATE}(?!\\p{Script=Han})|本报讯)(?:[（(][^）)\\n]{0,30}[）)])?)(?:\\s*/[^/\\n]{2,12}/)?(?:\\s*(?:--|—|–))?\\s*[:：]?\\s*`,
  "u",
);

const upper = (s: string) => s === s.toUpperCase() && /\p{Lu}.*\p{Lu}/u.test(s);
const letters = (s: string) => s.replace(/[^\p{L}]/gu, "").length;
const wireKind = (marker: string): DatelineKind | null => {
  // "Newsfile Corp. - November 18, 2026" names the wire before the date.
  const name = marker.split(/\s+-\s+/)[0]!.trim();
  return RELEASE_WIRE.test(name) ? "release_wire" : NEWS_AGENCY.test(name) ? "news_agency" : null;
};

/**
 * The dateline at the start of a body, if it has one: an upper-case place (or any place followed by a date or a
 * wire), up to two further comma parts, an optional date and wire or agency marker, then a dash or colon (or ACCESS
 * Newswire's "/ wire / date /"); or one of
 * the Chinese forms 新华社北京11月18日电, 【温哥华11月18日讯】, 本报讯. A headline-like opening ("LME copper rose",
 * "BHP, Rio Tinto and Vale said") is not one.
 */
export function readDateline(bodyHead: string): Dateline | null {
  const head = bodyHead.slice(0, DATELINE_LIMIT);
  const chinese = CHINESE.exec(head);
  if (chinese?.groups) {
    const text = chinese.groups.inner ?? chinese.groups.lead ?? "";
    const named = (list: string[]) => list.find((name) => text.startsWith(name)) ?? null;
    const agency = named(CHINESE_AGENCIES),
      wire = named(CHINESE_WIRES);
    return { end: chinese[0].length, kind: agency ? "news_agency" : wire ? "release_wire" : "unmarked", marker: agency ?? wire };
  }
  const latin = LATIN.exec(head);
  if (!latin?.groups) return null;
  const { place, parts, slash, paren, slashedWire } = latin.groups;
  const date = latin.groups.date ?? latin.groups.slashedDate;
  const marker = (slash ?? paren ?? slashedWire)?.trim() ?? null;
  const kind = marker ? wireKind(marker) : null;
  // A marker that is no wire or agency (a parenthesis in an opening sentence) is no dateline evidence.
  if (marker && !kind) return null;
  // An upper-case word alone before a dash is too often a ticker or a shouted headline ("BHP - "); it counts when
  // it is long enough to be a city, has a further part, or a date or wire follows.
  if (!date && !marker) {
    if (!upper(place!) || NOT_A_PLACE.test(place!)) return null;
    if (letters(place!) < 4 && !parts) return null;
  }
  return { end: latin[0].length, kind: kind ?? "unmarked", marker };
}

/** Length of the dateline at the start of body_head, 0 if there is none. */
export const datelineEnd = (bodyHead: string): number => readDateline(bodyHead)?.end ?? 0;

const ACTIVE = new Set(["event_location", "rule_scope", "affected_location"]);
const jurisdictions = new Map(JURISDICTIONS.map((j) => [j.id, j]));
const countryOf = (code: string) => {
  const row = jurisdictions.get(code);
  return row?.kind === "subdivision" ? (row.parent ?? code) : code;
};
const NAME_LOCALES = ["en", "es", "pt", "fr", "zh"];
/** Every common name of a country or subdivision, in the languages the news line reads. */
function placeNames(code: string): string[] {
  const names = new Set<string>();
  for (const id of new Set([code, countryOf(code)])) {
    const row = jurisdictions.get(id);
    if (!row) continue;
    names.add(row.name_en);
    names.add(row.name_zh);
    for (const alias of COUNTRY_ALIASES[id] ?? []) names.add(alias);
    if (row.kind === "country") for (const locale of NAME_LOCALES) names.add(new Intl.DisplayNames([locale], { type: "region" }).of(id)!);
  }
  return [...names];
}
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const names = (text: string, name: string) =>
  /\p{Script=Han}/u.test(name) ? text.includes(name) : new RegExp(`(?<![\\p{L}\\p{N}])${literal(name)}(?![\\p{L}\\p{N}])`, "iu").test(text);

interface PlaceRow {
  code: string;
  role: string;
  mention: string;
  segment: string;
  quote: string;
}
const placeRow = (value: unknown): PlaceRow | null => {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return ["code", "role", "mention", "segment", "quote"].every((key) => typeof row[key] === "string") ? (row as unknown as PlaceRow) : null;
};

export type KeptReason = "title_names_it" | "named_elsewhere";

/**
 * The structure step's answer with the countries it took only from the dateline turned into the issuer's location.
 * An active assignment is demoted when its segment is body_head and its mention lies inside the dateline. It is kept
 * (and listed in `kept`) when the title names that country, or when the step gave the same country or one of its
 * subdivisions another active assignment outside the dateline. A second mention found by searching the text is
 * deliberately not enough: the "About the company" paragraph of a release names the head office's country. So a story
 * the step quoted only from its dateline ends with no country rather than a wrong one. A news agency's dateline is
 * treated like a release wire's (design L, B4): its reporter is often where the news is, but whether that earns an
 * exception is for the count of datelines by kind to decide, so the kind is returned with the result. The answer is
 * not validated here; validateGeography (editorial/geography.ts) recomputes codes and the main country from the
 * returned candidate.
 */
export function demoteDateline<T extends { assignments: readonly unknown[] }>(
  candidate: T,
  segments: ReadonlyArray<{ id: string; text: string }>,
): {
  candidate: T;
  dateline: Dateline | null;
  demoted: { code: string; quote: string }[];
  kept: { code: string; quote: string; reason: KeptReason }[];
} {
  const head = segments.find((s) => s.id === "body_head")?.text ?? "";
  const title = segments.find((s) => s.id === "title")?.text ?? "";
  const dateline = readDateline(head);
  const none = { candidate, dateline, demoted: [], kept: [] };
  if (!dateline) return none;
  const rows = candidate.assignments.map(placeRow);
  const insideDateline = (row: PlaceRow) => {
    if (row.segment !== "body_head") return false;
    const quoteAt = head.indexOf(row.quote),
      mentionAt = row.quote.indexOf(row.mention);
    return quoteAt >= 0 && mentionAt >= 0 && quoteAt + mentionAt < dateline.end;
  };
  const inDateline = rows.map((row) => !!row && ACTIVE.has(row.role) && insideDateline(row));
  const demoted: { code: string; quote: string }[] = [];
  const kept: { code: string; quote: string; reason: KeptReason }[] = [];
  const assignments = candidate.assignments.map((value, i) => {
    const row = rows[i];
    if (!row || !inDateline[i]) return value;
    const country = countryOf(row.code);
    const reason: KeptReason | null = [row.mention, ...placeNames(row.code)].some((name) => names(title, name))
      ? "title_names_it"
      : rows.some((other, j) => !!other && j !== i && !inDateline[j] && ACTIVE.has(other.role) && countryOf(other.code) === country)
        ? "named_elsewhere"
        : null;
    if (reason) {
      kept.push({ code: row.code, quote: row.quote, reason });
      return value;
    }
    demoted.push({ code: row.code, quote: row.quote });
    return { ...row, role: "issuer_location" };
  });
  if (!demoted.length) return { ...none, kept };
  return { candidate: { ...candidate, assignments }, dateline, demoted, kept };
}
