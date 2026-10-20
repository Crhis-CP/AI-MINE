import { addDays, beijingDate, isoWeekLabel, isoWeekRange, isValidDate } from "@amp/contracts/time";
import { EDITION_TIMES } from "@amp/industry/site";
import { TimeAssertion } from "@amp/contracts/time-assertion";

export type ReportKind = "daily" | "weekly" | "monthly";
export function periodDates(kind: ReportKind, key: string) {
  if (kind === "daily" && isValidDate(key)) return { start: addDays(key, -1), end: key };
  if (kind === "weekly") {
    const range = isoWeekRange(key);
    if (range) return range;
  }
  if (kind === "monthly" && /^\d{4}-(0[1-9]|1[0-2])$/.test(key)) {
    const start = `${key}-01`;
    const next = new Date(`${start}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    return { start, end: addDays(next.toISOString().slice(0, 10), -1) };
  }
  throw new Error("Invalid report period");
}
export function periodWindow(kind: ReportKind, key: string) {
  const dates = periodDates(kind, key);
  return {
    ...dates,
    from: new Date(`${dates.start}T${kind === "daily" ? "08" : "00"}:00:00+08:00`),
    until: new Date(`${kind === "daily" ? dates.end : addDays(dates.end, 1)}T${kind === "daily" ? "08" : "00"}:00:00+08:00`),
  };
}
/** A source with no clock retains its stated calendar date; no timezone is invented. */
export function sourceCalendarDate(value: unknown) {
  const parsed = TimeAssertion.safeParse(value);
  if (!parsed.success || !["published", "registered", "formally_published"].includes(parsed.data.meaning)) return null;
  const time = parsed.data;
  return time.utc ? beijingDate(time.utc) : time.precision === "date" ? time.local_date : null;
}
/** Daily D can contain both D-1 and D; both natural periods need checking at a boundary. */
export function dependentPeriods(day: string) {
  return [
    ...new Map(
      [addDays(day, -1), day]
        .flatMap((date) => [
          { kind: "weekly" as const, key: isoWeekLabel(date) },
          { kind: "monthly" as const, key: date.slice(0, 7) },
        ])
        .map((period) => [`${period.kind}:${period.key}`, period]),
    ).values(),
  ];
}

export function periodDueAt(kind: ReportKind, key: string) {
  const range = periodWindow(kind, key);
  if (kind === "daily") return range.until;
  return new Date(`${addDays(range.end, 1)}T${EDITION_TIMES[kind]}:00+08:00`);
}
