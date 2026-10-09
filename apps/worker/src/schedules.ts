// Cron-style schedules (Asia/Shanghai). Each run is recorded in job_runs; missed slots run once.
import type { PgBoss } from "pg-boss";
import { ensureQueue, recordRun } from "@amp/backend/jobs/queue";
import { sweepUnprocessed } from "@amp/backend/jobs/content";
import { translatePending } from "@amp/backend/editorial/translate";
import { adaptIntervals, scheduleDueSources } from "@amp/backend/sources/collect";
import { scheduleMpReconcile } from "@amp/backend/sources/mp";
import { computeHotRanking, snapshotHeat } from "@amp/backend/events/hot";
import { refreshStoryStatuses } from "@amp/backend/events/digest";
import { linkRelatedStories } from "@amp/backend/events/group";
import { catchUpReports, composeDaily, composeMonthly, composeWeekly } from "@amp/backend/reports/compose";
import { addDays, beijingDate, isoWeekLabel } from "@amp/contracts/time";
import { dailyRetention } from "@amp/backend/operations/retention";
import { submitIndexNow } from "@amp/backend/operations/indexnow";
import { checkAlerts, sendDigest } from "@amp/backend/operations/alerts";
import { autoReleaseUnknownReceipts } from "@amp/backend/admin/runs";
import { backupConfigured, runBackup } from "@amp/backend/operations/backup";
import { sourceHealthWeekly, usageWeekly } from "@amp/backend/operations/reports";
import { markStalePendingReceipts } from "@amp/backend/providers/receipts";
import { markStaleDeliveries } from "@amp/backend/notify/deliver";
import { refreshMetalPrices } from "@amp/backend/jobs/publication";

interface Scheduled {
  name: string;
  cron: string;
  run: () => Promise<unknown>;
  missed?: "skip" | "once";
}

const collecting = process.env.COLLECT_ENABLED !== "false";

export const SCHEDULES: Scheduled[] = [
  { name: "content.sweep", cron: "*/5 * * * *", run: sweepUnprocessed },
  // Repair missing per-item translation dispatch; this cron never calls a model itself.
  { name: "content.translate", cron: "*/5 * * * *", run: () => translatePending() },
  { name: "hot.rank", cron: "*/5 * * * *", run: () => computeHotRanking() },
  { name: "hot.snapshot", cron: "2 * * * *", run: () => snapshotHeat() },
  { name: "stories.status", cron: "7 * * * *", run: refreshStoryStatuses },
  { name: "stories.links", cron: "12 * * * *", run: linkRelatedStories },
  { name: "reports.daily", cron: "0 8 * * *", missed: "once", run: () => composeDaily(beijingDate(Date.now())) },
  { name: "reports.weekly", cron: "0 10 * * 1", missed: "once", run: () => composeWeekly(isoWeekLabel(addDays(beijingDate(Date.now()), -7))) },
  {
    name: "reports.monthly",
    cron: "30 10 1 * *",
    missed: "once",
    run: () => {
      const [y, m] = beijingDate(Date.now()).split("-").map(Number) as [number, number];
      return composeMonthly(m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`);
    },
  },
  { name: "reports.catch-up", cron: "15 * * * *", run: () => catchUpReports() },
  { name: "ops.retention", cron: "30 3 * * *", missed: "once", run: () => dailyRetention() },
  // IndexNow for new indexable pages (off unless INDEXNOW_SUBMIT_ENABLED).
  { name: "seo.indexnow", cron: "50 5 * * *", missed: "once", run: () => submitIndexNow() },
  // Work a stopped process left half way becomes visible, and unknown paid requests get their one
  // automatic release, before the alerts look.
  {
    name: "ops.recover",
    cron: "*/10 * * * *",
    run: async () => ({ receipts: await markStalePendingReceipts(), released: await autoReleaseUnknownReceipts(), deliveries: await markStaleDeliveries() }),
  },
  { name: "ops.alerts", cron: "*/10 * * * *", run: () => checkAlerts() },
  // One message with the follow-ups that do not touch readers (nothing when there are none).
  { name: "ops.digest", cron: "0 9 * * *", missed: "once", run: () => sendDigest() },
  ...(backupConfigured() ? [{ name: "ops.backup", cron: "10 4 * * *", missed: "once" as const, run: () => runBackup() }] : []),
  { name: "reports.source-health", cron: "0 9 * * 1", missed: "once", run: () => sourceHealthWeekly() },
  { name: "reports.usage-weekly", cron: "5 9 * * 1", missed: "once", run: () => usageWeekly() },
  ...(collecting
    ? [
        { name: "sources.schedule", cron: "* * * * *", run: () => scheduleDueSources(undefined, "news") },
        { name: "policy.sources.schedule", cron: "* * * * *", run: () => scheduleDueSources(undefined, "policy") },
        { name: "sources.adapt-intervals", cron: "20 4 * * *", run: adaptIntervals },
        // WeChat official accounts (paid), each once per its interval.
        { name: "sources.mp-reconcile", cron: "*/15 * * * *", run: () => scheduleMpReconcile() },
        // Official metal prices, stored only (the bureau publishes at 09:30). No lane: prices belong to neither line (DEC-66).
        { name: "metals.prices", cron: "45 9,15,21 * * *", missed: "once" as const, run: () => refreshMetalPrices() },
      ]
    : []),
];

export async function registerSchedules(boss: PgBoss) {
  for (const s of SCHEDULES) {
    const queue = `cron.${s.name}`;
    await ensureQueue(queue, { policy: "singleton", retryLimit: 1, expireInSeconds: 3600 });
    await boss.schedule(queue, s.cron, {}, { tz: "Asia/Shanghai", missed: s.missed ?? "skip" });
    // Schedules fire at minute boundaries; a 15 s pickup keeps them on time with a third of the polling.
    await boss.work(queue, { pollingIntervalSeconds: 15 }, async () => recordRun(s.name, s.run));
  }
  // A schedule removed from the table (a module switched off) must not keep firing from an earlier run.
  const names = new Set(SCHEDULES.map((s) => `cron.${s.name}`));
  for (const existing of await boss.getSchedules()) {
    if (existing.name.startsWith("cron.") && !names.has(existing.name)) await boss.unschedule(existing.name);
  }
}
