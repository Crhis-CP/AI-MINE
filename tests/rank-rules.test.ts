// The event order's rules (packages/backend/src/pipeline/rank/rules.ts and daily.ts): new or old, where an old report
// is filed, how much an item matters, and what a daily issue leads with. All pure: no database, no model.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReportCitation, ReportDetail } from "@amp/contracts/site";
import { factTiming, memberClaim } from "../packages/backend/src/pipeline/events/timing-rules.ts";
import { type DailyRank, eventAwareDaily } from "../packages/backend/src/pipeline/rank/daily.ts";
import {
  cardAnchor,
  developed,
  earlierCopy,
  eventAwareHot,
  type FreshnessInput,
  freshness,
  genreOf,
  importance,
  type LeadCandidate,
  issueOrder,
  leadOf,
  RANK_RULESET,
  rankAnchor,
  THRESHOLDS,
  topicOf,
} from "../packages/backend/src/pipeline/rank/rules.ts";

const NOW = new Date("2026-11-19T02:00:00Z"); // Beijing 19 November, 10:00
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000);
const input = (more: Partial<FreshnessInput> = {}): FreshnessInput => ({
  reportedAt: NOW,
  ownDate: null,
  factDate: null,
  firstReportedAt: NOW,
  storyFirstReportedAt: null,
  recollectedFrom: null,
  ...more,
});

test("new, follow-up or old: the first rule that applies wins", () => {
  assert.deepEqual(freshness(input({ recollectedFrom: hoursAgo(48) })), { class: "old", basis: "recollected", occurredOn: null });
  assert.equal(freshness(input({ recollectedFrom: hoursAgo(47) })).class, "new", "an earlier copy within two days is the same news");
  assert.deepEqual(freshness(input({ ownDate: "2026-11-14" })), { class: "old", basis: "own_date", occurredOn: "2026-11-14" });
  assert.deepEqual(freshness(input({ ownDate: "2026-11-15" })), { class: "new", basis: "own_date", occurredOn: "2026-11-15" }, "four days is still news");
  assert.deepEqual(freshness(input({ firstReportedAt: hoursAgo(73) })), { class: "old", basis: "late_report", occurredOn: null });
  assert.equal(freshness(input({ firstReportedAt: hoursAgo(72) })).class, "new");
  assert.deepEqual(freshness(input({ firstReportedAt: hoursAgo(1), storyFirstReportedAt: hoursAgo(30) })), {
    class: "follow_up",
    basis: "no_evidence",
    occurredOn: null,
  });
  assert.deepEqual(freshness(input()), { class: "new", basis: "no_evidence", occurredOn: null });
});

test("the fact's day counts only when checked in a text or agreed by two reports; a single unchecked claim never makes a report old", () => {
  const old = { on: "2026-10-20" };
  assert.deepEqual(freshness(input({ factDate: { ...old, basis: "verified" } })), { class: "old", basis: "fact_date", occurredOn: "2026-10-20" });
  assert.equal(freshness(input({ factDate: { ...old, basis: "agreed" } })).class, "old");
  assert.deepEqual(freshness(input({ factDate: { ...old, basis: "claimed" } })), { class: "new", basis: "no_evidence", occurredOn: null });
  assert.equal(
    freshness(input({ factDate: { ...old, basis: "claimed" }, firstReportedAt: hoursAgo(100) })).basis,
    "late_report",
    "the report times still count",
  );
});

test("a fresh day of this report wins over an old first report and an old fact day: a new development is news", () => {
  const f = freshness(input({ ownDate: "2026-11-19", factDate: { on: "2026-10-01", basis: "verified" }, firstReportedAt: hoursAgo(240) }));
  assert.deepEqual(f, { class: "new", basis: "own_date", occurredOn: "2026-11-19" });
});

test("an earlier copy counts only from the same source and only before this report", () => {
  const self = { sourceId: "s1", reportedAt: NOW };
  assert.equal(earlierCopy(self, [{ sourceId: "s2", reportedAt: hoursAgo(500) }]), null, "another outlet's copy is its own report");
  assert.equal(earlierCopy(self, [{ sourceId: "s1", reportedAt: new Date(NOW.getTime() + 1000) }]), null);
  assert.deepEqual(
    earlierCopy(self, [
      { sourceId: "s1", reportedAt: hoursAgo(100) },
      { sourceId: "s1", reportedAt: hoursAgo(300) },
    ]),
    hoursAgo(300),
  );
});

test("an old report is filed on its event day, else its fact's first report, else the first copy; never later than its own place", () => {
  const dated = input({ ownDate: "2026-10-20" });
  assert.deepEqual(rankAnchor(freshness(dated), dated, NOW), new Date("2026-10-19T16:00:00Z"), "Beijing midnight of the event day");
  const late = input({ firstReportedAt: hoursAgo(100) });
  assert.deepEqual(rankAnchor(freshness(late), late, NOW), hoursAgo(100));
  const copy = input({ recollectedFrom: hoursAgo(400) });
  assert.deepEqual(rankAnchor(freshness(copy), copy, NOW), hoursAgo(400));
  assert.deepEqual(rankAnchor(freshness(late), late, hoursAgo(200)), hoursAgo(200), "a list time already earlier is kept");
  assert.equal(rankAnchor(freshness(input()), input(), NOW), null, "new reports keep their place");
});

test("a card is placed by its members that are not old; only an all-old card moves to its event time", () => {
  const fresh = { sortAt: hoursAgo(1), rankAnchor: null },
    older = { sortAt: hoursAgo(3), rankAnchor: null },
    old = { sortAt: hoursAgo(2), rankAnchor: new Date("2026-10-19T16:00:00Z") };
  assert.equal(cardAnchor([old, fresh]), fresh.sortAt.getTime());
  assert.equal(cardAnchor([old, fresh, older]), older.sortAt.getTime(), "earliest current member, as today");
  assert.equal(cardAnchor([old, { sortAt: hoursAgo(5), rankAnchor: hoursAgo(100) }]), old.rankAnchor.getTime());
  assert.throws(() => cardAnchor([]));
});

test("known limit: inside one fact, one member's checked background day files the whole card on that day", () => {
  // The two Zambia reports of tests/acceptance/order.ts fresh-report-keeps-its-card, put in ONE fact instead of two.
  // The undated report inherits the fact's checked day and is old with it, so the card moves to 20 October. Pinned so
  // the measurement of member agreement (design M, E6) and the read-side switch see it; separate facts keep the card.
  const reports = [
    { articleId: "zambia-background", at: hoursAgo(0), claim: "2026-10-20", text: "Zambia first restricted raw ore exports on October 20, 2026." },
    { articleId: "zambia-export", at: new Date(NOW.getTime() + 3_600_000), claim: null, text: "Zambia lifts its ban on copper concentrate exports." },
  ];
  const claims = reports.map((r) => memberClaim({ articleId: r.articleId, revision: 1, claim: r.claim, text: r.text, reportedAt: r.at }));
  const timing = factTiming(claims)!;
  assert.deepEqual([timing.occurredOn, timing.occurredBasis], ["2026-10-20", "verified"]);
  const members = reports.map((r, index) => {
    const i = input({
      reportedAt: r.at,
      ownDate: claims[index]!.verified ? claims[index]!.on : null,
      factDate: { on: timing.occurredOn, basis: timing.occurredBasis },
      firstReportedAt: timing.firstReportedAt,
    });
    const f = freshness(i);
    return { f, sortAt: r.at, rankAnchor: rankAnchor(f, i, r.at) };
  });
  assert.deepEqual(
    members.map((m) => [m.f.class, m.f.basis]),
    [
      ["old", "own_date"],
      ["old", "fact_date"],
    ],
  );
  assert.equal(cardAnchor(members), new Date("2026-10-19T16:00:00Z").getTime());
});

test("importance: score, official release, tagged major, old penalty; never the number of outlets", () => {
  assert.deepEqual(importance({ score: null, representativePriority: 3, tags: [], freshness: "new" }), {
    value: 50,
    inputs: { score: 50, official: 0, entity: 0, novelty: 0 },
  });
  assert.deepEqual(importance({ score: 80.123, representativePriority: 2, tags: ["铜", "力拓"], freshness: "old" }), {
    value: 57.12,
    inputs: { score: 80.123, official: 5, entity: 2, novelty: -30 },
  });
  assert.equal(
    importance({ score: 70, representativePriority: 3, tags: ["某初级勘探公司"], freshness: "follow_up" }).value,
    70,
    "an untagged company adds nothing",
  );
  assert.ok(RANK_RULESET.startsWith("rank-v1:") && RANK_RULESET.includes(`oldGapDays=${THRESHOLDS.oldGapDays}`), "the ruleset names its values");
});

test("genre from stored data, first match wins; the topic is the category unless it is commentary", () => {
  const base = { xPost: false, scope: "single", category: "policy_regulation", authorRole: "principal", title: "智利批准锂矿招标", representativePriority: 3 };
  assert.equal(genreOf({ ...base, xPost: true, scope: "composite" }), "post");
  assert.equal(genreOf({ ...base, scope: "composite" }), "roundup");
  assert.equal(genreOf({ ...base, category: "events_opinion" }), "commentary");
  assert.equal(genreOf({ ...base, authorRole: "observer" }), "commentary");
  assert.equal(genreOf({ ...base, title: "自然资源部发布《矿产资源法实施条例》" }), "document");
  assert.equal(genreOf({ ...base, representativePriority: 1 }), "official_release");
  assert.equal(genreOf(base), "report");
  assert.equal(topicOf("policy_regulation"), "policy_regulation");
  assert.equal(topicOf("events_opinion"), null);
  assert.equal(topicOf(null), null);
});

test("a story developed when its fact is new in the issue's window or its event day is at most two days old", () => {
  const window = { windowStart: new Date("2026-11-18T00:00:00Z"), windowEnd: new Date("2026-11-19T00:00:00Z"), issueDate: "2026-11-19" };
  assert.ok(developed({ ...window, factFirstReportedAt: new Date("2026-11-18T00:00:00Z"), occurredOn: null }));
  assert.equal(developed({ ...window, factFirstReportedAt: new Date("2026-11-19T00:00:00Z"), occurredOn: null }), false, "the window's end is outside");
  assert.equal(developed({ ...window, factFirstReportedAt: new Date("2026-11-17T23:59:00Z"), occurredOn: null }), false);
  assert.ok(developed({ ...window, factFirstReportedAt: null, occurredOn: "2026-11-17" }));
  assert.equal(developed({ ...window, factFirstReportedAt: null, occurredOn: "2026-11-16" }), false);
});

const cand = (id: string, importance: number, more: Partial<LeadCandidate> = {}): LeadCandidate => ({
  id,
  key: id,
  importance,
  freshness: "new",
  followUp: false,
  developed: false,
  ...more,
});

test("the lead: importance over outlets, yesterday's lead only when it developed, old news only when nothing else exists", () => {
  // The design's three fixtures: 82 over 70; 76 over yesterday's undeveloped 78; 88 over 75 when it developed.
  assert.equal(leadOf([cand("syndicated", 70), cand("policy", 82)], []), "policy");
  assert.equal(leadOf([cand("codelco", 78, { followUp: true }), cand("new-story", 76)], ["codelco"]), "new-story");
  assert.equal(leadOf([cand("codelco", 88, { developed: true }), cand("other", 75)], ["codelco"]), "codelco");
  assert.equal(leadOf([cand("old", 95, { freshness: "old" }), cand("small", 40)], []), "small");
  assert.equal(leadOf([cand("old", 95, { freshness: "old" })], []), "old", "an issue always has a lead");
  assert.equal(leadOf([cand("codelco", 78)], ["codelco"]), "codelco");
  assert.throws(() => leadOf([], []));
});

test("the lead memory: two earlier issues, by story key; an undeveloped follow-up loses the follow-up penalty's worth", () => {
  const story = (id: string, importance: number) => cand(id, importance, { key: "story-a" });
  assert.equal(leadOf([story("a-3", 90), cand("d", 60)], ["story-c", "story-a"]), "d", "led two issues ago");
  assert.equal(leadOf([story("a-4", 90), cand("d", 60)], ["story-c", "story-b", "story-a"]), "a-4", "three issues ago is forgotten");
  assert.equal(leadOf([story("a-5", 90), cand("d", 60)], [null, "story-c", "story-a"]), "a-5", "a quiet issue without a lead still counts as an issue");
  assert.equal(leadOf([story("a-6", 90), cand("d", 60)], [null, "story-a"]), "d");
  assert.equal(leadOf([cand("follow", 80, { followUp: true }), cand("fresh", 69)], []), "fresh", "a follow-up that did not develop: 80 − 12 = 68 < 69");
  assert.equal(leadOf([cand("follow", 80, { followUp: true, developed: true }), cand("fresh", 69)], []), "follow");
  assert.deepEqual(issueOrder([cand("b", 50), cand("a", 50), cand("c", 60, { followUp: true })], []), ["a", "b", "c"], "ties by id; 60 − 12 = 48");
});

test("the hot board: stale stories sink, heat order kept inside each group, ranks renumbered, fresh stories represented by their latest fresh report", () => {
  const entry = (rank: number, storyId: number) => ({
    rank,
    storyId,
    representativeItemId: `rep-${storyId}`,
    representativeUrl: `https://fixture.invalid/${storyId}`,
    representativeSource: "outlet",
    heat: 100 - rank,
  });
  const stories = new Map([
    [1, { fresh: false, latestFreshArticleId: null }],
    [2, { fresh: true, latestFreshArticleId: "latest-2" }],
    [3, { fresh: true, latestFreshArticleId: "rep-3" }],
  ]);
  const got = eventAwareHot([entry(3, 3), entry(1, 1), entry(2, 2), entry(4, 4)], stories);
  assert.deepEqual(
    got.map((e) => [e.rank, e.storyId, e.heat, e.representativeItemId, e.representativeUrl]),
    [
      [1, 2, 98, "latest-2", null],
      [2, 3, 97, "rep-3", "https://fixture.invalid/3"],
      [3, 4, 96, "rep-4", "https://fixture.invalid/4"],
      [4, 1, 99, "rep-1", "https://fixture.invalid/1"],
    ],
  );
});

// A stored daily issue: two sections of main items and one flash. The stored lead is the most widely carried item.
const citation = (itemId: string, storyPublicId: string | null = null, more: Partial<ReportCitation> = {}): ReportCitation => ({
  itemId,
  title: `title ${itemId}`,
  summary: `summary ${itemId}`,
  sourceName: "source",
  sourceUrl: `https://fixture.invalid/${itemId}`,
  sourceId: itemId,
  firstParty: false,
  role: "report",
  storyPublicId,
  publishedAt: "2026-11-18T10:00:00.000Z",
  available: true,
  ...more,
});
const issue = (more: Partial<ReportDetail> = {}): ReportDetail => {
  const sections = [
    { label: "政策", summary: null, items: [citation("wire", "s-wire", { followUp: "2026-11-18" }), citation("policy")] },
    { label: "项目", summary: null, items: [citation("mine"), citation("old-news")] },
  ];
  return {
    kind: "daily",
    key: "2026-11-19",
    title: "日报 · 2026-11-19",
    windowStart: "2026-11-18T00:00:00.000Z",
    windowEnd: "2026-11-19T00:00:00.000Z",
    generatedAt: "2026-11-19T00:00:00.000Z",
    firstPublishedAt: "2026-11-19T00:00:00.000Z",
    revision: 3,
    lead: { title: "stored lead words", leadParagraph: "stored paragraph" },
    leadItemId: "wire",
    overview: null,
    highlights: [sections[0]!.items[1]!, sections[1]!.items[0]!, sections[1]!.items[1]!],
    sections,
    stories: sections.flatMap((s) => s.items.map((i) => ({ ...i, label: s.label }))),
    flashes: [citation("flash-big")],
    metrics: { totalEvents: 4 },
    readingMinutes: 2,
    prev: "2026-11-18",
    next: null,
    ...more,
  };
};
const rank = (importance: number, more: Partial<DailyRank> = {}): DailyRank => ({ importance, freshness: "new", developed: false, ...more });
const RANKS = new Map<string, DailyRank>([
  ["wire", rank(80)],
  ["policy", rank(75)],
  ["mine", rank(72)],
  ["old-news", rank(90, { freshness: "old" })],
  ["flash-big", rank(99)],
]);
const FROM = new Date("2026-11-18T12:00:00Z");

test("the daily issue is re-led inside its stored main items; slots, sections and flashes stay as stored", () => {
  const stored = issue();
  const read = eventAwareDaily(stored, RANKS, ["s-wire"], FROM);
  assert.equal(read.leadItemId, "policy", "yesterday's undeveloped lead steps down; the bigger flash and the old item do not lead");
  assert.deepEqual(read.lead, { title: "title policy", leadParagraph: "summary policy" });
  assert.deepEqual(
    read.highlights.map((h) => h.itemId),
    ["mine", "wire", "old-news"],
  );
  assert.deepEqual(
    read.sections.map((s) => [s.label, s.items.map((i) => i.itemId)]),
    [
      ["政策", ["policy", "wire"]],
      ["项目", ["mine", "old-news"]],
    ],
  );
  assert.deepEqual(
    read.stories.map((s) => [s.label, s.itemId]),
    [
      ["政策", "policy"],
      ["政策", "wire"],
      ["项目", "mine"],
      ["项目", "old-news"],
    ],
  );
  assert.equal(read.flashes, stored.flashes);
  assert.deepEqual([read.revision, read.metrics, read.title], [stored.revision, stored.metrics, stored.title]);
  assert.deepEqual(stored, issue(), "the stored issue object is not modified");
});

test("a kept lead keeps its stored words", () => {
  const read = eventAwareDaily(issue(), new Map([...RANKS, ["wire", rank(80, { developed: true })]]), ["s-wire"], FROM);
  assert.equal(read.leadItemId, "wire");
  assert.deepEqual(read.lead, { title: "stored lead words", leadParagraph: "stored paragraph" });
});

test("the stored issue is returned untouched whenever the event order may not apply", () => {
  const cases: Array<[string, ReportDetail, ReadonlyMap<string, DailyRank>]> = [
    ["weekly", issue({ kind: "weekly" }), RANKS],
    ["first published before the order was switched on", issue({ firstPublishedAt: "2026-11-18T11:59:59.000Z" }), RANKS],
    ["no first publication time", issue({ firstPublishedAt: undefined }), RANKS],
    ["no named lead item", issue({ leadItemId: undefined }), RANKS],
    ["no lead (quiet or removed)", issue({ lead: null }), RANKS],
    ["a main item without a rank", issue(), new Map([...RANKS].filter(([id]) => id !== "mine"))],
    [
      "a withdrawn main item",
      issue({ sections: [{ label: "政策", summary: null, items: [citation("wire"), citation("policy", null, { available: false })] }] }),
      RANKS,
    ],
    ["no main items", issue({ sections: [] }), RANKS],
  ];
  for (const [why, stored, ranks] of cases) assert.equal(eventAwareDaily(stored, ranks, ["s-wire"], FROM), stored, why);
});

test("a quiet issue between two leads uses up a place in the lead memory", () => {
  // 90 − 12 = 78 still beats policy's 75, so only the memory can keep the wire story from leading.
  const ranks = new Map([...RANKS, ["wire", rank(90)]]);
  assert.equal(eventAwareDaily(issue(), ranks, [null, "s-wire"], FROM).leadItemId, "policy", "led two issues ago, one of them quiet");
  assert.equal(eventAwareDaily(issue(), ranks, [null, "s-other", "s-wire"], FROM).leadItemId, "wire", "led three issues ago is forgotten");
});
