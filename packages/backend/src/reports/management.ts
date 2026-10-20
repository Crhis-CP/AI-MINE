import { AdminReportList, NewsReportPeriod, ReportReconcileRequest, ReportReconcileResponse, routes } from "@amp/contracts/http/private";
import { SITE } from "@amp/industry/site";
import { sql } from "../db.ts";
import { actorOf, audit, requireActiveAdmin, type AdminPrincipal } from "@amp/backend/admin/auth";
import { Conflict } from "@amp/backend/admin/sources";
import { isReportWithdrawn } from "@amp/backend/publication/reports";
import { sha256, stableJson } from "../lib/ids.ts";
import { requestReportRevision } from "./revision-state.ts";

export async function managedReports(input: unknown, principal: AdminPrincipal) {
  const query = routes.adminReports.schema.querystring.parse(input);
  const rows = await sql.begin("read only", async (tx) => {
    await requireActiveAdmin(principal, tx);
    return tx<
      {
        kind: "daily" | "weekly" | "monthly";
        key: string;
        revision: number | null;
        origin: string | null;
        first_published_at: Date | null;
        last_revised_at: Date | null;
        content: Record<string, unknown> | null;
        state: string | null;
        requested_at: Date | null;
        checked_at: Date | null;
        next_attempt_at: Date | null;
        lease_until: Date | null;
        result: string | null;
        message: string | null;
      }[]
    >`WITH periods AS (
      SELECT kind,key FROM reports WHERE kind=${query.kind}
      UNION SELECT kind,key FROM reports.reconciliation_jobs WHERE kind=${query.kind}
    )
    SELECT p.kind,p.key,r.revision,r.origin,r.first_published_at,r.last_revised_at,r.content,
      j.state,j.requested_at,j.checked_at,j.next_attempt_at,j.lease_until,j.result,j.message
    FROM periods p LEFT JOIN reports r ON r.kind=p.kind AND r.key=p.key
    LEFT JOIN reports.reconciliation_jobs j ON j.kind=p.kind AND j.key=p.key
    WHERE (${query.before ?? null}::text IS NULL OR p.key<${query.before ?? null}) ORDER BY p.key DESC LIMIT ${query.limit + 1}`;
  });
  const page = rows.slice(0, query.limit);
  return AdminReportList.parse({
    items: page.map((row) => ({
      kind: row.kind,
      key: row.key,
      revision: row.revision ?? 0,
      origin: row.origin,
      title: `${SITE.name} ${row.kind === "daily" ? "日报" : row.kind === "weekly" ? "周报" : "月报"} · ${row.key}`,
      generationStatus: row.content?.correctionPending
        ? "pending"
        : ["ready", "pending", "failed", "summary"].includes(String(row.content?.generationStatus))
          ? row.content!.generationStatus
          : row.revision
            ? "summary"
            : "pending",
      firstPublishedAt: row.first_published_at?.toISOString() ?? null,
      lastRevisedAt: row.last_revised_at?.toISOString() ?? null,
      reconciliation: row.state
        ? {
            state: row.state,
            requestedAt: row.requested_at!.toISOString(),
            checkedAt: row.checked_at?.toISOString() ?? null,
            nextAttemptAt: ["pending", "retry", "running"].includes(row.state) ? ((row.lease_until ?? row.next_attempt_at)?.toISOString() ?? null) : null,
            result: row.result,
            message: row.message,
          }
        : null,
    })),
    nextKey: rows.length > query.limit ? page.at(-1)!.key : null,
  });
}

/** A durable command, not a synchronous model call. The existing sweep supplies delivery and recovery. */
export async function requestManagedReport(period: unknown, input: unknown, principal: AdminPrincipal, command: string) {
  const { kind, key } = NewsReportPeriod.parse(period),
    body = ReportReconcileRequest.parse(input),
    actor = actorOf(principal);
  if (!/^[\w-]{8,80}$/.test(command)) throw Object.assign(new Error("请求编号无效"), { statusCode: 400 });
  const fingerprint = sha256(stableJson({ kind, key, ...body }));
  return sql.begin(async (tx) => {
    await requireActiveAdmin(principal, tx);
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`report-command:${actor}:${command}`}))`;
    const [previous] = await tx<
      { request_hash: string; response: unknown }[]
    >`SELECT request_hash,response FROM reports.reconciliation_commands WHERE actor=${actor} AND command_key=${command}`;
    if (previous) {
      if (previous.request_hash !== fingerprint) throw new Conflict("此请求编号已用于另一项操作，请重新提交。");
      return ReportReconcileResponse.parse(previous.response);
    }
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`withdrawal:news:report:${kind}:${key}`}))`;
    const [report] = await tx<{ revision: number; origin: string }[]>`SELECT revision,origin FROM reports WHERE kind=${kind} AND key=${key} FOR UPDATE`;
    const [pending] = await tx<{ state: string }[]>`SELECT state FROM reports.reconciliation_jobs WHERE kind=${kind} AND key=${key} FOR UPDATE`;
    if (!report && !pending) return null;
    const revision = report?.revision ?? 0;
    if (revision !== body.expectedRevision) throw new Conflict("报告版本已变化，请刷新后重新核对。");
    const status = (await isReportWithdrawn("news", kind, key, tx))
      ? "withdrawn"
      : report?.origin === "manual"
        ? "preserved_manual"
        : pending && ["pending", "running"].includes(pending.state)
          ? "already_pending"
          : "queued";
    if (status === "queued") await requestReportRevision(kind, key, "operator_request", [], tx);
    const response = ReportReconcileResponse.parse({ kind, key, revision, status });
    await tx`INSERT INTO reports.reconciliation_commands(actor,command_key,request_hash,response)
      VALUES(${actor},${command},${fingerprint},${tx.json(response)})`;
    await audit(actor, "report.reconcile", `${kind}:${key}`, body.reason, { revision }, response, command, tx);
    return response;
  });
}
