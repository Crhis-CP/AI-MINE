import { prepareModelQuota, type ModelQuotaAlias } from "./model-budget.ts";
import { admitUsage, reserveUsageAttempt, settleUsageAttempt, authorizeUsageSend, type UsageContext, type UsageReservation } from "./usage-protection.ts";
import { UNKNOWN_AUTO_RELEASE_NOTE } from "./unknown-recovery.ts";
import { rateYuan, type UsageBounds } from "./usage-pricing.ts";

import { assertRuntimeControl, requireRuntimeRunning, type RuntimeControlSnapshot } from "../operations/lane-controls.ts";
// Paid requests (models, Jina, Dajiala) go through here.
//
// 1. A logical request has a stable key bound to task, input revision, provider, model, prompt and config.
// 2. Before calling, a placeholder row and an attempt row are persisted; budgets count attempts.
// 3. The raw response is saved before any business write; recovery reuses a received response.
// 4. A request whose outcome is unknown (timeout after sending, crash mid-flight) is not re-sent by the
//    caller. Recovery may release it once after 30 minutes, preserving the unknown charge.
//    A billed answer that failed validation may be bought again at most twice; the saved response is reused after that.
import { sql, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { recordLocalReuse } from "./usage-accounting.ts";

export class BudgetExceededError extends Error {
  readonly service: string;
  readonly retryAfterSeconds: number;
  constructor(service: string, window: string, retryAfterSeconds: number) {
    super(`Budget for ${service} exhausted (${window})`);
    this.service = service;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class UsageProtectionError extends BudgetExceededError {
  readonly reason: string;
  readonly usageCode: string | null;
  constructor(service: string, reason: string, usageCode: string | null = null) {
    super(service, "usage_protection", 60);
    this.reason = reason;
    this.usageCode = usageCode;
    this.message = reason;
  }
}
export class ReceiptBusyError extends Error {}
export class ReceiptAttemptSupersededError extends Error {}
export class ReceiptPhysicalLimitError extends Error {}
export class ReceiptCooldownError extends Error {
  readonly receiptId: number;
  readonly retryAfterSeconds: number;
  constructor(receiptId: number, retryAfterSeconds: number) {
    super(`Receipt ${receiptId} translation retry cooling down (${retryAfterSeconds}s)`);
    this.receiptId = receiptId;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
export class ReceiptOutputLimitError extends Error {
  readonly receiptId: number;
  readonly rejected: number;
  constructor(receiptId: number, rejected: number) {
    super(`Receipt ${receiptId} reached its output retry limit (${rejected})`);
    this.receiptId = receiptId;
    this.rejected = rejected;
  }
}

export class ReceiptUnknownError extends Error {
  readonly receiptId: number;
  readonly attemptId: string | null;
  constructor(receiptId: number, message: string, attemptId: string | null = null) {
    super(message);
    this.receiptId = receiptId;
    this.attemptId = attemptId;
  }
}

/** Availability/refusal evidence; only explicitly proven pre-send or unbilled kinds clear billing uncertainty. */
export class ProviderRejectedError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  receiptId: number | null = null;
  attemptId: string | null = null;
  readonly failureKind:
    | "provider_unbilled"
    | "connect_before_send"
    | "input_changed"
    | "configuration_changed"
    | "unproven"
    | "provider_outage"
    | "provider_refused";
  constructor(
    message: string,
    status: number | null,
    retryable: boolean,
    failureKind:
      | "provider_unbilled"
      | "connect_before_send"
      | "input_changed"
      | "configuration_changed"
      | "unproven"
      | "provider_outage"
      | "provider_refused" = "provider_unbilled",
  ) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.failureKind = failureKind;
  }
}

export interface CallOutcome {
  response: unknown;
  requestId?: string | null;
  usage?: Record<string, unknown> | null;
  cost?: { amount: number | string; currency: string; basis: "actual" | "estimated" } | null;
}

export interface PolicyReceiptContext {
  lane: "policy";
  category: "policy_fulltext" | "policy_interpret";
  sourceIds: string[];
  manifestHash: string;
  inputFingerprint: string;
  permissionVersions: Record<string, number>;
  partIds?: string[];
  manifest: unknown;
}

export interface ModelAttemptSnapshot {
  connection_id: string | null;
  connection_revision: number | null;
  configuration_hash: string;
  key_fingerprint: string | null;
  pricing?: { input: string; output: string; currency: "CNY"; basis: string };
}
export interface ReceiptRequest {
  /** Persist the chosen pair when a real alternate receipt is reused or claimed. Not a spending exemption. */
  fallbackFor?: { primaryKey: string; routeRevision: number };
  /** Explicit caller send cap; durable received responses remain reusable. */
  maxPhysicalAttempts?: 1;
  usageContext?: UsageContext;
  costBounds?: UsageBounds;
  modelSnapshot?: ModelAttemptSnapshot;
  service: string;
  /** Shared service quota; does not alter billing identity or the paid-result cache key. */
  budgetService?: string;
  budgetAliases?: ModelQuotaAlias[];
  lane?: "news" | "policy";
  runtimeControl?: RuntimeControlSnapshot;
  model?: string | null;
  purpose: string;
  subject?: string | null;
  /** Everything that determines the output. Hashed into the logical key; only a redacted summary is stored. */
  identity: unknown;
  /** Exact pre-configuration-hash identity, only for safe cache migration. */
  legacyIdentity?: unknown;
  legacyModel?: string | null;
  policy?: PolicyReceiptContext;
  /** Stored for diagnosis; must not contain secrets. */
  requestSummary?: Record<string, unknown>;
  /** Distinguishes an explicit re-run (e.g. admin "re-evaluate") from recovery of the same request. */
  attemptTag?: string;
  /** Translation opts in; existing capabilities keep their current retry behavior. */
  maxRejectedOutputs?: 1 | 3;
  translationObservations?: TranslationObservation[];
}

export interface TranslationObservation {
  receiptId: string;
  attemptId: string | null;
}

/** Read-only admission evidence; the gateway still claims and checks every actual retry. */
export async function retryableTranslationSubjects(
  candidates: (TranslationObservation & { subject: string; maxRejectedOutputs: 1 | 3 })[],
): Promise<Set<string>> {
  if (!candidates.length) return new Set();
  const receiptIds = [...new Set(candidates.map((row) => row.receiptId))];
  const rows = await sql<{ receiptId: string; attemptId: string; subject: string; rejected: number; identical: boolean }[]>`
    SELECT r.id::text AS "receiptId",a.id::text AS "attemptId",r.subject,budget.rejected,budget.identical
    FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id AND a.id=r.response_attempt_id AND a.attempt=r.attempts
      AND a.status='received' AND a.output_rejected_at IS NOT NULL AND a.response IS NOT NULL AND a.response=r.response
      AND coalesce(a.response->'choices'->0->>'finish_reason','') IN ('','stop')
    JOIN LATERAL (
      SELECT count(*)::int AS rejected,
        count(*) FILTER(WHERE status='received')>=2
        AND count(content) FILTER(WHERE status='received')=count(*) FILTER(WHERE status='received')
        AND count(DISTINCT content) FILTER(WHERE status='received')=1 AS identical
      FROM (SELECT status,response->'choices'->0->'message'->>'content' AS content FROM receipt_attempts
        WHERE receipt_id=r.id AND output_rejected_at IS NOT NULL) outputs
    ) budget ON true WHERE r.id=ANY(${receiptIds}::bigint[]) AND r.purpose='translate_body' AND r.status='failed'`;
  const budgets = new Map(rows.map((row) => [row.receiptId, row]));
  return new Set(
    candidates
      .filter((candidate) => {
        const row = budgets.get(candidate.receiptId);
        return (
          row &&
          row.attemptId === candidate.attemptId &&
          row.subject === candidate.subject &&
          row.rejected > 0 &&
          row.rejected < candidate.maxRejectedOutputs &&
          !row.identical
        );
      })
      .map((candidate) => candidate.subject),
  );
}

export interface ReceiptResult {
  receiptId: number;
  response: unknown;
  reused: boolean;
  attemptId: string | null;
}

const PENDING_STALE_MS = 10 * 60 * 1000;
const knownTranslationUsage = (usage: Record<string, unknown> | null) =>
  [usage?.prompt_tokens, usage?.completion_tokens].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);

async function recordFallbackAttempt(db: Db, req: ReceiptRequest, receiptId: number, attemptId: string | null): Promise<void> {
  if (!req.fallbackFor) return;
  const changed =
    await db`UPDATE ai.model_fallback_resolutions SET backup_receipt_id=${receiptId},backup_attempt_id=${attemptId},accepted_at=NULL,updated_at=now()
    WHERE primary_key=${req.fallbackFor.primaryKey} AND route_revision=${req.fallbackFor.routeRevision}
      AND backup_model=${req.service} AND backup_configuration_hash=${req.modelSnapshot?.configuration_hash ?? null}`;
  if (changed.count !== 1) throw new ReceiptBusyError("备用配置已变化，等待任务重新读取");
}

/** The independent policy intake retains its existing preview-cost guard. */
async function policyPreviewReceiptBlocker(db: Db, req: ReceiptRequest, logicalKey: string, lane: string | undefined) {
  if (
    lane !== "policy" ||
    req.service !== "jina" ||
    req.purpose !== "source_listing" ||
    req.requestSummary?.source_preview !== true ||
    !req.subject?.startsWith("source:")
  )
    return null;
  const [row] = await db<{ id: number; status: string; attempt_id: string | null }[]>`SELECT r.id,r.status,a.id::text AS attempt_id
    FROM receipts r LEFT JOIN receipt_attempts a ON a.receipt_id=r.id AND a.attempt=r.attempts
    WHERE r.service='jina' AND r.purpose='source_listing' AND r.subject=${req.subject} AND r.logical_key<>${logicalKey}
      AND coalesce(r.request->>'lane','news')=${lane ?? "news"} AND r.status IN ('pending','unknown') ORDER BY r.id LIMIT 1`;
  if (!row) return null;
  return row.status === "pending" ? { kind: "busy" as const, row } : { kind: "unknown" as const, row };
}

async function observeTranslation(db: Db, stage: string | null, receipt: TranslationObservation) {
  if (!stage) return;
  const rows = await db<{ version: number }[]>`SELECT coalesce(a.attempt,r.attempts) AS version FROM receipts r
    LEFT JOIN receipt_attempts a ON a.id::text=${receipt.attemptId} AND a.receipt_id=r.id
    WHERE r.id=${receipt.receiptId} AND r.purpose='translate_body' AND (${receipt.attemptId === null} OR a.id IS NOT NULL)`;
  if (!rows.length) throw new Error("Translation observation has no matching actual receipt/attempt");
  // The counter locates the observation; only the independently verified opaque id proves an attempt.
  await db`INSERT INTO ai.translation_receipt_observations(scope,receipt_id,receipt_version,attempt_id)
    VALUES(${stage},${receipt.receiptId},${rows[0]!.version},${receipt.attemptId}) ON CONFLICT(scope,receipt_id,receipt_version)
    DO UPDATE SET attempt_id=coalesce(translation_receipt_observations.attempt_id,EXCLUDED.attempt_id),
      known_unbilled=CASE WHEN EXCLUDED.attempt_id IS NOT NULL THEN false ELSE translation_receipt_observations.known_unbilled END`;
}

async function observeOriginalTranslation(db: Db, stage: string | null) {
  if (!stage) return;
  // Before observations/checkpoints existed, only the original subject proves this material's use.
  // A received response needs its own pointer; the current ordinal alone cannot prove its provenance.
  const rows = await db<{ id: string; attempt_id: string | null }[]>`
    SELECT r.id::text AS id,CASE WHEN r.status IN ('pending','unknown') THEN ca.id::text
      WHEN a.attempt=r.attempts AND a.status='received' AND a.response IS NOT NULL AND a.response=r.response
        THEN a.id::text ELSE NULL END AS attempt_id
    FROM receipts r LEFT JOIN receipt_attempts ca ON ca.receipt_id=r.id AND ca.attempt=r.attempts
      LEFT JOIN receipt_attempts a ON a.id=r.response_attempt_id AND a.receipt_id=r.id
    WHERE r.purpose='translate_body' AND r.subject ~ ${"^" + stage + "(#[0-9]+)?$"}
      AND r.status IN ('pending','unknown','received','completed') ORDER BY r.id FOR UPDATE OF r`;
  for (const row of rows) await observeTranslation(db, stage, { receiptId: row.id, attemptId: row.attempt_id });
}

export function logicalKeyFor(req: ReceiptRequest): string {
  const identity = sha256(stableJson(req.policy ? { input: req.identity, policy: req.policy } : req.identity));
  return [req.service, req.purpose, req.model ?? "-", identity, req.attemptTag ?? "0"].join(":");
}

interface ReceiptRow {
  id: number;
  id_text: string;
  status: string;
  response: unknown;
  attempt_id: string | null;
  current_attempt_id: string | null;
  has_response: boolean;
  response_bound: boolean;
  created_at: Date;
  updated_at: Date;
}

export class PolicyPartLimitError extends Error {
  readonly partIds: string[];
  constructor(partIds: string[]) {
    super("Policy parts already have two provider attempts");
    this.partIds = partIds;
  }
}
async function checkPolicyPartLimit(tx: Db, req: ReceiptRequest) {
  const ids = req.purpose === "policy_fulltext" ? req.policy?.partIds : null;
  if (!ids?.length) return;
  const rows = await tx<{ parts: string[] }[]>`SELECT r.request->'partIds' AS parts
    FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id WHERE r.purpose='policy_fulltext'
      AND r.request->'partIds' ?| ${ids}::text[] AND a.origin='live'
      AND (a.failure_kind IS NULL OR a.failure_kind NOT IN ('usage_blocked','input_changed','configuration_changed','connect_before_send'))`;
  const blocked = ids.filter((id) => rows.filter((row) => row.parts.includes(id)).length >= 2);
  if (blocked.length) throw new PolicyPartLimitError(blocked);
}

type PolicyReceiptRecord = {
  receiptId: number;
  attemptId: string;
  response: unknown;
  request: { manifest?: { upstream_artifacts?: { kind: string; id: string; version: string; content_hash: string; manifest_id: string }[] } };
};
/** Recorded physical responses are authoritative; never synthesize an attempt from an ordinal. */
export async function readPolicyPartResponses(partIds: string[], recipe: string) {
  if (!partIds.length) return [];
  const rows = await sql<PolicyReceiptRecord[]>`
    SELECT r.id AS "receiptId",a.id::text AS "attemptId",a.response,r.request
    FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id AND a.id=r.response_attempt_id
    WHERE r.purpose='policy_fulltext' AND a.status='received' AND a.response IS NOT NULL
      AND r.request->'partIds' ?| ${partIds}::text[] ORDER BY a.started_at DESC`;
  return rows.filter((row) =>
    row.request.manifest?.upstream_artifacts?.some((a) => a.kind === "policy_part" && partIds.includes(a.id) && a.version === recipe),
  );
}

/** Exact current physical response for downstream policy checkpoints; no ordinal or subject guessing. */
export async function readPolicyResponse(receipt: { receiptId: number; attemptId: string }) {
  const [row] = await sql<
    {
      receiptId: number;
      attemptId: string;
      purpose: string;
      model: string | null;
      service: string;
      configuration_hash: string | null;
      connection_id: string | null;
      connection_revision: number | null;
      status: string;
      response: unknown;
      request: Record<string, unknown>;
      usage: Record<string, unknown> | null;
    }[]
  >`
    SELECT r.id AS "receiptId",a.id::text AS "attemptId",r.purpose,a.model,a.service,r.status,a.response,r.request,a.usage,ms.configuration_hash,ms.connection_id,ms.connection_revision
    FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id AND a.id=r.response_attempt_id AND a.attempt=r.attempts
    LEFT JOIN ai.model_attempt_snapshots ms ON ms.attempt_id=a.id
    WHERE r.id=${receipt.receiptId} AND a.id::text=${receipt.attemptId} AND a.status='received' AND a.response=r.response
      AND r.purpose IN ('policy_fulltext','policy_group','policy_interpret','policy_verify','policy_vision') AND r.origin='live' AND a.origin='live'`;
  return row ? { ...row, knownUsage: knownTranslationUsage(row.usage) } : null;
}

/** Recovery never resets an in-flight or unknown paid attempt. The receipt recovery flow owns its release. */
export async function receiptWaitingForRecovery(receiptId: number, db: Db = sql): Promise<boolean> {
  const [row] = await db<{ status: string }[]>`SELECT status FROM receipts WHERE id=${receiptId}`;
  return !row || row.status === "pending" || row.status === "unknown";
}

/** A new grouping recipe may replace a known rejected answer, never an unknown or in-flight attempt. */
export async function changedGroupingRecipeReceipts(
  inputs: Array<{ receiptId: string; subject: string }>,
  promptVersion: string,
  limit: number,
  db: Db,
): Promise<Map<string, string>> {
  if (!inputs.length || !promptVersion) return new Map();
  const subjects = new Map(inputs.map((row) => [row.receiptId, row.subject]));
  const rows = await db<{ id: string; subject: string }[]>`SELECT r.id::text AS id,r.subject FROM receipts r
    JOIN receipt_attempts a ON a.id=r.response_attempt_id AND a.receipt_id=r.id AND a.attempt=r.attempts
    WHERE r.id=ANY(${inputs.map((row) => row.receiptId)}::bigint[]) AND r.purpose='group_article'
      AND r.origin='live' AND a.origin='live' AND r.status='failed' AND a.status='received'
      AND r.response IS NOT NULL AND a.response=r.response AND r.request->>'lane'='news'
      AND jsonb_typeof(r.request->'promptVersion')='string' AND r.request->>'promptVersion'<>''
      AND r.request->>'promptVersion'<>${promptVersion}
      AND r.error LIKE 'unusable output: %Every candidate and any unknown query scope require an explicit answer%'
    ORDER BY r.created_at,r.id LIMIT ${Math.max(1, Math.min(limit, 100))}`;
  return new Map(rows.filter((row) => subjects.get(row.id) === row.subject).map((row) => [row.id, row.subject] as const));
}

/** Known successful grouping answers only; a non-null recipe excludes that recipe's completions. No paid text is returned. */
export async function completedGroupingRecipeReceipts(inputs: Array<{ receiptId: string; subject: string }>, promptVersion: string | null, db: Db) {
  if (!inputs.length) return new Map<string, string>();
  const subjects = new Map(inputs.map((row) => [row.receiptId, row.subject]));
  const rows = await db<{ id: string; subject: string }[]>`SELECT r.id::text AS id,r.subject FROM receipts r
    JOIN receipt_attempts a ON a.id=r.response_attempt_id AND a.receipt_id=r.id AND a.attempt=r.attempts
    WHERE r.id=ANY(${inputs.map((row) => row.receiptId)}::bigint[]) AND r.purpose='group_article'
      AND r.origin='live' AND a.origin='live' AND r.status='completed' AND a.status='received'
      AND r.response IS NOT NULL AND a.response=r.response AND r.request->>'lane'='news'
      AND r.request->>'promptVersion' LIKE 'group-batch+group-value@%'
      AND (${promptVersion}::text IS NULL OR r.request->>'promptVersion'<>${promptVersion})`;
  return new Map(rows.filter((row) => subjects.get(row.id) === row.subject).map((row) => [row.id, row.subject]));
}

/** Recover a just-failed JSON parse from the real response pointer; callers still verify the exact input hashes. */
export async function readPolicyResponseForReceipt(receiptId: number) {
  const [row] = await sql<{ attemptId: string | null }[]>`SELECT response_attempt_id::text AS "attemptId" FROM receipts WHERE id=${receiptId}`;
  return row?.attemptId ? readPolicyResponse({ receiptId, attemptId: row.attemptId }) : null;
}

/** Same immutable derived input after a restart/control renewal; the consumer still verifies every input hash. */
export async function readPolicyStageResponses(stageId: string) {
  const rows = await sql<{ receiptId: number; attemptId: string }[]>`SELECT id AS "receiptId",response_attempt_id::text AS "attemptId" FROM receipts
    WHERE purpose IN ('policy_group','policy_interpret','policy_verify','policy_vision') AND origin='live' AND response_attempt_id IS NOT NULL
      AND request->'manifest'->'upstream_artifacts' @> ${sql.json([{ kind: "policy_stage_input", id: stageId }])}::jsonb ORDER BY id DESC`;
  return (await Promise.all(rows.map((row) => readPolicyResponse(row)))).filter((row) => row !== null);
}

export async function settlePolicyResponse(db: Db, receipt: { receiptId: number; attemptId: string | null }, accepted: boolean | null) {
  const [row] = await db<{ usage: Record<string, unknown> | null }[]>`SELECT a.usage FROM receipts r JOIN receipt_attempts a ON a.id=r.response_attempt_id
    WHERE r.id=${receipt.receiptId} AND a.id::text=${receipt.attemptId} AND a.receipt_id=r.id AND a.attempt=r.attempts
      AND r.purpose IN ('policy_fulltext','policy_group','policy_interpret','policy_verify','policy_vision') AND a.status='received' AND a.response=r.response FOR UPDATE OF r,a`;
  if (!row) return null;
  if (accepted) await completeReceipt(db, receipt.receiptId);
  else if (accepted === false) await db`UPDATE receipts SET status='failed',error='policy candidate rejected',updated_at=now() WHERE id=${receipt.receiptId}`;
  return { knownUsage: knownTranslationUsage(row.usage) };
}

async function checkPolicyReceipts(tx: Db, context?: PolicyReceiptContext) {
  if (!context) return;
  const rows = await tx<
    {
      id: number;
      status: string;
      error: string | null;
      attempt_error: string | null;
      attempt_id: string | null;
      attempt_status: string | null;
      usage: Record<string, unknown> | null;
      response: unknown;
    }[]
  >`
    SELECT r.id,r.status,r.error,a.error AS attempt_error,a.id::text AS attempt_id,a.status AS attempt_status,a.usage,a.response
    FROM receipts r LEFT JOIN receipt_attempts a ON a.receipt_id=r.id AND a.attempt=r.attempts
    WHERE r.request->>'lane'='policy' AND r.request->'sourceIds' ?| ${context.sourceIds}::text[]
      AND (r.status IN ('pending','unknown') OR a.status IN ('pending','unknown','received')) ORDER BY r.id`;
  for (const row of rows) {
    if (
      row.status === "failed" &&
      row.attempt_status === "unknown" &&
      row.error?.startsWith(UNKNOWN_AUTO_RELEASE_NOTE) &&
      row.attempt_error?.startsWith(UNKNOWN_AUTO_RELEASE_NOTE)
    )
      continue;
    if (row.status === "pending" || row.attempt_status === "pending") throw new ReceiptBusyError(`Policy source receipt ${row.id} is in flight`);
    if (row.status === "unknown" || row.attempt_status === "unknown")
      throw new ReceiptUnknownError(row.id, "Policy source has an unresolved request outcome; regrouping cannot permit another payment", row.attempt_id);
  }
}

async function checkBudget(tx: Db, service: string): Promise<void> {
  const [budget] = await tx<{ per_minute: number; per_hour: number; per_day: number }[]>`
    SELECT per_minute, per_hour, per_day FROM budgets WHERE service = ${service}`;
  if (!budget) return; // default rows come with the migrations; a service an operator removed is unlimited
  // Every request sent counts, retries of the same logical request included.
  const [counts] = await tx<{ minute: number; hour: number; day: number }[]>`
    SELECT
      count(*) FILTER (WHERE started_at > now() - interval '1 minute') AS minute,
      count(*) FILTER (WHERE started_at > now() - interval '1 hour') AS hour,
      count(*) AS day
    FROM receipt_attempts
    WHERE coalesce(quota_service,service) = ${service} AND origin = 'live' AND started_at > now() - interval '1 day'`;
  const c = counts!;
  if (budget.per_minute <= 0 || budget.per_hour <= 0 || budget.per_day <= 0) {
    throw new BudgetExceededError(service, "stopped", 3600);
  }
  if (c.minute >= budget.per_minute) throw new BudgetExceededError(service, "minute", 60);
  if (c.hour >= budget.per_hour) throw new BudgetExceededError(service, "hour", 600);
  if (c.day >= budget.per_day) throw new BudgetExceededError(service, "day", 3600);
}

async function legacyModelReceipt(db: Db, req: ReceiptRequest) {
  if (req.legacyIdentity === undefined) return null;
  const legacyKey = logicalKeyFor({ ...req, model: req.legacyModel ?? req.model, identity: req.legacyIdentity });
  const [exact] = await db<
    ReceiptRow[]
  >`SELECT r.id,r.id::text AS id_text,r.status,r.response,r.created_at,r.updated_at,r.response IS NOT NULL AS has_response,ca.id::text AS current_attempt_id,
 (a.id IS NOT NULL AND a.status='received' AND a.response IS NOT NULL AND a.response=r.response) AS response_bound,
 CASE WHEN a.attempt=r.attempts AND a.status='received' AND a.response=r.response THEN a.id::text ELSE NULL END AS attempt_id
 FROM receipts r LEFT JOIN receipt_attempts a ON a.id=r.response_attempt_id AND a.receipt_id=r.id
 LEFT JOIN receipt_attempts ca ON ca.receipt_id=r.id AND ca.attempt=r.attempts
 WHERE r.logical_key=${legacyKey} AND r.status IN ('received','completed') FOR UPDATE OF r`;
  if (exact) {
    if (exact.response_bound && exact.attempt_id === null) throw new ReceiptAttemptSupersededError("Legacy receipt stores an older physical attempt");
    await recordLocalReuse(db, {
      service: req.service,
      model: req.model,
      purpose: req.purpose,
      lane: req.policy?.lane ?? req.lane ?? req.runtimeControl?.lane ?? req.usageContext?.lane ?? "unknown",
    });
    return { kind: "reuse" as const, row: exact };
  }
  const hash = typeof req.requestSummary?.userHash === "string" ? req.requestSummary.userHash : null;
  const [unresolved] = await db<
    ReceiptRow[]
  >`SELECT r.id,r.id::text AS id_text,r.status,r.response,r.created_at,r.updated_at,r.response IS NOT NULL AS has_response,a.id::text AS current_attempt_id,false AS response_bound,a.id::text AS attempt_id
 FROM receipts r LEFT JOIN receipt_attempts a ON a.receipt_id=r.id AND a.attempt=r.attempts LEFT JOIN ai.model_attempt_snapshots ms ON ms.attempt_id=a.id
 WHERE r.model IS NOT NULL AND r.status IN ('pending','unknown') AND ms.configuration_hash IS NULL
 AND (r.request->>'lane' IS NULL OR r.request->>'lane'=${req.policy?.lane ?? req.lane ?? req.runtimeControl?.lane ?? req.usageContext?.lane ?? null})
 AND (r.logical_key=${legacyKey} OR (${!!req.policy} AND r.purpose=${req.purpose} AND r.subject IS NOT DISTINCT FROM ${req.subject ?? null} AND ${hash}::text IS NOT NULL AND r.request->>'userHash'=${hash}))
 ORDER BY r.id LIMIT 1 FOR UPDATE OF r`;
  if (!unresolved) return null;
  if (unresolved.status === "pending" && Date.now() - unresolved.updated_at.getTime() < PENDING_STALE_MS) return { kind: "busy" as const, row: unresolved };
  if (unresolved.status === "pending") await markUnknown(db, unresolved.id, "Legacy attempt outcome remains unknown after configuration hashing upgrade");
  return { kind: "unknown" as const, row: unresolved };
}

/**
 * Runs a paid request at most once per logical key and returns its raw response.
 * The caller parses the response and commits business results, then calls completeReceipt.
 */
export async function paidRequest(req: ReceiptRequest, call: () => Promise<CallOutcome>, beforeAttempt?: (tx: Db) => Promise<void>): Promise<ReceiptResult> {
  if (req.maxRejectedOutputs !== undefined && (![1, 3].includes(req.maxRejectedOutputs) || req.purpose !== "translate_body"))
    throw new Error("Only translation may opt into a rejected-output limit");
  const knownLane = req.policy?.lane ?? req.lane ?? req.runtimeControl?.lane ?? req.usageContext?.lane;
  if (knownLane && !["news", "policy"].includes(knownLane)) throw new Error("Invalid receipt lane");
  const { lane: _summaryLane, ...summary } = req.requestSummary ?? {};
  const requestMetadata = {
    ...(req.usageContext ? { sourceIds: req.usageContext.sourceIds, usage_object: req.usageContext.object } : {}),
    ...summary,
    ...(req.policy ?? {}),
    ...(knownLane ? { lane: knownLane } : {}),
    ...(req.budgetService ? { quota_service: req.budgetService } : {}),
  };
  const quotaService = req.budgetService ?? req.service;
  if (!quotaService.trim()) throw new Error("A request service is required");
  const logicalKey = logicalKeyFor(req);
  const usageInputKey = sha256(stableJson([req.service, req.model ?? null, req.purpose, req.identity]));
  const article = /^article:([a-zA-Z0-9_-]+@[1-9][0-9]*)/.exec(req.subject ?? "");
  const usageContext =
    req.usageContext ??
    (knownLane
      ? {
          lane: knownLane,
          capability: req.purpose,
          sourceIds: req.policy?.sourceIds ?? [],
          object: article ? { kind: "article" as const, id: article[1]! } : null,
        }
      : null);
  const usageAdmission = (tx: Db) =>
    admitUsage(tx, {
      context: usageContext,
      subject: req.subject,
      logicalKey: usageInputKey,
      service: req.service,
      model: req.model,
      configurationHash: req.modelSnapshot?.configuration_hash,
      bounds: req.costBounds,
      registeredPricing: req.modelSnapshot?.pricing,
    });
  const stage = req.maxRejectedOutputs === undefined ? null : (req.subject?.match(/^(article:[a-zA-Z0-9_-]+@[1-9][0-9]*)#[0-9]+$/)?.[1] ?? null);
  if (req.translationObservations?.length && !stage) throw new Error("Translation observations require an actual material stage");

  if (req.budgetService) await prepareModelQuota(req.budgetService, req.service, req.modelSnapshot, req.budgetAliases);
  const claimed = await sql.begin(async (tx) => {
    for (const sourceId of [...new Set(req.policy?.sourceIds ?? [])].sort()) await tx`SELECT pg_advisory_xact_lock(hashtext(${`policy-source:${sourceId}`}))`;
    // Serialize the translation output-repair cap; unknown outcomes are held by their own logical key.
    if (stage) await tx`SELECT pg_advisory_xact_lock(hashtext(${"translation:" + stage}))`;
    for (const receipt of req.translationObservations ?? []) await observeTranslation(tx, stage, receipt);
    // Serialise budget checks per service so concurrent workers cannot overshoot.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"budget:" + quotaService}))`;
    await observeOriginalTranslation(tx, stage);
    const [existing] = await tx<ReceiptRow[]>`
      SELECT r.id,r.id::text AS id_text,r.status,r.response,r.created_at,r.updated_at,r.response IS NOT NULL AS has_response,ca.id::text AS current_attempt_id,
        (a.id IS NOT NULL AND a.status='received' AND a.response IS NOT NULL AND a.response=r.response) AS response_bound,
        CASE WHEN a.attempt=r.attempts AND a.status='received' AND a.response IS NOT NULL AND a.response=r.response
          THEN a.id::text ELSE NULL END AS attempt_id
      FROM receipts r LEFT JOIN receipt_attempts a ON a.id=r.response_attempt_id AND a.receipt_id=r.id
        LEFT JOIN receipt_attempts ca ON ca.receipt_id=r.id AND ca.attempt=r.attempts
      WHERE r.logical_key=${logicalKey} FOR UPDATE OF r`;
    if (existing) {
      await recordFallbackAttempt(tx, req, existing.id, existing.attempt_id ?? existing.current_attempt_id);
      if (existing.status === "received" || existing.status === "completed") {
        if (existing.response_bound && existing.attempt_id === null) throw new ReceiptAttemptSupersededError(`Receipt ${existing.id} stores an older attempt`);
        await observeTranslation(tx, stage, { receiptId: existing.id_text, attemptId: existing.attempt_id });
        await recordLocalReuse(tx, { service: req.service, model: req.model, purpose: req.purpose, lane: knownLane ?? "unknown" });
        return { kind: "reuse" as const, row: existing };
      }
      if (existing.status === "pending") {
        await observeTranslation(tx, stage, { receiptId: existing.id_text, attemptId: existing.current_attempt_id });
        if (Date.now() - existing.updated_at.getTime() < PENDING_STALE_MS) return { kind: "busy" as const, row: existing };
        await markUnknown(tx, existing.id, "placeholder went stale without a recorded result");
        return { kind: "unknown" as const, row: { ...existing, attempt_id: existing.current_attempt_id } };
      }
      if (existing.status === "unknown") {
        await observeTranslation(tx, stage, { receiptId: existing.id_text, attemptId: existing.current_attempt_id });
        return { kind: "unknown" as const, row: { ...existing, attempt_id: existing.current_attempt_id } };
      }
      // A downstream validator may reject a filter response, but that never authorizes another send to the refusing route.
      if (
        existing.response_bound &&
        (existing.response as { choices?: Array<{ finish_reason?: string }> } | null)?.choices?.[0]?.finish_reason === "content_filter"
      ) {
        await recordLocalReuse(tx, { service: req.service, model: req.model, purpose: req.purpose, lane: knownLane ?? "unknown" });
        return { kind: "reuse" as const, row: existing };
      }
      if (req.maxPhysicalAttempts === 1) {
        const [physical] =
          await tx`SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id=${existing.id} AND (failure_kind IS NULL OR failure_kind NOT IN ('usage_blocked','input_changed','configuration_changed'))`;
        if (physical!.n >= 1) throw new ReceiptPhysicalLimitError("备用接入已尝试一次，保留原回执并等待处理");
      }
      // Count rejected physical outputs under the claim lock, before creating another paid attempt.
      if (req.maxRejectedOutputs !== undefined) {
        if (existing.has_response && !existing.response_bound) {
          await observeTranslation(tx, stage, { receiptId: existing.id_text, attemptId: null });
          await recordLocalReuse(tx, { service: req.service, model: req.model, purpose: req.purpose, lane: knownLane ?? "unknown" });
          return { kind: "reuse" as const, row: existing };
        }
        const [count] = await tx`SELECT count(*)::int AS n,
          CASE WHEN max(finished_at) + interval '5 minutes' > now()
            THEN greatest(1,extract(epoch FROM max(finished_at) + interval '5 minutes' - now())::int) ELSE 0 END AS cooldown
          FROM receipt_attempts WHERE receipt_id=${existing.id} AND output_rejected_at IS NOT NULL`;
        if (count!.n >= req.maxRejectedOutputs) return { kind: "limited" as const, id: existing.id, rejected: count!.n as number };
        // The same finished answer was already bought twice. Keep that failure; do not pay for a third copy.
        if (count!.n >= 2) {
          const copies = await tx<{ content: string | null }[]>`
            SELECT response->'choices'->0->'message'->>'content' AS content
            FROM receipt_attempts
            WHERE receipt_id=${existing.id} AND output_rejected_at IS NOT NULL AND status='received'`;
          const first = copies[0]?.content;
          if (copies.length >= 2 && first != null && copies.every((row) => row.content === first))
            return { kind: "limited" as const, id: existing.id, rejected: copies.length };
        }
        if (count!.cooldown > 0) return { kind: "cooldown" as const, id: existing.id, seconds: count!.cooldown as number };
      }
      // A known output-limit truncation cannot finish under the same immutable request budget.
      // Retain/reuse its bound response until the caller changes the request configuration.
      if (
        req.model &&
        existing.response_bound &&
        (existing.response as { choices?: Array<{ finish_reason?: string }> } | null)?.choices?.[0]?.finish_reason === "length"
      ) {
        await recordLocalReuse(tx, { service: req.service, model: req.model, purpose: req.purpose, lane: knownLane ?? "unknown" });
        return { kind: "reuse" as const, row: existing };
      }
      // Count real returned attempts, including missing usage, before another bounded output retry.
      if (req.maxRejectedOutputs === undefined && existing.has_response) {
        const [counts] = await tx<{ stored: number }[]>`SELECT count(*)::int AS stored FROM receipt_attempts
          WHERE receipt_id=${existing.id} AND status='received' AND response IS NOT NULL`;
        if (counts && counts.stored >= 3) {
          // Report workers need a terminal verdict; paused/waiting turns are not physical outputs.
          if (req.purpose === "report_weekly" || req.purpose === "report_monthly")
            return { kind: "limited" as const, id: existing.id, rejected: counts.stored };
          await recordLocalReuse(tx, { service: req.service, model: req.model, purpose: req.purpose, lane: knownLane ?? "unknown" });
          return { kind: "reuse" as const, row: existing };
        }
      }
      // failed: the provider did not take the request, or its answer was unusable; a new attempt is allowed.
      const blocked = await policyPreviewReceiptBlocker(tx, req, logicalKey, knownLane);
      if (blocked) return blocked;
      if (stage && !existing.has_response)
        await tx`UPDATE ai.translation_receipt_observations SET known_unbilled=true
        WHERE receipt_id=${existing.id_text} AND receipt_version=(SELECT attempts FROM receipts WHERE id=${existing.id_text}) AND attempt_id IS NULL`;
      const legacy = await legacyModelReceipt(tx, req);
      if (legacy) return legacy;
      await checkPolicyReceipts(tx, req.policy);
      await checkPolicyPartLimit(tx, req);
      await checkBudget(tx, quotaService);
      // Preserve a deliberately stopped legacy connection without splitting new service counters.
      if (quotaService !== req.service) {
        const [held] = await tx`SELECT 1 FROM budgets WHERE service=${req.service} AND (per_minute=0 OR per_hour=0 OR per_day=0)`;
        if (held) throw new BudgetExceededError(req.service, "stopped", 3600);
      }
      const control = await requireRuntimeRunning(
        knownLane ?? "news",
        [!req.model && (req.service === "jina" || req.service === "dajiala") ? "collection" : "processing"],
        tx,
      );
      if (req.runtimeControl) {
        if (req.runtimeControl.lane !== control.lane || !control.switches.every((s) => req.runtimeControl!.switches.includes(s)))
          throw new Error("Runtime control scope mismatch");
        await assertRuntimeControl(tx, req.runtimeControl);
      }
      const usage = await usageAdmission(tx);
      if (!usage.reservation) return { kind: "usage_blocked" as const, reason: usage.blocked!, code: usage.code };
      await beforeAttempt?.(tx);
      const [r] = await tx<{ attempts: number }[]>`
        UPDATE receipts SET status = 'pending', attempts = attempts + 1, error = NULL, completed_at = NULL, updated_at = now() WHERE id = ${existing.id} RETURNING attempts`;
      const attemptId = await startAttempt(tx, existing.id, r!.attempts, req, usage.reservation);
      await reserveUsageAttempt(tx, attemptId, existing.id, usage.reservation);
      await recordFallbackAttempt(tx, req, existing.id, attemptId);
      await observeTranslation(tx, stage, { receiptId: existing.id_text, attemptId });
      return { kind: "call" as const, id: existing.id, attemptId, attempt: r!.attempts, control };
    }
    const blocked = await policyPreviewReceiptBlocker(tx, req, logicalKey, knownLane);
    if (blocked) return blocked;
    const legacy = await legacyModelReceipt(tx, req);
    if (legacy) return legacy;
    await checkPolicyReceipts(tx, req.policy);
    await checkPolicyPartLimit(tx, req);
    await checkBudget(tx, quotaService);
    // Preserve a deliberately stopped legacy connection without splitting new service counters.
    if (quotaService !== req.service) {
      const [held] = await tx`SELECT 1 FROM budgets WHERE service=${req.service} AND (per_minute=0 OR per_hour=0 OR per_day=0)`;
      if (held) throw new BudgetExceededError(req.service, "stopped", 3600);
    }
    const control = await requireRuntimeRunning(
      knownLane ?? "news",
      [!req.model && (req.service === "jina" || req.service === "dajiala") ? "collection" : "processing"],
      tx,
    );
    if (req.runtimeControl) {
      if (req.runtimeControl.lane !== control.lane || !control.switches.every((s) => req.runtimeControl!.switches.includes(s)))
        throw new Error("Runtime control scope mismatch");
      await assertRuntimeControl(tx, req.runtimeControl);
    }
    const usage = await usageAdmission(tx);
    if (!usage.reservation) return { kind: "usage_blocked" as const, reason: usage.blocked!, code: usage.code };
    await beforeAttempt?.(tx);
    const [row] = await tx<{ id: number; id_text: string }[]>`
      INSERT INTO receipts (logical_key, service, model, purpose, subject, status, request, attempts)
      VALUES (${logicalKey}, ${req.service}, ${req.model ?? null}, ${req.purpose}, ${req.subject ?? null}, 'pending',
              ${tx.json(requestMetadata as never)}, 1)
      RETURNING id,id::text AS id_text`;
    const attemptId = await startAttempt(tx, row!.id, 1, req, usage.reservation);
    await reserveUsageAttempt(tx, attemptId, row!.id, usage.reservation);
    await recordFallbackAttempt(tx, req, row!.id, attemptId);
    await observeTranslation(tx, stage, { receiptId: row!.id_text, attemptId });
    return { kind: "call" as const, id: row!.id, attemptId, attempt: 1, control };
  });

  if (claimed.kind === "usage_blocked") throw new UsageProtectionError(req.service, claimed.reason, claimed.code ?? null);
  if (claimed.kind === "reuse") return { receiptId: claimed.row.id, response: claimed.row.response, reused: true, attemptId: claimed.row.attempt_id };
  if (claimed.kind === "limited") throw new ReceiptOutputLimitError(claimed.id, claimed.rejected);
  if (claimed.kind === "cooldown") throw new ReceiptCooldownError(claimed.id, claimed.seconds);
  if (claimed.kind === "busy") throw new ReceiptBusyError(`Receipt ${claimed.row.id} is in flight`);
  if (claimed.kind === "unknown") {
    throw new ReceiptUnknownError(
      claimed.row.id,
      `Receipt ${claimed.row.id} has an unknown outcome; authorized recovery is required before retry`,
      claimed.row.attempt_id,
    );
  }

  const { id: receiptId, attemptId, attempt } = claimed;
  const started = Date.now();
  let outcome: CallOutcome;
  try {
    try {
      const blocked = await sql.begin(async (tx) => {
        await assertRuntimeControl(tx, claimed.control);
        return authorizeUsageSend(tx, attemptId);
      });
      if (blocked) throw new UsageProtectionError(req.service, blocked);
    } catch (error) {
      throw error instanceof UsageProtectionError ? error : new UsageProtectionError(req.service, "新的付费调用已暂停或控制版本发生变化");
    }
    outcome = await call();
  } catch (error) {
    const knownUnbilled =
      error instanceof ProviderRejectedError &&
      ["provider_unbilled", "connect_before_send", "provider_outage", "provider_refused", "input_changed", "configuration_changed"].includes(error.failureKind);
    const status = knownUnbilled || error instanceof UsageProtectionError ? "failed" : "unknown";
    const failureKind = error instanceof ProviderRejectedError ? error.failureKind : error instanceof UsageProtectionError ? "usage_blocked" : "unknown";
    // "unknown": the request may have reached the provider (timeout, reset): do not re-send automatically.
    const message = (error instanceof ProviderRejectedError ? error.message : String(error)).slice(0, 2000);
    await sql.begin(async (tx) => {
      await tx`UPDATE receipts SET status = ${status}, error = ${message}, updated_at = now() WHERE id = ${receiptId} AND attempts=${attempt}`;
      await tx`UPDATE receipt_attempts SET status = ${status}, failure_kind=${failureKind}, error = ${message}, latency_ms = ${Date.now() - started}, finished_at = now() WHERE id = ${attemptId}`;
      await settleUsageAttempt(tx, attemptId, status);
    });
    if (status === "unknown") throw new ReceiptUnknownError(receiptId, "调用结果或费用尚未确认，已保留回执并停止自动重发", attemptId);
    if (error instanceof ProviderRejectedError) {
      error.receiptId = receiptId;
      error.attemptId = attemptId;
    }
    throw error;
  }

  const current = await sql.begin(async (tx) => {
    // Same lock order as stale recovery and settlement: receipt before its attempt.
    await tx`SELECT id FROM receipts WHERE id=${receiptId} FOR UPDATE`;
    const recordedCost = await settleUsageAttempt(tx, attemptId, { usage: outcome.usage ?? null, cost: outcome.cost ?? null });
    // Keep actual foreign-currency bills; never turn them into guessed CNY. The protection ledger retains unknown reservation.
    if (!outcome.cost || outcome.cost.basis === "estimated") outcome.cost = recordedCost;
    // Always retain this attempt's actual return, even when a newer attempt already owns the receipt.
    await tx`UPDATE receipt_attempts SET status='received',response=${tx.json((outcome.response ?? null) as never)},
      request_id=${outcome.requestId ?? null},usage=${outcome.usage ? tx.json(outcome.usage as never) : null},
      cost=${outcome.cost?.amount ?? null},currency=${outcome.cost?.currency ?? null},cost_basis=${outcome.cost?.basis ?? null},
      latency_ms=${Date.now() - started},finished_at=now() WHERE id=${attemptId}`;
    const changed = await tx`UPDATE receipts r SET status='received',response=a.response,response_attempt_id=a.id,
      request_id=a.request_id,usage=a.usage,cost=a.cost,currency=a.currency,cost_basis=a.cost_basis,
      received_at=a.finished_at,updated_at=now()
      FROM receipt_attempts a WHERE a.id=${attemptId} AND r.id=a.receipt_id AND r.id=${receiptId} AND r.attempts=${attempt}`;
    return changed.count === 1;
  });
  if (!current) throw new ReceiptAttemptSupersededError(`Receipt ${receiptId} attempt ${attemptId} is no longer current`);
  await sql.begin((tx) => assertRuntimeControl(tx, claimed.control));
  return { receiptId, response: outcome.response, reused: false, attemptId };
}

async function startAttempt(tx: Db, receiptId: number, attempt: number, req: ReceiptRequest, usage: UsageReservation): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO receipt_attempts (receipt_id, attempt, service, quota_service, model, status) VALUES (${receiptId}, ${attempt}, ${req.service}, ${req.budgetService ?? req.service}, ${req.model ?? null}, 'pending')
    RETURNING id::text AS id`;
  if (req.modelSnapshot) {
    const snapshot = req.modelSnapshot;
    const price = usage.quote.price;
    const pricing =
      snapshot.pricing ??
      (price && price.input_per_million_micros !== null && price.output_per_million_micros !== null
        ? {
            input: rateYuan(price.input_per_million_micros),
            output: rateYuan(price.output_per_million_micros),
            currency: "CNY",
            basis: price.basis_url,
          }
        : { unknown: true });
    await tx`INSERT INTO ai.model_attempt_snapshots(attempt_id,connection_id,connection_revision,configuration_hash,key_fingerprint,pricing)
      VALUES(${row!.id},${snapshot.connection_id},${snapshot.connection_revision},${snapshot.configuration_hash},${snapshot.key_fingerprint},${tx.json(pricing)})`;
  }
  return row!.id;
}

async function markUnknown(tx: Db, receiptId: number, reason: string) {
  const changed = await tx`UPDATE receipts SET status = 'unknown', error = ${reason}, updated_at = now() WHERE id = ${receiptId} AND status = 'pending'`;
  if (!changed.count) return;
  await tx`UPDATE receipt_attempts SET status = 'unknown', error = ${reason}, finished_at = now() WHERE receipt_id = ${receiptId} AND status = 'pending'`;
}

/**
 * Placeholders left behind by a process that stopped mid-request (crash, kill) become "unknown", so
 * the unresolved attempt stays visible; a separate recovery pass may release it once after its grace period.
 */
export async function markStalePendingReceipts(): Promise<number> {
  return sql.begin(async (tx) => {
    const stale = await tx<{ id: number }[]>`SELECT id FROM receipts WHERE status = 'pending'
      AND updated_at < ${new Date(Date.now() - PENDING_STALE_MS)} FOR UPDATE SKIP LOCKED`;
    for (const r of stale) await markUnknown(tx, r.id, "placeholder went stale without a recorded result");
    return stale.length;
  });
}

export async function completeReceipt(db: Db, receiptId: number): Promise<void> {
  await db`UPDATE receipts SET status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now() WHERE id = ${receiptId} AND status IN ('received','completed')`;
}

/** Marks a received response that could not be used (e.g. unparsable) so a fresh attempt can be made. */
export async function rejectReceivedResponse(receiptId: number, reason: string, attemptId?: string | null): Promise<void> {
  await sql`UPDATE receipts SET status='failed',error=${reason.slice(0, 2000)},updated_at=now()
    WHERE id=${receiptId} AND status IN ('received','completed')
      AND (${attemptId === undefined} OR response_attempt_id::text IS NOT DISTINCT FROM ${attemptId ?? null})`;
}

/** Caller transaction binds translation state to this exact returned attempt; a stale writer changes nothing. */
export async function settleTranslationResponse(
  db: Db,
  receipt: Pick<ReceiptResult, "receiptId" | "attemptId">,
  verdict: { accepted: true } | { accepted: false; reason: string },
): Promise<{ rejected: number } | null> {
  if (receipt.attemptId === null) return null;
  const [row] = await db<{ status: string; usage: Record<string, unknown> | null; output_rejected_at: Date | null }[]>`
    SELECT r.status,a.usage,a.output_rejected_at FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id
    WHERE r.id=${receipt.receiptId} AND a.id=${receipt.attemptId} AND r.response_attempt_id=a.id AND r.attempts=a.attempt
      AND r.purpose='translate_body' AND a.status='received' AND a.response IS NOT NULL AND a.response=r.response
      AND r.status IN ('received','completed','failed') FOR UPDATE OF r,a`;
  if (!row || (verdict.accepted && (row.output_rejected_at || row.status === "failed"))) return null;
  if (verdict.accepted) {
    if (row.status !== "completed") await completeReceipt(db, receipt.receiptId);
  } else {
    await db`UPDATE receipt_attempts SET output_rejected_at=coalesce(output_rejected_at,now()) WHERE id=${receipt.attemptId}`;
    // A returned bad answer may consume a bounded retry; missing usage remains a cost-reconciliation issue.
    if (row.status !== "failed")
      await db`UPDATE receipts SET status='failed',error=${verdict.reason.slice(0, 2000)},updated_at=now() WHERE id=${receipt.receiptId}`;
  }
  const [count] = await db<
    { n: number }[]
  >`SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id=${receipt.receiptId} AND output_rejected_at IS NOT NULL`;
  return { rejected: count!.n };
}

/** A truncation branch requires this attempt's actual response/usage; never infer it from caller flags. */
export async function canReplaceTranslationResponse(db: Db, receipt: Pick<ReceiptResult, "receiptId" | "attemptId">): Promise<boolean> {
  if (receipt.attemptId === null) return false;
  const [row] = await db<{ usage: Record<string, unknown> | null; finish: string | null }[]>`
    SELECT a.usage,a.response->'choices'->0->>'finish_reason' AS finish FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id
    WHERE r.id=${receipt.receiptId} AND a.id=${receipt.attemptId} AND r.response_attempt_id=a.id AND r.attempts=a.attempt
      AND r.purpose='translate_body' AND r.status='received' AND a.status='received' AND a.response=r.response
      AND NOT EXISTS (SELECT 1 FROM receipt_attempts old WHERE old.receipt_id=r.id AND old.output_rejected_at IS NOT NULL)
    FOR UPDATE OF r,a`;
  return row?.finish === "length";
}

/** Called only after an operator's documented non-billing confirmation; CAS and settlement share its transaction. */
export const MANUAL_UNBILLED_NOTE_PREFIX = "人工核对：供应商未计费。";

export async function releaseUnknownReceiptUnbilled(db: Db, receiptId: number, error: string, observed: { attempts: number; version: string }) {
  const [before] = await db<{ subject: string | null; purpose: string; request: unknown }[]>`UPDATE receipts SET status='failed',error=${error},updated_at=now()
    WHERE id=${receiptId} AND status='unknown' AND attempts=${observed.attempts} AND updated_at::text=${observed.version} RETURNING subject,purpose,request`;
  if (!before) return null;
  const attempts = await db<{ id: string }[]>`UPDATE receipt_attempts SET status='failed',error=${error}
    WHERE receipt_id=${receiptId} AND attempt=${observed.attempts} AND status='unknown' RETURNING id::text`;
  for (const attempt of attempts) await settleUsageAttempt(db, attempt.id, "failed");
  return before;
}

/** Current-revision recovery permissions; retained unknown bills are never rewritten as unbilled. */
export async function releasedTranslationScopes(scopes: string[]): Promise<Set<string>> {
  if (!scopes.length) return new Set();
  const rows = await sql<{ scope: string; status: string; error: string | null; attempts: number; released_attempt: number; response_bound: boolean }[]>`
    SELECT substring(r.subject from '^(article:[a-zA-Z0-9_-]+@[1-9][0-9]*)') AS scope,
      r.status,r.error,r.attempts,old.attempt AS released_attempt,
      (current.response IS NOT NULL AND current.response=r.response) AS response_bound
    FROM receipts r JOIN receipt_attempts old ON old.receipt_id=r.id AND ((old.status='unknown' AND old.error LIKE ${UNKNOWN_AUTO_RELEASE_NOTE + "%"})
      OR (old.status='failed' AND old.error LIKE ${MANUAL_UNBILLED_NOTE_PREFIX + "%"}))
    LEFT JOIN receipt_attempts current ON current.id=r.response_attempt_id AND current.receipt_id=r.id
      AND current.attempt=r.attempts AND current.attempt>old.attempt AND current.status='received' AND current.output_rejected_at IS NULL
    WHERE r.purpose='translate_body' AND substring(r.subject from '^(article:[a-zA-Z0-9_-]+@[1-9][0-9]*)')=ANY(${scopes}::text[])`;
  return new Set(
    rows
      .filter(
        (row) =>
          (row.status === "failed" &&
            (row.error?.startsWith(UNKNOWN_AUTO_RELEASE_NOTE) || row.error?.startsWith(MANUAL_UNBILLED_NOTE_PREFIX)) &&
            row.attempts === row.released_attempt) ||
          (["received", "completed"].includes(row.status) && row.response_bound),
      )
      .map((row) => row.scope),
  );
}
