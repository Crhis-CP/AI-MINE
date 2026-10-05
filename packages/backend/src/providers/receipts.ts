// Paid requests (models, Jina, Dajiala) go through here.
//
// 1. A logical request has a stable key bound to task, input revision, provider, model, prompt and config.
// 2. Before calling, a placeholder row and an attempt row are persisted; budgets count attempts.
// 3. The raw response is saved before any business write; recovery reuses a received response.
// 4. A request whose outcome is unknown (timeout after sending, crash mid-flight) is not re-sent by the
//    caller or a timer. Only evidence that it was not billed can permit another paid attempt.
import { dbOf, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";

const sql = dbOf("ai-gateway");

export class BudgetExceededError extends Error {
  readonly service: string;
  readonly retryAfterSeconds: number;
  constructor(service: string, window: string, retryAfterSeconds: number) {
    super(`Budget for ${service} exhausted (${window})`);
    this.service = service;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ReceiptBusyError extends Error {}
export class ReceiptAttemptSupersededError extends Error {}
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
    super(`Receipt ${receiptId} reached its translation output retry limit (${rejected})`);
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

/** Raised by a call when the provider clearly did not accept (and will not bill) the request. */
export class ProviderRejectedError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

export interface CallOutcome {
  response: unknown;
  requestId?: string | null;
  usage?: Record<string, unknown> | null;
  cost?: { amount: number; currency: string; basis: "actual" | "estimated" } | null;
}

export interface ReceiptRequest {
  service: string;
  model?: string | null;
  purpose: string;
  subject?: string | null;
  /** Everything that determines the output. Hashed into the logical key; only a redacted summary is stored. */
  identity: unknown;
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

export interface ReceiptResult {
  receiptId: number;
  response: unknown;
  reused: boolean;
  attemptId: string | null;
}

const PENDING_STALE_MS = 10 * 60 * 1000;
const knownTranslationUsage = (usage: Record<string, unknown> | null) =>
  [usage?.prompt_tokens, usage?.completion_tokens].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);

async function translationBlocker(db: Db, stage: string | null, logicalKey: string) {
  if (!stage) return null;
  const rows = await db<
    {
      id: number;
      id_text: string;
      status: string;
      usage: Record<string, unknown> | null;
      attempt_id: string | null;
      known_unbilled: boolean;
      has_response: boolean;
      receipt_version: number;
    }[]
  >`
    SELECT r.id,r.id::text AS id_text,CASE WHEN a.id IS NULL AND r.attempts<>o.receipt_version THEN 'unknown' ELSE coalesce(a.status,r.status) END AS status,
      a.usage,o.attempt_id,o.known_unbilled,r.response IS NOT NULL AS has_response,o.receipt_version
    FROM ai.translation_receipt_observations o JOIN receipts r ON r.id=o.receipt_id
      LEFT JOIN receipt_attempts a ON a.id::text=o.attempt_id AND a.receipt_id=r.id AND a.attempt=o.receipt_version
    WHERE o.scope=${stage} AND r.logical_key<>${logicalKey} ORDER BY r.id`;
  for (const row of rows) {
    if (row.known_unbilled) continue;
    if (row.status === "failed" && row.attempt_id === null && !row.has_response) {
      await db`UPDATE ai.translation_receipt_observations SET known_unbilled=true
        WHERE scope=${stage} AND receipt_id=${row.id_text} AND receipt_version=${row.receipt_version} AND attempt_id IS NULL`;
      continue;
    }
    if (row.attempt_id !== null && (row.status === "failed" || (row.status === "received" && knownTranslationUsage(row.usage)))) continue;
    if (row.attempt_id !== null && row.status === "pending") return { kind: "busy" as const, row };
    return { kind: "unknown" as const, row };
  }
  return null;
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
  const identity = sha256(stableJson(req.identity));
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
    WHERE service = ${service} AND origin = 'live' AND started_at > now() - interval '1 day'`;
  const c = counts!;
  if (budget.per_minute <= 0 || budget.per_hour <= 0 || budget.per_day <= 0) {
    throw new BudgetExceededError(service, "stopped", 3600);
  }
  if (c.minute >= budget.per_minute) throw new BudgetExceededError(service, "minute", 60);
  if (c.hour >= budget.per_hour) throw new BudgetExceededError(service, "hour", 600);
  if (c.day >= budget.per_day) throw new BudgetExceededError(service, "day", 3600);
}

/**
 * Runs a paid request at most once per logical key and returns its raw response.
 * The caller parses the response and commits business results, then calls completeReceipt.
 */
export async function paidRequest(req: ReceiptRequest, call: () => Promise<CallOutcome>): Promise<ReceiptResult> {
  if (req.maxRejectedOutputs !== undefined && (![1, 3].includes(req.maxRejectedOutputs) || req.purpose !== "translate_body"))
    throw new Error("Only translation may opt into a rejected-output limit");
  const logicalKey = logicalKeyFor(req);
  const stage = req.maxRejectedOutputs === undefined ? null : (req.subject?.match(/^(article:[a-zA-Z0-9_-]+@[1-9][0-9]*)#[0-9]+$/)?.[1] ?? null);
  if (req.translationObservations?.length && !stage) throw new Error("Translation observations require an actual material stage");

  const claimed = await sql.begin(async (tx) => {
    // A changed recipe/input key cannot route around an unresolved call in this material stage.
    if (stage) await tx`SELECT pg_advisory_xact_lock(hashtext(${"translation:" + stage}))`;
    for (const receipt of req.translationObservations ?? []) await observeTranslation(tx, stage, receipt);
    // Serialise budget checks per service so concurrent workers cannot overshoot.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"budget:" + req.service}))`;
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
      if (existing.status === "received" || existing.status === "completed") {
        if (existing.response_bound && existing.attempt_id === null) throw new ReceiptAttemptSupersededError(`Receipt ${existing.id} stores an older attempt`);
        await observeTranslation(tx, stage, { receiptId: existing.id_text, attemptId: existing.attempt_id });
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
      // Count rejected physical outputs under the claim lock, before creating another paid attempt.
      if (req.maxRejectedOutputs !== undefined) {
        if (existing.has_response && !existing.response_bound) {
          await observeTranslation(tx, stage, { receiptId: existing.id_text, attemptId: null });
          return { kind: "reuse" as const, row: existing };
        }
        const [count] = await tx`SELECT count(*)::int AS n,
          CASE WHEN max(finished_at) + interval '5 minutes' > now()
            THEN greatest(1,extract(epoch FROM max(finished_at) + interval '5 minutes' - now())::int) ELSE 0 END AS cooldown
          FROM receipt_attempts WHERE receipt_id=${existing.id} AND output_rejected_at IS NOT NULL`;
        if (count!.n >= req.maxRejectedOutputs) return { kind: "limited" as const, id: existing.id, rejected: count!.n as number };
        if (count!.cooldown > 0) return { kind: "cooldown" as const, id: existing.id, seconds: count!.cooldown as number };
      }
      // failed: the provider did not take the request, or its answer was unusable; a new attempt is allowed.
      const blocked = await translationBlocker(tx, stage, logicalKey);
      if (blocked) return blocked;
      if (stage && !existing.has_response)
        await tx`UPDATE ai.translation_receipt_observations SET known_unbilled=true
        WHERE receipt_id=${existing.id_text} AND receipt_version=(SELECT attempts FROM receipts WHERE id=${existing.id_text}) AND attempt_id IS NULL`;
      await checkBudget(tx, req.service);
      const [r] = await tx<{ attempts: number }[]>`
        UPDATE receipts SET status = 'pending', attempts = attempts + 1, error = NULL, completed_at = NULL, updated_at = now() WHERE id = ${existing.id} RETURNING attempts`;
      const attemptId = await startAttempt(tx, existing.id, r!.attempts, req);
      await observeTranslation(tx, stage, { receiptId: existing.id_text, attemptId });
      return { kind: "call" as const, id: existing.id, attemptId, attempt: r!.attempts };
    }
    const blocked = await translationBlocker(tx, stage, logicalKey);
    if (blocked) return blocked;
    await checkBudget(tx, req.service);
    const [row] = await tx<{ id: number; id_text: string }[]>`
      INSERT INTO receipts (logical_key, service, model, purpose, subject, status, request, attempts)
      VALUES (${logicalKey}, ${req.service}, ${req.model ?? null}, ${req.purpose}, ${req.subject ?? null}, 'pending',
              ${tx.json((req.requestSummary ?? {}) as never)}, 1)
      RETURNING id,id::text AS id_text`;
    const attemptId = await startAttempt(tx, row!.id, 1, req);
    await observeTranslation(tx, stage, { receiptId: row!.id_text, attemptId });
    return { kind: "call" as const, id: row!.id, attemptId, attempt: 1 };
  });

  if (claimed.kind === "reuse") return { receiptId: claimed.row.id, response: claimed.row.response, reused: true, attemptId: claimed.row.attempt_id };
  if (claimed.kind === "limited") throw new ReceiptOutputLimitError(claimed.id, claimed.rejected);
  if (claimed.kind === "cooldown") throw new ReceiptCooldownError(claimed.id, claimed.seconds);
  if (claimed.kind === "busy") throw new ReceiptBusyError(`Receipt ${claimed.row.id} is in flight`);
  if (claimed.kind === "unknown") {
    throw new ReceiptUnknownError(
      claimed.row.id,
      `Receipt ${claimed.row.id} has an unknown outcome; confirmation that it was not billed is required before retry`,
      claimed.row.attempt_id,
    );
  }

  const { id: receiptId, attemptId, attempt } = claimed;
  const started = Date.now();
  let outcome: CallOutcome;
  try {
    outcome = await call();
  } catch (error) {
    const status = error instanceof ProviderRejectedError ? "failed" : "unknown";
    // "unknown": the request may have reached the provider (timeout, reset): do not re-send automatically.
    const message = (error instanceof ProviderRejectedError ? error.message : String(error)).slice(0, 2000);
    await sql.begin(async (tx) => {
      await tx`UPDATE receipts SET status = ${status}, error = ${message}, updated_at = now() WHERE id = ${receiptId} AND attempts=${attempt}`;
      await tx`UPDATE receipt_attempts SET status = ${status}, error = ${message}, latency_ms = ${Date.now() - started}, finished_at = now() WHERE id = ${attemptId}`;
    });
    throw error;
  }

  const current = await sql.begin(async (tx) => {
    // Same lock order as stale recovery and settlement: receipt before its attempt.
    await tx`SELECT id FROM receipts WHERE id=${receiptId} FOR UPDATE`;
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
  return { receiptId, response: outcome.response, reused: false, attemptId };
}

async function startAttempt(tx: Db, receiptId: number, attempt: number, req: ReceiptRequest): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status) VALUES (${receiptId}, ${attempt}, ${req.service}, ${req.model ?? null}, 'pending')
    RETURNING id::text AS id`;
  return row!.id;
}

async function markUnknown(tx: Db, receiptId: number, reason: string) {
  const changed = await tx`UPDATE receipts SET status = 'unknown', error = ${reason}, updated_at = now() WHERE id = ${receiptId} AND status = 'pending'`;
  if (!changed.count) return;
  await tx`UPDATE receipt_attempts SET status = 'unknown', error = ${reason}, finished_at = now() WHERE receipt_id = ${receiptId} AND status = 'pending'`;
}

/**
 * Placeholders left behind by a process that stopped mid-request (crash, kill) become "unknown", so
 * the unresolved attempt stays visible even when no caller retries it; elapsed time never releases it.
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
    const knownUsage = knownTranslationUsage(row.usage);
    // Missing usage preserves received/completed: validation cannot silently authorize another payment.
    if (knownUsage && row.status !== "failed")
      await db`UPDATE receipts SET status='failed',error=${verdict.reason.slice(0, 2000)},updated_at=now() WHERE id=${receipt.receiptId}`;
  }
  const [count] = await db`SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id=${receipt.receiptId} AND output_rejected_at IS NOT NULL`;
  return { rejected: count!.n as number };
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
  return row?.finish === "length" && knownTranslationUsage(row.usage);
}
