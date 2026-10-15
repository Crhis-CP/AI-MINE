import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, dbOf } from "@amp/backend/db";
import {
  applyOwnerPolicySuspension,
  changeOwnerLaneControls,
  listLaneControls,
  runtimeControlSnapshot,
} from "../packages/backend/src/operations/lane-controls.ts";
import { installUsageFixtureForService } from "./usage-protection-fixture.ts";
import { paidRequest } from "@amp/backend/providers/receipts";
import { autoReleaseUnknownReceipts } from "@amp/backend/admin/runs";
const sql = dbOf("ops");
after(closeDb);
test("planned policy suspension keeps publication and news running, preserves holds, and never reapplies after a manual resume", async () => {
  await installUsageFixtureForService("policy-pause-fixture");
  await assert.rejects(
    paidRequest(
      { service: "policy-pause-fixture", lane: "policy", purpose: "policy_fulltext", subject: "fixture-policy", identity: "pause-fixture" },
      async () => {
        throw new Error("synthetic unknown result");
      },
    ),
  );
  await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE subject='fixture-policy'`;
  const before = await listLaneControls();
  const processing = before.owner_revisions.find((r) => r.lane === "policy" && r.switch === "processing")!;
  await changeOwnerLaneControls(
    {
      lane: "policy",
      mode: "processing",
      action: "pause",
      reason: "已有人工暂停",
      expected_revisions: { processing: processing.revision },
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    },
    "fixture-owner",
  );
  const decision = { id: "fixture-policy-pause", reason: "成本和技术问题，后续重做；保留已有阅读" };
  assert.equal((await applyOwnerPolicySuspension(decision)).status, "paused");
  const held = await listLaneControls();
  assert.equal(held.controls.find((r) => r.lane === "policy" && r.switch === "processing")?.reason, "已有人工暂停");
  assert.equal((await runtimeControlSnapshot("policy", ["collection"])).paused, true);
  assert.equal((await runtimeControlSnapshot("policy", ["processing"])).paused, true);
  assert.equal((await runtimeControlSnapshot("policy", ["publication"])).paused, false);
  assert.equal((await runtimeControlSnapshot("news", ["collection", "processing", "publication"])).paused, false);
  assert.deepEqual(await autoReleaseUnknownReceipts(), { released: 0, requeued: 0 });
  assert.equal((await sql`SELECT status FROM receipts WHERE subject='fixture-policy'`)[0].status, "unknown");
  assert.equal((await applyOwnerPolicySuspension(decision)).status, "already_applied");
  const expected = Object.fromEntries(held.owner_revisions.filter((r) => r.lane === "policy").map((r) => [r.switch, r.revision]));
  await changeOwnerLaneControls(
    { lane: "policy", mode: "automatic", action: "resume", reason: "后续负责人明确恢复", expected_revisions: expected },
    "fixture-owner",
  );
  assert.equal((await applyOwnerPolicySuspension(decision)).status, "already_applied");
  assert.equal((await runtimeControlSnapshot("policy", ["collection", "processing"])).paused, false);
});
