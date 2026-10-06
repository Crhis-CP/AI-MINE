/** A time followed by its zone: "10:00Z", "10:00:00+08:00", "10:00:00 +0000", "10:00:00 GMT". */
const EXPLICIT_ZONE = /\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)\b/i;

function atOffset(
  y: string | number,
  mo: string | number,
  d: string | number,
  h: string | number,
  mi: string | number,
  s: string | number,
  utcOffset: string,
): Date | null {
  const p = (n: string | number) => String(n).padStart(2, "0");
  const t = Date.parse(`${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(s)}${utcOffset}`);
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * A published date as a list page or article prints it. Date.parse is kept only where it reads the same
 * on every host: a time with its zone, and an ISO date alone (UTC midnight). Anything else it would read
 * in the server's local zone (UTC in Docker), so "2026-09-26 10:00" is read in the source's offset instead.
 */
export function parseLooseDate(value: string | null | undefined, utcOffset = "+08:00"): Date | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  if (EXPLICIT_ZONE.test(v) || /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const direct = Date.parse(v);
    if (Number.isFinite(direct) && /\d{4}/.test(v)) return new Date(direct);
  }
  // 2026-09-26 / 2026/09/26 / 2026-09-26T10:00 / 2026年9月26日 (+ optional time), interpreted in the given offset.
  const m = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:(?:T|\s*)(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(v);
  if (m) {
    const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
    return atOffset(y!, mo!, d!, h, mi, s, utcOffset);
  }
  // "Sep 26, 2026": Date.parse reads it in the host's zone, so take its fields and place them in the offset.
  const en = Date.parse(v.replace(/(\d)(st|nd|rd|th)/, "$1"));
  if (!Number.isFinite(en)) return null;
  const local = new Date(en);
  return atOffset(local.getFullYear(), local.getMonth() + 1, local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds(), utcOffset);
}

/** The calendar day of an instant in an offset such as "+08:00"; null for an offset it cannot read. */
function dayInOffset(at: Date, utcOffset: string): string | null {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(utcOffset);
  if (!m) return null;
  const minutes = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  return new Date(at.getTime() + minutes * 60_000).toISOString().slice(0, 10);
}

/**
 * The published time kept for a parsed source date, read as the upstream reads it (Owner 2026-10-05:
 * where the handoff's way differs from the upstream's, the upstream's): the instant when the source gives
 * one; otherwise the text as printed, by parseLooseDate in the source's offset. One difference: a date
 * alone is the start of that day in the source's offset whatever its spelling (the upstream reads an ISO
 * date alone as UTC midnight, Beijing 08:00), so pages can tell it from a real time and show the date
 * only (Owner 2026-10-05: 只显示日期).
 */
export function sourcePublishedAt(
  time: { raw: string; utc: string | null; local_date?: string | null; local_time?: string | null } | null | undefined,
  utcOffset = "+08:00",
): Date | null {
  if (!time) return null;
  if (time.utc) return new Date(time.utc);
  const day = time.local_date && /^\d{4}-\d{2}-\d{2}$/.test(time.local_date) ? time.local_date : null;
  // A time of day the date evidence could not place in a zone, so it kept the date alone: read in the
  // source's offset, as the upstream reads it, as long as it still falls on that day.
  if (/\d{1,2}:\d{2}/.test(time.raw)) {
    const read = parseLooseDate(time.raw, utcOffset);
    if (read && (!day || dayInOffset(read, utcOffset) === day)) return read;
  }
  if (day) {
    const start = Date.parse(`${day}T00:00:00${utcOffset}`);
    if (Number.isFinite(start)) return new Date(start);
  }
  return parseLooseDate(time.raw, utcOffset);
}
