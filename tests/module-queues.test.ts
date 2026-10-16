import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb } from "@amp/backend/db";
import { defineQueue, installModules } from "@amp/backend/modules";
import { workModuleQueues, workQueues } from "@amp/backend/jobs/module-queues";
import { enqueue, getBoss, QUEUES, stopBoss } from "@amp/backend/jobs/queue";

after(async () => {
  installModules([]);
  await stopBoss();
  await closeDb();
});

test("an installed module consumes durable queue data with its own options and receives every batched item", async () => {
  const received: number[] = [];
  const queue = defineQueue<{ value: number }>({
    name: "fixture-module.capture",
    options: { policy: "standard", retryLimit: 0, expireInSeconds: 60 },
    worker: { batchSize: 2, pollingIntervalSeconds: 1 },
    async run(items) {
      received.push(...items.map((item) => item.value));
    },
  });
  installModules([{ name: "fixture-module", queues: [queue] }]);
  const boss = await getBoss();
  await workModuleQueues(boss);
  await enqueue(queue.name, { value: 1 });
  await enqueue(queue.name, { value: 2 });
  for (let attempt = 0; attempt < 200 && received.length < 2; attempt++) await delay(50);
  assert.deepEqual(received.sort(), [1, 2]);
  const actual = await boss.getQueue(queue.name);
  assert.equal(actual?.policy, "standard");
  assert.equal(actual?.retryLimit, 0);
  assert.equal(actual?.expireInSeconds, 60);
});

test("duplicate module or engine queue names are rejected before any queue is created", async () => {
  const boss = await getBoss();
  const queue = defineQueue({ name: "fixture-module.duplicate", options: {}, worker: {}, async run() {} });
  await assert.rejects(workQueues(boss, [queue, queue]), /duplicate module queue/);
  assert.equal(await boss.getQueue(queue.name), null);
  await assert.rejects(workQueues(boss, [{ ...queue, name: QUEUES.analyze }]), /duplicate module queue/);
});
