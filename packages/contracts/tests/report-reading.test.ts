import { test } from "node:test";
import assert from "node:assert/strict";
import { ReportReading } from "../src/http/report-reading.ts";
import { V3Report } from "../src/http/v3.ts";
import type { ReportCitation, ReportDetail } from "../src/site.ts";

test("report reading metadata remains optional and never fills unknown legacy states", () => {
  assert.equal(V3Report.shape.reading.parse(undefined), undefined);
  const legacy = {
    itemId: null,
    title: "旧引用",
    summary: null,
    sourceName: "来源",
    sourceUrl: "",
    sourceId: null,
    firstParty: false,
    role: null,
    storyPublicId: null,
    publishedAt: null,
    available: false,
  } satisfies ReportCitation;
  const lead: Pick<ReportDetail, "lead" | "leadItemId"> = { lead: { title: "旧导语", leadParagraph: "保留旧报告" } };
  assert.equal("followUp" in legacy, false);
  assert.equal("leadItemId" in lead, false);
});

test("a leading item belongs to the issue and optional source counts require evidence", () => {
  const value = { lead_item_id: "a", entries: [{ item_id: "a", fact_id: "fact-1", source_count: 3, follow_up_issue: "2026-10-14", related_item_ids: ["b"] }] };
  assert.deepEqual(ReportReading.parse(value), value);
  assert.equal(ReportReading.safeParse({ ...value, lead_item_id: "absent" }).success, false);
  assert.equal(ReportReading.safeParse({ ...value, entries: [...value.entries, ...value.entries] }).success, false);
  assert.equal(ReportReading.safeParse({ lead_item_id: null, entries: [{ item_id: "a", fact_id: null, source_count: 0 }] }).success, false);
  assert.deepEqual(ReportReading.parse({ lead_item_id: null, entries: [] }), { lead_item_id: null, entries: [] });
});
