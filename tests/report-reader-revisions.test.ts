// What readers see when a published issue is revised (Owner 2026-11-06: “日报里面老是有修订这种不应该出现的出现”):
// late reports joining a past daily issue keep its front page and are not written as a correction; a correction is
// recorded only when a story readers already saw is gone or a correction is pending.
import assert from "node:assert/strict";
import { test } from "node:test";
import { correctsIssue, keepDailyLead } from "../packages/backend/src/reports/reconcile.ts";
import type { StoredReportContent } from "../packages/backend/src/reports/references.ts";

const entry = (itemId: string, title = `标题${itemId}`) => ({ itemId, title, summary: `导读${itemId}` });
const issue = (lead: string, ids: string[]): StoredReportContent => ({
  leadItemId: lead,
  lead: { title: `标题${lead}`, leadParagraph: `导读${lead}` },
  highlights: ids.filter((id) => id !== lead).slice(0, 3),
  sections: [{ label: "企业与项目", items: ids.map((id) => entry(id)) }],
  sourceMemberIds: ids,
});

test("a late, higher-ranked report joins a past daily issue without taking its front page", () => {
  const before = issue("a", ["a", "b", "c"]);
  // Rebuilt with the late report "z" ranked first.
  const rebuilt = issue("z", ["z", "a", "b", "c"]);
  const kept = keepDailyLead(before, rebuilt);
  assert.equal(kept.leadItemId, "a");
  assert.deepEqual(kept.lead, { title: "标题a", leadParagraph: "导读a" });
  assert.deepEqual(kept.highlights, ["z", "b", "c"], "the late report leads the highlights instead");
  assert.deepEqual(kept.sections, rebuilt.sections, "every story stays in the issue");
});

test("the front page changes only when its story is no longer in the issue", () => {
  const before = issue("a", ["a", "b"]);
  const rebuilt = issue("b", ["b", "c"]);
  assert.equal(keepDailyLead(before, rebuilt), rebuilt);
  assert.equal(keepDailyLead(undefined, rebuilt), rebuilt, "a first publication is taken as built");
});

test("joining reports is not a correction; a story readers saw going is", () => {
  const before = issue("a", ["a", "b"]);
  assert.equal(correctsIssue(before, issue("a", ["a", "b", "c"])), false, "a late report joined");
  assert.equal(correctsIssue(before, { ...issue("a", ["a", "b"]), overview: "改写的综述" }), false, "only the overview changed");
  assert.equal(correctsIssue(before, issue("a", ["a"])), true, "a story readers saw is gone");
  assert.equal(correctsIssue({ ...before, correctionPending: true }, issue("a", ["a", "b"])), true, "a pending correction");
});
