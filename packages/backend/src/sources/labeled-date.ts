// A publication date the page itself labels as such. A date that only appears in the body
// (an effective date, a quote, a signed date) is not a publication date and is left unread.
import { sourcePublishedAt } from "./published-at.ts";

export interface LabeledPublicationDate {
  raw: string;
  /** YYYY-MM-DD as printed. */
  localDate: string;
  hasTime: boolean;
}

const LABELS = "发布日期|发布时间|发表时间|刊发时间|公布日期";
const DATE = "(\\d{4})\\s*[-/.年]\\s*(\\d{1,2})\\s*[-/.月]\\s*(\\d{1,2})\\s*日?(?:\\s*(\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?";

function realDay(year: number, month: number, day: number): boolean {
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function fromParts(year: string, month: string, day: string, hour?: string, minute?: string, second?: string): LabeledPublicationDate | null {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!realDay(y, m, d)) return null;
  const localDate = `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const hasTime = hour !== undefined && minute !== undefined;
  if (!hasTime) return { raw: localDate, localDate, hasTime: false };
  const hh = String(Number(hour)).padStart(2, "0");
  const mm = String(Number(minute)).padStart(2, "0");
  const ss = second !== undefined ? `:${String(Number(second)).padStart(2, "0")}` : "";
  return { raw: `${localDate} ${hh}:${mm}${ss}`, localDate, hasTime: true };
}

/** Visible “发布日期：…” (and the same family of labels). The first label wins; body dates do not. */
export function readLabeledPublicationDate(html: string, options: { metadata?: boolean } = {}): LabeledPublicationDate | null {
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  const labeled = new RegExp(`(?:${LABELS})\\s*[：:]\\s*${DATE}`).exec(visible);
  if (labeled) {
    const parsed = fromParts(labeled[1]!, labeled[2]!, labeled[3]!, labeled[4], labeled[5], labeled[6]);
    if (parsed) return parsed;
  }
  return options.metadata === false ? null : readMetaPublicationDate(html);
}

function readMetaPublicationDate(html: string): LabeledPublicationDate | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = /(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!["pubdate", "article:published_time", "datepublished"].includes(name)) continue;
    const content = /content\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? "";
    const parts = new RegExp(DATE).exec(content);
    if (!parts) continue;
    const parsed = fromParts(parts[1]!, parts[2]!, parts[3]!, parts[4], parts[5], parts[6]);
    if (parsed) return parsed;
  }
  return null;
}

/** The instant to store: a labeled clock in the source offset, or the start of that day when no clock was printed. */
export function labeledPublicationInstant(html: string, utcOffset = "+08:00"): Date | null {
  const labeled = readLabeledPublicationDate(html);
  if (!labeled) return null;
  return sourcePublishedAt({ raw: labeled.raw, utc: null, local_date: labeled.localDate }, utcOffset);
}
