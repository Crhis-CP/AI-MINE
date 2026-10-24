import assert from "node:assert/strict";
import { test } from "node:test";
import { TopicPage, TopicDirectory } from "@amp/contracts/http/public";
import { AdminNavigationCounts, AdminModuleRuns, ReceiptReconciliationResponse } from "@amp/contracts/http/private";

const topic = {
  slug: "synthetic",
  name: "合成矿业主题",
  group: "project",
  definition: "只用于契约测试",
  total: 0,
  recent: 0,
  indexable: false,
  latestAt: null,
  basis: "all",
};
test("module outputs preserve legacy topic and private run responses without inventing missing data", () => {
  const page = { topic: { ...topic, related: [] }, items: [], page: 1, pageCount: 1 };
  assert.deepEqual(TopicPage.parse(page), page);
  assert.deepEqual(TopicDirectory.parse({ topics: [topic] }), { topics: [topic] });
  assert.deepEqual(TopicPage.parse({ ...page, parts: { synthetic: { available: true } } }).parts, { synthetic: { available: true } });
  assert.equal(TopicPage.safeParse({ ...page, privateBody: "not part of the public page" }).success, false);
  const runs = { receipts: { counts: {}, issues: [] }, deliveries: [] };
  assert.deepEqual(ReceiptReconciliationResponse.parse(runs), runs);
  const modules = { one: { status: "ready", data: { count: 0 } }, two: { status: "unavailable" } };
  assert.deepEqual(ReceiptReconciliationResponse.parse({ ...runs, modules }).modules, modules);
  assert.equal(AdminModuleRuns.safeParse({ two: { status: "unavailable", error: "secret detail" } }).success, false);
  assert.deepEqual(AdminNavigationCounts.parse({ feedback: 0, synthetic: 3 }), { feedback: 0, synthetic: 3 });
  for (const value of [-1, null, "unknown"]) assert.equal(AdminNavigationCounts.safeParse({ synthetic: value }).success, false);
});
