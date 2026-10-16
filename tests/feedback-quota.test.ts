import "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { closeDb, feedbackSql as sql, initializeDb } from "@amp/backend/db";
import { submitFeedback, feedbackSourceHash } from "@amp/backend/operations/feedback";

after(closeDb);
const request = (ip: string) => ({ idempotencyKey: randomUUID(), content: "用于验证并行实例和未知回执重试的合成反馈", ip, userAgent: "quota-fixture" });
const execute = promisify(execFile);
async function otherInstance(inputs: ReturnType<typeof request>[]) {
  const code = `import './tests/setup.ts';
    import {submitFeedback} from '@amp/backend/operations/feedback';
    import {closeDb} from '@amp/backend/db';
    const out = await Promise.all(JSON.parse(process.argv[1]).map(async input => {
      try { return {status:201,...await submitFeedback(input)}; } catch(e) { return {status:e.status,message:e.message}; }
    }));
    await closeDb(); console.log('RESULT:'+JSON.stringify(out));`;
  const result = await execute(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(inputs)], { timeout: 30_000 });
  return JSON.parse(result.stdout.match(/RESULT:(.+)/)![1]!) as Array<{ status: number; id?: number }>;
}

test("hourly five is atomic across separate instances; restart and replay cannot consume or bypass the durable limit", async () => {
  const inputs = Array.from({ length: 8 }, () => request("quota-client-one"));
  const rows = (await Promise.all([otherInstance(inputs.slice(0, 4)), otherInstance(inputs.slice(4))])).flat();
  assert.equal(rows.filter((r) => r.status === 201).length, 5);
  assert.equal(rows.filter((r) => r.status === 429).length, 3);
  const success = rows.findIndex((r) => r.status === 201);
  const id = rows[success]!.id;
  await closeDb();
  await initializeDb("test");
  assert.deepEqual(await submitFeedback(inputs[success]!), { id });
  assert.deepEqual((await otherInstance([inputs[success]!]))[0], { status: 201, id });
  assert.equal((await otherInstance([request("quota-client-one")]))[0]!.status, 429);
  const buckets = await sql`SELECT scope,used,window_start FROM feedback.quota_buckets ORDER BY scope`;
  assert.equal(buckets.find((r) => r.scope === "client_hour")!.used, 5);
  assert.equal(buckets.find((r) => r.scope === "site_day")!.used, 5, "rejected client claims roll back the global counter");
  assert.equal(new Date(buckets.find((r) => r.scope === "site_day")!.window_start).getUTCHours(), 16, "site day begins at Beijing midnight");
  assert.equal((await sql`SELECT count(*)::int n FROM feedback WHERE source_hash=${feedbackSourceHash("quota-client-one", "quota-fixture")}`)[0]!.n, 5);
});

test("the final daily slot is exclusive across instances and unknown-response retries still return the original receipt at quota", async () => {
  await sql`UPDATE feedback.quota_buckets SET used=499 WHERE scope='site_day'
    AND window_start=date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'`;
  const inputs = [request("daily-client-a"), request("daily-client-b")];
  const rows = (await Promise.all(inputs.map((input) => otherInstance([input])))).flat();
  assert.equal(rows.filter((r) => r.status === 201).length, 1);
  assert.equal(rows.filter((r) => r.status === 429).length, 1);
  const index = rows.findIndex((r) => r.status === 201);
  assert.deepEqual((await otherInstance([inputs[index]!]))[0], rows[index]);
  assert.equal((await sql`SELECT used FROM feedback.quota_buckets WHERE scope='site_day' ORDER BY window_start DESC LIMIT 1`)[0]!.used, 500);
  assert.equal(
    (
      await sql`SELECT count(*)::int n FROM feedback.quota_buckets WHERE scope='client_hour' AND bucket_key=ANY(${inputs.map((i) => feedbackSourceHash(i.ip, i.userAgent))})`
    )[0]!.n,
    1,
  );
});
