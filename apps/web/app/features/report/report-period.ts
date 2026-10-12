import { addDays, addCalendarMonths, beijingDate, isoWeekLabel } from "@amp/contracts/time";
import type { ReportKind } from "@amp/contracts/site";

/** Latest issue due under the approved Beijing schedule, including the hours before a boundary. */
export function expectedReportKey(kind: ReportKind, now = new Date()): string {
  const date = beijingDate(now);
  const local = new Date(now.getTime() + 8 * 3600_000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (kind === "daily") return minute >= 8 * 60 ? date : addDays(date, -1);
  if (kind === "weekly") {
    const weekday = (local.getUTCDay() + 6) % 7;
    return isoWeekLabel(addDays(date, -weekday - (weekday === 0 && minute < 10 * 60 ? 14 : 7)));
  }
  return addCalendarMonths(`${date.slice(0, 7)}-01`, local.getUTCDate() === 1 && minute < 10 * 60 + 30 ? -2 : -1).slice(0, 7);
}
