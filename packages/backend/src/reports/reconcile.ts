import type { PgBoss } from "pg-boss";
import { sql } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { lockNewsModelMaterials, newsMaterialBindings } from "@amp/backend/content/materials";
import { currentReportPublications, lockReportPublications } from "@amp/backend/publication/publish";
import { isReportWithdrawn } from "@amp/backend/publication/reports";
import { reportPublicInputs } from "@amp/backend/publication/groups";
import { readCurrentSourcePolicy, lockCurrentSourcePolicies } from "@amp/backend/admin/sources";
import { assertRuntimeControl, requireRuntimeRunning, runtimeControlSnapshot } from "../operations/lane-controls.ts";
import { completeReceipt, ReceiptOutputLimitError } from "../providers/receipts.ts";
import { modelFor } from "../editorial/models.ts";
import { recordRun } from "../jobs/queue.ts";
import { work } from "../jobs/module-queues.ts";
import { dailyDraft, periodContent } from "./draft.ts";
import { periodEntries } from "./edition.ts";
import { periodWindow, type ReportKind } from "./periods.ts";
import { writePeriod } from "./period-writing.ts";
import { reportMemberIds, storedReportEntries, type StoredReportContent } from "./references.ts";
import { RECONCILE_QUEUE, ensureReconciliationQueue, reportIsDue, preserveReportCalendar, requestReportDependents } from "./revision-state.ts";

type Report = {
  id: number;
  revision: number;
  content: StoredReportContent;
  origin: string;
  generated_at: Date;
};
/** Only factual selection and structure invalidate paid prose. Receipt reuse handles unchanged prompts. */
function facts(content: StoredReportContent) {
  const clean = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(clean)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => key !== "publicationRevision")
              .map(([key, v]) => [key, clean(v)]),
          )
        : value;
  return clean({
    lead: content.lead ?? null,
    sections: content.sections ?? [],
    themes: (content.themes ?? []).map((theme) => ({ heading: theme.heading, storyRefs: theme.storyRefs })),
    flashes: content.flashes ?? [],
    leadItemId: content.leadItemId ?? null,
    highlights: content.highlights ?? [],
    storyOrder: content.storyOrder ?? [],
    periodStart: content.periodStart ?? null,
    periodEnd: content.periodEnd ?? null,
  });
}
function sameFacts(a: StoredReportContent, b: StoredReportContent) {
  try {
    return stableJson(facts(a)) === stableJson(facts(b));
  } catch {
    // Malformed old JSON is revision evidence, never proof that the rebuilt issue is unchanged.
    return false;
  }
}
async function prepare(kind: ReportKind, key: string) {
  const range = periodWindow(kind, key);
  if (kind === "daily") return { ...(await dailyDraft(key, range.from, range.until)), range, top: [], period: null };
  const period = await periodEntries(range.start, range.end),
    top = period.entries.slice(0, kind === "weekly" ? 20 : 30);
  return {
    content: periodContent(kind, key, range.start, range.end, period, top, null),
    entries: top.length,
    waiting: !top.length,
    range,
    top,
    period,
  };
}
async function dailyDependencies(kind: ReportKind, key: string) {
  const range = periodWindow(kind, key);
  const start = kind === "daily" ? new Date(range.from.getTime() - 7 * 86400000).toISOString().slice(0, 10) : range.start;
  const end = kind === "daily" ? key : new Date(range.until.getTime() + 86400000).toISOString().slice(0, 10);
  return sql<{ key: string; revision: number }[]>`SELECT key,revision FROM reports WHERE kind='daily' AND key>=${start} AND key<=${end}
    AND (${kind}<>'daily' OR key<>${key}) ORDER BY key`;
}
/** One leased, bounded issue. No network call runs inside the commit transaction. */
export async function reconcileReport(kind: ReportKind, key: string) {
  if (!reportIsDue(kind, key)) return { status: "not_due" };
  const [job] = await sql<{ generation: string; attempts: number; reason_code: string; evidence: string[] }[]>`
    UPDATE reports.reconciliation_jobs SET state='running',lease_until=now()+interval '15 minutes',attempts=attempts+1
    WHERE kind=${kind} AND key=${key} AND state IN ('pending','running')
      AND (lease_until IS NULL OR lease_until<now()) RETURNING generation,attempts,reason_code,evidence`;
  if (!job) return { status: "current" };
  const settle = async (state: string, result: string | null, message: string, hash: string | null = null) => {
    await sql`UPDATE reports.reconciliation_jobs SET state=${state},result=${result},message=${message},input_hash=coalesce(${hash},input_hash),
      checked_at=now(),lease_until=NULL,next_attempt_at=now()+make_interval(mins=>${Math.min(360, 5 * 2 ** Math.min(job.attempts, 7))})
      WHERE kind=${kind} AND key=${key} AND generation=${job.generation}`;
  };
  try {
    const [old] = await sql<Report[]>`SELECT id,revision,content,origin,generated_at FROM reports WHERE kind=${kind} AND key=${key}`;
    if (old?.origin === "manual") {
      await settle("preserved_manual", null, "本期由人工维护，已保留原稿。");
      return { status: "preserved_manual" };
    }
    if (await isReportWithdrawn("news", kind, key)) {
      await settle("withdrawn", null, "本期已被人工撤回，系统不会恢复发布。");
      return { status: "withdrawn" };
    }
    const publication = await requireRuntimeRunning("news", ["publication"]);
    const prepared = await prepare(kind, key),
      hash = sha256(stableJson(facts(prepared.content)));
    const pending = kind === "daily" ? Number((prepared.content as { generator?: { pendingSelections?: number } }).generator?.pendingSelections ?? 0) : 0;
    if (prepared.waiting && (!old || pending > 0)) {
      await settle("retry", "waiting", "仍在等待本期合格材料；系统会继续核对。", hash);
      return { status: "waiting" };
    }
    const unchanged = old && !old.content?.correctionPending && sameFacts(old.content, prepared.content);
    const needsProse = kind !== "daily" && prepared.top.length > 0 && (!unchanged || !old?.content.overview);
    if (unchanged && !needsProse) {
      await settle("done", "unchanged", "已核对，事实和编排没有变化。", hash);
      return { status: "unchanged" };
    }
    const ids = reportMemberIds(prepared.content),
      permissions = await Promise.all(
        [...new Set((await currentReportPublications(ids)).map((entry) => entry.sourceId))].sort().map(async (sourceId) => {
          const policy = await readCurrentSourcePolicy(sourceId);
          if (!policy) throw new Error("Report source permission missing");
          return { sourceId, permissionVersion: policy.permission_version };
        }),
      );
    const expected = stableJson(await currentReportPublications(ids));
    const publicInputs = await reportPublicInputs(ids);
    const referenceRows = storedReportEntries(prepared.content);
    if (
      publicInputs.length !== ids.length ||
      referenceRows.some((entry) => {
        const row = publicInputs.find((input) => input.id === entry.itemId);
        return !row || row.title !== entry.title || (typeof entry.summary === "string" && (row.summary ?? "") !== entry.summary);
      })
    )
      throw new Error("Report inputs changed before composition");
    const materials = stableJson(await newsMaterialBindings(ids));
    const dependencies = stableJson(await dailyDependencies(kind, key));
    const processing = await runtimeControlSnapshot("news", ["processing"]);
    let written: Awaited<ReturnType<typeof writePeriod>> | null = null;
    let requiresManualReview = false;
    if (needsProse) {
      try {
        written = await writePeriod(kind as "weekly" | "monthly", key, prepared.range.start, prepared.range.end, prepared.top, await modelFor("report"));
      } catch (error) {
        requiresManualReview = error instanceof ReceiptOutputLimitError;
        /* Existing gateway owns original attempts and uncertain costs. Keep a factual rule summary and retry later. */
      }
    }
    const content: StoredReportContent =
      written && prepared.period
        ? periodContent(kind as "weekly" | "monthly", key, prepared.range.start, prepared.range.end, prepared.period, prepared.top, written)
        : prepared.content;
    // An emptied historical issue must not claim the original window was fully judged.
    if (!prepared.entries && old) {
      content.lead = null;
      content.overview = null;
    }
    const saved = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`withdrawal:news:report:${kind}:${key}`}))`;
      await assertRuntimeControl(tx, publication);
      if (written) await assertRuntimeControl(tx, processing);
      if (permissions.length) await lockCurrentSourcePolicies(tx, permissions);
      await lockNewsModelMaterials(ids, tx);
      await tx`SELECT pg_advisory_xact_lock(hashtext('report_candidates'))`;
      await lockReportPublications(ids, tx);
      if (stableJson(await currentReportPublications(ids, tx)) !== expected || stableJson(await newsMaterialBindings(ids, tx)) !== materials) return false;
      if (stableJson(await reportPublicInputs(ids)) !== stableJson(publicInputs)) return false;
      const deps = await dailyDependencies(kind, key);
      if (stableJson(deps) !== dependencies) return false;
      // Serialize all report writers, including the old correction path and manual revisions.
      const [latest] = await tx<Report[]>`SELECT id,revision,content,origin,generated_at FROM reports WHERE kind=${kind} AND key=${key} FOR UPDATE`;
      const [current] = await tx`SELECT generation FROM reports.reconciliation_jobs WHERE kind=${kind} AND key=${key} FOR UPDATE`;
      if (
        Number(current?.generation) !== Number(job.generation) ||
        (latest?.revision ?? 0) !== (old?.revision ?? 0) ||
        latest?.origin === "manual" ||
        (await isReportWithdrawn("news", kind, key, tx))
      )
        return false;
      await preserveReportCalendar(tx);
      const changed =
        !latest ||
        latest.content?.correctionPending ||
        !sameFacts(latest.content, content) ||
        stableJson(latest.content.overview ?? null) !== stableJson(content.overview ?? null);
      if (changed) {
        const revision = (latest?.revision ?? 0) + 1;
        const reason = latest ? "已依据补充或更正后的公开报道修订本期内容。" : "已根据可靠来源日期补齐本期内容。";
        const previous = Array.isArray(latest?.content?.corrections) ? latest.content.corrections : [];
        const revised = {
          ...content,
          correctionPending: false,
          sourceMemberIds: ids,
          corrections: [...previous, { revision, reason, at: new Date().toISOString() }],
        };
        if (latest) {
          await tx`INSERT INTO report_revisions(report_id,revision,content,generated_at,reason)
            VALUES(${latest.id},${latest.revision},${tx.json(latest.content as never)},${latest.generated_at},${stableJson({ reason: job.reason_code, evidence: job.evidence })}) ON CONFLICT DO NOTHING`;
          await tx`UPDATE reports SET content=${tx.json(revised as never)},revision=${revision},model=${written?.model ?? null},
            origin=${written ? "model" : "rule"},last_revised_at=now(),updated_at=now(),window_start=${prepared.range.from},window_end=${prepared.range.until}
            WHERE id=${latest.id}`;
        } else
          await tx`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,first_published_at,model,origin)
          VALUES(${kind},${key},${prepared.range.from},${prepared.range.until},${tx.json(revised as never)},now(),now(),${written?.model ?? null},${written ? "model" : "rule"})`;
        if (kind === "daily") await requestReportDependents(key, ids, tx);
      }
      const retry = needsProse && !written?.overview && !requiresManualReview;
      await tx`UPDATE reports.reconciliation_jobs SET state=${retry ? "retry" : "done"},result=${requiresManualReview ? "waiting" : changed ? "revised" : "unchanged"},
        input_hash=${hash},checked_at=now(),lease_until=NULL,next_attempt_at=now()+interval '30 minutes',
        message=${requiresManualReview ? "综述多次未通过内容核验，已停止自动重试；事实汇编保持可读。请人工检查模型设置后重新核对。" : retry ? "事实汇编已核对，综述暂未完成；系统稍后再试。" : changed ? "本期已更新，相关周报和月报会继续核对。" : "已核对，事实和编排没有变化。"}
        WHERE kind=${kind} AND key=${key} AND generation=${job.generation}`;
      if (latest) await tx`UPDATE reports.correction_jobs SET state='done',last_error=NULL,updated_at=now() WHERE report_id=${latest.id}`;
      if (written) await completeReceipt(tx, written.receiptId);
      return true;
    });
    if (!saved) await settle("retry", "waiting", "处理期间材料或报告版本已变化，系统将重新核对。");
    return { status: saved ? "reconciled" : "stale" };
  } catch (error) {
    await settle("retry", "waiting", "本次核对未完成；已保留原报告和处理记录，系统稍后再试。");
    throw error;
  }
}
export async function registerReconciliationJobs(boss: PgBoss) {
  await ensureReconciliationQueue();
  await work(
    boss,
    RECONCILE_QUEUE,
    { localConcurrency: 1, pollingIntervalSeconds: 2 },
    async () => "news",
    async (data) => recordRun(RECONCILE_QUEUE, () => reconcileReport(data.kind, data.key)),
  );
}
