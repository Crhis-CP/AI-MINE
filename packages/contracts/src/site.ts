// First-party site API (/api/site/*). Not a public API: it may evolve with the website,
// but it is served from the same public read layer as v1, RSS and MCP.
import type { SourceTimeProjection } from "./time-assertion.ts";
import type { CategoryKey } from "./taxonomy.ts";

export type SourceKind = "rss" | "web_list" | "json_list" | "mp_account" | "external";

export interface SourceRef {
  id: string;
  name: string;
  kind: SourceKind;
  firstParty: boolean;
}

export type StoryRef = import("zod").infer<typeof import("./http/public.ts").StoryRef>;

export type ItemSummary = ItemSummaryCore;
interface ItemSummaryCore {
  id: string;
  revision: number;
  title: string;
  originalTitle: string | null;
  summary: string | null;
  reason: string | null;
  source: SourceRef;
  links: { original: string };
  publishedAt: string | null;
  discoveredAt: string;
  timelineAt: string;
  category: CategoryKey | null;
  tags: string[];
  score: number | null;
  selected: boolean;
  channel: "news";
  story: StoryRef | null;
}

/** The fields rendered by a site feed card; full original text lives in the item detail. */
export type FeedItemSummary = import("zod").infer<typeof import("./http/public.ts").FeedItemSummary>;

/** Reading-group counts and optional newest development, from the same wire schema. */
export type GroupInfo = import("zod").infer<typeof import("./http/public.ts").GroupInfo>;
export type TimelineCard = import("zod").infer<typeof import("./http/public.ts").TimelineCard>;
export type HotStripEntry = import("zod").infer<typeof import("./http/public.ts").HotStripEntry>;
export type TimelineFilters = import("zod").infer<typeof import("./http/public.ts").SiteFilters>;
export type TimelineResponse = import("zod").infer<typeof import("./http/public.ts").TimelineResponse>;

export type PoolResponse = import("zod").infer<typeof import("./http/public.ts").PoolResponse>;

export interface OutlineEntry {
  id: string;
  text: string;
  level: number;
}

export interface ItemDetail extends ItemSummary {
  readingMode: "full" | "summary-only";
  author: string | null;
  language: string | null;
  /** Chinese body (translation or Chinese original) and original body, whitelisted HTML. */
  body: { zh: string | null; original: string | null; zhKind: "translation" | "original" | null; complete: boolean } | null;
  outline: OutlineEntry[];
  relatedStories: StoryRef[];
  indexable: boolean;
  group: GroupInfo | null;
}

export type GroupReport = GroupReportCore;
interface GroupReportCore {
  id: string;
  title: string;
  summary: string | null;
  source: SourceRef;
  timelineAt: string;
  originalUrl: string;
  selected: boolean;
}

export interface GroupReportsResponse {
  factId: string;
  revision: string;
  reports: GroupReport[];
  nextCursor: string | null;
}

export interface Development {
  factId: string;
  title: string;
  occurredAt: string | null;
  representative: ItemSummary;
  reportCount: number;
}

export interface DevelopmentsResponse {
  story: StoryRef;
  revision: string;
  developments: Development[];
  nextCursor: string | null;
}

export type { ProblemBody } from "./http/common.ts";

// ---------------------------------------------------------------------------
// Hot ranking and stories
// ---------------------------------------------------------------------------

export interface HotEntryView {
  rank: number;
  story: StoryRef;
  heat: number;
  trend: "up" | "down" | "flat" | "new" | "unknown";
  trendPct: number | null;
  badges: Array<"surge" | "new" | "rising">;
  participantCount: number;
  sourceCount: number;
  signalCount: number;
  reportCount: number;
  sourceNames: string[];
  latestAt: string;
  firstReportAt: string;
  representative: { id: string; url: string; sourceName: string } | null;
  /** Hourly heat over the 24 hours up to the ranking, oldest first; null where no comparable snapshot exists. */
  spark: Array<number | null>;
  /** The story's AI digest, else its fact statement. */
  summary: string | null;
  /** The latest development, one line. */
  latest: string | null;
}

export interface HotResponse {
  computedAt: string | null;
  ruleVersion: string | null;
  windowHours: number;
  entries: HotEntryView[];
}

export interface HeatPoint {
  hour: string;
  heat: number;
  participants: number;
}

export type StoryReportView = StoryReportViewCore;
interface StoryReportViewCore {
  id: string;
  title: string;
  summary: string | null;
  source: SourceRef;
  publishedAt: string;
  originalUrl: string;
  selected: boolean;
  factId: string;
}

export type StoryFactView = StoryFactViewCore;
interface StoryFactViewCore {
  factId: string;
  title: string;
  occurredAt: string | null;
  firstReportAt: string;
  reportCount: number;
  representative: StoryReportView;
}

export interface StoryDetail {
  publicId: string;
  title: string;
  status: "active" | "watching" | "settled";
  reportCount: number;
  sourceCount: number;
  firstReportAt: string | null;
  latestAt: string | null;
  digest: string | null;
  digestUpdatedAt: string | null;
  /** The story's own factual summary, when it has one. */
  summary: string | null;
  /** Without a digest or summary: the summary of the report the story started from. */
  excerpt: { text: string; sourceName: string } | null;
  latest: string | null;
  whyHot: {
    participants48h: number;
    newParticipants6h: number;
    recentReports24h: number;
    observationComplete: boolean;
    rank: number | null;
    heat: number | null;
  };
  developments: StoryFactView[];
  officialReports: StoryReportView[];
  timeline: StoryReportView[];
  heat: HeatPoint[];
  related: Array<StoryRef & { relation: "storyline" | "related"; latestAt: string | null }>;
}

// ---------------------------------------------------------------------------
// Reports (daily / weekly / monthly)
// ---------------------------------------------------------------------------

export type ReportKind = "daily" | "weekly" | "monthly";

export type ReportCitation = ReportCitationCore;
interface ReportCitationCore {
  itemId: string | null;
  title: string;
  summary: string | null;
  sourceName: string;
  sourceUrl: string;
  sourceId: string | null;
  firstParty: boolean;
  role: string | null;
  storyPublicId: string | null;
  /** When the cited report was published, if it is still in the database. */
  publishedAt: string | null;
  /** False once the item was withdrawn; the citation then shows as removed. */
  available: boolean;
}

export interface ReportDetail {
  kind: ReportKind;
  key: string;
  title: string;
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
  revision: number;
  lead: { title: string; leadParagraph: string } | null;
  overview: string | null;
  highlights: ReportCitation[];
  /** As edited: daily categories, weekly and monthly themes. */
  sections: Array<{ label: string; summary: string | null; items: ReportCitation[] }>;
  /** Reading order: every section item once, labelled with its section. */
  stories: Array<ReportCitation & { label: string }>;
  flashes: ReportCitation[];
  metrics: Record<string, number>;
  readingMinutes: number;
  prev: string | null;
  next: string | null;
}

export interface ReportIndexEntry {
  key: string;
  title: string | null;
  generatedAt: string;
  count: number;
}

export type { SiteStats } from "./http/public.ts";
export type { MetalPrices } from "./http/public.ts";

/** A reading page transfers one language; the canonical item retains both for exports. */
export interface SiteItemDetail extends ItemDetail {
  hasTranslation: boolean;
  bodyLanguage: "zh" | "original";
}

export type StoryFollowup = StoryFollowupCore;
interface StoryFollowupCore {
  factId: string;
  representative: { id: string; title: string; source: { name: string }; timelineAt: string };
}
export interface StoryFollowupsResponse {
  items: StoryFollowup[];
  more: boolean;
}

/** All issue keys keep numbering and calendars stable; closed daily months omit their titles. */
export interface ReportNavigationEntry {
  key: string;
  title?: string | null;
  count?: number;
}

/** Unactivated reader variants; these derive fields from the same Zod source as future clients. */
type SourceDatedItemTime = import("zod").infer<typeof import("./http/public.ts").SourceDatedItemTime>;
export type SourceDatedItemSummary = ItemSummaryCore & SourceDatedItemTime;
export type SourceDatedGroupReport = GroupReportCore & SourceDatedItemTime;
export type SourceDatedStoryReportView = Omit<StoryReportViewCore, "publishedAt"> &
  SourceDatedItemTime & {
    publishedAt: SourceDatedItemSummary["publishedAt"];
  };
export type SourceDatedReportCitation = ReportCitationCore & SourceTimeProjection;
export type SourceDatedStoryFactView = Omit<StoryFactViewCore, "firstReportAt" | "representative"> & {
  firstReportAt: string | null;
  representative: SourceDatedStoryReportView;
};
export type SourceDatedStoryFollowup = Omit<StoryFollowupCore, "representative"> & {
  representative: StoryFollowupCore["representative"] & SourceDatedItemTime;
};
