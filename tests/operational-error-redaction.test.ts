import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { getBoss, stopBoss } from "@amp/backend/jobs/queue";
import { runsOverview } from "@amp/backend/admin/runs";

after(async () => {
  await stopBoss();
  await closeDb();
});

test("historical truncated task errors never return a database connection string", async () => {
  await getBoss();
  const credential = "SyntheticDbCredentialSentinel",
    connection = `postgresql://worker:${credential.repeat(8)}@db.invalid/archive`;
  await sql`INSERT INTO job_runs(job,status,error) VALUES('synthetic.redaction-history','failed',${"x".repeat(230) + connection})`;
  const overview = await runsOverview();
  const old = overview.timeline.find((row) => row.job === "synthetic.redaction-history");
  assert.ok(old);
  assert.ok(!old.error.includes(credential) && !old.error.includes("postgresql://"), "a truncated URI must also be redacted on read");
});
