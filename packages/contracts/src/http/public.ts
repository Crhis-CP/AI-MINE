import { z } from "zod";
import { CATEGORY_KEYS, CHANNEL_KEYS } from "../taxonomy.ts";
import { Problem, ProblemResponse } from "./common.ts";

/** Existing about-page figures, read from the public publication layer. */
export const SiteStats = z.strictObject({
  sources: z.number(),
  sourceKinds: z.record(z.string(), z.number()),
  heatOnlySources: z.number(),
  items: z.number(),
  selected: z.number(),
  dailies: z.number(),
  day: z.strictObject({ collected: z.number(), selected: z.number() }),
});
export type SiteStats = z.infer<typeof SiteStats>;
export const SiteFilters = z.strictObject({
  channel: z.enum(CHANNEL_KEYS),
  category: z.enum(CATEGORY_KEYS).nullable(),
  tag: z.string().nullable(),
  topic: z.string().nullable().optional(),
});
export const FeedItemSummary = z.strictObject({
  id: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  reason: z.string().nullable(),
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
  timelineAt: z.iso.datetime({ offset: true }),
  category: z.enum(CATEGORY_KEYS).nullable(),
  tags: z.array(z.string()),
  score: z.number().nullable(),
  selected: z.boolean(),
  channel: z.literal("news"),
  source: z.strictObject({ name: z.string() }),
});
export const PoolResponse = z.strictObject({
  filters: SiteFilters.extend({ q: z.string().nullable(), tab: z.enum(["time", "relevance"]) }),
  items: z.array(FeedItemSummary),
  page: z.number(),
  pageCount: z.number(),
  total: z.number(),
  todayCount: z.number(),
  freshness: z.iso.datetime({ offset: true }),
  generatedAt: z.iso.datetime({ offset: true }),
});
// Documentation/client parameters only: the live route retains looseQuery and its existing parser.
export const PoolQuery = z.object({
  channel: z.enum(CHANNEL_KEYS).optional(),
  category: z.enum(CATEGORY_KEYS).optional(),
  tag: z.string().optional(),
  topic: z.string().optional(),
  q: z.string().optional(),
  tab: z.enum(["time", "relevance"]).optional(),
  page: z.number().optional(),
});
export const StoryRef = z.strictObject({ publicId: z.string(), title: z.string() });
export const GroupInfo = z.strictObject({
  factId: z.string(),
  story: StoryRef.nullable(),
  /** Other public sources of the represented fact, matching the expandable reports. */
  additionalSourceCount: z.number(),
  /** Distinct public reports across the group's facts. */
  reportCount: z.number(),
  /** Facts with at least one selected item under the current filters. */
  developmentCount: z.number(),
  /** Newest development when it differs from the represented fact. */
  latestDevelopment: z
    .strictObject({ factId: z.string(), title: z.string(), at: z.iso.datetime({ offset: true }) })
    .nullable()
    .optional(),
});
export const TimelineCard = z.strictObject({
  key: z.string(),
  anchorAt: z.iso.datetime({ offset: true }),
  item: FeedItemSummary,
  group: GroupInfo.nullable(),
});
export const HotStripEntry = z.strictObject({
  rank: z.number(),
  title: z.string(),
  heat: z.number(),
  trend: z.enum(["up", "down", "flat", "new", "unknown"]),
  storyPublicId: z.string().nullable(),
  itemId: z.string().nullable(),
});
export const TimelineResponse = z.strictObject({
  filters: SiteFilters,
  cards: z.array(TimelineCard),
  nextCursor: z.string().nullable(),
  /** Absolute time when a pending item in this scope becomes visible. */
  refreshAt: z.iso.datetime({ offset: true }).nullable(),
  hot: z.array(HotStripEntry).nullable(),
  dayCounts: z.record(z.string(), z.number()),
  generatedAt: z.iso.datetime({ offset: true }),
});
export const TimelineQuery = PoolQuery.pick({ channel: true, category: true, tag: true, topic: true }).extend({
  cursor: z.string().optional(),
  limit: z.number().optional(),
});
export const schemas = { SiteStats, SiteFilters, FeedItemSummary, PoolResponse, StoryRef, GroupInfo, TimelineCard, HotStripEntry, TimelineResponse, Problem };
export const routes = {
  siteTimeline: {
    method: "GET" as const,
    url: "/api/site/timeline",
    schema: {
      operationId: "siteTimeline",
      querystring: TimelineQuery,
      response: { 200: TimelineResponse, 304: z.undefined(), 400: ProblemResponse, 503: ProblemResponse },
    },
  },
  sitePool: {
    method: "GET" as const,
    url: "/api/site/pool",
    schema: {
      operationId: "sitePool",
      querystring: PoolQuery,
      response: { 200: PoolResponse, 304: z.undefined(), 400: ProblemResponse, 503: ProblemResponse },
    },
  },
  siteStats: {
    method: "GET" as const,
    url: "/api/site/stats",
    schema: { operationId: "siteStats", response: { 200: SiteStats, 304: z.undefined(), 503: ProblemResponse } },
  },
};
