import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { recoverUnknownOnce } from "../packages/backend/src/providers/unknown-recovery.ts";
import { changeSystemLaneControl, laneControlHolderRevisions } from "../packages/backend/src/operations/lane-controls.ts";

after(closeDb);
test("two hundred paused policy receipts cannot hide a recoverable news receipt or consume paused recovery opportunities", async () => {
  const paused = [];
  for (let i = 0; i < 201; i++) {
    const lane = i < 200 ? "policy" : "news";
    const [receipt] = await sql`INSERT INTO receipts(logical_key,service,model,purpose,status,request,attempts,updated_at)
      VALUES(${`fair-${i}`},'synthetic','synthetic','invariant_test','unknown',${sql.json({ lane })},1,now()-interval '31 minutes') RETURNING id`;
    await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status,started_at,finished_at) VALUES(${receipt.id},1,'synthetic','unknown',now()-interval '31 minutes',now()-interval '31 minutes')`;
    if (i < 200) paused.push(receipt.id);
  }
  const revision = (await laneControlHolderRevisions("policy", "system")).processing!;
  await changeSystemLaneControl({
    lane: "policy",
    switches: ["processing"],
    action: "pause",
    expected: { processing: revision },
    reason: "Synthetic policy pause",
    actor: "test",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  const result = await recoverUnknownOnce(Date.now(), async () => true);
  assert.deepEqual(result, { released: 1, requeued: 1 });
  assert.equal(Number((await sql`SELECT count(*) FROM receipts WHERE id=ANY(${paused}::bigint[]) AND status='unknown'`)[0].count), 200);
  assert.equal((await sql`SELECT 1 FROM receipt_attempts WHERE receipt_id=ANY(${paused}::bigint[]) AND error IS NOT NULL`).length, 0);
});
