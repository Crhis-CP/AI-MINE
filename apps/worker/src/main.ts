// Worker process: queues and schedules for collection, processing, events, reports and ops.
import { closeDb, initializeDb } from "@amp/backend/db";
import { ensureQueue, getBoss, QUEUES, stopBoss } from "@amp/backend/jobs/queue";
import { registerContentJobs } from "@amp/backend/jobs/content";
import { registerSourceJobs } from "@amp/backend/jobs/sources";
import { registerEventJobs } from "@amp/backend/jobs/events";
import { registerNotifyJobs } from "@amp/backend/jobs/notify";
import { registerPublicationJobs } from "@amp/backend/jobs/publication";
import { registerSchedules } from "./schedules.ts";
import { ensureContentTargets } from "@amp/backend/notify/deliver";
import { startHeartbeat } from "@amp/backend/operations/heartbeat";

await initializeDb("worker");

await ensureContentTargets();
const boss = await getBoss();
for (const queue of Object.values(QUEUES)) await ensureQueue(queue);
await registerContentJobs(boss);
if (process.env.COLLECT_ENABLED !== "false") await registerSourceJobs(boss);
await registerEventJobs(boss);
await registerNotifyJobs(boss);
await registerPublicationJobs(boss);
await registerSchedules(boss);
const heartbeat = startHeartbeat("worker");
console.log(JSON.stringify({ level: "info", msg: "worker started", pid: process.pid }));

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", msg: "worker stopping" }));
  clearInterval(heartbeat);
  await stopBoss();
  await closeDb();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
