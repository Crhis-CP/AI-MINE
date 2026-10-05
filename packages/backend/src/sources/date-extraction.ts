import { ZodError } from "zod";
import { isValidDate } from "@amp/contracts/time";
import {
  SourceDateParseInput,
  SourceDateParseResult,
  SourceDateObservationInput,
  type SourceDateCandidate,
  SourceTimeParts,
  normalizeSourceTime,
} from "@amp/contracts/time-assertion";
import { sourceDateConfigHash, sourceDateProfile } from "./config-keys.ts";
import type { SourceRow } from "./types.ts";
import { newUuid } from "../lib/ids.ts";

/** Unbound source bytes: content assigns the real article/revision under its own transaction. */
export function observeSourceDate(
  source: SourceRow,
  url: string,
  raw: string,
  locator: string,
  options: { detail?: boolean; observedAt?: string; format?: SourceDateObservationInput["format"]; formatPattern?: string; language?: string } = {},
): SourceDateObservationInput {
  const profile = sourceDateProfile(source.config, options.detail);
  return SourceDateObservationInput.parse({
    ...profile,
    format: options.format ?? profile.format,
    formatPattern: options.formatPattern ?? profile.formatPattern,
    language: options.language ?? profile.language,
    basis: profile.basis ?? `Source field: ${locator}`,
    sourceId: source.id,
    configHash: sourceDateConfigHash(source.kind, source.config),
    observationId: newUuid(),
    observedAt: options.observedAt ?? new Date().toISOString(),
    url,
    raw,
    locator,
    excerpt: raw.trim() ? raw : `Missing source date at ${locator}`,
    origin: "source",
    condition_text: null,
  });
}

export function toDateCandidate(observation: SourceDateObservationInput): SourceDateCandidate {
  const { sourceId: _source, configHash: _config, observationId: _id, observedAt: _at, url: _url, alternatives: _alternatives, ...candidate } = observation;
  return candidate;
}

type Reason = NonNullable<SourceDateParseResult["reason"]>;
type Fields = { day: string; clock: string | null; offset?: string; weekday?: string };
class InvalidDate extends Error {
  readonly reason: Reason;
  constructor(reason: Reason) {
    super(reason);
    this.reason = reason;
  }
}
function reject(reason: Reason): never {
  throw new InvalidDate(reason);
}
const ISO = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/i;
const RFC =
  /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}:\d{2}(?::\d{2})?)(?:\s+(UT|UTC|GMT|[A-Z]{1,5}|[+-]\d{4}))?$/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DECLARED: Record<string, [string, "ymd" | "dmy" | "mdy"]> = {
  "YYYY-MM-DD": ["(\\d{4})-(\\d{2})-(\\d{2})", "ymd"],
  "YYYY/MM/DD": ["(\\d{4})/(\\d{2})/(\\d{2})", "ymd"],
  "YYYY.MM.DD": ["(\\d{4})\\.(\\d{2})\\.(\\d{2})", "ymd"],
  YYYYMMDD: ["(\\d{4})(\\d{2})(\\d{2})", "ymd"],
  YYYY年M月D日: ["(\\d{4})年(\\d{1,2})月(\\d{1,2})日", "ymd"],
  "DD/MM/YYYY": ["(\\d{2})/(\\d{2})/(\\d{4})", "dmy"],
  "MM/DD/YYYY": ["(\\d{2})/(\\d{2})/(\\d{4})", "mdy"],
};
const dayOf = (year: string, month: string, day: string) => `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
const fraction = (clock: string) => clock.split(".")[1] ?? "";
function at(wholeSecond: number, subsecond: string): string {
  if (!Number.isFinite(wholeSecond) || !Number.isFinite(new Date(wholeSecond).getTime())) reject("invalid_calendar");
  return `${new Date(wholeSecond).toISOString().slice(0, 19)}${subsecond ? `.${subsecond}` : ""}Z`;
}
function explicitInstant(day: string, clock: string, offset: string): string {
  const seconds = clock.length === 5 ? `${clock}:00` : clock.split(".")[0];
  let shift = 0;
  if (!["Z", "UT", "UTC", "GMT"].includes(offset.toUpperCase())) {
    const match = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
    if (!match || Number(match[2]) > 23 || Number(match[3]) > 59) reject("invalid_offset");
    shift = (Number(match[2]) * 60 + Number(match[3])) * 60_000 * (match[1] === "+" ? 1 : -1);
  }
  return at(Date.parse(`${day}T${seconds}Z`) - shift, fraction(clock));
}
function zoneWall(instant: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}
/** Verify local-time candidates against IANA; neither DST folds nor gaps are guessed. */
function zonedInstant(day: string, clock: string, timezone: string): string {
  const wall = `${day}T${clock.length === 5 ? `${clock}:00` : clock.split(".")[0]}`,
    naive = Date.parse(`${wall}Z`);
  const offsets = new Set(
    [-36, -24, -12, 0, 12, 24, 36]
      .map((hour) => {
        const sample = naive + hour * 3_600_000;
        return Date.parse(`${zoneWall(sample, timezone)}Z`) - sample;
      })
      .filter(Number.isFinite),
  );
  const matches = [...offsets].map((offset) => naive - offset).filter((instant) => zoneWall(instant, timezone) === wall);
  if (matches.length !== 1) reject(matches.length ? "ambiguous_local_time" : "nonexistent_local_time");
  return at(matches[0], fraction(clock));
}
function epoch(raw: string, milliseconds: boolean): string {
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) reject("unrecognized_format");
  const digits = raw.split(".")[1]?.length ?? 0,
    divisor = 10n ** BigInt(digits);
  const numerator = BigInt(raw.replace(".", "")) * (milliseconds ? 1n : 1000n);
  let whole = numerator / divisor,
    rest = numerator % divisor;
  if (rest < 0n) {
    whole--;
    rest += divisor;
  }
  const date = new Date(Number(whole));
  if (!Number.isFinite(date.getTime())) reject("invalid_calendar");
  return date.toISOString().replace("Z", `${rest ? rest.toString().padStart(digits, "0") : ""}Z`);
}
function declared(raw: string, pattern: string | null, language: string | null): Fields {
  if (!pattern || !language?.trim()) reject("missing_format_language");
  const time = / (HH:mm(?::ss)?)$/.exec(pattern),
    format = time ? pattern.slice(0, -time[0].length) : pattern;
  const entry = Object.hasOwn(DECLARED, format) ? DECLARED[format] : undefined;
  if (!entry) reject("unsupported_format");
  const suffix = time ? (time[1] === "HH:mm" ? " (\\d{2}:\\d{2})" : " (\\d{2}:\\d{2}:\\d{2})") : "";
  const match = new RegExp(`^${entry[0]}${suffix}$`).exec(raw);
  if (!match) reject("unrecognized_format");
  const [, a, b, c, clock] = match;
  return { day: entry[1] === "ymd" ? dayOf(a, b, c) : entry[1] === "dmy" ? dayOf(c, b, a) : dayOf(c, a, b), clock: clock ?? null };
}

type UnboundInput = Omit<SourceDateParseInput, "binding">;
type UnboundResult = { reason: SourceDateParseResult["reason"]; evidence: Omit<SourceDateParseResult["evidence"], "binding"> };

/** The same lexical parser serves intake windows and the later real material binding. */
function parseRawDate(source: UnboundInput, validate: (value: UnboundResult) => UnboundResult): UnboundResult {
  const { raw, meaning, basis, condition_text, timezone, ...context } = source;
  const unknown = (reason: Reason): UnboundResult =>
    validate({
      reason,
      evidence: {
        ...context,
        instantBasis: null,
        interpretation: reason === "missing" ? "missing" : reason.includes("ambiguous") ? "ambiguous" : reason === "weekday_conflict" ? "conflict" : "invalid",
        time: normalizeSourceTime(
          { raw, meaning, basis, condition_text, local_date: null, local_time: null, utc: null, timezone: null, precision: "unknown" },
          { instantBasis: null, timezoneEvidence: null },
        ),
      },
    });
  try {
    const value = raw.trim();
    if (!value) return unknown("missing");
    if (/(?:\bago\b|\byesterday\b|\bhace\b|昨天|前天|\d+\s*(?:分钟|小时|天)前)/i.test(value)) return unknown("relative_without_anchor");
    const iso = ISO.exec(value),
      rfc = RFC.exec(value);
    if (context.format === "unknown")
      context.format = iso ? "iso8601" : rfc ? "rfc2822" : reject(/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value) ? "ambiguous_format" : "unrecognized_format");
    let fields: Fields,
      utc: string | null = null,
      zone: string | null = null;
    let instantBasis: SourceDateParseResult["evidence"]["instantBasis"] = null;
    if (context.format === "epoch_seconds" || context.format === "epoch_milliseconds") {
      utc = epoch(value, context.format === "epoch_milliseconds");
      fields = { day: utc.slice(0, 10), clock: utc.slice(11, -1) };
      instantBasis = "explicit";
    } else if (context.format === "declared") fields = declared(value, context.formatPattern, context.language);
    else if (context.format === "iso8601") {
      if (!iso) reject("unrecognized_format");
      fields = { day: iso[1], clock: iso[2] ?? null, offset: iso[3] };
    } else {
      if (!rfc) reject("unrecognized_format");
      context.language = "en";
      fields = { day: dayOf(rfc[4], String(MONTHS.indexOf(rfc[3].toLowerCase()) + 1), rfc[2]), clock: rfc[5], weekday: rfc[1], offset: rfc[6] };
      if (fields.offset && !/^(?:Z|UT|UTC|GMT|[+-]\d{4})$/i.test(fields.offset)) fields.offset = undefined;
    }
    if (!isValidDate(fields.day)) reject("invalid_calendar");
    if (fields.weekday && DAYS[new Date(`${fields.day}T00:00:00Z`).getUTCDay()] !== fields.weekday.toLowerCase()) reject("weekday_conflict");
    if (fields.clock && !SourceTimeParts.shape.local_time.safeParse(fields.clock).success) reject("invalid_time");
    if (fields.clock && !utc && fields.offset) {
      utc = explicitInstant(fields.day, fields.clock, fields.offset);
      instantBasis = "explicit";
    } else if (fields.clock && !utc && timezone && source.timezoneEvidence) {
      utc = zonedInstant(fields.day, fields.clock, timezone);
      zone = timezone;
      instantBasis = "verified_timezone";
    }
    if (condition_text) {
      utc = null;
      fields.clock = null;
      instantBasis = null;
    }
    const time = normalizeSourceTime(
      {
        raw,
        meaning,
        basis,
        condition_text,
        local_date: fields.day,
        local_time: fields.clock,
        utc,
        timezone: zone,
        precision: fields.clock ? (fields.clock.length === 5 ? "minute" : "second") : "date",
      },
      { instantBasis, timezoneEvidence: source.timezoneEvidence },
    );
    return validate({ reason: null, evidence: { ...context, instantBasis, interpretation: "parsed", time } });
  } catch (error) {
    if (error instanceof InvalidDate) return unknown(error.reason);
    if (error instanceof ZodError) return unknown("invalid_time");
    throw error;
  }
}

/** A display/window hint only, never material identity or publication admission. */
export function previewSourceDate(observation: SourceDateObservationInput) {
  const { sourceId: _source, configHash: _config, alternatives, ...input } = SourceDateObservationInput.parse(observation);
  if (
    alternatives?.length ||
    input.origin !== "source" ||
    input.meaning !== "published" ||
    input.publicationBasis !== "source_published" ||
    input.condition_text
  )
    return null;
  const parsed = parseRawDate(input, (value) => {
    if (value.evidence.interpretation === "parsed" && !value.evidence.excerpt.includes(value.evidence.time.raw)) reject("invalid_time");
    return value;
  });
  return parsed.reason ? null : parsed.evidence.time;
}

/** Only content supplies the actual article/revision; lexical parsing never invents a binding. */
export function parseSourceDate(input: SourceDateParseInput): SourceDateParseResult {
  const { binding, ...source } = SourceDateParseInput.parse(input);
  const parsed = parseRawDate(source, (value) => {
    const bound = SourceDateParseResult.parse({ reason: value.reason, evidence: { ...value.evidence, binding } });
    const { binding: _binding, ...evidence } = bound.evidence;
    return { reason: bound.reason, evidence };
  });
  return { reason: parsed.reason, evidence: { ...parsed.evidence, binding } };
}
