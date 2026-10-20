import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { stopBoss, type getBoss } from "@amp/backend/jobs/queue";
import { composeDaily, enqueuePendingReportCorrections, registerReportCorrectionJobs } from "@amp/backend/reports/compose";
import { loadReport } from "@amp/backend/publication/reports";
import { historyMaterial } from "./report-history-fixture.ts";

after(async () => {
  await stopBoss();
  await closeDb();
});

test("the existing server sweep repairs a late historical daily without changing its first publication or pushing it again", async () => {
  await historyMaterial("2020-09-30", "月底扩建获批");
  await composeDaily("2020-10-01");
  const first = (await loadReport("daily", "2020-10-01"))!;
  const late = await historyMaterial("2020-09-30", "另一矿山新投产");
  await enqueuePendingReportCorrections();
  const [queued] = await sql`SELECT data FROM pgboss.job WHERE name='reports.reconcile' AND data->>'key'='2020-10-01'`;
  assert.ok(queued, "the normal server sweep must enqueue late material for an already published issue");
  const handlers = new Map<string, (jobs: { data: unknown }[]) => Promise<unknown>>();
  await registerReportCorrectionJobs({
    work: async (name: string, _options: unknown, handler: (jobs: { data: unknown }[]) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  } as unknown as Awaited<ReturnType<typeof getBoss>>);
  await handlers.get("reports.reconcile")!([{ data: queued.data }]);
  const changed = (await loadReport("daily", "2020-10-01"))!;
  assert.ok(changed.stories.some((entry) => entry.itemId === late));
  assert.equal(changed.generatedAt, first.generatedAt);
  assert.equal(changed.firstPublishedAt, first.firstPublishedAt);
  assert.ok(changed.lastRevisedAt);
  assert.equal(changed.revision, first.revision + 1);
  assert.ok((await sql`SELECT 1 FROM reports.reconciliation_jobs WHERE kind='monthly' AND key='2020-09'`).length);
  const pushes = await sql`SELECT id FROM pgboss.job WHERE name='notify.selected'`;
  assert.equal(pushes.length, 0);
  await handlers.get("reports.reconcile")!([{ data: queued.data }]);
  assert.equal((await loadReport("daily", "2020-10-01"))!.revision, changed.revision);
});
