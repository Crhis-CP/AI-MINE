import { z } from "zod";
import { beijingDate, beijingTime, isValidDate } from "./time.ts";

export const TIME_MEANINGS = {
  published: "来源发布",
  updated: "来源更新",
  registered: "来源登记",
  public_inspection: "公开阅览",
  formally_published: "正式刊发",
  signed: "签署",
  effective: "生效",
  applicable: "适用",
  deadline: "截止",
  compiled: "汇编",
  expires: "到期",
  event: "事件发生",
  discovered: "本站发现",
  site_public: "本站收录",
  uploaded: "上传",
  checked: "原文核对",
  repealed: "废止",
} as const;
const CalendarDate = z.string().refine(isValidDate, "Invalid calendar date");
const Nonblank = z.string().refine((value) => value.trim().length > 0, "Evidence text is required");
const UtcInstant = z.iso.datetime().refine((value) => Number.isFinite(Date.parse(value)), "Invalid UTC instant");
const LocalTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/);
const fraction = (value: string) => (value.split(".")[1] ?? "").replace(/Z$/, "").replace(/0+$/, "");
const IanaTimezone = z.string().refine((value) => {
  if (!/^(?:UTC|[A-Za-z_+-]+\/[A-Za-z0-9_+/-]+)$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Invalid IANA timezone");

/** Parsed source components; acquisition must preserve raw text and establish the parsing basis. */
export const SourceTimeParts = z.strictObject({
  meaning: z.enum(Object.keys(TIME_MEANINGS) as [keyof typeof TIME_MEANINGS, ...Array<keyof typeof TIME_MEANINGS>]),
  raw: z.string().max(300),
  local_date: CalendarDate.nullable(),
  local_time: LocalTime.nullable(),
  timezone: IanaTimezone.nullable(),
  utc: UtcInstant.nullable(),
  precision: z.enum(["unknown", "date", "minute", "second"]).default("date"),
  basis: Nonblank.max(500),
  condition_text: z.string().max(2000).nullable(),
});

/** Unregistered DTO: no HTTP route or current publication consumer uses it yet. */
export const TimeAssertion = SourceTimeParts.extend({
  meaning_label: z.string(),
  label: z.string(),
  beijing_date: CalendarDate.nullable(),
}).superRefine((time, ctx) => {
  const reject = () => ctx.addIssue({ code: "custom", message: "Inconsistent time precision or calendar projection" });
  if ((time.utc && !UtcInstant.safeParse(time.utc).success) || (time.timezone && !IanaTimezone.safeParse(time.timezone).success)) return reject();
  if (time.meaning_label !== TIME_MEANINGS[time.meaning]) reject();
  if (time.condition_text && time.utc) reject();
  if (time.precision === "unknown") {
    if ([time.local_date, time.local_time, time.utc, time.beijing_date].some((value) => value !== null)) reject();
  } else if (time.precision === "date") {
    if (!time.local_date || time.local_time !== null || time.utc !== null || time.beijing_date !== time.local_date) reject();
  } else {
    if (!time.local_date || !time.local_time || !time.utc) return reject();
    if (time.beijing_date !== beijingDate(time.utc)) reject();
    if (time.precision === "minute" && (time.local_time.length !== 5 || Date.parse(time.utc) % 60_000 !== 0 || fraction(time.utc))) reject();
    if (time.precision === "second" && time.local_time.length < 8) reject();
    if (time.precision === "second" && fraction(time.local_time) !== fraction(time.utc)) reject();
    if (time.timezone) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: time.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(time.utc));
      const at = (kind: string) => parts.find((part) => part.type === kind)!.value;
      const date = `${at("year")}-${at("month")}-${at("day")}`,
        clock = `${at("hour")}:${at("minute")}:${at("second")}`;
      if (time.local_date !== date || time.local_time.slice(0, 8) !== clock.slice(0, time.precision === "minute" ? 5 : 8)) reject();
    }
  }
});
export type TimeAssertion = z.infer<typeof TimeAssertion>;
export type SourceTimeParts = z.infer<typeof SourceTimeParts>;

export const SourceDateBinding = z.strictObject({
  articleId: Nonblank,
  sourceId: Nonblank,
  revision: z.number().int().positive(),
  configHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SourceDateBinding = z.infer<typeof SourceDateBinding>;
export const SourceDateEvidence = z
  .strictObject({
    binding: SourceDateBinding,
    observationId: Nonblank,
    observedAt: UtcInstant,
    url: z.url({ protocol: /^https?$/ }),
    locator: Nonblank,
    excerpt: Nonblank,
    origin: z.enum(["source", "http_header", "system"]),
    interpretation: z.enum(["parsed", "missing", "invalid", "ambiguous", "conflict"]),
    format: z.enum(["iso8601", "rfc2822", "epoch_seconds", "epoch_milliseconds", "declared", "unknown"]),
    formatPattern: Nonblank.nullable(),
    language: z.string().nullable(),
    publicationBasis: z.enum(["source_published", "official_registered", "formally_published", "other"]),
    instantBasis: z.enum(["explicit", "verified_timezone"]).nullable(),
    timezoneEvidence: Nonblank.nullable(),
    time: TimeAssertion,
  })
  .superRefine((value, ctx) => {
    if (
      value.interpretation === "parsed" &&
      (!value.time.raw.trim() || !value.excerpt.includes(value.time.raw) || (value.format === "declared" && (!value.formatPattern || !value.language?.trim())))
    )
      ctx.addIssue({ code: "custom", message: "Parsed source date lacks its original fragment or declared format/language" });
    if (
      (value.time.timezone && !value.timezoneEvidence) ||
      (value.time.utc && !value.instantBasis) ||
      (value.instantBasis === "verified_timezone" && !value.time.timezone)
    )
      ctx.addIssue({ code: "custom", message: "Source timezone or absolute instant has no verified basis" });
  });
export type SourceDateEvidence = z.infer<typeof SourceDateEvidence>;

/** This does not parse raw strings or infer a timezone. Only verified acquisition output may be supplied. */
export function normalizeSourceTime(
  input: Omit<SourceTimeParts, "precision"> & { precision?: SourceTimeParts["precision"] },
  basis: Pick<SourceDateEvidence, "instantBasis" | "timezoneEvidence">,
): TimeAssertion {
  const time = SourceTimeParts.parse(input);
  if (!basis.timezoneEvidence) time.timezone = null;
  if (time.precision === "unknown") time.local_date = time.local_time = time.utc = null;
  const hasInstant = time.utc !== null && (basis.instantBasis === "explicit" || (basis.instantBasis === "verified_timezone" && time.timezone !== null));
  const reduced = (time.precision === "minute" || time.precision === "second") && !hasInstant;
  if (reduced) time.precision = time.local_date ? "date" : "unknown";
  if (time.precision === "date" || time.precision === "unknown") time.local_time = time.utc = null;
  const day = time.utc ? beijingDate(time.utc) : time.local_date;
  const value = time.utc ? `${day} ${beijingTime(time.utc)}` : day;
  return TimeAssertion.parse({
    ...time,
    meaning_label: TIME_MEANINGS[time.meaning],
    beijing_date: day,
    label: value ? `${TIME_MEANINGS[time.meaning]}于 ${value}${reduced ? "（时区待核实）" : ""}` : "日期待核实",
  });
}

/** Acquisition supplies a raw field and its context, never a pre-labelled parsed assertion. */
export const SourceDateParseInput = z.strictObject(SourceDateEvidence.shape).omit({ time: true, interpretation: true, instantBasis: true }).extend({
  raw: SourceTimeParts.shape.raw,
  meaning: SourceTimeParts.shape.meaning,
  basis: SourceTimeParts.shape.basis,
  condition_text: SourceTimeParts.shape.condition_text,
  timezone: SourceTimeParts.shape.timezone,
});
export type SourceDateParseInput = z.infer<typeof SourceDateParseInput>;
export const SourceDateParseResult = z.strictObject({
  evidence: SourceDateEvidence,
  reason: z
    .enum([
      "missing",
      "unrecognized_format",
      "ambiguous_format",
      "invalid_calendar",
      "invalid_time",
      "invalid_offset",
      "weekday_conflict",
      "ambiguous_local_time",
      "nonexistent_local_time",
      "relative_without_anchor",
      "unsupported_format",
      "missing_format_language",
    ])
    .nullable(),
});
export type SourceDateParseResult = z.infer<typeof SourceDateParseResult>;

/** Intake cannot invent the material identity/revision that content assigns under its lock. */
export const SourceDateObservationInput = z.strictObject(SourceDateParseInput.shape).omit({ binding: true }).extend({
  sourceId: SourceDateBinding.shape.sourceId,
  configHash: SourceDateBinding.shape.configHash,
});
export type SourceDateObservationInput = z.infer<typeof SourceDateObservationInput>;
const EvidenceVersion = z.number().int().nonnegative();
const PermissionVersion = z.number().int().positive();

/** Omission means no date mutation. null is never an instruction to erase current evidence. */
export const MaterialSourceDateInput = z
  .strictObject({
    sourceDateObservation: SourceDateObservationInput.optional(),
    expectedSourceDateVersion: EvidenceVersion.optional(),
    permissionVersion: PermissionVersion.optional(),
  })
  .refine(
    (input) =>
      input.sourceDateObservation === undefined
        ? input.expectedSourceDateVersion === undefined && input.permissionVersion === undefined
        : input.expectedSourceDateVersion !== undefined && input.permissionVersion !== undefined,
    "Date mutations require the observed evidence and permission versions",
  );
export type MaterialSourceDateInput = z.infer<typeof MaterialSourceDateInput>;

/** Existing four fields retain their meaning; current revision/version are returned on every branch. */
export const MaterialUpdateResult = z
  .strictObject({
    articleId: SourceDateBinding.shape.articleId,
    created: z.boolean(),
    revised: z.boolean(),
    backfill: z.boolean(),
    revision: SourceDateBinding.shape.revision,
    sourceTimeChanged: z.boolean(),
    metadataChanged: z.boolean(),
    sourceDateVersion: EvidenceVersion,
    sourceDateOutcome: z.enum(["unchanged", "applied", "stale"]),
  })
  .refine(
    (result) =>
      (!result.created || (result.revision === 1 && !result.revised)) &&
      (!result.sourceTimeChanged || (result.metadataChanged && result.sourceDateOutcome === "applied")) &&
      (result.sourceDateOutcome !== "applied" || (result.sourceDateVersion > 0 && result.metadataChanged)),
    "Inconsistent material/date update result",
  );
export type MaterialUpdateResult = z.infer<typeof MaterialUpdateResult>;

/** CAS preconditions only, not a permit. Consumers must recheck live source permissions before work/write. */
export const SourceDateTask = z.strictObject({
  lane: z.literal("news"),
  articleId: SourceDateBinding.shape.articleId,
  sourceId: SourceDateBinding.shape.sourceId,
  expectedRevision: SourceDateBinding.shape.revision,
  configHash: SourceDateBinding.shape.configHash,
  permissionVersion: PermissionVersion,
  expectedSourceDateVersion: EvidenceVersion,
  observationId: Nonblank.optional(),
});
export type SourceDateTask = z.infer<typeof SourceDateTask>;
