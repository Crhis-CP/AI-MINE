// The run's order: the gates (paperwork and hygiene, no build needed) go first, and a failed gate stops the
// builds and tests of a full run, so a missing card is reported in the first minute.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runOrder, STAGES, stoppedBy } from "../run.ts";

test("gates run first; inside each group the listed order is kept", () => {
  const order = runOrder([{ name: "install" }, { name: "path-guard", gate: true }, { name: "test" }, { name: "docs", gate: true }]).map((s) => s.name);
  assert.deepEqual(order, ["path-guard", "docs", "install", "test"]);
});

test("a failed gate stops the stages that are not gates, and never another gate", () => {
  const gates = new Set(["path-guard", "docs"]);
  const results = [
    { name: "path-guard", status: "fail" },
    { name: "docs", status: "pass" },
  ];
  assert.equal(stoppedBy({}, results, gates), "path-guard");
  assert.equal(stoppedBy({ gate: true }, results, gates), null);
  assert.equal(stoppedBy({}, [{ name: "docs", status: "pass" }], gates), null);
  // A failed stage that is not a gate stops nothing by this rule: `after` decides there.
  assert.equal(stoppedBy({}, [{ name: "typecheck", status: "fail" }], gates), null);
});

test("the gates are the checks that need no install, build or database, so they can stand first", () => {
  const gates = STAGES.filter((s) => s.gate);
  assert.deepEqual(
    gates.map((s) => s.name),
    ["product-update", "names", "path-guard", "secrets", "docs", "tasks"],
  );
  for (const s of gates) assert.ok(!s.after?.length && !s.needsDb, `${s.name} depends on an earlier stage`);
  // Every stage still runs exactly once.
  assert.deepEqual(
    runOrder(STAGES)
      .map((s) => s.name)
      .sort(),
    STAGES.map((s) => s.name).sort(),
  );
});
