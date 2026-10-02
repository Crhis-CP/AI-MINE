// Behaviour baseline, part 1 (handoff docs/04-architecture/04-aihot-adoption.md 7.3): the HTTP route
// table, the queue definitions and the worker schedules, written as stable text files so a structural
// change ("move only, no behaviour change") can be compared against the baseline byte for byte.
//   node scripts/baseline/capture.ts <out-dir>
// DATABASE_URL must point at a throwaway *_ci or *_test database; nothing is written to it.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/baseline/capture.ts <out-dir>");
  process.exit(2);
}
const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname.slice(1);
if (!/_(ci|test)$/.test(dbName)) {
  console.error(`refusing to run: DATABASE_URL must name a *_ci or *_test database (got "${dbName}")`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const write = (name: string, text: string) => writeFileSync(path.join(out, name), text.endsWith("\n") ? text : `${text}\n`);

const { buildApp } = await import("../../apps/api/src/app.ts");
const app = await buildApp();
await app.ready();
write("routes.txt", app.printRoutes({ commonPrefix: false }));
await app.close();

const { QUEUES, QUEUE_OPTIONS } = await import("@aihot/backend/jobs/queue");
write("queues.json", JSON.stringify({ queues: QUEUES, options: QUEUE_OPTIONS }, null, 2));

const { SCHEDULES } = await import("../../apps/worker/src/schedules.ts");
write(
  "schedules.json",
  JSON.stringify(
    SCHEDULES.map(({ name, cron, missed }) => ({ name, cron, missed: missed ?? null })),
    null,
    2,
  ),
);

const { closeDb } = await import("@aihot/backend/db");
await closeDb();
console.log(`baseline: routes, queues and schedules written to ${out}`);
