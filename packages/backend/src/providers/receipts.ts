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
  constructor(receiptId: number, message: string) {
    super(message);
    this.receiptId = receiptId;
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
  maxRejectedOutputs?: 3;
}

export interface ReceiptResult {
  receiptId: number;
  response: unknown;
  reused: boolean;
  attemptId: string | null;
}

const PENDING_STALE_MS = 10 * 60 * 1000;

export function logicalKeyFor(req: ReceiptRequest): string {
  const identity = sha256(stableJson(req.identity));
  return [req.service, req.purpose, req.model ?? "-", identity, req.attemptTag ?? "0"].join(":");
}

interface ReceiptRow {
  id: number;
  status: string;
  response: unknown;
  attempt_id: string | null;
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
  if (req.maxRejectedOutputs !== undefined && (req.maxRejectedOutputs !== 3 || req.purpose !== "translate_body"))
    throw new Error("Only translation may opt into the three rejected-output limit");
  const logicalKey = logicalKeyFor(req);

  const claimed = await sql.begin(async (tx) => {
    // Serialise budget checks per service so concurrent workers cannot overshoot.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"budget:" + req.service}))`;
    const [existing] = await tx<ReceiptRow[]>`
      SELECT r.id,r.status,r.response,r.created_at,r.updated_at,r.response IS NOT NULL AS has_response,
        (a.id IS NOT NULL AND a.status='received' AND a.response IS NOT NULL AND a.response=r.response) AS response_bound,
        CASE WHEN a.attempt=r.attempts AND a.status='received' AND a.response IS NOT NULL AND a.response=r.response
          THEN a.id::text ELSE NULL END AS attempt_id
      FROM receipts r LEFT JOIN receipt_attempts a ON a.id=r.response_attempt_id AND a.receipt_id=r.id
      WHERE r.logical_key=${logicalKey} FOR UPDATE OF r`;
    if (existing) {
      if (existing.status === "received" || existing.status === "completed") {
        if (existing.response_bound && existing.attempt_id === null) throw new ReceiptAttemptSupersededError(`Receipt ${existing.id} stores an older attempt`);
        return { kind: "reuse" as const, row: existing };
      }
      if (existing.status === "pending") {
        if (Date.now() - existing.updated_at.getTime() < PENDING_STALE_MS) return { kind: "busy" as const, row: existing };
        await markUnknown(tx, existing.id, "placeholder went stale without a recorded result");
        return { kind: "unknown" as const, row: existing };
      }
      if (existing.status === "unknown") return { kind: "unknown" as const, row: existing };
      // Count rejected physical outputs under the claim lock, before creating another paid attempt.
      if (req.maxRejectedOutputs !== undefined) {
        if (existing.has_response && !existing.response_bound) return { kind: "reuse" as const, row: existing };
        const [count] = await tx`SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id=${existing.id} AND output_rejected_at IS NOT NULL`;
        if (count!.n >= req.maxRejectedOutputs) return { kind: "limited" as const, id: existing.id, rejected: count!.n as number };
      }
      // failed: the provider did not take the request, or its answer was unusable; a new attempt is allowed.
      await checkBudget(tx, req.service);
      const [r] = await tx<{ attempts: number }[]>`
        UPDATE receipts SET status = 'pending', attempts = attempts + 1, error = NULL, completed_at = NULL, updated_at = now() WHERE id = ${existing.id} RETURNING attempts`;
      const attemptId = await startAttempt(tx, existing.id, r!.attempts, req);
      return { kind: "call" as const, id: existing.id, attemptId, attempt: r!.attempts };
    }
    await checkBudget(tx, req.service);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO receipts (logical_key, service, model, purpose, subject, status, request, attempts)
      VALUES (${logicalKey}, ${req.service}, ${req.model ?? null}, ${req.purpose}, ${req.subject ?? null}, 'pending',
              ${tx.json((req.requestSummary ?? {}) as never)}, 1)
      RETURNING id`;
    const attemptId = await startAttempt(tx, row!.id, 1, req);
    return { kind: "call" as const, id: row!.id, attemptId, attempt: 1 };
  });

  if (claimed.kind === "reuse") return { receiptId: claimed.row.id, response: claimed.row.response, reused: true, attemptId: claimed.row.attempt_id };
  if (claimed.kind === "limited") throw new ReceiptOutputLimitError(claimed.id, claimed.rejected);
  if (claimed.kind === "busy") throw new ReceiptBusyError(`Receipt ${claimed.row.id} is in flight`);
  if (claimed.kind === "unknown") {
    throw new ReceiptUnknownError(
      claimed.row.id,
      `Receipt ${claimed.row.id} has an unknown outcome; confirmation that it was not billed is required before retry`,
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
    const knownUsage = [row.usage?.prompt_tokens, row.usage?.completion_tokens].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);
    // Missing usage preserves received/completed: validation cannot silently authorize another payment.
    if (knownUsage && row.status !== "failed")
      await db`UPDATE receipts SET status='failed',error=${verdict.reason.slice(0, 2000)},updated_at=now() WHERE id=${receipt.receiptId}`;
  }
  const [count] = await db`SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id=${receipt.receiptId} AND output_rejected_at IS NOT NULL`;
  return { rejected: count!.n as number };
}
