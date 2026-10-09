import { z } from "zod";
import { SourceTimeProjection } from "../time-assertion.ts";
import { isValidDate } from "../time.ts";
import { CATEGORY_KEYS, CHANNEL_KEYS } from "../taxonomy.ts";
import { Problem, ProblemResponse } from "./common.ts";
import { policySchemas, policyRoutes } from "./policy.ts";
export * from "./policy.ts";

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
/** ADR-0025 future shapes only; current aliases/registry remain unchanged until atomic activation. */
export const SourceDatedItemTime = SourceTimeProjection.extend({ firstPublicAt: z.iso.datetime({ offset: true }).nullable() });
const FeedItemSummaryCore = z.strictObject({
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
export const SourceDatedFeedItemSummary = FeedItemSummaryCore.extend(SourceDatedItemTime.shape);
export const FeedItemSummary = FeedItemSummaryCore;

const PoolResponseCore = z.strictObject({
  filters: SiteFilters.extend({ q: z.string().nullable(), tab: z.enum(["time", "relevance"]) }),
  items: z.array(FeedItemSummaryCore),
  page: z.number(),
  pageCount: z.number(),
  total: z.number(),
  todayCount: z.number(),
  freshness: z.iso.datetime({ offset: true }),
  generatedAt: z.iso.datetime({ offset: true }),
});
export const SourceDatedPoolResponse = PoolResponseCore.extend({ items: z.array(SourceDatedFeedItemSummary) });
export const PoolResponse = PoolResponseCore;

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
const TimelineCardCore = z.strictObject({
  key: z.string(),
  anchorAt: z.iso.datetime({ offset: true }),
  item: FeedItemSummaryCore,
  group: GroupInfo.nullable(),
});
export const SourceDatedTimelineCard = TimelineCardCore.extend({
  day: z.string().refine(isValidDate, "Invalid source calendar day"),
  item: SourceDatedFeedItemSummary,
});
export const TimelineCard = TimelineCardCore;

export const HotStripEntry = z.strictObject({
  rank: z.number(),
  title: z.string(),
  heat: z.number(),
  trend: z.enum(["up", "down", "flat", "new", "unknown"]),
  storyPublicId: z.string().nullable(),
  itemId: z.string().nullable(),
});
const TimelineResponseCore = z.strictObject({
  filters: SiteFilters,
  cards: z.array(TimelineCardCore),
  nextCursor: z.string().nullable(),
  /** Absolute time when a pending item in this scope becomes visible. */
  refreshAt: z.iso.datetime({ offset: true }).nullable(),
  hot: z.array(HotStripEntry).nullable(),
  dayCounts: z.record(z.string(), z.number()),
  generatedAt: z.iso.datetime({ offset: true }),
});
export const SourceDatedTimelineResponse = TimelineResponseCore.extend({ cards: z.array(SourceDatedTimelineCard) });
export const TimelineResponse = TimelineResponseCore;

export const TimelineQuery = PoolQuery.pick({ channel: true, category: true, tag: true, topic: true }).extend({
  cursor: z.string().optional(),
  limit: z.number().optional(),
});

const priceText = z.string().regex(/\S/, "must not be blank");
const priceUrl = z.url({ protocol: /^https$/ });
const priceValue = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/)
  .refine((value) => /[1-9]/.test(value), "must be a positive decimal string");
const pricePeriod = z.strictObject({ start: z.iso.date(), end: z.iso.date(), label: priceText }).refine((p) => p.start <= p.end, "invalid period order");
const priceLink = z.strictObject({ name: priceText, url: priceUrl });

/** Site-only prices; decimal strings keep source precision without floating-point conversion. */
export const MetalPrices = z
  .strictObject({
    generatedAt: z.iso.datetime({ offset: true }),
    intro: priceText,
    latest: z.array(
      z.strictObject({
        tag: priceText,
        label: priceText.nullable(),
        stale: z.boolean(),
        extras: z.array(z.strictObject({ metals: z.array(priceText).min(1), label: priceText, stale: z.boolean() })),
      }),
    ),
    sources: z
      .array(
        z.strictObject({
          key: priceText,
          name: priceText,
          tag: priceText,
          status: z.enum(["fresh", "stale", "empty"]),
          latest: z.strictObject({ label: priceText, release: z.strictObject({ label: priceText, url: priceUrl, date: z.iso.date().nullable() }) }).nullable(),
        }),
      )
      .min(1),
    metals: z
      .array(
        z.strictObject({
          key: priceText,
          name: priceText,
          quotes: z
            .array(
              z.strictObject({
                key: priceText,
                source: priceText,
                title: priceText,
                spec: priceText.nullable(),
                footnote: z.int().positive().nullable(),
                value: priceValue.nullable(),
                unit: priceText,
                currency: z.enum(["CNY", "USD"]),
                decimals: z.int().min(0).max(6).nullable(),
                period: pricePeriod.nullable(),
                change: z
                  .strictObject({
                    percent: z
                      .string()
                      .regex(/^-?(?:0|[1-9]\d*)\.\d$/)
                      .refine((value) => value !== "-0.0", "negative zero is not allowed"),
                    previous: z.strictObject({ value: priceValue, period: pricePeriod }),
                  })
                  .nullable(),
              }),
            )
            .min(1),
        }),
      )
      .min(1),
    notes: z.array(z.strictObject({ ref: z.int().positive().nullable(), text: priceText, link: priceLink.nullable() })),
    officialLinks: z.array(priceLink.extend({ note: priceText })),
  })
  .superRefine((data, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const sourceKeys = new Set<string>(),
      tags = new Set<string>(),
      metalKeys = new Set<string>(),
      quoteKeys = new Set<string>();
    const refs = new Set<number>(),
      usedRefs = new Set<number>();
    for (const [i, source] of data.sources.entries()) {
      if (sourceKeys.has(source.key)) issue(["sources", i, "key"], "duplicate source");
      sourceKeys.add(source.key);
      tags.add(source.tag);
      if ((source.status === "empty") !== (source.latest === null)) issue(["sources", i, "latest"], "empty status and latest must agree");
    }
    const latestTags = new Set<string>();
    for (const [i, latest] of data.latest.entries()) {
      if (latestTags.has(latest.tag) || !tags.has(latest.tag)) issue(["latest", i, "tag"], "duplicate or unknown frequency tag");
      latestTags.add(latest.tag);
      if (latest.label === null && (latest.stale || latest.extras.length)) issue(["latest", i], "an empty frequency has no stale flag or extras");
    }
    if ([...tags].some((tag) => !latestTags.has(tag))) issue(["latest"], "missing source frequency tag");
    let nextRef = 1,
      plainNotes = false;
    for (const [i, note] of data.notes.entries()) {
      if (note.ref === null) plainNotes = true;
      else {
        if (plainNotes || note.ref !== nextRef++) issue(["notes", i, "ref"], "footnotes must come first, numbered consecutively from one");
        refs.add(note.ref);
      }
      const links = note.text.match(/\{link\}/g)?.length ?? 0;
      if (links !== (note.link ? 1 : 0) || /[{}]/.test(note.text.replaceAll("{link}", ""))) issue(["notes", i, "text"], "invalid link placeholder");
    }
    for (const [i, metal] of data.metals.entries()) {
      if (metalKeys.has(metal.key)) issue(["metals", i, "key"], "duplicate metal");
      metalKeys.add(metal.key);
      for (const [j, quote] of metal.quotes.entries()) {
        const path = ["metals", i, "quotes", j];
        if (quoteKeys.has(quote.key)) issue([...path, "key"], "duplicate quote");
        quoteKeys.add(quote.key);
        const source = data.sources.find((s) => s.key === quote.source);
        if (!source) issue([...path, "source"], "unknown source");
        if ((quote.value === null) !== (quote.period === null)) issue([...path, "period"], "price and period must be present together");
        if (quote.change && quote.value === null) issue([...path, "change"], "a comparison requires a price");
        if (source?.status === "empty" && quote.value !== null) issue([...path, "value"], "an empty source has no price");
        if (quote.footnote !== null) {
          if (!refs.has(quote.footnote)) issue([...path, "footnote"], "unknown footnote");
          usedRefs.add(quote.footnote);
        }
      }
    }
    if ([...refs].some((ref) => !usedRefs.has(ref))) issue(["notes"], "unused footnote");
  });
export type MetalPrices = z.infer<typeof MetalPrices>;

export const schemas = {
  ...policySchemas,
  SiteStats,
  SiteFilters,
  FeedItemSummary,
  PoolResponse,
  StoryRef,
  GroupInfo,
  TimelineCard,
  HotStripEntry,
  TimelineResponse,
  MetalPrices,
  Problem,
};
export const routes = {
  ...policyRoutes,
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
  siteMetalPrices: {
    method: "GET" as const,
    url: "/api/site/metal-prices",
    schema: { operationId: "siteMetalPrices", response: { 200: MetalPrices, 304: z.undefined(), 503: ProblemResponse } },
  },
};
