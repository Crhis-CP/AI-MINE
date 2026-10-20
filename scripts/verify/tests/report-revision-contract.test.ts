import assert from "node:assert/strict";
import { test } from "node:test";
import { NewsReportPeriod, ReportReconcileRequest, ReportReconcileResponse, routes } from "@amp/contracts/http/private";

test("report reconciliation accepts only a real period of the requested kind", () => {
  for (const [kind, key] of [
    ["daily", "2026-10-20"],
    ["daily", "2024-02-29"],
    ["weekly", "2026-W42"],
    ["monthly", "2026-09"],
  ])
    assert.equal(NewsReportPeriod.safeParse({ kind, key }).success, true, `${kind}:${key}`);
  for (const [kind, key] of [
    ["daily", "2026-02-29"],
    ["daily", "2026-09"],
    ["weekly", "2026-W00"],
    ["weekly", "2026-W54"],
    ["weekly", "2026-10-20"],
    ["monthly", "2026-13"],
    ["monthly", "2026-00"],
    ["monthly", "2026-9"],
    ["policy", "2026-09"],
  ])
    assert.equal(NewsReportPeriod.safeParse({ kind, key }).success, false, `${kind}:${key}`);
});
test("revision requests require a positive observed revision, a reason and an idempotency key", () => {
  assert.equal(ReportReconcileRequest.safeParse({ expectedRevision: 1, reason: "历史来源已更正" }).success, true);
  for (const input of [
    { expectedRevision: 0, reason: "说明" },
    { expectedRevision: 1.5, reason: "说明" },
    { expectedRevision: 1, reason: " " },
    { expectedRevision: 1, reason: "说明", force: true },
  ])
    assert.equal(ReportReconcileRequest.safeParse(input).success, false);
  assert.equal(routes.reconcileNewsReport.schema.headers.safeParse({ "idempotency-key": "report-revision-20261020" }).success, true);
  assert.equal(routes.reconcileNewsReport.schema.headers.safeParse({}).success, false);
  for (const status of ["queued", "already_pending", "preserved_manual", "withdrawn"])
    assert.equal(ReportReconcileResponse.safeParse({ kind: "daily", key: "2026-10-20", revision: 1, status }).success, true);
});
