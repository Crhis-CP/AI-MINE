import assert from "node:assert/strict";
import { test } from "node:test";
import { mapLimit } from "../packages/backend/src/lib/concurrency.ts";

test("mapLimit bounds unfinished work and preserves input order", async () => {
  let active = 0,
    peak = 0;
  const items = Array.from({ length: 30 }, (_, i) => i);
  const result = await mapLimit(items, 4, async (i) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 30 - i));
    active--;
    return i * 2;
  });
  assert.equal(peak, 4);
  assert.deepEqual(
    result,
    items.map((i) => i * 2),
  );
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});

test("mapLimit rejects invalid limits and stops dispatching after failure", async () => {
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    await assert.rejects(
      mapLimit([1], limit, async (i) => i),
      RangeError,
    );
  let calls = 0;
  const error = new Error("read failed");
  await assert.rejects(
    mapLimit([1, 2, 3], 1, async () => {
      calls++;
      throw error;
    }),
    (caught) => caught === error,
  );
  assert.equal(calls, 1);
});
