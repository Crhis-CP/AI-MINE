// Behaviour baseline, part 1 (handoff docs/04-architecture/04-aihot-adoption.md 7.3): the HTTP route
// table, the queue definitions and the worker schedules, written as stable text files so a structural
// change ("move only, no behaviour change") can be compared against the baseline byte for byte.
//   node scripts/baseline/capture.ts <out-dir>
// DATABASE_URL must point at a throwaway *_ci or *_test database; nothing is written to it.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { initializeDb } from "@amp/backend/db";
import type { HTTPMethods } from "fastify";
import { normalizeRouteTree } from "./routes.ts";

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

await initializeDb("test");
const { buildApp } = await import("../../apps/api/src/app.ts");
const combined = new Set<string>();
for (const role of ["public-api", "private-api"] as const) {
  const app = await buildApp(role);
  try {
    await app.ready();
    const tree = app.printRoutes({ commonPrefix: false });
    write(`routes-${role}.txt`, tree);
    // These two fixed fallback registrations are the prefixes the router printer omits.
    const wildcards: Readonly<Record<string, string>> = role === "public-api" ? { "": "/api/public/*", "/api/v1": "/api/v1/*" } : {};
    for (const entry of normalizeRouteTree(tree, wildcards)) {
      const separator = entry.indexOf(" ");
      if (!app.hasRoute({ method: entry.slice(0, separator) as HTTPMethods, url: entry.slice(separator + 1) }))
        throw new Error(`Captured route does not exist: ${entry}`);
      combined.add(entry);
    }
  } finally {
    await app.close();
  }
}
write("routes.txt", [...combined].sort().join("\n"));

const { QUEUES, QUEUE_OPTIONS } = await import("@amp/backend/jobs/queue");
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

const { closeDb } = await import("@amp/backend/db");
await closeDb();
console.log(`baseline: routes, queues and schedules written to ${out}`);
