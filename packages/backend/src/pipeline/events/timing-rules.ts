// When the thing a fact reports happened, decided by rules alone (no model call, no database).
//
// The structure step states one occurrence date per report (analyses.output.fact.occurredAt: "the date the original
// states explicitly"). Nothing has ever checked it, and a wrong date is costly: it can move a fresh report out of
// "today". So a claim counts as checked only when that calendar day is actually written in the report, and not as the
// end of a reporting period ("quarter ended 30 September", "截至9月30日"), which is a date in the text but not the day
// anything happened. A fact's date then comes from its members: the earliest checked claim, else a date two members
// agree on, else the founding report's own claim, which stays a claim (rank/rules.ts never makes a report old on it).
import { beijingDate, isValidDate } from "@amp/contracts/time";

/** How a fact's occurrence date is known; stored as events.fact_timing.occurred_basis. */
export type OccurredBasis = "verified" | "agreed" | "claimed" | "none";

/** One member report's say on when its fact happened. */
export interface MemberClaim {
  articleId: string;
  revision: number;
  /** The claimed calendar day, YYYY-MM-DD; null when the report states none or the claim was unusable. */
  on: string | null;
  /** The day is written in the report's own text, outside a period-end phrase. */
  verified: boolean;
  /** When the report itself came out: coalesce(published_at, discovered_at), as the event engine uses. */
  at: Date;
}

export interface FactTiming {
  occurredOn: string | null;
  occurredBasis: OccurredBasis;
  firstReportedAt: Date;
  firstArticleId: string;
  lastReportedAt: Date;
  members: number;
}

/** A structure-step date as stored: YYYY-MM-DD, optionally followed by a time the model added. Anything else is no claim. */
export function parseClaim(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const day = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(value.trim())?.[1];
  return day && isValidDate(day) ? day : null;
}

/** Whole calendar days from `earlier` to `later` (both YYYY-MM-DD). */
export function dayGap(later: string, earlier: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
}

const MONTHS: Readonly<Record<string, number>> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
  // Spanish and Portuguese ("18 de noviembre", "18 de novembro"); "abril", "agosto" are shared.
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
  janeiro: 1,
  fevereiro: 2,
  março: 3,
  maio: 5,
  junho: 6,
  julho: 7,
  setembro: 9,
  outubro: 10,
  novembro: 11,
  dezembro: 12,
  // French ("18 novembre 2026").
  janvier: 1,
  février: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  août: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  décembre: 12,
};
// Longest names first, so "september" is not read as "sep" followed by "tember".
const MONTH = `(${Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|")})`;
const YEAR = String.raw`(\d{4})`;
const DAY = String.raw`(\d{1,2})`;

/** The written forms of a day, each with which capture holds the year, month and day. */
const FORMS: ReadonlyArray<{ pattern: RegExp; year: number; month: number; day: number }> = [
  // 2026-11-18, 2026/11/18, 2026.11.18
  { pattern: new RegExp(String.raw`(?<!\d)${YEAR}[-/.](\d{1,2})[-/.]${DAY}(?!\d)`, "gu"), year: 1, month: 2, day: 3 },
  // 2026年11月18日, 11月18日, 11月18号
  { pattern: new RegExp(String.raw`(?:${YEAR}\s*年\s*)?(\d{1,2})\s*月\s*${DAY}\s*[日号]`, "gu"), year: 1, month: 2, day: 3 },
  // Nov. 18, 2026; November 18th 2026; Nov 18
  { pattern: new RegExp(String.raw`(?<![\p{L}])${MONTH}\.?\s+${DAY}(?:st|nd|rd|th)?(?!\d)(?:,?\s*${YEAR}(?!\d))?`, "giu"), year: 3, month: 1, day: 2 },
  // 18 November 2026; 18th of November; 18 de noviembre de 2026; 18 de novembro; 18 novembre 2026; 1er mars
  {
    pattern: new RegExp(String.raw`(?<!\d)${DAY}(?:st|nd|rd|th|er)?\s+(?:of\s+|de\s+)?${MONTH}(?![\p{L}])\.?(?:,?\s*(?:de(?:l)?\s+)?${YEAR}(?!\d))?`, "giu"),
    year: 3,
    month: 2,
    day: 1,
  },
];

/**
 * Words right before a day that make it the end of a reporting period or a cut-off, not an occurrence: results "for the
 * quarter ended September 30", "in the nine months to 30 September", reserves "as at 30 June", figures "截至 9月30日",
 * and the end of a range that starts with a day ("7月1日至9月30日", "July 1 to September 30", "1–30 September"). The
 * text check must not turn those into proof that something happened that day. A dash only closes a range when it
 * touches the day before it, so a headline such as "UPDATE 2 - Nov 18" still counts.
 */
const PERIOD_END = new RegExp(
  String.raw`(?:\b(?:ended|ending|as\s+(?:at|of)|through|(?:months?|quarter|half(?:-year)?|period|year|results)\s+to)\s+(?:on\s+)?` +
    String.raw`|截至|截止(?:到|至)?|terminad[oa]\s+(?:el|em)\s+|al\s+cierre\s+del?\s+` +
    String.raw`|(?:[日号]|\d(?:st|nd|rd|th)?)\s*(?:至|到)|(?:[日号]|\d(?:st|nd|rd|th)?)[~–—-]|\d(?:st|nd|rd|th)?\s+(?:to|until)\s)\s*$`,
  "iu",
);

/**
 * The calendar days written in a text, as YYYY-MM-DD. A form without a year takes the report's year, or the year
 * before when that would put the day after the report (a January report recalling "December 28").
 */
export function writtenDays(text: string, reportDay: string): string[] {
  const normalized = text.normalize("NFKC");
  const days = new Set<string>();
  for (const form of FORMS)
    for (const match of normalized.matchAll(form.pattern)) {
      const before = normalized.slice(Math.max(0, match.index - 24), match.index);
      if (PERIOD_END.test(before)) continue;
      const monthText = match[form.month]!;
      const month = /^\d+$/.test(monthText) ? Number(monthText) : MONTHS[monthText.toLowerCase()];
      if (!month) continue;
      const mmdd = `${String(month).padStart(2, "0")}-${match[form.day]!.padStart(2, "0")}`;
      const stated = match[form.year];
      let day = `${stated ?? reportDay.slice(0, 4)}-${mmdd}`;
      if (!stated && day > reportDay) day = `${Number(reportDay.slice(0, 4)) - 1}-${mmdd}`;
      if (isValidDate(day)) days.add(day);
    }
  return [...days];
}

/** Whether the report writes this calendar day as something other than a period end. */
export function dateInText(text: string, on: string, reportedAt: Date): boolean {
  return writtenDays(text, beijingDate(reportedAt)).includes(on);
}

/**
 * One member's claim, checked against its text. A day after the report's own Beijing day is dropped: a report can
 * announce what is scheduled, and a scheduled day is not when anything happened.
 */
export function memberClaim(i: { articleId: string; revision: number; claim: unknown; text: string; reportedAt: Date }): MemberClaim {
  const claimed = parseClaim(i.claim);
  const on = claimed && claimed <= beijingDate(i.reportedAt) ? claimed : null;
  return { articleId: i.articleId, revision: i.revision, on, verified: on !== null && dateInText(i.text, on, i.reportedAt), at: i.reportedAt };
}

/**
 * A fact's timing from its current members' claims. The founder is the earliest report (ties by article id, so the
 * answer does not depend on the order members are read). Null when the fact has no member left.
 *
 * Known limit: one member that writes a background day ("first restricted exports on October 20") and claims it makes
 * that day the fact's checked day, and every member without a checked day of its own then counts as old with it, so
 * the whole fact is filed on that day. Only a different checked day in a member's own text keeps it fresh. Whether to
 * trust a single member's day for the others is left to the production measurement of member agreement (design M, E6).
 */
export function factTiming(claims: readonly MemberClaim[]): FactTiming | null {
  if (!claims.length) return null;
  const byTime = [...claims].sort((a, b) => a.at.getTime() - b.at.getTime() || a.articleId.localeCompare(b.articleId));
  const founder = byTime[0]!;
  const timing = {
    firstReportedAt: founder.at,
    firstArticleId: founder.articleId,
    lastReportedAt: byTime.at(-1)!.at,
    members: claims.length,
  };
  const verified = claims.flatMap((c) => (c.verified && c.on ? [c.on] : [])).sort();
  if (verified.length) return { ...timing, occurredOn: verified[0]!, occurredBasis: "verified" };
  // Two reports stating the same day are evidence even when neither writes it in a checkable form. Two copies of one
  // wire text count twice here; the production measurement of agreement (design M, E6) decides whether that is enough.
  const counts = new Map<string, number>();
  for (const c of claims) if (c.on) counts.set(c.on, (counts.get(c.on) ?? 0) + 1);
  const agreed = [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (agreed) return { ...timing, occurredOn: agreed[0], occurredBasis: "agreed" };
  if (founder.on) return { ...timing, occurredOn: founder.on, occurredBasis: "claimed" };
  return { ...timing, occurredOn: null, occurredBasis: "none" };
}
