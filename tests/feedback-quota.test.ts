import "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { closeDb, feedbackSql as sql } from "@amp/backend/db";
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

test("five rolling-minute attempts are atomic in an API process and saved retries do not spend another attempt", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const inputs = Array.from({ length: 8 }, () => request("quota-client-one"));
  const rows = await Promise.all(
    inputs.map(async (input) => {
      try {
        return { status: 201, id: (await submitFeedback(input)).id };
      } catch (error) {
        return { status: (error as { status: number }).status, id: undefined };
      }
    }),
  );
  assert.equal(rows.filter((row) => row.status === 201).length, 5);
  assert.equal(rows.filter((row) => row.status === 429).length, 3);
  const success = rows.findIndex((row) => row.status === 201),
    id = rows[success]!.id;
  assert.deepEqual(await submitFeedback(inputs[success]!), { id });
  t.mock.timers.tick(60_001);
  assert.ok((await submitFeedback(request("quota-client-one"))).id);
  assert.equal((await otherInstance([request("quota-client-one")]))[0]!.status, 201, "a new API process starts a new minute window");
  assert.equal((await sql`SELECT count(*)::int n FROM feedback WHERE source_hash=${feedbackSourceHash("quota-client-one", "quota-fixture")}`)[0]!.n, 7);
});

test("legacy amount-of-feedback buckets no longer block submission, while invalid images still spend new attempts", async () => {
  await sql`INSERT INTO feedback.quota_buckets(scope,bucket_key,window_start,used) VALUES('site_day','site',now(),500)`;
  assert.ok((await submitFeedback(request("daily-client-a"))).id);
  for (let i = 0; i < 5; i++)
    await assert.rejects(submitFeedback({ ...request("invalid-image-client"), screenshot: { mime: "image/png", data: Buffer.from("invalid") } }), /有效的/);
  await assert.rejects(submitFeedback(request("invalid-image-client")), (error) => (error as { status: number }).status === 429);
  assert.ok((await submitFeedback(request("another-client"))).id);
  assert.equal((await sql`SELECT used FROM feedback.quota_buckets WHERE scope='site_day'`)[0]!.used, 500, "historical quota rows remain untouched");
});
