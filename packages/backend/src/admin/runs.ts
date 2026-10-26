import { resumePolicyAfterReceipt } from "../policy/receipt-recovery.ts";
import { recoverUnknownOnce } from "../providers/unknown-recovery.ts";
import { releaseUnknownReceiptUnbilled, MANUAL_UNBILLED_NOTE_PREFIX } from "@amp/backend/providers/receipts";
import { readCurrentBody, resetFailedMaterialForRetry } from "@amp/backend/content/materials";
// Runs view: task timeline, queue backlog, source lag, error classes, process
// heartbeats, and the receipts and deliveries whose outcome needs an operator.
import { sql, type Tx, type Db } from "../db.ts";
import { audit, requireOwner, type AdminPrincipal } from "./auth.ts";
import { Conflict } from "./sources.ts";
import { failureGroupSql, queueProcessing, requeueFailed } from "../jobs/content.ts";
import { currentScheduledJobs } from "../jobs/schedule-status.ts";
import { QUEUES } from "../jobs/queue.ts";
import { enqueueJob as enqueue } from "../jobs/module-queues.ts";
import { EVENT_CONTINUATIONS } from "../events/queues.ts";
import { CAPABILITIES } from "../editorial/models.ts";
import { ReceiptReleaseRequest, ReceiptVersionInput, type ReceiptVersionFields } from "@amp/contracts/http/private";
import { sha256, stableJson } from "../lib/ids.ts";
import { redactDatabaseConnection } from "../lib/operational-error.ts";
import { serverModules } from "../modules.ts";
import { recordedRunContext } from "../operations/run-context.ts";

const STALE_HEARTBEAT_MS = 3 * 60_000;

/** Worker recovery reads only the last completed result; running/failed attempts never advance it. */
export async function latestSuccessfulRunResult(job: string): Promise<unknown> {
  const [row] = await sql<{ detail: unknown }[]>`SELECT detail FROM job_runs
    WHERE job=${job} AND status='ok' ORDER BY started_at DESC,id DESC LIMIT 1`;
  return row?.detail ?? null;
}

/** Preserve the newest failure/unfinished observation, excluding only the exact invoking run. */
export async function previousRecordedRun(job: string) {
  const current = recordedRunContext.getStore();
  const [row] = await sql<{ id: string; started_at: Date; finished_at: Date | null; status: string; detail: unknown }[]>`
    SELECT id::text,started_at,finished_at,status,detail FROM job_runs
    WHERE job=${job} AND id IS DISTINCT FROM ${current?.job === job ? current.id : null}::bigint
    ORDER BY started_at DESC,job_runs.id DESC LIMIT 1`;
  return row ?? null;
}

/** Exact database text only: no Date/epoch conversion, I/O, or authentication semantics. */
export function receiptObservedVersion(input: ReceiptVersionFields): string {
  const { receiptId, attempts, updatedAtUtc } = ReceiptVersionInput.parse(input);
  return `rv1:${sha256(stableJson(["receipt-observation-v1", receiptId, attempts, updatedAtUtc]))}`;
}

export async function runsOverview() {
  const currentJobs = await currentScheduledJobs();
  const [heartbeats, latest, timeline, queues, failedJobs, lagging, receipts, receiptIssues, deliveries, errors, ingest] = await Promise.all([
    sql<
      { key: string; value: Record<string, unknown>; updated_at: Date }[]
    >`SELECT key, value, updated_at FROM settings WHERE key LIKE 'heartbeat.%' ORDER BY key`,
    sql`
      WITH latest AS (
        SELECT DISTINCT ON (job) job, started_at, finished_at, status, left(error, 400) AS error
        FROM job_runs WHERE job=ANY(${currentJobs}::text[]) ORDER BY job, started_at DESC,id DESC
      ), counts AS (
        SELECT job, count(*) FILTER (WHERE status = 'failed')::int AS failed_24h, count(*)::int AS runs_24h
        FROM job_runs WHERE job=ANY(${currentJobs}::text[]) AND started_at > now() - interval '24 hours' GROUP BY job
      )
      SELECT latest.*, coalesce(counts.failed_24h, 0) AS failed_24h, coalesce(counts.runs_24h, 0) AS runs_24h
      FROM latest LEFT JOIN counts USING (job) ORDER BY job`,
    sql`SELECT id, job, started_at, finished_at, status, left(error, 300) AS error FROM job_runs ORDER BY started_at DESC LIMIT 80`,
    sql<{ name: string; state: string; n: number; oldest: Date }[]>`
      SELECT name, state, count(*)::int AS n, min(created_on) AS oldest FROM pgboss.job
      WHERE state IN ('created', 'retry', 'active') GROUP BY 1, 2 ORDER BY 1, 2`,
    sql`
      SELECT name, count(*)::int AS failed, max(completed_on) AS last, left((array_agg(output::text ORDER BY completed_on DESC))[1], 300) AS last_output
      FROM pgboss.job WHERE state = 'failed' AND completed_on > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC`,
    sql`
      SELECT id, name, kind, health, fail_count, last_ok_at, last_fetch_at, next_fetch_at, interval_minutes, left(last_error, 200) AS last_error
      FROM sources
      WHERE enabled AND kind NOT IN ('mp_account', 'external')
        AND (health = 'failing' OR next_fetch_at < now() - interval '30 minutes' OR last_ok_at < now() - make_interval(mins => greatest(interval_minutes * 6, 360)))
      ORDER BY health = 'failing' DESC, next_fetch_at LIMIT 60`,
    sql<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM receipts WHERE created_at > now() - interval '7 days' GROUP BY 1`,
    sql`
      SELECT id, service, model, purpose, subject, status, attempts, left(error, 240) AS error, created_at, updated_at,
        id::text AS version_id, pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version_time FROM receipts
      WHERE status = 'unknown' OR (status = 'failed' AND updated_at > now() - interval '3 days') OR (status = 'pending' AND updated_at < now() - interval '15 minutes')
      ORDER BY status = 'unknown' DESC, updated_at DESC LIMIT 40`,
    sql`
      SELECT id, target_key, subject_kind, subject_id, status, attempts, left(response, 240) AS response, created_at, updated_at,retry_reason,retry_at,abandoned_at FROM deliveries
      WHERE abandoned_at IS NULL AND (status IN ('unknown', 'failed') OR (status = 'sending' AND updated_at < now() - interval '15 minutes'))
      ORDER BY status = 'unknown' DESC, updated_at DESC LIMIT 40`,
    sql`
      SELECT ${failureGroupSql()} AS error, count(*)::int AS n, max(discovered_at) AS last,
             (array_agg(id ORDER BY discovered_at DESC))[1] AS example
      FROM articles WHERE processing_state = 'failed' AND discovered_at > now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
    sql`SELECT client, kind, status, left(error, 200) AS error, summary, created_at FROM ingest_events ORDER BY created_at DESC LIMIT 20`,
  ]);
  // Articles waiting to retry after a passing provider problem (they are not failed).
  const [retrying] = await sql<{ n: number; next: Date | null }[]>`
    SELECT count(*)::int AS n, min(processing_retry_at) AS next FROM articles WHERE processing_state = 'new' AND processing_attempts > 0`;
  const now = Date.now();
  // Existing records may predate safe task logging. Redact even if SQL already truncated the URI.
  for (const row of [...latest, ...timeline, ...failedJobs]) {
    if (typeof row.error === "string") row.error = redactDatabaseConnection(row.error);
    if (typeof row.last_output === "string") row.last_output = redactDatabaseConnection(row.last_output);
  }
  const modules = await Promise.all(
    serverModules()
      .flatMap(({ name, admin }) => (admin?.runs ? [{ name, read: admin.runs }] : []))
      .map(async ({ name, read }) => {
        try {
          // Isolate serialization failures before they can break the complete dashboard response.
          return [name, { status: "ready", data: JSON.parse(JSON.stringify(await read())) }] as const;
        } catch {
          return [name, { status: "unavailable" }] as const;
        }
      }),
  );
  return {
    ...(modules.length ? { modules: Object.fromEntries(modules) } : {}),
    checkedAt: new Date(now).toISOString(),
    processes: heartbeats.map((h) => ({
      role: h.key.slice("heartbeat.".length),
      ...h.value,
      at: h.updated_at,
      alive: now - h.updated_at.getTime() < STALE_HEARTBEAT_MS,
    })),
    jobs: latest,
    timeline,
    queues,
    failedJobs,
    lagging,
    receipts: {
      counts: Object.fromEntries(receipts.map((r) => [r.status, r.n])),
      issues: receiptIssues.map(({ version_id, version_time, ...row }) => ({
        ...row,
        version: receiptObservedVersion({ receiptId: version_id, attempts: row.attempts, updatedAtUtc: version_time }),
      })),
    },
    deliveries,
    errors,
    retrying: { count: retrying?.n ?? 0, next: retrying?.next ?? null },
    ingest,
  };
}

const ARTICLE_STEPS = new Set([
  ...(["prefilter", "score", "understand", "summarize", "wording", "structure"] as const).flatMap((step) => CAPABILITIES[step].purposes),
  "body_fallback",
]);

/**
 * Confirmed non-billing permits another attempt. Receipt, attempt, audit and any processing job
 * commit together; concurrent confirmations cannot release or queue the same receipt twice.
 */
type ReceiptVersion = { attempts: number; version: string };

async function release(id: number, error: string, actor: string, note: string, billed: false, db: Db, observed: ReceiptVersion) {
  const before = await releaseUnknownReceiptUnbilled(db, id, error, observed);
  if (!before) throw new Conflict("这条回执已被其他操作处理，请刷新后重试");
  const requeued = await resumeReceiptWork(before, db);
  await audit(
    actor,
    "receipt.release",
    `receipt:${id}`,
    note,
    { status: "unknown", attempts: observed.attempts, updatedAt: observed.version },
    { status: "failed", billed, requeued },
    undefined,
    db,
  );
  return { id, status: "failed", subject: before.subject, purpose: before.purpose, requeued };
}

/** Existing endpoint can confirm non-billing; billed reconciliation needs the separate amount contract. */
export async function releaseReceipt(id: number, input: unknown, actor: string, principal?: AdminPrincipal) {
  if (principal) await requireOwner(principal);
  const parsed = ReceiptReleaseRequest.safeParse(input);
  if (!parsed.success) throw Object.assign(new Error("请重新读取回执版本，并填写供应商未计费的核对依据"), { statusCode: 400 });
  const data = parsed.data;
  const [row] = await sql<(ReceiptVersion & { status: string; version_id: string; version_time: string })[]>`
    SELECT status, attempts, updated_at::text AS version, id::text AS version_id,
      pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version_time FROM receipts WHERE id = ${id}`;
  if (!row) return null;
  if (row.status !== "unknown") throw new Conflict("只有结果未知的回执需要人工核对");
  if (data.version !== receiptObservedVersion({ receiptId: row.version_id, attempts: row.attempts, updatedAtUtc: row.version_time }))
    throw new Conflict("回执已变化，请重新读取并核对本次尝试的计费依据");
  if (data.billed) throw new Conflict("已计费但结果未取回：须完成金额核销，当前不能放行或重新发起付费调用");
  const note = data.note;
  const error = `${MANUAL_UNBILLED_NOTE_PREFIX}${note}`;
  return sql.begin(async (tx) => {
    if (principal) await requireOwner(principal, tx);
    return release(id, error, actor, note, false, tx, row);
  });
}

/** Restore the original stage; grouping and translation never buy scoring again. */
async function resumeReceiptWork(row: { purpose: string; subject: string | null; request: unknown }, db: Db) {
  const request = row.request && typeof row.request === "object" ? (row.request as Record<string, unknown>) : null;
  // Old shared receipts keep their recovery; isolated evaluations never resume production work.
  if (request?.usage_purpose === "evaluation" && request.receipt_scope === "evaluation-v1") return false;
  if (await resumePolicyAfterReceipt(row.request, db)) return true;
  if (["translate_body", "group_article", "group_review", "group_signal"].includes(row.purpose)) {
    const pattern =
      row.purpose === "translate_body" ? /^article:([a-zA-Z0-9_-]+)@([1-9][0-9]*)#[0-9]+$/ : /^article:([a-zA-Z0-9_-]+)@([1-9][0-9]*)(?::fact:[1-9][0-9]*)?$/;
    const subject = pattern.exec(row.subject ?? "");
    const current = subject ? await readCurrentBody(subject[1]!, db) : null;
    if (!current || current.revision !== Number(subject![2])) return false;
    const translation = row.purpose === "translate_body";
    return !!(await enqueue(
      translation ? QUEUES.translate : QUEUES.group,
      { articleId: current.id, lane: "news", ...(row.purpose === "group_signal" ? { signalOnly: true } : {}) },
      { singletonKey: current.id },
      db,
    ));
  }
  if (["group_story", "group_story_review"].includes(row.purpose)) {
    const match = /^story:([1-9][0-9]*):([1-9][0-9]*)$/.exec(row.subject ?? "");
    const ids = match?.slice(1).map(Number);
    if (!ids?.every(Number.isSafeInteger)) return false;
    const storyIds = [...new Set(ids)].sort((a, b) => a - b);
    return !!(await enqueue(EVENT_CONTINUATIONS.consolidate, { lane: "news", storyIds }, { singletonKey: storyIds.join(":") }, db));
  }
  if (row.purpose === "story_digest") {
    const match = /^story:([1-9][0-9]*)@[0-9]+$/.exec(row.subject ?? "");
    const storyId = Number(match?.[1]);
    if (!Number.isSafeInteger(storyId)) return false;
    return !!(await enqueue(QUEUES.digest, { lane: "news", storyId }, { singletonKey: `story:${storyId}` }, db));
  }
  const subject = ARTICLE_STEPS.has(row.purpose) ? /^article:([a-zA-Z0-9_-]+)(?:@([1-9][0-9]*))?$/.exec(row.subject ?? "") : null;
  if (!subject || (!subject[2] && row.purpose !== "body_fallback")) return false;
  const stale = new Error("The receipt belongs to an older material revision");
  try {
    return await (db as Tx).savepoint(async (tx) => {
      if (!(await resetFailedMaterialForRetry(tx, subject[1]!))) return false;
      const current = await readCurrentBody(subject[1]!, tx);
      if (!current || (subject[2] && current.revision !== Number(subject[2]))) throw stale;
      return !!(await queueProcessing(current.id, { db: tx }));
    });
  } catch (error) {
    if (error === stale) return false;
    throw error;
  }
}

/** One automatic release; the original uncertain charge remains available for reconciliation. */
export async function autoReleaseUnknownReceipts(now = Date.now()) {
  return recoverUnknownOnce(now, resumeReceiptWork);
}

/** Failed articles (one failure group, or all of the last 30 days) back into processing. */
export async function requeueFailedArticles(input: { group: string | null; reason: string }, actor: string) {
  if (!input.reason?.trim()) throw new Error("reason is required");
  const result = await requeueFailed(input.group);
  await audit(actor, "processing.requeue", input.group ? `failure:${input.group.slice(0, 80)}` : "failure:all", input.reason, null, result);
  return result;
}

/** An in-doubt delivery: confirmed as arrived, given up, or sent again after checking the group. */
export async function resolveDelivery(id: number, input: { outcome: "sent" | "drop" | "resend"; note: string }, actor: string) {
  if (!input.note?.trim()) throw new Error("note is required");
  const [before] = await sql<
    { status: string; version: string; abandoned_at: Date | null }[]
  >`SELECT status, abandoned_at, updated_at::text AS version FROM deliveries WHERE id = ${id}`;
  if (!before) return null;
  if (before.abandoned_at || (before.status !== "unknown" && before.status !== "failed")) throw new Conflict("这条投递不需要处理");
  let status: string;
  if (input.outcome === "sent") {
    const changed =
      await sql`UPDATE deliveries SET status = 'sent',retry_reason=null,retry_at=null,sent_at = coalesce(sent_at, now()), response = ${`人工确认已送达：${input.note}`}, updated_at = now()
      WHERE id = ${id} AND status IN ('unknown', 'failed') AND updated_at::text = ${before.version}`;
    if (!changed.count) throw new Conflict("这条投递已被其他操作处理，请刷新后重试");
    status = "sent";
  } else if (input.outcome === "drop") {
    const changed =
      await sql`UPDATE deliveries SET status = 'failed',abandoned_at=now(),retry_reason=null,retry_at=null,response = ${`人工放弃：${input.note}`}, updated_at = now()
      WHERE id = ${id} AND status IN ('unknown', 'failed') AND updated_at::text = ${before.version}`;
    if (!changed.count) throw new Conflict("这条投递已被其他操作处理，请刷新后重试");
    status = "failed";
  } else {
    const { resendDelivery } = await import("../notify/deliver.ts");
    status = (await resendDelivery(id, before.version)).status;
  }
  await audit(actor, `delivery.${input.outcome}`, `delivery:${id}`, input.note, { status: before.status }, { status });
  return { id, status };
}
