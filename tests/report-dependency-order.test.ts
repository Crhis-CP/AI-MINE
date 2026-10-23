import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { requestReportRevision, enqueueReportReconciliation } from "../packages/backend/src/reports/revision-state.ts";

after(async () => {
  await stopBoss();
  await closeDb();
});
const queued = async (kind: string, key: string) =>
  (await sql`SELECT id FROM pgboss.job WHERE name='reports.reconcile' AND data->>'kind'=${kind} AND data->>'key'=${key}`).length;

test("a daily waiting for missing material does not indefinitely block its monthly revision", async () => {
  await requestReportRevision("daily", "2020-09-07", "synthetic missing input", []);
  await sql`UPDATE reports.reconciliation_jobs SET state='retry',result='waiting',next_attempt_at='2100-01-01T00:00Z' WHERE kind='daily' AND key='2020-09-07'`;
  await requestReportRevision("monthly", "2020-09", "synthetic daily revision", []);
  await enqueueReportReconciliation();
  assert.equal(await queued("monthly", "2020-09"), 1, "the period worker must be able to evaluate its available daily contents");
  assert.equal(await queued("daily", "2020-09-07"), 0, "a waiting daily keeps its backoff");
});

test("ready daily work still precedes a dependent month and releases it after completion", async () => {
  await requestReportRevision("daily", "2020-10-07", "synthetic ready input", []);
  await requestReportRevision("monthly", "2020-10", "synthetic daily revision", []);
  await enqueueReportReconciliation();
  assert.equal(await queued("monthly", "2020-10"), 0);
  assert.equal(await queued("daily", "2020-10-07"), 1);
  await sql`UPDATE reports.reconciliation_jobs SET state='done',result='revised' WHERE kind='daily' AND key='2020-10-07'`;
  await enqueueReportReconciliation();
  assert.equal(await queued("monthly", "2020-10"), 1);
});
