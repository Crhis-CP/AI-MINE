import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FeedItemSummary,
  GroupInfo,
  TimelineResponse,
  PoolResponse,
  ReportGroupInfo,
  ReportGroupDetailFields,
  ReportGroupedTimelineResponse,
  ReportGroupedPoolResponse,
  ReportGroupedPoolQuery,
  ReportGroupedTimelineQuery,
  ReportGroupedItemQuery,
  ReportGroupReportsQuery,
  ReportGroupReportsResponse,
  schemas,
  routes,
} from "@amp/contracts/http/public";
import { ReportIdentityDecision, ReportGroupProjectionChange } from "../packages/contracts/src/report-groups.ts";
import type { GroupReport, SiteItemDetail, ReportGroupedSiteItemDetail } from "@amp/contracts/site";

const at = "2026-10-01T00:00:00Z";
const item = {
  id: "synthetic-a",
  title: "合成报道",
  summary: null,
  reason: null,
  source: { name: "合成来源" },
  publishedAt: null,
  timelineAt: at,
  category: null,
  tags: [],
  score: 58,
  selected: false,
  channel: "news",
};
const filters = { channel: "all", category: null, tag: null, topic: null };
const card = { key: "a:synthetic-a", anchorAt: at, item, group: null };
const timeline = { filters, cards: [card], nextCursor: null, refreshAt: null, hot: null, dayCounts: {}, generatedAt: at };
const pool = {
  filters: { ...filters, q: null, tab: "time" },
  items: [item],
  cards: [card],
  page: 1,
  pageCount: 1,
  total: 1,
  todayCount: 1,
  freshness: at,
  generatedAt: at,
};
const group = { id: "00000000-0000-4000-8000-000000000001", memberIds: ["synthetic-a", "synthetic-b"], reportCount: 2, additionalSourceCount: 1 };

test("legacy strict payloads stay unchanged and negotiated schemas accept rollback responses without inventing fields", () => {
  assert.deepEqual(TimelineResponse.parse(timeline), timeline);
  assert.deepEqual(PoolResponse.parse(pool), pool);
  assert.deepEqual(ReportGroupedTimelineResponse.parse(timeline), timeline);
  assert.deepEqual(ReportGroupedPoolResponse.parse(pool), pool);
  assert.deepEqual(ReportGroupDetailFields.parse({}), {});
  for (const value of [group, null]) {
    const next = { ...card, reportGroup: value };
    assert.equal(TimelineResponse.safeParse({ ...timeline, cards: [next] }).success, false);
    assert.equal(PoolResponse.safeParse({ ...pool, cards: [next] }).success, false);
    assert.equal(FeedItemSummary.safeParse({ ...item, reportGroup: value }).success, false);
    assert.equal(ReportGroupedTimelineResponse.safeParse({ ...timeline, cards: [next] }).success, true);
    assert.equal(ReportGroupedPoolResponse.safeParse({ ...pool, cards: [next] }).success, true);
  }
  const compatible: SiteItemDetail extends ReportGroupedSiteItemDetail ? true : false = true;
  assert.equal(compatible, true);
});

test("the capability is explicit for list and detail queries and never inferred from a truthy value", () => {
  for (const schema of [ReportGroupedPoolQuery, ReportGroupedTimelineQuery, ReportGroupedItemQuery]) {
    assert.deepEqual(schema.parse({}), {});
    assert.equal(schema.parse({ readingGroups: "reports-v1" }).readingGroups, "reports-v1");
    for (const value of [true, 1, "1", "true", "reports-v2", null]) assert.equal(schema.safeParse({ readingGroups: value }).success, false);
  }
  assert.equal(ReportGroupReportsQuery.safeParse({ ...filters, category: undefined, tag: undefined, topic: undefined, take: 40, scope: "all" }).success, true);
  assert.equal(ReportGroupReportsQuery.safeParse({ take: 41 }).success, false);
  const memberFilters = {
    q: "合成",
    source: "synthetic-source",
    mineral: "copper",
    on: "2026-10-01",
    from: "2026-10-01",
    to: "2026-10-02",
    selected: false,
    scope: "all",
    cursor: "cursor",
    take: 20,
    revision: "v1",
  };
  assert.deepEqual(ReportGroupReportsQuery.parse(memberFilters), memberFilters);
});

test("report groups cannot masquerade as facts or leak private evidence through source expansion", () => {
  assert.equal(GroupInfo.safeParse(group).success, false);
  for (const extra of [{ factId: "fake-fact" }, { receiptId: 1 }, { reason: "private model reason" }, { quote: "private source text" }])
    assert.equal(ReportGroupInfo.safeParse({ ...group, ...extra }).success, false);
  assert.equal(ReportGroupInfo.safeParse({ ...group, memberIds: ["synthetic-a", "synthetic-a"] }).success, false);
  assert.equal(ReportGroupInfo.safeParse({ ...group, additionalSourceCount: 2 }).success, false);
  const report: GroupReport = {
    id: item.id,
    title: item.title,
    summary: null,
    source: { id: "synthetic-source", name: "合成来源", kind: "rss", firstParty: false },
    timelineAt: at,
    originalUrl: "https://example.invalid/article",
    selected: false,
  };
  const body = { reportGroupId: group.id, revision: "members-v1", reports: [report], nextCursor: null };
  assert.deepEqual(ReportGroupReportsResponse.parse(body), body);
  assert.equal(ReportGroupReportsResponse.safeParse({ ...body, factId: group.id }).success, false);
  assert.equal(ReportGroupReportsResponse.safeParse({ ...body, reports: [{ ...report, receiptId: 1 }] }).success, false);
  assert.equal(ReportGroupReportsResponse.safeParse({ ...body, reports: [{ ...report, originalUrl: "javascript:void(0)" }] }).success, false);
  assert.equal(routes.siteReportGroupReports.url, "/api/site/report-groups/:reportGroupId/reports");
  assert.ok(!Object.keys(schemas).includes("ReportIdentityDecision"));
});

test("private decisions bind both current materials and real attempts; projection requests contain no model answer", () => {
  const binding = {
    articleId: "synthetic-a",
    sourceId: "synthetic-source",
    materialRevision: 2,
    contentHash: "a".repeat(64),
    sourceDateVersion: 0,
    permissionVersion: 1,
    manualStateHash: "b".repeat(64),
  };
  const anchor = { ...binding, articleId: "synthetic-b", sourceId: "synthetic-other" };
  const identity = { lane: "news", article: binding, anchor, recipe: "synthetic-v1", inputFingerprint: "c".repeat(64) };
  const decision = {
    ...identity,
    relation: "same_report",
    evidence: { articleQuote: "合成的左侧证据", anchorQuote: "合成的右侧证据" },
    reason: "合成模型判断",
    receiptId: 1,
    attemptId: "2",
  };
  assert.deepEqual(ReportIdentityDecision.parse(decision), decision);
  assert.equal(ReportIdentityDecision.parse({ ...decision, attemptId: "9007199254740993" }).attemptId, "9007199254740993");
  for (const attemptId of [null, "0", "02", "-1", "bad", "2.1"]) assert.equal(ReportIdentityDecision.safeParse({ ...decision, attemptId }).success, false);
  for (const change of [{ lane: "policy" }, { receiptId: null }, { attemptId: 0 }, { anchor: binding }, { evidence: null }, { relation: "waiting" }])
    assert.equal(ReportIdentityDecision.safeParse({ ...decision, ...change }).success, false);
  assert.equal(ReportIdentityDecision.safeParse({ ...decision, relation: "insufficient", evidence: null }).success, true);
  const projection = { ...identity, groupId: group.id };
  assert.equal(ReportGroupProjectionChange.safeParse({ articleId: binding.articleId, projection }).success, true);
  assert.equal(ReportGroupProjectionChange.safeParse({ articleId: anchor.articleId, projection }).success, false);
  assert.equal(ReportGroupProjectionChange.safeParse({ articleId: binding.articleId, projection: { ...projection, receiptId: 1 } }).success, false);
  assert.deepEqual(ReportGroupProjectionChange.parse({ articleId: binding.articleId, projection: null }), { articleId: binding.articleId, projection: null });
});
