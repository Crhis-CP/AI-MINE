import { readFile } from "node:fs/promises";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";
import {
  UsageProtectionConfig,
  UsageBreaker,
  UsageConfigRecord,
  UsagePriceRecord,
  UsagePrice,
  UsageProtectionEvent,
  UsageProtectionOverview,
  type UsageScope,
} from "@amp/contracts/http/private";
import { z } from "zod";
import { beijingDate, beijingMidnight } from "@amp/contracts/time";
import { dbOf, type Db } from "../db.ts";
import { sha256, stableJson, newUuid } from "../lib/ids.ts";
import { audit } from "../admin/auth.ts";
import { priceQuote, settleQuotedCost, amountMicros, centsText, MICRO, ratioMicros, type UsageBounds, type UsageQuote } from "./usage-pricing.ts";
const sql = dbOf("ai-gateway");
export type UsageConfig = z.infer<typeof UsageProtectionConfig>;
export type Scope = z.infer<typeof UsageScope>;
export type UsageContext = { lane: "news" | "policy"; capability: string; sourceIds: string[]; object: { kind: "article" | "policy"; id: string } | null };
export type TaskBudget = { key: string; limit_micros: string };
export type UsageReservation = {
  taskBudget?: TaskBudget;
  context: UsageContext;
  logicalKey: string;
  quote: UsageQuote;
  configVersion: number;
};
export const usageLock = async (db: Db) => {
  await db`SELECT pg_advisory_xact_lock(hashtext('usage-protection'))`;
};
export async function usageConfiguration(db: Db = sql) {
  const [row] = await db<
    { version: number; config: unknown; effective_at: Date; actor: string; reason: string }[]
  >`SELECT version,config,effective_at,actor,reason FROM ai.usage_control_versions ORDER BY version DESC LIMIT 1`;
  if (!row) return null;
  const parsed = UsageConfigRecord.safeParse({ ...row, effective_at: row.effective_at.toISOString() });
  return parsed.success ? parsed.data : null;
}
/**
 * Writes the controlled initial version once when the table is empty.
 * An existing version, including one a person changed later, is left as it is.
 * A role that cannot write leaves the gate closed; it does not invent another threshold.
 */
export async function installInitialUsageControl(db: Db = sql): Promise<"installed" | "present" | "unavailable"> {
  let config: UsageConfig;
  try {
    config = UsageProtectionConfig.parse(JSON.parse(await readFile(path.join(REPO_ROOT, "industry/usage-controls.json"), "utf8")));
  } catch {
    return "unavailable";
  }
  try {
    const install = async (tx: Db) => {
      await usageLock(tx);
      if (await usageConfiguration(tx)) return "present" as const;
      await tx`INSERT INTO ai.usage_control_versions(version,config,actor,reason) VALUES(1,${tx.json(config)},'system:usage','受控配置初始版本')`;
      return "installed" as const;
    };
    return await (typeof (db as typeof sql).begin === "function" ? (db as typeof sql).begin(install) : install(db));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "42501") return "unavailable";
    if (code === "23505") return "present";
    throw error;
  }
}
export async function usageEvent(
  db: Db,
  id: string,
  kind: string,
  payload: Record<string, unknown>,
  lane: string | null = null,
  capability: string | null = null,
) {
  await db`INSERT INTO ai.usage_protection_events(id,kind,lane,capability,payload) VALUES(${id},${kind},${lane},${capability},${db.json(payload as never)}) ON CONFLICT(id) DO NOTHING`;
}
export async function usageBreakerRecord(db: Db, id: string) {
  const [row] =
    await db`SELECT id,revision,scope,trigger,state,window_key,config_version,current,threshold,warning_at,opened_at,created_at,recovered_at,recovered_by,recovery_reason,receipt_ids FROM ai.usage_breakers WHERE id=${id}`;
  if (!row) throw new Error("熔断记录不存在");
  return UsageBreaker.parse({
    ...row,
    ...Object.fromEntries(["warning_at", "opened_at", "created_at", "recovered_at"].map((k) => [k, row[k]?.toISOString() ?? null])),
  });
}
async function raise(
  db: Db,
  scope: Scope,
  trigger: "repeated_input" | "object_cost" | "daily_total",
  _level: "warning" | "open",
  window: string,
  configVersion: number,
  current: Record<string, string>,
  threshold: Record<string, string>,
  receipts: string[],
  now: Date,
) {
  const key = sha256(stableJson(scope));
  const [warning] = await db<{ id: string }[]>`SELECT id FROM ai.usage_breakers
    WHERE scope_key=${key} AND trigger=${trigger} AND window_key=${window} AND state='warning'
    ORDER BY created_at DESC LIMIT 1`;
  if (warning) {
    await db`UPDATE ai.usage_breakers SET current=${db.json(current)},threshold=${db.json(threshold)},receipt_ids=${receipts} WHERE id=${warning.id}`;
    return;
  }
  const id = `brk_${newUuid()}`;
  await db`INSERT INTO ai.usage_breakers(id,scope_key,scope,trigger,state,window_key,config_version,current,threshold,warning_at,created_at,receipt_ids)
    VALUES(${id},${key},${db.json(scope)},${trigger},'warning',${window},${configVersion},${db.json(current)},${db.json(threshold)},${now},${now},${receipts})`;
  const record = await usageBreakerRecord(db, id);
  await usageEvent(db, `${id}:warning`, "warning", record, scope.lane, scope.capability);
}

const capabilityScope = (lane: "news" | "policy", capability: string, source: string | null = null): Scope => ({
  lane,
  kind: source ? "capability_source" : "capability",
  capability,
  source_id: source,
  object_kind: null,
  object_id: null,
});
/** Retire the replaced automatic rules, retaining their history and independent manual pauses. */
export async function activeUsageBlocker(db: Db, _context: UsageContext): Promise<string | null> {
  const reason = "Owner 2026-10-15：按上游请求次数控制；费用与重复次数仅提醒";
  const rows = await db<{ id: string }[]>`UPDATE ai.usage_breakers SET state='recovered',revision=revision+1,
    recovered_at=now(),recovered_by='system:usage-alignment',recovery_reason=${reason}
    WHERE state='open' AND trigger IN ('daily_total','object_cost','repeated_input') RETURNING id`;
  for (const row of rows) {
    const record = await usageBreakerRecord(db, row.id);
    await audit("system:usage-alignment", "usage.breaker.recover", row.id, reason, { state: "open" }, record, undefined, db);
    await usageEvent(db, `${row.id}:recovered`, "recovered", record, record.scope.lane, record.scope.capability);
  }
  return null;
}

function sumKeys(c: UsageContext, day: string) {
  const month = day.slice(0, 7),
    scope = { lane: c.lane, capability: c.capability },
    sources = c.sourceIds.slice().sort();
  const keys: Array<{ kind: string; key: string; context: Record<string, unknown> }> = [
    { kind: "day", key: day, context: { day } },
    { kind: "month", key: month, context: { month } },
    { kind: "lane_month", key: stableJson([month, c.lane]), context: { month, lane: c.lane } },
    { kind: "capability_day", key: stableJson([day, c.lane, c.capability]), context: { day, ...scope } },
    { kind: "capability_month", key: stableJson([month, c.lane, c.capability]), context: { month, ...scope } },
    { kind: "source_month", key: stableJson([month, c.lane, sources]), context: { month, lane: c.lane, source_ids: sources } },
  ];
  if (c.object)
    keys.push({
      kind: "object",
      key: stableJson([c.lane, c.object.kind, c.object.id]),
      context: { lane: c.lane, object_kind: c.object.kind, object_id: c.object.id },
    });
  return keys;
}
async function applySums(db: Db, c: UsageContext, day: string, delta: { settled: bigint; unknown: bigint; reserved: bigint }) {
  for (const key of sumKeys(c, day))
    await db`INSERT INTO ai.usage_sums(kind,key,context,settled_micros,unknown_micros,reserved_micros)
 VALUES(${key.kind},${key.key},${db.json(key.context as never)},${delta.settled.toString()},${delta.unknown.toString()},${delta.reserved.toString()})
 ON CONFLICT(kind,key) DO UPDATE SET settled_micros=ai.usage_sums.settled_micros+EXCLUDED.settled_micros,unknown_micros=ai.usage_sums.unknown_micros+EXCLUDED.unknown_micros,reserved_micros=ai.usage_sums.reserved_micros+EXCLUDED.reserved_micros`;
}
export async function reserveUsageAttempt(db: Db, attemptId: string, receiptId: number, value: UsageReservation, now = new Date()) {
  await usageLock(db);
  const c = value.context;
  await db`INSERT INTO ai.usage_attempts(attempt_id,receipt_id,logical_key,lane,capability,source_ids,object_kind,object_id,reserved_micros,state,quote,occurred_at,task_key,task_limit_micros)
 VALUES(${attemptId},${receiptId},${value.logicalKey},${c.lane},${c.capability},${c.sourceIds},${c.object?.kind ?? null},${c.object?.id ?? null},${value.quote.reserved_micros},'reserved',${db.json(value.quote)},${now},${value.taskBudget?.key ?? null},${value.taskBudget?.limit_micros ?? null})`;
  await applySums(db, c, beijingDate(now), { settled: 0n, unknown: 0n, reserved: BigInt(value.quote.reserved_micros) });
}
type AttemptUsage = {
  lane: "news" | "policy";
  capability: string;
  source_ids: string[];
  object_kind: "article" | "policy" | null;
  object_id: string | null;
  logical_key: string;
  reserved_micros: string;
  settled_micros: string | null;
  state: "reserved" | "settled" | "unknown" | "failed";
  quote: UsageQuote;
  occurred_at: Date;
};
const contextOf = (row: AttemptUsage): UsageContext => ({
  lane: row.lane,
  capability: row.capability,
  sourceIds: row.source_ids,
  object: row.object_kind && row.object_id ? { kind: row.object_kind, id: row.object_id } : null,
});
/** Reservation is never released merely because a request timed out or did not report usage. */
export async function settleUsageAttempt(
  db: Db,
  attemptId: string,
  outcome: { usage: Record<string, unknown> | null; cost: { amount: number | string; currency: string; basis: string } | null } | "unknown" | "failed",
  now = new Date(),
) {
  await usageLock(db);
  const [row] = await db<
    AttemptUsage[]
  >`SELECT lane,capability,source_ids,object_kind,object_id,logical_key,reserved_micros::text,settled_micros::text,state,quote,occurred_at FROM ai.usage_attempts WHERE attempt_id=${attemptId} FOR UPDATE`;
  if (!row) return null;
  const cost = typeof outcome === "object" ? settleQuotedCost(row.quote, outcome.usage, outcome.cost) : null;
  const state = outcome === "failed" ? "failed" : cost ? "settled" : "unknown";
  const amount = cost?.micros ?? 0n,
    reserve = BigInt(row.reserved_micros);
  const before = {
    settled: row.state === "settled" ? BigInt(row.settled_micros!) : 0n,
    unknown: row.state === "unknown" ? reserve : 0n,
    reserved: row.state === "reserved" ? reserve : 0n,
  };
  await db`UPDATE ai.usage_attempts SET state=${state},settled_micros=${cost ? amount.toString() : null},updated_at=${now} WHERE attempt_id=${attemptId}`;
  await applySums(db, contextOf(row), beijingDate(row.occurred_at), {
    settled: (state === "settled" ? amount : 0n) - before.settled,
    unknown: (state === "unknown" ? reserve : 0n) - before.unknown,
    reserved: -before.reserved,
  });
  const configuration = await usageConfiguration(db);
  if (configuration) {
    await evaluateInput(db, configuration, contextOf(row), row.logical_key, now);
    if (!(await usageCoverageGap(db, configuration, now))) {
      await evaluateDaily(db, configuration, now);
      await evaluateNotices(db, configuration, now);
    }
  }
  return cost ? { amount: centsText(cost.micros), currency: "CNY", basis: cost.basis } : null;
}
type Configuration = NonNullable<Awaited<ReturnType<typeof usageConfiguration>>>;
async function evaluateInput(db: Db, configuration: Configuration, c: UsageContext, logicalKey: string, now: Date) {
  const b = configuration.config.breaker,
    ratio = ratioMicros(b.warning_ratio),
    since = new Date(now.getTime() - b.repeat_window_seconds * 1000);
  const rows = await db<
    { receipt_id: string }[]
  >`SELECT receipt_id::text FROM ai.usage_attempts WHERE logical_key=${logicalKey} AND submitted AND state<>'failed' AND occurred_at>=${since} ORDER BY occurred_at`;
  const repeat = Math.max(0, rows.length - 1),
    warning = Math.min(b.repeat_count - 1, Number((BigInt(b.repeat_count) * ratio) / MICRO));
  if (repeat >= warning && rows.length) {
    const [recent] = await db<
      { window_key: string }[]
    >`SELECT window_key FROM ai.usage_breakers WHERE trigger='repeated_input' AND created_at>=${since} AND scope->>'lane'=${c.lane} AND scope->>'capability'=${c.capability} AND state<>'recovered' ORDER BY created_at DESC LIMIT 1`;
    const window = recent?.window_key ?? now.toISOString();
    for (const source of c.sourceIds.length ? c.sourceIds : [null])
      await raise(
        db,
        capabilityScope(c.lane, c.capability, source),
        "repeated_input",
        repeat >= b.repeat_count ? "open" : "warning",
        window,
        configuration.version,
        { repeats: String(repeat) },
        { limit: String(b.repeat_count), warning: String(warning) },
        rows.slice(-5).map((r) => r.receipt_id),
        now,
      );
  }
  if (c.object) {
    const key = stableJson([c.lane, c.object.kind, c.object.id]);
    const [total] = await db<
      { amount: string }[]
    >`SELECT (settled_micros+unknown_micros)::text AS amount FROM ai.usage_sums WHERE kind='object' AND key=${key}`;
    const amount = BigInt(total?.amount ?? "0"),
      limit = BigInt(c.object.kind === "policy" ? b.policy_object_micros : b.news_object_micros);
    if (amount * MICRO >= limit * ratio)
      await raise(
        db,
        { lane: c.lane, kind: "object", capability: null, source_id: null, object_kind: c.object.kind, object_id: c.object.id },
        "object_cost",
        amount > limit ? "open" : "warning",
        key,
        configuration.version,
        { micros: amount.toString() },
        { micros: limit.toString(), warning_micros: ((limit * ratio) / MICRO).toString() },
        rows.slice(-5).map((r) => r.receipt_id),
        now,
      );
  }
}
async function dailyMeasurement(db: Db, configuration: Configuration, now: Date) {
  const b = configuration.config.breaker,
    day = beijingDate(now),
    start = beijingDate(new Date(beijingMidnight(day).getTime() - b.lookback_days * 86400000));
  const totals = await db<
    { key: string; amount: string }[]
  >`SELECT key,(settled_micros+unknown_micros)::text AS amount FROM ai.usage_sums WHERE kind='day' AND key>=${start} AND key<=${day}`;
  const [first] = await db<{ first: Date | null }[]>`SELECT min(started_at) AS first FROM receipt_attempts WHERE origin='live'`;
  const historyDays = first?.first
    ? Math.min(b.lookback_days, Math.max(0, Math.round((beijingMidnight(day).getTime() - beijingMidnight(beijingDate(first.first)).getTime()) / 86400000)))
    : 0;
  const today = BigInt(totals.find((t) => t.key === day)?.amount ?? "0"),
    history = totals.filter((t) => t.key < day),
    sum = history.reduce((a, t) => a + BigInt(t.amount), 0n),
    ratio = ratioMicros(b.warning_ratio),
    multiple = ratioMicros(b.daily_multiple),
    days = BigInt(historyDays);
  const historic = days > 0n && sum > 0n;
  const open = historic ? today > BigInt(b.daily_floor_micros) && today * days * MICRO > sum * multiple : today > BigInt(b.daily_no_history_micros);
  const warning = historic
    ? today * MICRO >= BigInt(b.daily_floor_micros) * ratio && today * days * MICRO * MICRO >= sum * multiple * ratio
    : today * MICRO >= BigInt(b.daily_no_history_micros) * ratio;
  return { day, today, sum, days, open, warning };
}
async function evaluateDaily(db: Db, configuration: Configuration, now: Date) {
  const b = configuration.config.breaker,
    { day, today, sum, days, open, warning } = await dailyMeasurement(db, configuration, now);
  if (!open && !warning) return;
  const groups = await db<
    { context: { lane: "news" | "policy"; capability: string }; amount: string }[]
  >`SELECT context,(settled_micros+unknown_micros)::text AS amount FROM ai.usage_sums WHERE kind='capability_day' AND context->>'day'=${day} ORDER BY settled_micros+unknown_micros DESC,key`;
  let covered = 0n;
  for (const [index, g] of groups.entries()) {
    if (BigInt(g.amount) === 0n || (!open && index >= 3) || (open && covered * 2n >= today)) break;
    const recent = await db<
      { id: string }[]
    >`SELECT receipt_id::text AS id FROM ai.usage_attempts WHERE lane=${g.context.lane} AND capability=${g.context.capability} AND occurred_at>=${beijingMidnight(day)} ORDER BY occurred_at DESC LIMIT 5`;
    await raise(
      db,
      capabilityScope(g.context.lane, g.context.capability),
      "daily_total",
      open ? "open" : "warning",
      day,
      configuration.version,
      { micros: today.toString(), history_micros: sum.toString(), history_days: String(days), capability_micros: g.amount },
      { multiple: b.daily_multiple, floor_micros: b.daily_floor_micros, no_history_micros: b.daily_no_history_micros, warning_ratio: b.warning_ratio },
      recent.map((r) => r.id),
      now,
    );
    covered += BigInt(g.amount);
  }
}
async function evaluateNotices(db: Db, configuration: Configuration, now: Date) {
  const month = beijingDate(now).slice(0, 7),
    step = BigInt(configuration.config.usage_notice.step_micros);
  const [total] = await db<{ amount: string }[]>`SELECT (settled_micros+unknown_micros)::text AS amount FROM ai.usage_sums WHERE kind='month' AND key=${month}`;
  const amount = BigInt(total?.amount ?? "0"),
    threshold = (amount / step) * step;
  const [prior] = await db<
    { notified_micros: string; last_total_micros: string }[]
  >`SELECT notified_micros::text,last_total_micros::text FROM ai.usage_notice_progress WHERE month=${month}`;
  const old = BigInt(prior?.notified_micros ?? "0");
  if (threshold <= old) return;
  const groups = await db<
    { kind: string; context: Record<string, unknown>; micros: string }[]
  >`SELECT kind,context,(settled_micros+unknown_micros)::text AS micros FROM ai.usage_sums WHERE kind IN ('lane_month','capability_month','source_month') AND context->>'month'=${month} ORDER BY settled_micros+unknown_micros DESC,key`;
  await usageEvent(db, `usage-notice:${month}:${threshold}`, "usage_notice", {
    month,
    cumulative_micros: amount.toString(),
    increment_micros: (amount - BigInt(prior?.last_total_micros ?? "0")).toString(),
    previous_threshold_micros: old.toString(),
    crossed_through_micros: threshold.toString(),
    step_micros: step.toString(),
    top: groups.filter((r, i, all) => all.slice(0, i).filter((p) => p.kind === r.kind).length < 3),
    notice: "这只是提示，没有暂停任何处理",
  });
  await db`INSERT INTO ai.usage_notice_progress(month,notified_micros,last_total_micros) VALUES(${month},${threshold.toString()},${amount.toString()}) ON CONFLICT(month) DO UPDATE SET notified_micros=EXCLUDED.notified_micros,last_total_micros=EXCLUDED.last_total_micros,updated_at=now()`;
}
/** Purposes each belong to one lane. Mirrors CAPABILITIES in editorial/models.ts; a purpose in both or neither is not guessed. */
const NEWS_PURPOSES = [
  "prefilter_article",
  "score_article",
  "understand_article",
  "summarize_article",
  "structure_article",
  "group_article",
  "group_signal",
  "group_story",
  "group_review",
  "group_story_review",
  "story_digest",
  "report_lead",
  "report_daily",
  "report_weekly",
  "report_monthly",
  "translate_body",
] as const;
const POLICY_PURPOSES = ["policy_fulltext", "policy_group", "policy_interpret", "policy_vision", "policy_verify"] as const;
const ATTRIBUTABLE_PURPOSES = [...NEWS_PURPOSES, ...POLICY_PURPOSES];
function laneFromPurpose(purpose: string): "news" | "policy" | null {
  const news = (NEWS_PURPOSES as readonly string[]).includes(purpose),
    policy = (POLICY_PURPOSES as readonly string[]).includes(purpose);
  return news === policy ? null : news ? "news" : "policy";
}
type RecordedAttempt = {
  attempt_id: string;
  receipt_id: string;
  logical_key: string;
  purpose: string;
  subject: string | null;
  status: string;
  cost: string | null;
  currency: string | null;
  cost_basis: string | null;
  request: Record<string, unknown> | null;
  started_at: Date;
  usage: Record<string, unknown> | null;
  service: string;
  model: string | null;
  configuration_hash: string | null;
};
function recordedLane(row: RecordedAttempt): "news" | "policy" | null {
  const explicit = row.request?.lane;
  if (explicit === "news" || explicit === "policy") return explicit;
  return explicit ? null : laneFromPurpose(row.purpose);
}
/** Use a receipt's own CNY figure. Token-only receipts take the single price valid that day; foreign bills and unknown calls stay out. */
async function recordedMicros(db: Db, row: RecordedAttempt, day: string): Promise<bigint | null> {
  if (row.currency && row.currency !== "CNY") return null;
  if (row.status === "failed") return 0n;
  if (row.currency === "CNY" && ["actual", "estimated"].includes(row.cost_basis ?? "")) return amountMicros(row.cost ?? "");
  if (row.status !== "received" || row.cost !== null || row.currency) return null;
  const prices = await db<
    { id: string; version: number; price: unknown }[]
  >`SELECT id,version,price FROM ai.usage_prices WHERE price->>'service'=${row.service} AND price->>'model'=${row.model ?? ""} AND price->>'currency'='CNY'`;
  const valid = prices.flatMap((item) => {
    const parsed = UsagePrice.safeParse(item.price);
    if (!parsed.success || parsed.data.observed_on > day || parsed.data.valid_until < day) return [];
    if (row.configuration_hash && parsed.data.configuration_hash !== row.configuration_hash) return [];
    return [{ id: item.id, version: item.version, price: parsed.data }];
  });
  if (valid.length !== 1) return null;
  const settled = settleQuotedCost(
    { price_id: valid[0]!.id, price_version: valid[0]!.version, price: valid[0]!.price, reserved_micros: "0", bounds: null },
    row.usage,
    null,
  );
  return settled?.basis === "estimated" ? settled.micros : null;
}
async function adoptOne(db: Db, row: RecordedAttempt): Promise<boolean> {
  const lane = z.enum(["news", "policy"]).nullable().parse(recordedLane(row));
  if (!lane) return false;
  const day = beijingDate(row.started_at),
    cost = await recordedMicros(db, row, day);
  if (cost === null) return false;
  const explicit = row.request?.lane === "news" || row.request?.lane === "policy";
  if (!explicit)
    await db`UPDATE receipts SET request=jsonb_set(coalesce(request,'{}'::jsonb),'{lane}',pg_catalog.to_jsonb(${lane}::text),true) WHERE id=${row.receipt_id} AND coalesce(request->>'lane','') NOT IN ('news','policy')`;
  if (row.status !== "failed" && row.cost === null && !row.currency) {
    const text = centsText(cost);
    const written =
      await db`UPDATE receipt_attempts SET cost=${text},currency='CNY',cost_basis='estimated' WHERE id=${row.attempt_id} AND cost IS NULL AND currency IS NULL RETURNING id`;
    if (!written.length) return false;
    await db`UPDATE receipts SET cost=${text},currency='CNY',cost_basis='estimated' WHERE id=${row.receipt_id} AND response_attempt_id=${row.attempt_id} AND cost IS NULL AND currency IS NULL`;
  }
  const supplied = row.request?.usage_object as { kind?: unknown; id?: unknown } | undefined,
    article = /^article:([a-zA-Z0-9_-]+@[1-9][0-9]*)/.exec(row.subject ?? "");
  const parsedObject = z.object({ kind: z.enum(["article", "policy"]), id: z.string() }).safeParse(supplied);
  const object = parsedObject.success ? parsedObject.data : article ? { kind: "article" as const, id: article[1]! } : null;
  const context: UsageContext = {
    lane,
    capability: row.purpose,
    sourceIds: Array.isArray(row.request?.sourceIds) ? row.request.sourceIds.filter((v): v is string => typeof v === "string") : [],
    object,
  };
  const inserted = await db<
    { attempt_id: string }[]
  >`INSERT INTO ai.usage_attempts(attempt_id,receipt_id,logical_key,lane,capability,source_ids,object_kind,object_id,reserved_micros,settled_micros,state,quote,occurred_at,submitted) VALUES(${row.attempt_id},${row.receipt_id},${row.logical_key},${lane},${row.purpose},${context.sourceIds},${object?.kind ?? null},${object?.id ?? null},'0',${cost.toString()},${row.status === "failed" ? "failed" : "settled"},${db.json({ recorded_attempt: true })},${row.started_at},true) ON CONFLICT(attempt_id) DO NOTHING RETURNING attempt_id`;
  if (inserted.length) await applySums(db, context, day, { settled: cost, unknown: 0n, reserved: 0n });
  return true;
}
/** Bring recorded receipts into the ledger. CNY already on the receipt is kept; token counts use the one registered price. No currency conversion and no resend. */
async function adoptRecordedUsage(db: Db, since: Date) {
  const skipped: string[] = [];
  for (let pass = 0; pass < 40; pass++) {
    const rows = await db<
      RecordedAttempt[]
    >`SELECT a.id::text AS attempt_id,r.id::text AS receipt_id,r.logical_key,r.purpose,r.subject,a.status,a.cost::text,a.currency,a.cost_basis,r.request,a.started_at,a.usage,a.service,a.model,s.configuration_hash FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id LEFT JOIN ai.usage_attempts u ON u.attempt_id=a.id LEFT JOIN ai.model_attempt_snapshots s ON s.attempt_id=a.id WHERE a.origin='live' AND a.started_at>=${since} AND u.attempt_id IS NULL AND a.status IN ('received','failed') AND (pg_catalog.cardinality(${skipped}::bigint[])=0 OR a.id <> ALL(${skipped}::bigint[])) AND (r.request->>'lane' IN ('news','policy') OR r.purpose = ANY(${ATTRIBUTABLE_PURPOSES}::text[])) AND (a.currency IS NULL OR a.currency='CNY') AND (a.status='failed' OR (a.currency='CNY' AND a.cost IS NOT NULL AND a.cost_basis IN ('actual','estimated')) OR (a.status='received' AND a.cost IS NULL AND a.currency IS NULL AND coalesce(a.usage->>'prompt_tokens',a.usage->>'input_tokens',a.usage->>'tokens',a.usage->>'total_tokens') ~ '^[0-9]+$' AND a.usage->>'completion_tokens' ~ '^[0-9]+$')) ORDER BY a.id LIMIT 500`;
    if (!rows.length) return;
    for (const row of rows) if (!(await adoptOne(db, row))) skipped.push(row.attempt_id);
  }
}
/** Existing attempts without a price/reservation must be reconciled, never silently counted as zero. */
async function usageCoverageGap(db: Db, configuration: Configuration, now: Date, adopt = false, context?: UsageContext, subject?: string | null) {
  const since = new Date(
    Math.min(
      beijingMidnight(`${beijingDate(now).slice(0, 7)}-01`).getTime(),
      beijingMidnight(beijingDate(now)).getTime() - configuration.config.breaker.lookback_days * 86400000,
    ),
  );
  if (adopt) await adoptRecordedUsage(db, since);
  const [missing] = await db<
    { n: number }[]
  >`SELECT count(*)::int AS n FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id LEFT JOIN ai.usage_attempts u ON u.attempt_id=a.id
 WHERE a.origin='live' AND a.started_at>=${since} AND a.status<>'failed' AND u.attempt_id IS NULL
 AND (${context === undefined} OR (r.request->>'lane'=${context?.lane ?? null} AND (
   (${context?.object?.id ?? null}::text IS NOT NULL AND ((r.request->'usage_object'->>'kind'=${context?.object?.kind ?? null} AND r.request->'usage_object'->>'id'=${context?.object?.id ?? null}) OR (${context?.object?.kind ?? null}='article' AND (r.subject=${context?.object ? `article:${context.object.id}` : null} OR r.subject LIKE ${context?.object ? `article:${context.object.id}#%` : null}))))
   OR (${(context?.sourceIds.length ?? 0) > 0} AND r.purpose=${context?.capability ?? null} AND r.request->'sourceIds' ?| ${context?.sourceIds ?? []}::text[])
   OR (${!context?.object && !context?.sourceIds.length && !!subject} AND r.purpose=${context?.capability ?? null} AND r.subject=${subject ?? null})
 )))`;
  return missing!.n ? `有${missing!.n}次历史调用尚未纳入可核费用，需要补齐原回执费用和业务归属` : null;
}
export async function admitUsage(
  db: Db,
  input: {
    context: UsageContext | null;
    subject?: string | null;
    taskBudget?: TaskBudget;
    logicalKey: string;
    service: string;
    model?: string | null;
    configurationHash?: string | null;
    bounds?: UsageBounds;
    registeredPricing?: { input: string; output: string; basis: string };
  },
  now = new Date(),
): Promise<{ reservation: UsageReservation | null; blocked: string | null; code?: string }> {
  await usageLock(db);
  let configuration: Configuration | null = null;
  try {
    configuration = await usageConfiguration(db);
  } catch {
    /* Reporting configuration does not impose a payment quota. */
  }
  const missing = !configuration ? "用量提醒配置缺失或不可读取" : null;
  if (missing)
    await usageEvent(
      db,
      `usage-missing:${beijingDate(now)}:${sha256(missing)}`,
      "configuration_missing",
      { reason: missing },
      input.context?.lane ?? null,
      input.context?.capability ?? null,
    );
  if (!input.context) return { reservation: null, blocked: "缺少真实业务线及费用归属" };
  const c = input.context;
  await activeUsageBlocker(db, c);
  if (configuration) {
    await evaluateInput(db, configuration, c, input.logicalKey, now);
    if (!(await usageCoverageGap(db, configuration, now, true))) await evaluateDaily(db, configuration, now);
  }
  const priced = await priceQuote(db, input, now);
  if (!priced.quote) {
    await usageEvent(
      db,
      `usage-price-missing:${beijingDate(now)}:${sha256(stableJson([input.service, input.model, priced.missing]))}`,
      "configuration_missing",
      { reason: priced.missing, service: input.service, model: input.model ?? null },
      c.lane,
      c.capability,
    );
  }
  const quote: UsageQuote = priced.quote ?? { price_id: null, price_version: 0, price: null, reserved_micros: "0", bounds: input.bounds ?? null };
  if (input.taskBudget) {
    const task = input.taskBudget;
    if (!priced.quote) return { reservation: null, blocked: "有限额的研究任务需要可核对的费用估算", code: "task_budget_unpriced" };
    if (!task.key.trim() || task.key.length > 200 || !/^([1-9]\d{0,17})$/.test(task.limit_micros))
      return { reservation: null, blocked: "研究任务费用上界无效", code: "task_budget_invalid" };
    const [current] = await db<
      { used: string; low: string | null; high: string | null }[]
    >`SELECT coalesce(sum(CASE WHEN state='settled' THEN settled_micros WHEN state IN ('reserved','unknown') THEN reserved_micros ELSE 0 END),0)::text AS used,min(task_limit_micros)::text AS low,max(task_limit_micros)::text AS high FROM ai.usage_attempts WHERE task_key=${task.key}`;
    if (current!.low !== null && (current!.low !== task.limit_micros || current!.high !== task.limit_micros))
      return { reservation: null, blocked: "任务费用上界发生变化，不能通过新参数绕过", code: "task_budget_changed" };
    if (BigInt(current!.used) + BigInt(priced.quote.reserved_micros) > BigInt(task.limit_micros))
      return { reservation: null, blocked: "本次来源研究已达到单任务费用上界，已有进度和回执保留", code: "task_budget_exceeded" };
  }
  return {
    reservation: {
      context: c,
      logicalKey: input.logicalKey,
      quote,
      configVersion: configuration?.version ?? 0,
      ...(input.taskBudget ? { taskBudget: input.taskBudget } : {}),
    },
    blocked: null,
  };
}
/** Recheck before dispatch, then mark actual gateway hand-off, not merely the earlier reservation. */
export async function authorizeUsageSend(db: Db, attemptId: string, now = new Date()) {
  await usageLock(db);
  const [row] = await db<
    AttemptUsage[]
  >`SELECT lane,capability,source_ids,object_kind,object_id,logical_key,reserved_micros::text,settled_micros::text,state,quote,occurred_at FROM ai.usage_attempts WHERE attempt_id=${attemptId}`;
  if (!row) return "缺少费用预留证据";
  const c = contextOf(row),
    configuration = await usageConfiguration(db);
  if (configuration) {
    await evaluateInput(db, configuration, c, row.logical_key, now);
    if (!(await usageCoverageGap(db, configuration, now))) await evaluateDaily(db, configuration, now);
  }
  const open = await activeUsageBlocker(db, c);
  if (open) return `费用熔断等待恢复：${open}`;
  await db`UPDATE ai.usage_attempts SET submitted=true WHERE attempt_id=${attemptId}`;
  return null;
}
/** Observe timed-out placeholders and evaluate without sending. The scheduler calls delivery separately. */
export async function evaluateUsageProtection(now = new Date()) {
  return sql.begin(async (db) => {
    await usageLock(db);
    await activeUsageBlocker(db, { lane: "news", capability: "usage-observation", sourceIds: [], object: null });
    const config = await usageConfiguration(db);
    if (!config) {
      await usageEvent(db, `usage-missing:${beijingDate(now)}`, "configuration_missing", { reason: "费用保护配置尚未安装" });
      return { missing: ["费用保护配置尚未安装"] };
    }
    const stale = await db<
      { attempt_id: string; status: string }[]
    >`SELECT u.attempt_id::text,a.status FROM ai.usage_attempts u JOIN receipt_attempts a ON a.id=u.attempt_id WHERE (u.state='reserved' AND a.status='unknown') OR (u.state IN ('reserved','unknown') AND a.status='failed')`;
    for (const row of stale) await settleUsageAttempt(db, row.attempt_id, row.status === "failed" ? "failed" : "unknown", now);
    const expiring = await db<
      { id: string; version: number; price: { service: string; model: string; valid_until: string } }[]
    >`SELECT id,version,price FROM ai.usage_prices WHERE price->>'valid_until'<=${beijingDate(new Date(now.getTime() + 7 * 86400000))}`;
    for (const p of expiring)
      await usageEvent(db, `usage-price-expiry:${p.id}:${p.version}`, "configuration_missing", {
        reason: `计费依据临期或已过期：${p.price.service}${p.price.model ? ` / ${p.price.model}` : ""}，有效至${p.price.valid_until}。请核对官方依据并登记有效日期；历史费用保持原依据。`,
      });
    const gap = await usageCoverageGap(db, config, now, true);
    if (!gap) {
      await evaluateDaily(db, config, now);
      await evaluateNotices(db, config, now);
    }
    if (gap) await usageEvent(db, `usage-coverage:${beijingDate(now)}`, "configuration_missing", { reason: gap });
    const open = await db<{ id: string; scope: Scope; opened_at: Date }[]>`SELECT id,scope,opened_at FROM ai.usage_breakers WHERE state='open'`;
    for (const row of open)
      if (beijingDate(row.opened_at) !== beijingDate(now))
        await usageEvent(
          db,
          `${row.id}:reminder:${beijingDate(now)}`,
          "opened",
          { ...(await usageBreakerRecord(db, row.id)), reminder: true },
          row.scope.lane,
          row.scope.capability,
        );
    const [unknown] = await db<
      { amount: string; oldest: Date | null }[]
    >`SELECT coalesce(sum(reserved_micros),0)::text AS amount,min(occurred_at) AS oldest FROM ai.usage_attempts WHERE state='unknown'`;
    if (
      BigInt(unknown!.amount) >= BigInt(config.config.unknown_alert.amount_micros) ||
      (unknown!.oldest && now.getTime() - unknown!.oldest.getTime() >= config.config.unknown_alert.oldest_age_seconds * 1000)
    )
      await usageEvent(db, `unknown-usage:${beijingDate(now)}`, "unknown_usage", { micros: unknown!.amount, oldest: unknown!.oldest?.toISOString() ?? null });
    return { missing: gap ? [gap] : [] };
  });
}
async function currentUsageIndicators(db: Db, configuration: Configuration, openTriggers: Array<{ trigger: string; scope: Scope }>, now: Date) {
  const b = configuration.config.breaker,
    ratio = ratioMicros(b.warning_ratio),
    out: Array<{ trigger: string; scope: Scope | null; current: Record<string, string>; threshold: Record<string, string>; level: string }> = [];
  const [repeated] = await db<
    { logical_key: string; n: number }[]
  >`SELECT logical_key,(count(*)-1)::int AS n FROM ai.usage_attempts WHERE submitted AND state<>'failed' AND occurred_at>=${new Date(now.getTime() - b.repeat_window_seconds * 1000)} GROUP BY logical_key ORDER BY count(*) DESC,logical_key LIMIT 1`;
  const [repeatScope] = repeated
    ? await db<
        { lane: "news" | "policy"; capability: string; source_ids: string[] }[]
      >`SELECT lane,capability,source_ids FROM ai.usage_attempts WHERE logical_key=${repeated.logical_key} ORDER BY occurred_at DESC LIMIT 1`
    : [];
  const repeats = repeated?.n ?? 0,
    warn = Math.min(b.repeat_count - 1, Number((BigInt(b.repeat_count) * ratio) / MICRO));
  const level = (trigger: string, warning: boolean, lane?: string) =>
    openTriggers.some((b) => b.trigger === trigger && (!lane || b.scope.lane === lane)) ? "tripped" : warning ? "warning" : "normal";
  out.push({
    trigger: "repeated_input",
    scope: repeatScope
      ? capabilityScope(repeatScope.lane, repeatScope.capability, repeatScope.source_ids.length === 1 ? repeatScope.source_ids[0]! : null)
      : null,
    current: { repeats: String(repeats) },
    threshold: { limit: String(b.repeat_count), warning: String(warn) },
    level: level("repeated_input", !!repeated && repeats >= warn),
  });
  for (const lane of ["news", "policy"] as const) {
    const [row] = await db<
      { context: { object_kind: "article" | "policy"; object_id: string }; amount: string }[]
    >`SELECT context,(settled_micros+unknown_micros)::text AS amount FROM ai.usage_sums WHERE kind='object' AND context->>'lane'=${lane} ORDER BY settled_micros+unknown_micros DESC,key LIMIT 1`;
    const amount = BigInt(row?.amount ?? "0"),
      limit = BigInt(lane === "policy" ? b.policy_object_micros : b.news_object_micros);
    out.push({
      trigger: "object_cost",
      scope: row ? { lane, kind: "object", capability: null, source_id: null, ...row.context } : null,
      current: { micros: amount.toString(), lane },
      threshold: { micros: limit.toString(), warning_micros: ((limit * ratio) / MICRO).toString() },
      level: level("object_cost", amount * MICRO >= limit * ratio, lane),
    });
  }
  const daily = await dailyMeasurement(db, configuration, now);
  out.push({
    trigger: "daily_total",
    scope: null,
    current: { micros: daily.today.toString(), history_micros: daily.sum.toString(), history_days: String(daily.days) },
    threshold: { multiple: b.daily_multiple, floor_micros: b.daily_floor_micros, no_history_micros: b.daily_no_history_micros, warning_ratio: b.warning_ratio },
    level: level("daily_total", daily.warning),
  });
  return out;
}
export async function readUsageProtection(db: Db = sql) {
  const [configuration, prices, breakers, events] = await Promise.all([
    usageConfiguration(db),
    db<{ id: string; version: number; price: unknown; updated_at: Date }[]>`SELECT id,version,price,updated_at FROM ai.usage_prices ORDER BY id`,
    db<
      { id: string }[]
    >`SELECT id FROM ai.usage_breakers WHERE state='open' OR id IN (SELECT id FROM ai.usage_breakers ORDER BY created_at DESC LIMIT 200) ORDER BY created_at DESC`,

    db`SELECT id,kind,lane,payload,created_at,delivery_status,sent_at FROM ai.usage_protection_events ORDER BY created_at DESC LIMIT 200`,
  ]);
  const missing = !configuration ? ["费用保护配置尚未安装"] : (await usageCoverageGap(db, configuration, new Date())) ? ["存在未纳入费用保护的历史回执"] : [];
  const records = await Promise.all(breakers.map((r) => usageBreakerRecord(db, r.id)));
  let initial_config: UsageConfig | null = null;
  try {
    initial_config = UsageProtectionConfig.parse(JSON.parse(await readFile(path.join(REPO_ROOT, "industry/usage-controls.json"), "utf8")));
  } catch {
    /* Missing template never installs defaults or opens the paid gate. */
  }

  return UsageProtectionOverview.parse({
    initial_config,
    as_of: new Date().toISOString(),
    indicators:
      configuration && !missing.length
        ? await currentUsageIndicators(
            db,
            configuration,
            records.filter((r) => r.state === "open"),
            new Date(),
          )
        : [],
    configuration,
    prices: prices.map((r) => UsagePriceRecord.parse({ ...r, updated_at: r.updated_at.toISOString() })),
    breakers: records,
    events: events.map((r) => UsageProtectionEvent.parse({ ...r, created_at: r.created_at.toISOString(), sent_at: r.sent_at?.toISOString() ?? null })),
    missing,
  });
}
