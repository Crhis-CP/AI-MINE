import { test } from "node:test";
import assert from "node:assert/strict";
import { arrangeDaily, reportImportance, type EditionEntry } from "../packages/backend/src/reports/arrangement.ts";
function item(id: string, sourceId = id, extra: Partial<EditionEntry> = {}): EditionEntry {
  return {
    entry: {
      itemId: id,
      factId: `f-${id}`,
      storyPublicId: id,
      title: `合成矿业变化 ${id}`,
      summary: "合成事件导读",
      sourceName: sourceId,
      sourceId,
      sourceUrl: `https://example.invalid/${id}`,
      firstParty: false,
      role: "媒体",
      score: 80,
      publishedAt: "2026-10-15T01:00:00Z",
      sources: 1,
    },
    category: "company_project",
    storyId: null,
    mentions: new Set(),
    sourceIds: new Set([sourceId]),
    authority: 3,
    importance: 80,
    commentary: false,
    previous: null,
    ...extra,
  };
}
test("daily keeps twelve main events, ten flashes and at most two main items per source", () => {
  const entries = Array.from({ length: 30 }, (_, i) => item(String(i).padStart(2, "0"), `s${i % 6}`, { importance: 100 - i }));
  const issue = arrangeDaily(entries);
  assert.equal(issue.main.length, 12);
  assert.equal(issue.flashes.length, 10);
  assert.equal(issue.stats.left, 8);
  for (const source of new Set(issue.main.map((e) => e.entry.sourceId))) assert.equal(issue.main.filter((e) => e.entry.sourceId === source).length, 2);
  assert.equal(issue.main[0]!.entry.itemId, "00");
});
test("official action or four-source new facts can lead again; commentary and thin follow-ups move to flashes", () => {
  const previous = { key: "2026-10-14", title: "此前报道" };
  const fresh = item("fresh");
  const official = item("official", "official", { previous, authority: 0 });
  const commentary = item("commentary", "commentary", { previous, authority: 0, commentary: true });
  const thin = item("thin", "thin", { previous });
  const wide = item("wide", "wide", { previous });
  wide.entry.sources = 4;
  const issue = arrangeDaily([thin, commentary, wide, official, fresh]);
  assert.deepEqual(new Set(issue.main.map((e) => e.entry.itemId)), new Set(["fresh", "official", "wide"]));
  assert.deepEqual(new Set(issue.flashes.map((e) => e.entry.itemId)), new Set(["commentary", "thin"]));
  assert.equal(issue.stats.followUpsAsFlashes, 2);
  assert.equal(arrangeDaily([thin, commentary]).main.length, 2, "a day containing only follow-ups still has a readable issue");
});
test("a roundup attaches to the most important mentioned event without mutating the saved candidates", () => {
  const a = item("a", "official", { storyId: 1, importance: 90 }),
    b = item("b", "press", { storyId: 2, importance: 80 });
  const roundup = item("roundup", "research", { mentions: new Set([1, 2]), importance: 95 });
  const first = arrangeDaily([a, b, roundup]),
    second = arrangeDaily([a, b, roundup]);
  assert.deepEqual(first, second);
  assert.equal(first.main.length, 2);
  assert.equal(first.stats.roundupsFolded, 1);
  assert.deepEqual(
    first.main[0]!.entry.related?.map((e) => e.itemId),
    ["roundup"],
  );
  assert.equal(first.main[0]!.entry.sources, 2);
  assert.equal(a.entry.related, undefined);
  assert.equal(a.sourceIds.size, 1);
  assert.ok(
    reportImportance({ score: 80, participants: 3, official: true, followUp: false }) >
      reportImportance({ score: 80, participants: 3, official: false, followUp: true }),
  );
});
