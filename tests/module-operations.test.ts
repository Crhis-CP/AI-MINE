import "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { getBoss, stopBoss } from "@amp/backend/jobs/queue";
import { installModules } from "@amp/backend/modules";
import { checkAlerts, collectFindings, sendDigest } from "@amp/backend/operations/alerts";
import { dailyRetention } from "@amp/backend/operations/retention";
import { sourceHealthWeekly } from "@amp/backend/operations/reports";
import { currentScheduledJobs } from "../packages/backend/src/jobs/schedule-status.ts";

const internal = process.env.FEISHU_INTERNAL_ENABLED;
process.env.FEISHU_INTERNAL_ENABLED = "false";
before(async () => {
  await getBoss();
});
after(async () => {
  installModules([]);
  if (internal === undefined) delete process.env.FEISHU_INTERNAL_ENABLED;
  else process.env.FEISHU_INTERNAL_ENABLED = internal;
  await stopBoss();
  await closeDb();
});

test("module alert failures stay visible while other alerts and follow-ups still run once", async () => {
  const calls: string[] = [];
  installModules([
    {
      name: "broken",
      alerts: async () => {
        throw new Error("synthetic unavailable");
      },
    },
    {
      name: "working",
      alerts: async () => {
        calls.push("alert");
        return [{ key: "fixture.alert", title: "合成即时检查", level: "now" }];
      },
      followUps: async () => {
        calls.push("follow-up");
        return [{ key: "fixture.follow-up", title: "合成跟进检查", level: "digest" }];
      },
    },
  ]);
  const findings = await collectFindings();
  assert.deepEqual(calls, ["alert", "follow-up"]);
  for (const key of ["module.broken.alerts", "fixture.alert", "fixture.follow-up"]) assert.equal(findings.filter((finding) => finding.key === key).length, 1);
});

test("an incomplete module check cannot close existing immediate or digest incidents", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const now = Date.now();
  let phase: "open" | "failed" | "healthy" = "open";
  const modules = [
    {
      name: "fixture",
      alerts: async () => {
        if (phase === "failed") throw new Error("synthetic unavailable");
        return phase === "healthy"
          ? []
          : [
              { key: "metals.fixture-now", title: "合成立即异常", level: "now" as const },
              { key: "metals.fixture-digest", title: "合成跟进异常", level: "digest" as const },
            ];
      },
    },
    {
      name: "other",
      alerts: async () => (phase === "open" ? [{ key: "metals.other-now", title: "其他扩展异常", level: "now" as const }] : []),
    },
  ];
  installModules(modules);
  await checkAlerts(now);
  await sendDigest(now);
  for (const installed of [[], [{ name: "fixture" }]]) {
    installModules(installed);
    log.mock.resetCalls();
    const skipped = await checkAlerts(now + 30_000);
    await sendDigest(now + 30_000);
    assert.ok(skipped.open.includes("metals.fixture-now"), "an uninstalled or absent hook supplies no recovery evidence");
    assert.ok(!skipped.sent.includes("metals.fixture-now:recovered"));
    assert.ok(!log.mock.calls.some((call) => String(call.arguments[0]).includes("已恢复：合成跟进异常")));
    const [retained] = await sql`SELECT value FROM settings WHERE key='alerts.state'`;
    assert.ok(retained.value["digest:metals.fixture-digest"]);
  }
  installModules(modules);
  phase = "failed";
  log.mock.resetCalls();
  const failed = await checkAlerts(now + 60_000);
  await sendDigest(now + 60_000);
  assert.ok(failed.open.includes("metals.fixture-now"));
  assert.ok(failed.sent.includes("metals.other-now:recovered"), "a successful independent module can still recover");
  assert.ok(!failed.sent.includes("metals.fixture-now:recovered"));
  assert.ok(!log.mock.calls.some((call) => String(call.arguments[0]).includes("已恢复：合成跟进异常")));
  const [held] = await sql`SELECT value FROM settings WHERE key='alerts.state'`;
  assert.ok(held.value["digest:metals.fixture-digest"]);
  installModules([]);
  const removedAfterFailure = await checkAlerts(now + 90_000);
  assert.ok(removedAfterFailure.open.includes("metals.fixture-now"));
  assert.ok(!removedAfterFailure.sent.includes("metals.fixture-now:recovered"));
  await sendDigest(now + 90_000);
  const [uninstalled] = await sql`SELECT value FROM settings WHERE key='alerts.state'`;
  assert.ok(uninstalled.value["digest:metals.fixture-digest"], "removing a failed hook must retain its existing incident");
  installModules(modules);
  phase = "healthy";
  assert.ok((await checkAlerts(now + 120_000)).sent.includes("metals.fixture-now:recovered"));
  await sendDigest(now + 120_000);
  const [closed] = await sql`SELECT value FROM settings WHERE key='alerts.state'`;
  assert.equal(closed.value["digest:metals.fixture-digest"], undefined);
});

test("a failed module retention does not stop other modules or core housekeeping and does not report success", async () => {
  let keptRunning = false;
  installModules([
    {
      name: "broken",
      retention: async () => {
        throw new Error("synthetic unavailable");
      },
    },
    {
      name: "working",
      retention: async () => {
        keptRunning = true;
        return { removed: 0 };
      },
    },
  ]);
  await sql`INSERT INTO delivery_leases(lease_key,holder,expires_at) VALUES('module-retention-fixture','synthetic',now()-interval '1 hour')`;
  await assert.rejects(dailyRetention(), /broken/);
  assert.equal(keptRunning, true);
  assert.equal((await sql`SELECT 1 FROM delivery_leases WHERE lease_key='module-retention-fixture'`).length, 0);
  installModules([{ name: "working", retention: async () => ({ removed: 2 }) }]);
  assert.deepEqual((await dailyRetention()).modules, { working: { removed: 2 } });
});

test("module source health and external jobs join the existing reports without hiding unavailable checks", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const warning = t.mock.method(console, "warn", () => {});
  installModules([
    {
      name: "broken",
      sourceHealth: async () => {
        throw new Error("synthetic unavailable");
      },
      admin: {
        currentJobs: async () => {
          throw new Error("synthetic unavailable");
        },
      },
    },
    { name: "working", sourceHealth: async () => ["合成扩展来源正常"], admin: { currentJobs: async () => ["outside.fixture", "outside.fixture"] } },
  ]);
  await sourceHealthWeekly();
  const output = log.mock.calls.map((call) => String(call.arguments[0])).find((value) => value.includes("信源周报")) ?? "";
  assert.match(output, /合成扩展来源正常/);
  assert.match(output, /broken.*暂时无法核对/);
  assert.doesNotMatch(output, /没有需要处理的信源/);
  assert.equal((await currentScheduledJobs()).filter((name) => name === "outside.fixture").length, 1);
  assert.equal(warning.mock.calls.length, 1);
});
