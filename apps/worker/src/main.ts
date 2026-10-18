import { SERVER_MODULES } from "@amp/site/modules/server";
import { workModuleQueues } from "@amp/backend/jobs/module-queues";
import { installModules } from "@amp/backend/modules";
// Worker process: queues and schedules for collection, processing, events, reports and ops.
import { closeDb, initializeDb } from "@amp/backend/db";
import { ensureQueue, getBoss, QUEUES, stopBoss } from "@amp/backend/jobs/queue";
import { registerContentJobs, registerModelConnectionProbeJobs } from "@amp/backend/jobs/content";
import { registerSourceJobs, ensureSourceQueues } from "@amp/backend/jobs/sources";
import { registerEventJobs } from "@amp/backend/jobs/events";
import { registerNotifyJobs } from "@amp/backend/jobs/notify";
import { registerReportCorrectionJobs } from "@amp/backend/reports/compose";
import { registerPublicationJobs } from "@amp/backend/jobs/publication";
import { registerSchedules } from "./schedules.ts";
import { ensureContentTargets } from "@amp/backend/notify/deliver";
import { startHeartbeat } from "@amp/backend/operations/heartbeat";

installModules(SERVER_MODULES);
await initializeDb("worker");

await ensureContentTargets();
const boss = await getBoss();
for (const queue of Object.values(QUEUES)) await ensureQueue(queue);
await ensureSourceQueues();
await registerContentJobs(boss);
await workModuleQueues(boss);
await registerModelConnectionProbeJobs(boss);
if (process.env.COLLECT_ENABLED !== "false") await registerSourceJobs(boss);
await registerEventJobs(boss);
await registerNotifyJobs(boss);
await registerPublicationJobs(boss);
await registerReportCorrectionJobs(boss);
await registerSchedules(boss);
const heartbeat = startHeartbeat("worker");
console.log(JSON.stringify({ level: "info", msg: "worker started", pid: process.pid }));

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  const started = performance.now();
  console.log(JSON.stringify({ level: "info", msg: "worker stopping" }));
  const report = (phase: "start" | "waiting" | "complete") => {
    const queues = new Map<string, { queue: string; count: number; oldestMs: number }>();
    for (const work of boss.getWipData({ includeInternal: true })) {
      if (!work.count) continue;
      const row = queues.get(work.name) ?? { queue: work.name, count: 0, oldestMs: 0 };
      row.count += work.count;
      row.oldestMs = Math.max(row.oldestMs, work.lastJobStartedOn === null ? 0 : Math.max(0, Date.now() - work.lastJobStartedOn));
      queues.set(work.name, row);
    }
    const jobs = [...queues.values()].sort((a, b) => a.queue.localeCompare(b.queue));
    console.log(
      JSON.stringify({
        level: "info",
        msg: "queue drain",
        phase,
        elapsedMs: Math.round(performance.now() - started),
        count: jobs.reduce((n, job) => n + job.count, 0),
        jobs,
      }),
    );
  };
  clearInterval(heartbeat);
  report("start");
  const progress = setInterval(() => report("waiting"), 10_000);
  progress.unref();
  try {
    await stopBoss();
    report("complete");
  } finally {
    clearInterval(progress);
  }
  const closing = performance.now();
  await closeDb();
  console.log(
    JSON.stringify({
      level: "info",
      msg: "worker stopped",
      elapsedMs: Math.round(performance.now() - started),
      databaseCloseMs: Math.round(performance.now() - closing),
    }),
  );
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
