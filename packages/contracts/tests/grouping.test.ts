import { test } from "node:test";
import assert from "node:assert/strict";
import { GroupingOverview, NewsGroupingDiagnostic, ReceiptReconciliationResponse } from "../src/http/private.ts";

test("old running pages remain valid and missing grouping fields never become confirmation", () => {
  const old = ReceiptReconciliationResponse.parse({ receipts: { counts: {}, issues: [] }, deliveries: [] });
  assert.equal(old.grouping, undefined);
  assert.equal(NewsGroupingDiagnostic.safeParse({}).success, false);
  const pending = NewsGroupingDiagnostic.parse({
    materialRevision: 3,
    inputRevision: null,
    status: "pending",
    selectionCandidate: null,
    addsValue: null,
    reason: null,
    receiptId: null,
    error: null,
  });
  assert.equal(pending.addsValue, null);
  assert.equal(NewsGroupingDiagnostic.safeParse({ ...pending, status: "complete" }).success, false);
  assert.equal(NewsGroupingDiagnostic.safeParse({ ...pending, status: "complete", inputRevision: 2 }).success, false);
  assert.equal(
    NewsGroupingDiagnostic.safeParse({ ...pending, status: "complete", inputRevision: 3, addsValue: false, reason: "重复报道，无新增信息" }).success,
    true,
  );
});

test("grouping overview distinguishes receipt waiting from manual handling and bounds its counts", () => {
  const item = {
    articleId: "fixture-article",
    title: "矿业项目公告",
    since: "2026-10-15T08:00:00Z",
    failed: false,
    recovery: "receipt",
    receiptId: 1,
    error: null,
  };
  assert.equal(GroupingOverview.parse({ waiting: 1, needsAttention: 1, items: [item] }).items[0].recovery, "receipt");
  for (const value of [
    { waiting: 0, needsAttention: 1, items: [] },
    { waiting: 0, needsAttention: 0, items: [item] },
    { waiting: 1, needsAttention: 0, items: [{ ...item, recovery: "confirmed" }] },
  ])
    assert.equal(GroupingOverview.safeParse(value).success, false);
});
