// The order acceptance cases (tests/acceptance/order.ts): what is new, what the home list starts with, what a daily
// issue leads with. The event order must meet every case. Today's code is run beside it so the defect cases are seen
// to bite: each is a defect the Owner saw on the live site, and a case today's code already met would prove nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runCases } from "./acceptance/case.ts";
import { NEXT_ORDER, ORDER_CASES, type OrderEffects, TODAY_ORDER } from "./acceptance/order.ts";

function outcome(name: string, effects: OrderEffects) {
  const results = runCases(ORDER_CASES, effects);
  for (const c of ORDER_CASES) {
    const problem = results.get(c.id)!;
    console.log(`${name} ${problem === null ? "met  " : "UNMET"} ${c.kind} ${c.id}: ${c.says}${problem === null ? "" : ` — ${problem}`}`);
  }
  return results;
}

test("the event order meets every order case", () => {
  const results = outcome("next ", NEXT_ORDER);
  assert.deepEqual(
    [...results].filter(([, problem]) => problem !== null),
    [],
  );
});

test("today's code fails every defect case: the cases describe what the Owner saw", () => {
  const results = outcome("today", TODAY_ORDER);
  assert.deepEqual(
    ORDER_CASES.filter((c) => c.kind === "defect" && results.get(c.id) === null).map((c) => c.id),
    [],
    "a defect case today's code meets does not show the defect",
  );
});

test("every case says what the reader wants in Chinese; every defect case carries the Owner's words", () => {
  for (const c of ORDER_CASES) {
    assert.ok(c.says.length >= 8 && /[一-鿿]/.test(c.says), c.id);
    if (c.kind === "defect") assert.match(c.says, /^“[^”]+”：/, c.id);
  }
});
