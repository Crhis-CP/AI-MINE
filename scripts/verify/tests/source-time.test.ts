import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceDateVerdict } from "../../../packages/backend/src/content/source-time.ts";
import { type SourceDateEvidence, type SourceTimeParts, TimeAssertion, normalizeSourceTime } from "@amp/contracts/time-assertion";
import type { SourceDateParseInput } from "@amp/contracts/time-assertion";
import { SourceDateObservationInput, MaterialSourceDateInput, MaterialUpdateResult, SourceDateTask } from "@amp/contracts/time-assertion";
import { parseSourceDate } from "../../../packages/backend/src/sources/date-extraction.ts";

const binding = { articleId: "article-fixture", sourceId: "source-fixture", revision: 1, configHash: "a".repeat(64) };
const now = Date.parse("2026-10-04T09:00:00.000Z");
const noZone = { instantBasis: null, timezoneEvidence: null } as const;
function parts(change: Partial<SourceTimeParts> = {}): SourceTimeParts {
  return {
    meaning: "published",
    raw: "2026-10-04",
    local_date: "2026-10-04",
    local_time: null,
    timezone: null,
    utc: null,
    precision: "date",
    basis: "列表发布日期栏",
    condition_text: null,
    ...change,
  };
}
function evidence(change: Partial<SourceDateEvidence> = {}): SourceDateEvidence {
  return {
    binding,
    observationId: "fetch-fixture",
    observedAt: "2026-10-04T09:00:00.000Z",
    url: "https://source.invalid/item",
    locator: "time[datetime]",
    excerpt: "发布日期：2026-10-04",
    origin: "source",
    interpretation: "parsed",
    format: "iso8601",
    formatPattern: null,
    language: null,
    publicationBasis: "source_published",
    ...noZone,
    time: normalizeSourceTime(parts(), noZone),
    ...change,
  };
}
function instant(at: string, change: Partial<SourceDateEvidence> = {}) {
  const time = normalizeSourceTime(parts({ raw: at, local_date: at.slice(0, 10), local_time: at.slice(11, -1), utc: at, precision: "second" }), {
    ...noZone,
    instantBasis: "explicit",
  });
  return evidence({ time, excerpt: `Published: ${at}`, instantBasis: "explicit", ...change });
}
const verdict = (value: unknown, clock = now) => sourceDateVerdict("news", value, binding, clock);

test("calendar date is literal; missing precision never manufactures an instant", () => {
  const input = parts();
  const { precision: _precision, ...withoutPrecision } = input;
  const time = normalizeSourceTime(withoutPrecision, noZone);
  assert.equal(time.precision, "date");
  assert.equal(time.local_time, null);
  assert.equal(time.utc, null);
  assert.equal(time.beijing_date, "2026-10-04");
  assert.equal(verdict(evidence({ time })).status, "reliable");
  assert(!TimeAssertion.safeParse({ ...time, utc: "2026-10-04T00:00:00Z" }).success);
  assert(!TimeAssertion.safeParse({ ...time, local_time: "00:00" }).success);
  for (const day of ["2026-02-29", "2026-04-31", "2026-13-01", "03/04/2026"]) assert.throws(() => normalizeSourceTime(parts({ local_date: day }), noZone));
  assert.equal(normalizeSourceTime(parts({ local_date: "2024-02-29" }), noZone).local_date, "2024-02-29");
});

test("unverified local timezone reduces precision, while explicit absolute time retains UTC without inventing IANA", () => {
  const input = parts({ raw: "2026-10-04 01:00", local_time: "01:00", timezone: "Asia/Shanghai", precision: "minute", utc: "2026-10-03T17:00:00Z" });
  const reduced = normalizeSourceTime(input, noZone);
  assert.equal(reduced.timezone, null);
  assert.equal(reduced.precision, "date");
  assert.equal(reduced.utc, null);
  assert.equal(reduced.local_time, null);
  assert.equal(reduced.raw, input.raw);
  assert.match(reduced.label, /时区待核实/);
  assert.equal(verdict(evidence({ time: reduced, excerpt: input.raw })).status, "reliable");
  const absolute = instant("2026-10-03T23:00:00.000Z");
  assert.equal(absolute.time.timezone, null);
  assert.equal(absolute.time.beijing_date, "2026-10-04");
  assert.equal(verdict(absolute).status, "reliable");
  const offset = normalizeSourceTime(parts({ raw: "2026-10-04T00:30+14:00", local_time: "00:30", utc: "2026-10-03T10:30:00Z", precision: "minute" }), {
    ...noZone,
    instantBasis: "explicit",
  });
  assert.equal(offset.local_date, "2026-10-04");
  assert.equal(offset.beijing_date, "2026-10-03");
  assert.equal(offset.timezone, null);
  const verified = normalizeSourceTime(input, { instantBasis: "verified_timezone", timezoneEvidence: "来源明确声明UTC+8并经核实" });
  assert.equal(verified.precision, "minute");
  assert.equal(verified.timezone, "Asia/Shanghai");
  assert.throws(() => normalizeSourceTime({ ...input, utc: "2026-10-03T18:00:00Z" }, { instantBasis: "verified_timezone", timezoneEvidence: "known" }));
  assert.throws(() => normalizeSourceTime({ ...input, timezone: "+08:00" }, noZone));
  assert.throws(() => normalizeSourceTime({ ...input, timezone: "Asia/Not_A_Zone" }, noZone));
});

test("absolute timestamps allow exactly five minutes, including original sub-millisecond precision", () => {
  for (const [delta, expected] of [
    [299_999, "reliable"],
    [300_000, "reliable"],
    [300_001, "pending"],
  ] as const) {
    const result = verdict(instant(new Date(now + delta).toISOString()));
    assert.equal(result.status, expected);
    if (result.status === "pending") assert.equal(result.reason, "future");
  }
  assert.equal(verdict(instant("2026-10-04T09:05:00.000001Z")).status, "pending");
  assert.equal(verdict(instant("2026-10-04T09:05:00.000000Z")).status, "reliable");
  assert.equal(verdict(instant("2026-10-04T09:04:59.999999Z")).status, "reliable");
  const valid = instant("2026-10-04T09:00:00.001Z");
  for (const change of [{ utc: "invalid" }, { timezone: "invalid/zone" }, { local_time: "09:00:00.002" }])
    assert.equal(verdict({ ...valid, time: { ...valid.time, ...change } }).status, "pending");
  assert.throws(() => verdict(evidence(), Number.NaN));
});

test("date-only future bound follows the UTC+14 day and never shifts its displayed calendar day", () => {
  const atBoundary = Date.parse("2026-10-04T10:00:00Z");
  const time = normalizeSourceTime(parts({ raw: "2026-10-05", local_date: "2026-10-05" }), noZone);
  const nextDay = evidence({ time, excerpt: time.raw });
  assert.deepEqual(verdict(nextDay, atBoundary - 1), { status: "pending", reason: "future" });
  assert.equal(verdict(nextDay, atBoundary).status, "reliable");
  assert.equal(verdict(nextDay, atBoundary + 1).status, "reliable");
  assert.equal(time.beijing_date, "2026-10-05");
  assert.equal(time.utc, null);
});

test("system, update, signing and effective dates cannot replace a news publication basis", () => {
  for (const meaning of ["updated", "signed", "effective", "discovered", "site_public", "checked", "event"] as const)
    assert.deepEqual(verdict(evidence({ time: normalizeSourceTime(parts({ meaning }), noZone) })), { status: "pending", reason: "not_source_publication" });
  for (const origin of ["system", "http_header"] as const)
    assert.deepEqual(verdict(evidence({ origin })), { status: "pending", reason: "not_source_publication" });
  for (const [meaning, publicationBasis] of [
    ["registered", "official_registered"],
    ["formally_published", "formally_published"],
  ] as const) {
    const time = normalizeSourceTime(parts({ meaning }), noZone);
    assert.equal(verdict(evidence({ time })).status, "pending");
    assert.equal(verdict(evidence({ time, publicationBasis })).status, "reliable");
  }
  assert.equal(verdict(evidence({ time: normalizeSourceTime(parts({ condition_text: "待批准后" }), noZone) })).status, "pending");
});

test("unparsed, ambiguous, invalid and conflicting source evidence returns pending without borrowing observation time", () => {
  assert.deepEqual(verdict(null), { status: "pending", reason: "missing" });
  for (const interpretation of ["missing", "ambiguous", "invalid", "conflict"] as const)
    assert.deepEqual(verdict(evidence({ interpretation })), { status: "pending", reason: "unresolved" });
  assert.equal(verdict(evidence({ format: "unknown" })).status, "pending");
  assert.equal(verdict(evidence({ format: "declared", formatPattern: "DD/MM/YYYY", language: null })).status, "pending");
  assert.equal(
    verdict(evidence({ time: normalizeSourceTime(parts({ precision: "unknown", raw: "03/04/2026" }), noZone), excerpt: "03/04/2026" })).status,
    "pending",
  );
  assert.equal(verdict(evidence({ excerpt: "unrelated fragment" })).status, "pending");
  assert.equal(verdict(evidence({ time: { ...evidence().time, raw: "" } })).status, "pending");
});

test("source evidence is bound to current article/source/revision/config and retains a readable locator and raw fragment", () => {
  for (const changed of [{ articleId: "other" }, { sourceId: "other" }, { revision: 2 }, { configHash: "b".repeat(64) }])
    assert.deepEqual(verdict(evidence({ binding: { ...binding, ...changed } })), { status: "pending", reason: "stale" });
  for (const changed of [{ locator: " " }, { observationId: "" }, { observedAt: "invalid" }, { url: "file:///tmp/date" }])
    assert.equal(verdict(evidence(changed)).status, "pending");
  const time = normalizeSourceTime(parts({ precision: "minute", local_time: "17:00", utc: "2026-10-04T09:00:00Z", timezone: "Asia/Shanghai" }), {
    instantBasis: "verified_timezone",
    timezoneEvidence: "verified source statement",
  });
  assert.equal(verdict(evidence({ time, instantBasis: "verified_timezone" })).status, "pending");
});

test("policy dates never receive a news public-or-private decision or a derived legal status", () => {
  assert.throws(() => sourceDateVerdict(undefined as never, evidence(), binding, now), /explicit.*lane/);
  for (const input of [null, evidence(), instant("2027-01-01T00:00:00.000Z"), evidence({ interpretation: "ambiguous" })])
    assert.deepEqual(sourceDateVerdict("policy", input, binding, now), { status: "not_applicable", rule: "BR-POL-11" });
});

function request(raw: string, change: Partial<SourceDateParseInput> = {}): SourceDateParseInput {
  const { time: _time, interpretation: _interpretation, instantBasis: _instantBasis, ...context } = evidence();
  return {
    ...context,
    raw,
    meaning: "published",
    basis: "页面发布时间字段",
    condition_text: null,
    timezone: null,
    format: "unknown",
    excerpt: `原始字段：${raw}`,
    ...change,
  };
}
function unknown(raw: string, reason: string, change: Partial<SourceDateParseInput> = {}) {
  const result = parseSourceDate(request(raw, change));
  assert.equal(result.reason, reason);
  assert.equal(result.evidence.time.precision, "unknown");
  assert.equal(result.evidence.time.utc, null);
  assert.equal(result.evidence.time.local_date, null);
  assert.equal(result.evidence.time.raw, raw);
  assert.equal(verdict(result.evidence).status, "pending");
}

test("strict raw parsing closes the measured loose-parser rollover, inferred-midnight and guessed-zone shapes", () => {
  for (const raw of ["2026-10-04", "2026-10-04 10:30"]) {
    const result = parseSourceDate(request(raw));
    assert.equal(result.reason, null);
    assert.equal(result.evidence.time.precision, "date");
    assert.equal(result.evidence.time.local_date, "2026-10-04");
    assert.equal(result.evidence.time.utc, null);
    assert.equal(result.evidence.time.local_time, null);
  }
  unknown("2026-02-30", "invalid_calendar");
  unknown("2026-02-29", "invalid_calendar");
  unknown("2026-10-04T10:30+99:00", "invalid_offset");
  unknown("2026-10-04T24:00Z", "invalid_time");
  unknown("03/04/2026", "ambiguous_format");
  unknown("2026", "unrecognized_format");
  unknown("published 2026-10-04 nonsense", "unrecognized_format");
});

test("ISO absolute offsets and decimal seconds retain raw evidence and do not become an inferred IANA zone", () => {
  const raw = " 2026-10-04T00:30:12.123456+14:00 ";
  const input = request(raw, { timezone: "Asia/Shanghai", timezoneEvidence: "config for unzoned fields" });
  const result = parseSourceDate(input),
    time = result.evidence.time;
  assert.equal(result.reason, null);
  assert.equal(time.utc, "2026-10-03T10:30:12.123456Z");
  assert.equal(time.local_date, "2026-10-04");
  assert.equal(time.beijing_date, "2026-10-03");
  assert.equal(time.timezone, null);
  assert.equal(time.raw, raw);
  assert.equal(result.evidence.excerpt, input.excerpt);
  assert.equal(result.evidence.locator, input.locator);
  assert.deepEqual(result.evidence.binding, input.binding);
  assert.equal(result.evidence.observationId, input.observationId);
  assert.equal(verdict(parseSourceDate(request("2026-10-04T09:05:00.000001Z")).evidence).status, "pending");
  assert.equal(verdict(parseSourceDate(request("2026-10-04T09:05:00.000000Z")).evidence).status, "reliable");
  assert.equal(parseSourceDate(request("2026-10-04T00:30+0800")).evidence.time.utc, "2026-10-03T16:30:00Z");
  assert.equal(parseSourceDate(request("2026-10-04t00:30z")).evidence.time.utc, "2026-10-04T00:30:00Z");
});

test("RFC dates validate calendars and weekday, retain English basis and reduce unverified named zones", () => {
  const result = parseSourceDate(request("Sun, 04 Oct 2026 10:30:45 +1400"));
  assert.equal(result.reason, null);
  assert.equal(result.evidence.time.utc, "2026-10-03T20:30:45Z");
  assert.equal(result.evidence.format, "rfc2822");
  assert.equal(result.evidence.language, "en");
  assert.equal(parseSourceDate(request("04 Oct 2026 10:30 GMT")).evidence.time.utc, "2026-10-04T10:30:00Z");
  const unverified = parseSourceDate(request("04 Oct 2026 10:30 CST"));
  assert.equal(unverified.reason, null);
  assert.equal(unverified.evidence.time.precision, "date");
  assert.equal(unverified.evidence.time.utc, null);
  unknown("Mon, 04 Oct 2026 10:30 GMT", "weekday_conflict");
  unknown("31 Feb 2026 10:30 GMT", "invalid_calendar");
  unknown("04 Oct 2026 10:30 +2460", "invalid_offset");
});

test("epoch parsing requires the explicit unit and preserves positive and negative decimal precision", () => {
  const seconds = String(now / 1000),
    milliseconds = String(now);
  assert.equal(parseSourceDate(request(seconds, { format: "epoch_seconds" })).evidence.time.utc, "2026-10-04T09:00:00.000Z");
  assert.equal(parseSourceDate(request(milliseconds, { format: "epoch_milliseconds" })).evidence.time.utc, "2026-10-04T09:00:00.000Z");
  assert.match(parseSourceDate(request(`${seconds}.000001`, { format: "epoch_seconds" })).evidence.time.utc!, /09:00:00\.0000010*Z$/);
  assert.equal(parseSourceDate(request("-0.000001", { format: "epoch_seconds" })).evidence.time.utc, "1969-12-31T23:59:59.999999000Z");
  unknown(seconds, "unrecognized_format");
  for (const raw of ["NaN", "Infinity", "1e3", "0x1000"]) unknown(raw, "unrecognized_format", { format: "epoch_seconds" });
  unknown("999999999999999999999999", "invalid_calendar", { format: "epoch_milliseconds" });
});

test("declared pattern and language determine calendar order without choosing a country default", () => {
  for (const [formatPattern, expected] of [
    ["DD/MM/YYYY", "2026-04-03"],
    ["MM/DD/YYYY", "2026-03-04"],
  ]) {
    const result = parseSourceDate(request("03/04/2026", { format: "declared", formatPattern, language: "en" }));
    assert.equal(result.reason, null);
    assert.equal(result.evidence.time.local_date, expected);
    assert.equal(result.evidence.time.utc, null);
  }
  for (const [raw, formatPattern] of [
    ["2026年10月4日", "YYYY年M月D日"],
    ["20261004", "YYYYMMDD"],
    ["2026.10.04", "YYYY.MM.DD"],
  ]) {
    const result = parseSourceDate(request(raw, { format: "declared", formatPattern, language: "zh" }));
    assert.equal(result.evidence.time.local_date, "2026-10-04");
    assert.equal(result.evidence.time.utc, null);
  }
  unknown("03/04/2026", "missing_format_language", { format: "declared", formatPattern: "DD/MM/YYYY" });
  for (const formatPattern of [".*", "toString", "__proto__"])
    unknown("2026-10-04", "unsupported_format", { format: "declared", formatPattern, language: "en" });
});

test("verified IANA local conversion rejects DST gaps and folds instead of selecting one instant", () => {
  const config = { timezone: "America/New_York", timezoneEvidence: "source declares America/New_York" };
  const stable = parseSourceDate(request("2026-10-04T10:30", config));
  assert.equal(stable.reason, null);
  assert.equal(stable.evidence.time.utc, "2026-10-04T14:30:00Z");
  assert.equal(stable.evidence.time.timezone, config.timezone);
  unknown("2026-03-08T02:30", "nonexistent_local_time", config);
  unknown("2026-11-01T01:30", "ambiguous_local_time", config);
  unknown("9999-12-31T23:30", "invalid_time", { timezone: "Pacific/Honolulu", timezoneEvidence: "verified" });
  assert.equal(parseSourceDate(request("2026-11-01T01:30-04:00", config)).evidence.time.utc, "2026-11-01T05:30:00Z");
  const unverified = parseSourceDate(request("2026-10-04T10:30", { timezone: config.timezone }));
  assert.equal(unverified.evidence.time.utc, null);
  assert.equal(unverified.evidence.time.precision, "date");
});

test("relative and missing dates remain unknown regardless of observation timestamp", () => {
  unknown(" ", "missing");
  for (const raw of ["3 hours ago", "yesterday", "2小时前", "hace 2 días"]) unknown(raw, "relative_without_anchor", { observedAt: "2027-01-01T00:00:00Z" });
});

test("raw parsing preserves date meaning and origin; it does not supply a news date from updated/effective/system facts", () => {
  for (const meaning of ["updated", "effective"] as const) {
    const result = parseSourceDate(request("2026-10-04", { meaning }));
    assert.equal(result.evidence.time.meaning, meaning);
    assert.equal(verdict(result.evidence).status, "pending");
    assert.deepEqual(sourceDateVerdict("policy", result.evidence, binding, now), { status: "not_applicable", rule: "BR-POL-11" });
  }
  assert.equal(verdict(parseSourceDate(request("2026-10-04", { origin: "http_header" })).evidence).status, "pending");
  const conditional = parseSourceDate(request("2026-10-04T09:00Z", { meaning: "effective", condition_text: "经批准后" }));
  assert.equal(conditional.evidence.time.utc, null);
  assert.equal(conditional.evidence.time.condition_text, "经批准后");
});

test("intake preserves an unbound raw observation; only content's actual identity can form the parser binding", () => {
  const { binding: originalBinding, ...raw } = request("2026-10-04");
  const observation = SourceDateObservationInput.parse({ ...raw, sourceId: originalBinding.sourceId, configHash: originalBinding.configHash });
  assert(!SourceDateObservationInput.safeParse({ ...observation, articleId: "temporary-id" }).success);
  assert(!SourceDateObservationInput.safeParse({ ...observation, revision: 1 }).success);
  const { sourceId, configHash, ...value } = observation;
  const parsed = parseSourceDate({ ...value, binding: { sourceId, configHash, articleId: "content-assigned-fixture", revision: 3 } });
  assert.equal(parsed.evidence.binding.articleId, "content-assigned-fixture");
  assert.equal(parsed.evidence.binding.revision, 3);
  assert.equal(parsed.evidence.time.raw, observation.raw);
  assert.equal(parsed.evidence.locator, observation.locator);
  assert.deepEqual(MaterialSourceDateInput.parse({}), {});
  assert(!MaterialSourceDateInput.safeParse({ sourceDateObservation: null }).success);
  assert(!MaterialSourceDateInput.safeParse({ sourceDateObservation: observation }).success);
  assert(!MaterialSourceDateInput.safeParse({ sourceDateObservation: observation, expectedSourceDateVersion: 0 }).success);
  assert(MaterialSourceDateInput.safeParse({ sourceDateObservation: observation, expectedSourceDateVersion: 0, permissionVersion: 1 }).success);
});

test("material result examples distinguish unchanged facts, body revision, evidence-only updates and stale CAS", () => {
  const unchanged = {
    articleId: binding.articleId,
    created: false,
    revised: false,
    backfill: false,
    revision: 3,
    sourceTimeChanged: false,
    metadataChanged: false,
    sourceDateVersion: 4,
    sourceDateOutcome: "unchanged",
  } as const;
  const examples = [
    unchanged,
    { ...unchanged, created: true, revision: 1, sourceDateVersion: 0 }, // no observation on creation
    { ...unchanged, revised: true, revision: 4 }, // body-only change keeps the current evidence version
    { ...unchanged, sourceDateOutcome: "applied", metadataChanged: true, sourceDateVersion: 5 }, // changed evidence, same time facts
    { ...unchanged, sourceDateOutcome: "applied", metadataChanged: true, sourceTimeChanged: true, sourceDateVersion: 5 },
    { ...unchanged, sourceDateOutcome: "stale", sourceDateVersion: 5 }, // keep current state; never retarget stale evidence automatically
  ];
  for (const value of examples) assert(MaterialUpdateResult.safeParse(value).success);
  assert(!MaterialUpdateResult.safeParse({ ...unchanged, created: true }).success);
  assert(!MaterialUpdateResult.safeParse({ ...unchanged, sourceTimeChanged: true }).success);
  assert(!MaterialUpdateResult.safeParse({ ...unchanged, sourceDateOutcome: "applied", sourceDateVersion: 0 }).success);
  assert(!MaterialUpdateResult.safeParse({ ...unchanged, sourceDateOutcome: "applied", sourceDateVersion: 5 }).success);
});

test("news date task carries exact material/config/permission/evidence preconditions without permitting policy work", () => {
  const job = {
    lane: "news",
    articleId: binding.articleId,
    sourceId: binding.sourceId,
    expectedRevision: 3,
    configHash: binding.configHash,
    permissionVersion: 1,
    expectedSourceDateVersion: 4,
    observationId: "existing-fetch-record",
  };
  assert(SourceDateTask.safeParse(job).success);
  for (const key of Object.keys(job).filter((key) => key !== "observationId")) {
    const missing: Record<string, unknown> = { ...job };
    delete missing[key];
    assert(!SourceDateTask.safeParse(missing).success, key);
  }
  for (const change of [{ lane: "policy" }, { expectedRevision: 0 }, { expectedSourceDateVersion: -1 }, { permissionVersion: 0 }])
    assert(!SourceDateTask.safeParse({ ...job, ...change }).success);
});
