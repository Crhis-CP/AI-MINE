// Category filters match stored keys in both directions until history is reclassified (ADR-0031).
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { categoryKeys } from "../packages/backend/src/publication/items.ts";

test("a current key also matches rows still stored under its sole retired predecessor", () => {
  assert.deepEqual(categoryKeys("safety_environment")?.sort(), ["esg_community_labor", "safety_environment", "safety_incident"]);
  assert.deepEqual(categoryKeys("policy_regulation")?.sort(), ["policy_regulation", "supply_trade_controls"]);
  assert.deepEqual(categoryKeys("operations_output"), ["operations_output"], "a split key is left to the model reclassification");
  assert.deepEqual(categoryKeys("company_project")?.sort(), ["operations_output", "project_development"]);
  assert.equal(categoryKeys(null), null);
});
