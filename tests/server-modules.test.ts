import assert from "node:assert/strict";
import { after, test } from "node:test";
import { defineServerModule, installModules, serverModules, scheduledTasks } from "@amp/backend/modules";
after(() => installModules([]));
test("module schedules respect startup conditions and do not replace engine work", async () => {
  let enabled = true,
    ran = 0;
  const engine = { name: "core.job", cron: "* * * * *", run: async () => "core" };
  const extension = defineServerModule({
    name: "prices",
    schedules: [
      {
        name: "prices.refresh",
        cron: "*/30 * * * *",
        when: () => enabled,
        run: async () => {
          ran++;
        },
      },
    ],
  });
  installModules([extension]);
  assert.deepEqual(
    scheduledTasks([engine]).map((task) => task.name),
    ["core.job", "prices.refresh"],
  );
  assert.equal(ran, 0, "installing definitions cannot execute business work");
  await scheduledTasks([engine])[1]!.run();
  assert.equal(ran, 1);
  enabled = false;
  assert.deepEqual(
    scheduledTasks([engine]).map((task) => task.name),
    ["core.job"],
  );
  assert.throws(() => installModules([extension, extension]), /duplicate module/);
  assert.equal(serverModules().length, 1, "an invalid install does not replace the active set");
  installModules([{ name: "conflict", schedules: [engine] }]);
  assert.throws(() => scheduledTasks([engine]), /duplicate schedule/);
  installModules([]);
  assert.deepEqual(scheduledTasks([engine]), [engine]);
});
