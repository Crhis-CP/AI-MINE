// What readers see when a published issue is revised (Owner 2026-11-06: “日报里面老是有修订这种不应该出现的出现”):
// late reports joining a past daily issue keep its front page (arrangeDaily) and are not written as a correction; a correction is
// recorded only when a story readers already saw is gone or a correction is pending.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type EditionEntry, arrangeDaily } from "../packages/backend/src/reports/arrangement.ts";
import { correctsIssue } from "../packages/backend/src/reports/reconcile.ts";
import { reportMemberIds, storedReportEntries, type StoredReportContent } from "../packages/backend/src/reports/references.ts";

const entry = (itemId: string, title = `标题${itemId}`) => ({ itemId, title, summary: `导读${itemId}` });
const issue = (lead: string, ids: string[]): StoredReportContent => ({
  leadItemId: lead,
  lead: { title: `标题${lead}`, leadParagraph: `导读${lead}` },
  highlights: ids.filter((id) => id !== lead).slice(0, 3),
  sections: [{ label: "企业与项目", items: ids.map((id) => entry(id)) }],
  sourceMemberIds: ids,
});

const edition = (itemId: string, importance: number, sourceId = `src-${itemId}`): EditionEntry => ({
  entry: {
    ...entry(itemId),
    factId: null,
    storyPublicId: null,
    sourceName: sourceId,
    sourceUrl: "",
    sourceId,
    firstParty: false,
    role: "媒体",
    score: null,
    publishedAt: "",
    sources: 1,
  },
  category: null,
  storyId: null,
  mentions: new Set(),
  sourceIds: new Set([sourceId]),
  authority: 3,
  importance,
  commentary: false,
  previous: null,
});
const ids = (list: EditionEntry[]) => list.map((e) => e.entry.itemId);

test("a late, higher-ranked report joins a past daily issue without taking its front page", () => {
  // Rebuilt with the late report "z" ranked first; the issue led with "a".
  const entries = [edition("z", 90), edition("a", 70), edition("b", 60), edition("c", 50)];
  assert.deepEqual(ids(arrangeDaily(entries).main), ["z", "a", "b", "c"], "a first publication is arranged by rank");
  const kept = arrangeDaily(entries, "a");
  assert.deepEqual(ids(kept.main), ["a", "z", "b", "c"], "the lead stays first and the late report leads the highlights");
  assert.deepEqual(kept.flashes, []);
});

test("the old lead keeps the front page even when late reports of its source fill that source's quota", () => {
  // Codex review (#350): two higher-ranked late reports from the lead's own source used to push it into the flashes.
  const entries = [edition("x", 95, "s1"), edition("y", 90, "s1"), edition("a", 70, "s1"), edition("b", 60, "s2")];
  assert.deepEqual(ids(arrangeDaily(entries).flashes), ["a"], "without the kept lead it is a flash");
  const kept = arrangeDaily(entries, "a");
  assert.deepEqual(ids(kept.main), ["a", "x", "b"], "the lead counts inside its source's quota of two");
  assert.deepEqual(ids(kept.flashes), ["y"]);
});

test("the front page changes only when its story is no longer in the issue", () => {
  const entries = [edition("b", 60), edition("c", 50)];
  assert.deepEqual(ids(arrangeDaily(entries, "a").main), ["b", "c"]);
});

test("joining reports is not a correction; a story readers saw going is", () => {
  const before = issue("a", ["a", "b"]);
  assert.equal(correctsIssue(before, issue("a", ["a", "b", "c"])), false, "a late report joined");
  assert.equal(correctsIssue(before, { ...issue("a", ["a", "b"]), overview: "改写的综述" }), false, "only the overview changed");
  assert.equal(correctsIssue(before, issue("a", ["a"])), true, "a story readers saw is gone");
  assert.equal(correctsIssue({ ...before, correctionPending: true }, issue("a", ["a", "b"])), true, "a pending correction");
});

test("a damaged stored issue reads as empty instead of stopping its repair", () => {
  // Same class as the catch-up repair of a corrupt month: every reader of stored content goes through these helpers.
  for (const damaged of [
    { themes: "broken" },
    { sections: [null, { items: "x" }], flashes: {} },
    { sourceMemberIds: "a" },
  ] as unknown as StoredReportContent[]) {
    assert.deepEqual(storedReportEntries(damaged), []);
    assert.deepEqual(reportMemberIds(damaged), []);
    assert.equal(correctsIssue(damaged, issue("a", ["a"])), false, "filling a damaged issue is a repair, not a correction");
  }
});
