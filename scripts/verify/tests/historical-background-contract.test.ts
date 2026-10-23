import assert from "node:assert/strict";
import { test } from "node:test";
import { StoryBackground, StoryBackgroundReport, StoryBackgroundFields } from "../../../packages/contracts/src/http/public.ts";
import {
  HistoricalCandidateRequest,
  HistoricalBackgroundCandidate,
  HistoricalBackgroundConfirmation,
  HistoricalBackgroundReference,
  HistoricalBackgroundProjection,
} from "../../../packages/contracts/src/site.ts";
import type { StoryDetail, HistoricalBackgroundReader, HistoricalBackgroundProjector } from "../../../packages/contracts/src/site.ts";
import { normalizeSourceTime } from "../../../packages/contracts/src/time-assertion.ts";

const query = { articleId: "current", materialRevision: 2, publicationRevision: 4, sourceDateVersion: 2 };
const candidate = { articleId: "archive", materialRevision: 1, publicationRevision: 3, sourceDateVersion: 0 };
const anchor = { kind: "project" as const, text: "甲矿项目", quote: "甲矿项目已经取得附条件的建设许可。" };
const report = {
  id: "archive",
  title: "合成旧报道",
  summary: null,
  source: { name: "合成来源" },
  publishedAt: null,
  sourceTime: null,
  selected: false,
  originalUrl: "https://example.com/archive",
};
const confirmed = {
  lane: "news",
  query,
  candidate,
  relation: "SAME_STORY",
  queryAnchor: anchor,
  candidateAnchor: anchor,
  receiptId: 12,
  inputHash: "a".repeat(64),
};

test("legacy story responses omit background; an ordinary historical report needs no fact or selection", () => {
  const legacy: Pick<StoryDetail, "background"> = {};
  assert.deepEqual(StoryBackgroundFields.parse(legacy), {});
  const result = StoryBackgroundFields.parse({ background: [{ relation: "SAME_STORY", item: report }] });
  assert.equal(result.background![0].item.selected, false);
  assert.ok(!("factId" in result.background![0].item));
  assert.throws(() => StoryBackground.parse({ relation: "UNRELATED", item: report }));
  assert.throws(() => StoryBackground.parse({ relation: "SAME_STORY", item: report, receiptId: 12 }));
});

test("background source time preserves a day or unknown, never supplies an invented clock", () => {
  const source = {
    meaning: "published" as const,
    raw: "2025-03-02",
    local_date: "2025-03-02",
    local_time: null,
    timezone: null,
    utc: null,
    precision: "date" as const,
    basis: "原文日期",
    condition_text: null,
  };
  const day = normalizeSourceTime(source, { instantBasis: null, timezoneEvidence: null });
  assert.equal(StoryBackgroundReport.parse({ ...report, sourceTime: day }).publishedAt, null);
  assert.equal(StoryBackgroundReport.parse(report).sourceTime, null);
  assert.throws(() => StoryBackgroundReport.parse({ ...report, sourceTime: day, publishedAt: "2025-03-02T00:00:00Z" }));
  assert.throws(() => StoryBackgroundReport.parse({ ...report, publishedAt: "2025-03-02T00:00:00Z" }));
  const instant = normalizeSourceTime(
    { ...source, raw: "2025-03-02T12:30:00Z", local_time: "12:30:00", utc: "2025-03-02T12:30:00Z", precision: "second" },
    { instantBasis: "explicit", timezoneEvidence: null },
  );
  assert.equal(StoryBackgroundReport.parse({ ...report, sourceTime: instant, publishedAt: instant.utc }).publishedAt, instant.utc);
  const effective = normalizeSourceTime({ ...source, meaning: "effective" }, { instantBasis: null, timezoneEvidence: null });
  assert.throws(() => StoryBackgroundReport.parse({ ...report, sourceTime: effective }));
});

test("historical recall is news-only, bounded and explicitly anchored rather than company-only", async () => {
  const request = { lane: "news", query, anchors: [anchor], limit: 3 };
  assert.ok(HistoricalCandidateRequest.safeParse(request).success);
  for (const change of [
    { lane: "policy" },
    { anchors: [] },
    { limit: 11 },
    { anchors: [{ ...anchor, kind: "company" }] },
    { anchors: [{ ...anchor, quote: "这里没有实际命中任何具体项目名称。" }] },
  ])
    assert.throws(() => HistoricalCandidateRequest.parse({ ...request, ...change }));
  const read: HistoricalBackgroundReader = async () => [HistoricalBackgroundCandidate.parse({ binding: candidate, item: report, anchors: [anchor] })];
  assert.equal((await read(HistoricalCandidateRequest.parse(request)))[0].binding.materialRevision, 1);
  assert.throws(() => HistoricalBackgroundCandidate.parse({ binding: candidate, item: { ...report, id: "other" }, anchors: [anchor] }));
});

test("confirmation binds both current versions and non-null quote/anchor evidence without claiming source validation", () => {
  assert.ok(HistoricalBackgroundConfirmation.safeParse(confirmed).success);
  for (const change of [
    { queryAnchor: null },
    { candidateAnchor: null },
    { candidate: query },
    { relation: "ROUNDUP" },
    { receiptId: 0 },
    { inputHash: "unbound" },
    { candidate: { ...candidate, publicationRevision: 0 } },
    { candidate: { ...candidate, sourceDateVersion: null } },
    { candidate: { ...candidate, sourceDateVersion: undefined } },
    { candidate: { ...candidate, sourceDateVersion: "0" } },
    { candidateAnchor: { ...anchor, kind: "document" } },
  ])
    assert.throws(() => HistoricalBackgroundConfirmation.parse({ ...confirmed, ...change }));
  // Structural parsing cannot prove a quote exists in the actual current source material.
  assert.ok(HistoricalBackgroundConfirmation.safeParse({ ...confirmed, queryAnchor: { ...anchor, quote: "甲矿项目这是合成的完整原文引用占位。" } }).success);
});

test("safe background references preserve actual date versions and never accept private proof fields", async () => {
  const storyPublicId = "87c00964-868d-48e6-b2bd-7a062fc9ec76";
  const reference = { lane: "news", storyPublicId, query, candidate, relation: "SAME_STORY" };
  assert.equal(HistoricalBackgroundReference.parse(reference).candidate.sourceDateVersion, 0);
  assert.equal(HistoricalBackgroundProjection.parse({ lane: "news", storyPublicId, references: [reference] }).references.length, 1);
  for (const privateProof of [{ receiptId: 12 }, { inputHash: "a".repeat(64) }, { quote: anchor.quote }, { queryAnchor: anchor }])
    assert.throws(() => HistoricalBackgroundReference.parse({ ...reference, ...privateProof }));
  assert.throws(() => HistoricalBackgroundProjection.parse({ lane: "news", storyPublicId: "4fdbb802-282a-4714-b963-7787bcf1c852", references: [reference] }));
  const transaction = { test: true };
  const project: HistoricalBackgroundProjector<typeof transaction> = async (_input, received) => assert.equal(received, transaction);
  await project(HistoricalBackgroundProjection.parse({ lane: "news", storyPublicId, references: [reference] }), transaction);
});
