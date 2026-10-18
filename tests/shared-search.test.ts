import assert from "node:assert/strict";
import { test } from "node:test";
import { sharedSearch } from "../packages/backend/src/lib/cache.ts";
test("only overlapping identical searches share work, with fresh retries and independent explicit clocks", async () => {
  let calls = 0;
  const completions: Array<{ resolve: (value: number) => void; reject: (error: Error) => void }> = [];
  const read = sharedSearch(
    (q: { term: string }) => q.term,
    async () => {
      calls++;
      return new Promise<number>((resolve, reject) => completions.push({ resolve, reject }));
    },
    (q) => !!q.term,
  );
  const first = read({ term: "copper" }),
    same = read({ term: "copper" }),
    other = read({ term: "nickel" });
  assert.equal(calls, 2);
  completions[0]!.resolve(1);
  completions[1]!.resolve(2);
  assert.deepEqual(await Promise.all([first, same, other]), [1, 1, 2]);
  const fresh = read({ term: "copper" });
  assert.equal(calls, 3);
  completions[2]!.reject(new Error("synthetic query failure"));
  await assert.rejects(fresh, /synthetic/);
  const retried = read({ term: "copper" });
  completions[3]!.resolve(3);
  assert.equal(await retried, 3);
  const fixed = read({ term: "copper" }, new Date(0)),
    fixedAgain = read({ term: "copper" }, new Date(0));
  assert.equal(calls, 6);
  completions[4]!.resolve(4);
  completions[5]!.resolve(5);
  assert.deepEqual(await Promise.all([fixed, fixedAgain]), [4, 5]);
  const listing = read({ term: "" }),
    listingAgain = read({ term: "" });
  assert.equal(calls, 8);
  completions[6]!.resolve(6);
  completions[7]!.resolve(7);
  assert.deepEqual(await Promise.all([listing, listingAgain]), [6, 7]);
});
