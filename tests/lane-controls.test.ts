import assert from "node:assert/strict";
import { test } from "node:test";
import { injectDb } from "@amp/backend/db";
import { LaneControlActionRequest } from "@amp/contracts/http/private";
import { publicRoleFixture } from "./public-role-fixture.ts";
import { denied } from "./role-db-fixture.ts";
import {
  listLaneControls,
  changeOwnerLaneControls,
  changeDeploymentLaneControl,
  runtimeControlSnapshot,
  assertRuntimeControl,
  requireRuntimeRunning,
  laneControlFindings,
  LaneControlConflict,
  RuntimeControlPaused,
  RuntimeControlStale,
} from "../packages/backend/src/operations/lane-controls.ts";
const expiry = (hours = 1) => new Date(Date.now() + hours * 3600_000).toISOString();
test("independent holder/lane controls preserve expiry, explicit restore and in-flight CAS using real operator and worker roles", async (t) => {
  const f = await publicRoleFixture(t),
    sessions = await f.login(),
    dispose = injectDb({ ops: sessions.private_ops });
  t.after(dispose);
  const before = await listLaneControls();
  assert.equal(before.controls.length, 0);
  assert.equal(before.owner_revisions.length, 6);
  const baseline = await runtimeControlSnapshot("news", ["processing"]);
  await assert.rejects(
    sessions.worker.begin("isolation level repeatable read", (tx) => assertRuntimeControl(tx, baseline)),
    /read committed/,
  );
  await changeOwnerLaneControls(
    { lane: "news", mode: "processing", action: "pause", reason: "Synthetic owner pause", expires_at: expiry(), expected_revisions: { processing: 0 } },
    "synthetic-owner",
  );
  assert.equal((await runtimeControlSnapshot("news", ["processing"])).paused, true);
  assert.equal((await runtimeControlSnapshot("policy", ["processing"])).paused, false);
  assert.equal((await runtimeControlSnapshot("news", ["collection", "publication"])).paused, false);
  await assert.rejects(
    sessions.worker.begin((tx) => assertRuntimeControl(tx, baseline)),
    RuntimeControlStale,
  );
  await assert.rejects(
    sessions.worker.begin((tx) => requireRuntimeRunning("news", ["processing"], tx)),
    RuntimeControlPaused,
  );
  const deploymentLease = await changeDeploymentLaneControl({
    lane: "news",
    switches: ["processing"],
    action: "pause",
    reason: "Synthetic deploy protection",
    actor: "synthetic-deploy",
    expiresAt: expiry(),
    expected: { processing: 0 },
  });
  assert.equal(deploymentLease.processing, 1);
  await assert.rejects(
    changeOwnerLaneControls(
      { lane: "news", mode: "processing", action: "resume", reason: "Stale restore", expected_revisions: { processing: 0 } },
      "synthetic-owner",
    ),
    LaneControlConflict,
  );
  await changeOwnerLaneControls(
    { lane: "news", mode: "processing", action: "resume", reason: "Synthetic owner restore", expected_revisions: { processing: 1 } },
    "synthetic-owner",
  );
  assert.equal((await runtimeControlSnapshot("news", ["processing"])).paused, true);
  await assert.rejects(
    changeDeploymentLaneControl({
      lane: "news",
      switches: ["processing"],
      action: "resume",
      reason: "Stale deployment restore",
      actor: "synthetic-deploy",
      expected: { processing: 0 },
    }),
    LaneControlConflict,
  );
  assert.ok((await laneControlFindings()).some((f) => f.key.startsWith("lane-control.conflict:")));
  await changeDeploymentLaneControl({
    lane: "news",
    switches: ["processing"],
    action: "resume",
    reason: "Explicit deployment restore",
    actor: "synthetic-deploy",
    expected: { processing: 1 },
  });
  assert.equal((await runtimeControlSnapshot("news", ["processing"])).paused, false);
  await assert.rejects(
    sessions.worker.begin((tx) => assertRuntimeControl(tx, baseline)),
    RuntimeControlStale,
    "pause then resume cannot silently authorize old in-flight work",
  );
  assert.equal((await laneControlFindings()).length, 0);
  await changeOwnerLaneControls(
    {
      lane: "all",
      mode: "automatic",
      action: "pause",
      reason: "Synthetic all pause",
      expires_at: expiry(),
      expected_revisions: { collection: 0, processing: 0 },
      confirm_all: true,
    },
    "synthetic-owner",
  );
  assert.equal((await runtimeControlSnapshot("policy", ["collection"])).paused, true);
  await f.admin`UPDATE ops.lane_controls SET expires_at=now()-interval '1 second' WHERE lane='all' AND holder='owner'`;
  assert.ok((await listLaneControls()).controls.every((c) => c.overdue));
  assert.equal((await runtimeControlSnapshot("policy", ["processing"])).paused, true);
  assert.equal((await laneControlFindings()).filter((f) => f.key.startsWith("lane-control.expired:")).length, 2);
  await assert.rejects(
    changeOwnerLaneControls(
      {
        lane: "all",
        mode: "automatic",
        action: "pause",
        reason: "Too long",
        expires_at: expiry(25),
        expected_revisions: { collection: 1, processing: 1 },
        confirm_all: true,
      },
      "synthetic-owner",
    ),
    /24 小时/,
  );
  assert.equal(
    LaneControlActionRequest.safeParse({ lane: "all", mode: "processing", action: "resume", reason: "No confirmation", expected_revisions: { processing: 1 } })
      .success,
    false,
  );
  assert.equal(
    LaneControlActionRequest.safeParse({
      lane: "news",
      mode: "publication",
      action: "resume",
      reason: "Forbidden daily action",
      expected_revisions: { processing: 0 },
    }).success,
    false,
  );
  assert.equal(
    LaneControlActionRequest.safeParse({
      lane: "news",
      holder: "deploy",
      mode: "processing",
      action: "resume",
      reason: "Wrong holder",
      expected_revisions: { processing: 0 },
    }).success,
    false,
  );
  await denied(sessions.public_read, "SELECT * FROM ops.lane_controls");
  await denied(sessions.public_read, "SELECT * FROM ops.lane_control_conflicts");
});
