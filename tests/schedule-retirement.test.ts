import { installModules } from "@amp/backend/modules";
import { runsOverview } from "@amp/backend/admin/runs";
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { dbOf, closeDb } from "@amp/backend/db";
import { getBoss, ensureQueue, stopBoss } from "@amp/backend/jobs/queue";
import { registerSchedules } from "../apps/worker/src/schedules.ts";
const queueDb = dbOf("queue"),
  opsDb = dbOf("ops");
after(async () => {
  installModules([]);
  await stopBoss();
  await closeDb();
});
test("retired timers remove schedules and waiting jobs while ordinary work and run history remain", async () => {
  const boss = await getBoss(),
    suffix = randomUUID();
  const old = `cron.retired-${suffix}`,
    orphan = `cron.unscheduled-${suffix}`,
    ordinary = `work.keep-${suffix}`,
    current = "cron.content.sweep";
  for (const name of [old, orphan, ordinary, current]) {
    await ensureQueue(name, { policy: "singleton", retryLimit: 1, expireInSeconds: 3600 });
    await boss.send(name, { fixture: true }, { startAfter: new Date(Date.now() + 3600000) });
  }
  await boss.schedule(old, "0 0 1 1 *", {}, { tz: "Asia/Shanghai" });
  const [audit] = await opsDb`INSERT INTO job_runs(job,status,started_at,finished_at) VALUES(${old.slice(5)},'failed',now(),now()) RETURNING id`;
  await opsDb`INSERT INTO job_runs(job,status,started_at,finished_at) VALUES(${current.slice(5)},'ok',now(),now())`;
  // Use real queue storage, without starting business handlers or making model/network calls.
  const registration = new Proxy(boss, {
    get(target, property) {
      if (property === "work") return async () => "synthetic-handler";
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let extensionEnabled = true;
  const extensionName = `module-${suffix}.refresh`;
  installModules([
    {
      name: "synthetic-extension",
      schedules: [
        {
          name: extensionName,
          cron: "0 0 1 1 *",
          when: () => extensionEnabled,
          run: async () => {
            throw new Error("Business handlers must not start in this test");
          },
        },
      ],
    },
  ]);
  await registerSchedules(registration);
  const names = new Set((await boss.getQueues()).map((queue) => queue.name));
  assert.equal(names.has(old), false);
  assert.equal(names.has(orphan), false, "previously unscheduled queues must also retire");
  assert.ok(names.has(current));
  assert.ok(names.has(ordinary));
  assert.ok(names.has(`cron.${extensionName}`), "installed extensions contribute actual schedules");
  extensionEnabled = false;
  await registerSchedules(registration);
  assert.ok(!(await boss.getQueues()).some((queue) => queue.name === `cron.${extensionName}`), "disabled extension timers retire through the same lifecycle");

  assert.ok(!(await boss.getSchedules()).some((schedule) => schedule.name === old));
  const [removed] = await queueDb`SELECT count(*)::int AS n FROM pgboss.job WHERE name IN (${old},${orphan})`;
  assert.equal(removed!.n, 0);
  const [kept] = await queueDb`SELECT count(*)::int AS n FROM pgboss.job WHERE name IN (${ordinary},${current})`;
  assert.equal(kept!.n, 2);
  assert.equal((await opsDb`SELECT id FROM job_runs WHERE id=${audit!.id}`).length, 1);
  const overview = await runsOverview();
  assert.ok(overview.jobs.some((row) => row.job === current.slice(5)));
  assert.ok(!overview.jobs.some((row) => row.job === old.slice(5)), "retired failures cannot remain on the current timer dashboard");
  assert.ok(
    overview.timeline.some((row) => Number(row.id) === Number(audit!.id)),
    "the historical run remains inspectable",
  );
});
