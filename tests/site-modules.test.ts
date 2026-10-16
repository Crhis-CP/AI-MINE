import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MODULES } from "../site/modules/index.ts";
import { SERVER_MODULES } from "../site/modules/server.ts";
import { installModules, scheduledTasks } from "@amp/backend/modules";
const previous = process.env.COLLECT_ENABLED;
after(() => {
  installModules([]);
  if (previous === undefined) delete process.env.COLLECT_ENABLED;
  else process.env.COLLECT_ENABLED = previous;
});
test("installed mining extensions retain the existing price timer and respect collection configuration without doing I/O", () => {
  assert.ok(SERVER_MODULES.every((server) => MODULES.some((module) => module.name === server.name)));
  installModules(SERVER_MODULES);
  process.env.COLLECT_ENABLED = "true";
  const prices = scheduledTasks([]).find((task) => task.name === "metals.prices");
  assert.ok(prices);
  assert.equal(prices.cron, "*/30 * * * *");
  assert.equal(prices.missed, "once");
  process.env.COLLECT_ENABLED = "false";
  assert.ok(!scheduledTasks([]).some((task) => task.name === "metals.prices"));
});

test("policy schedules are installed as a unit and collection-off leaves no source timer", () => {
  installModules(SERVER_MODULES);
  process.env.COLLECT_ENABLED = "true";
  const schedules = scheduledTasks([]);
  assert.equal(schedules.find((task) => task.name === "policy.pipeline.sweep")?.cron, "* * * * *");
  assert.equal(schedules.find((task) => task.name === "policy.reports")?.missed, "once");
  assert.ok(schedules.some((task) => task.name === "policy.sources.schedule"));
  process.env.COLLECT_ENABLED = "false";
  assert.ok(!scheduledTasks([]).some((task) => task.name === "policy.sources.schedule"));
  installModules([]);
  assert.deepEqual(scheduledTasks([]), []);
});
