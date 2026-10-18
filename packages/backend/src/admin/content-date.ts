import { sourceDateConfiguration } from "./sources.ts";
import { materialSourceTime } from "../content/date-evidence.ts";
import { z } from "zod";
import { AdminDateIntent, AdminDateCorrection, AdminDatePlan, AdminDateResult } from "@amp/contracts/http/private";
import { TimeAssertion } from "@amp/contracts/time-assertion";
import { beijingDate, beijingMidnight, beijingTime } from "@amp/contracts/time";
import {
  decideTimeline,
  isHistorical,
  saveCorrectedSourceTime,
  dateCorrectionMaterial,
  applyCorrectedMaterialDate,
  type CorrectionMaterial,
} from "../content/materials.ts";
import { removeAutomaticDateMembership } from "../events/group.ts";
import { sql, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { publishArticleTx } from "../publication/publish.ts";
import { invalidateReportCorrections } from "../reports/compose.ts";
import { enqueueJob } from "../jobs/module-queues.ts";
import { audit, previousAuditedCommand } from "./auth.ts";
import { Conflict } from "./sources.ts";

function timeOf(value: string | null): TimeAssertion | null {
  if (value === null) return null;
  const dayOnly = value.length === 10;
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1];
  const utc = dayOnly ? null : new Date(value).toISOString().replace(/\.\d{3}Z$/, fraction ? `.${fraction}Z` : ".000Z");
  const day = value.slice(0, 10);
  const clock = dayOnly ? null : value.slice(11).replace(/(?:Z|[+-]\d{2}:\d{2})$/, "");
  return TimeAssertion.parse({
    meaning: "published",
    meaning_label: "来源发布",
    raw: value,
    local_date: day,
    local_time: clock,
    timezone: !dayOnly && /(?:Z|[+-]00:00)$/.test(value) ? "UTC" : null,
    utc,
    precision: dayOnly ? "date" : "second",
    basis: "人工核对原文发布时间",
    condition_text: null,
    beijing_date: dayOnly ? day : beijingDate(utc!),
    label: dayOnly ? `来源发布于 ${day}` : `来源发布于 ${beijingDate(utc!)} ${beijingTime(utc!)}`,
  });
}
const publicDate = (time: TimeAssertion | null, fallback: Date | null) => time?.utc ?? time?.local_date ?? fallback?.toISOString() ?? null;
async function makePlan(a: CorrectionMaterial, input: z.infer<typeof AdminDateIntent>, db: Db) {
  const context = await sourceDateConfiguration(a.source_id, db);
  if (context?.lane !== "news") throw new Conflict("此操作仅用于资讯发布时间");
  const sourceTime = await materialSourceTime(
    { articleId: a.id, sourceId: a.source_id, revision: a.revision, configHash: context.configHash ?? "" },
    Number(a.source_date_version),
    Date.now(),
    db,
  );
  const time = timeOf(input.publishedAt);
  const date = time?.utc ? new Date(time.utc) : time?.local_date ? beijingMidnight(time.local_date) : null;
  const now = new Date();
  if (time && (time.utc ? date!.getTime() > now.getTime() : time.local_date! > beijingDate(now))) throw new Conflict("发布时间不能是未来日期");
  const before = {
    publishedAt: publicDate(sourceTime, a.published_at),
    sourceTime,
    timelineAt: a.timeline_at.toISOString(),
    backfill: a.backfill,
    backfillReason: a.backfill_reason,
  };
  const history = !!(date && (a.published_at ? a.published_at.getTime() < now.getTime() - 7 * 86400000 : isHistorical(a)));
  if (history && date!.getTime() >= now.getTime() - 7 * 86400000) throw new Conflict("历史内容不能通过日期校正刷入近期资讯");
  if (!history && isHistorical(a)) throw new Conflict("历史内容只校正有明确原文依据的历史日期");
  const explicit = ["unknown-publication-time", "stale-on-discovery"].includes(a.backfill_reason ?? "") ? null : a.backfill_reason;
  const timeline = history
    ? {
        publishedAt: date,
        timelineAt: !a.published_at || a.timeline_at.getTime() === a.published_at.getTime() ? date! : a.timeline_at,
        backfill: a.backfill,
        backfillReason: a.backfill_reason,
      }
    : decideTimeline(date, a.discovered_at, explicit);
  if (date && !timeline.publishedAt) throw new Conflict("发布时间超过首次收录容差，请重新核对原文");
  const after = {
    publishedAt: publicDate(time, null),
    sourceTime: time,
    timelineAt: timeline.timelineAt.toISOString(),
    backfill: timeline.backfill,
    backfillReason: timeline.backfillReason,
  };
  const archive = !history && isHistorical({ backfill: timeline.backfill, published_at: date, discovered_at: a.discovered_at });
  const settled =
    ["analyzed", "blocked", "skipped", "published"].includes(a.processing_state) &&
    (a.grouping_status === "complete" || a.processing_state === "blocked" || a.processing_state === "skipped");
  return AdminDatePlan.parse({
    articleId: a.id,
    version: a.revision,
    hash: sha256(stableJson({ a, sourceTime, input })),
    before,
    after,
    mode: history ? "history" : "live",
    archive,
    changed: stableJson([before.publishedAt, before.sourceTime?.precision]) !== stableJson([after.publishedAt, after.sourceTime?.precision]),
    ready: settled,
    reason: settled ? null : "内容仍在处理中，请处理结束后重新核对日期",
  });
}
export async function previewPublicationDateCorrection(id: string, value: unknown) {
  const input = AdminDateIntent.parse(value),
    a = await dateCorrectionMaterial(id, sql);
  return a ? makePlan(a, input, sql) : null;
}
export async function correctPublicationDate(id: string, value: unknown, requestId: string, actor: string) {
  const input = AdminDateCorrection.parse(value);
  z.string()
    .regex(/^[\w-]{8,80}$/)
    .parse(requestId);
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
    const a = await dateCorrectionMaterial(id, tx, true);
    if (!a) return null;
    const prior = await previousAuditedCommand(actor, "content.correct-publication-date", `content:${id}`, requestId, tx);
    const intent = { publishedAt: input.publishedAt, evidence: input.evidence };
    if (prior) {
      const saved = prior.result as { intent: unknown; result: unknown };
      if (stableJson(saved.intent) !== stableJson(intent)) throw new Conflict("同一个请求不能批准不同的日期或依据");
      return AdminDateResult.parse(saved.result);
    }
    const plan = await makePlan(a, intent, tx);
    if (a.revision !== input.version || plan.hash !== input.hash) throw new Conflict("材料或日期已经变化，请重新预览");
    if (!plan.ready) throw new Conflict(plan.reason!);
    if (plan.changed) {
      if (plan.archive && (await removeAutomaticDateMembership(id, tx)) === null) throw new Conflict("这条内容有人工归组，请先核对其归属");
      await saveCorrectedSourceTime(id, a.revision, plan.after.sourceTime, input.evidence, actor, tx);
      const date = plan.after.sourceTime?.utc
        ? new Date(plan.after.sourceTime.utc)
        : plan.after.sourceTime?.local_date
          ? beijingMidnight(plan.after.sourceTime.local_date)
          : null;
      await applyCorrectedMaterialDate(id, date, plan.after, tx);
      await publishArticleTx(tx, id);
      await invalidateReportCorrections(tx, [id], "manual_correction");
      await enqueueJob("events.hot-refresh", { lane: "news", articleId: id }, { singletonKey: "hot-ranking" }, tx);
    }
    const result = AdminDateResult.parse({
      articleId: id,
      revision: a.revision,
      status: plan.changed ? "corrected" : "unchanged",
      publishedAt: plan.after.publishedAt,
      archived: plan.archive,
    });
    await audit(actor, "content.correct-publication-date", `content:${id}`, input.reason, plan.before, { intent, result }, requestId, tx);
    return result;
  });
}
