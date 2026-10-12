import { z } from "zod";
import { TimeAssertion } from "../time-assertion.ts";
import { CATEGORY_KEYS } from "../taxonomy.ts";
import {
  Policy,
  PolicyCard,
  PolicyCursorQuery,
  PolicyCursorResponse,
  PolicyDetailQuery,
  PolicyHistoryQuery,
  PolicyHistoryPage,
  PolicyJurisdictionList,
  PolicyReport,
  PolicyReportCard,
  PolicyReportDetailQuery,
  PolicyScopeList,
  PolicyThread,
} from "./policy.ts";
const text = z.string(),
  id = text
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9_-]+$/),
  instant = z.iso.datetime({ offset: true });
const link = z.url({ protocol: /^https?$/ });
const envelope = { content_version: text, generated_at: instant };
const Labeled = z.strictObject({ code: text, label: text });
const Attribution = z.strictObject({ name: text, url: link });
const Metadata = z.strictObject({ provider: text, content_id: text });
const Jurisdiction = z.strictObject({ code: text, label: text, kind: z.enum(["country", "subdivision", "organization"]), parent: text.optional() });
export const V3Problem = z.strictObject({ code: text, message: text, request_id: text, retry_after_seconds: z.int().positive().optional() });
export const V3ItemCard = z.strictObject({
  id,
  revision: z.int().nonnegative(),
  content_kind: z.literal("news"),
  title: text,
  original_title: text,
  guide: text,
  reason: text.nullable(),
  category: Labeled.nullable(),
  jurisdictions: z.array(Jurisdiction),
  minerals: z.array(Labeled),
  publisher: z.strictObject({ id: text, name: text }),
  source_id: text,
  original_url: link,
  insecure_transport: z.boolean(),
  attributions: z.array(Attribution).min(1),
  published_time: TimeAssertion,
  updated_time: TimeAssertion.nullable(),
  first_public_at: TimeAssertion,
  first_public_basis: z.enum(["live", "unknown"]),
  reading_status: z.enum(["full_translation", "source_original", "summary_only", "translating", "guide_only"]),
  event_ids: z.array(text),
  story_id: text.nullable(),
  thread_id: text.nullable(),
  featured: z.boolean(),
  score: z.int().min(0).max(100).nullable(),
  independent_source_count: z.int().nonnegative(),
  ai_label: z.enum(["ai_generated", "ai_assisted_human_edited"]),
  license_note: text.nullable(),
});
export const V3ReadingBlock = z.strictObject({
  block_id: text,
  kind: z.enum(["heading", "paragraph", "list_item", "table", "quote", "footnote"]),
  text,
  table_rows: z.array(z.array(text)),
  evidence_ids: z.array(text),
  links: z.array(z.strictObject({ label: text, href: link })),
});
export const V3Reading = z.strictObject({
  mode: z.enum(["original", "official_translation", "ai_translation"]).nullable(),
  state: z.enum(["not_needed", "pending", "in_progress", "complete", "guide_only", "failed_terminal"]),
  guide_only_reason: z.enum(["summary_only_permission", "body_unobtainable", "over_limit", "in_attachment"]).nullable(),
  completeness: z.enum(["complete", "partial", "excerpt", "unavailable"]),
  completed_blocks: z.int().nonnegative(),
  total_blocks: z.int().nonnegative(),
  blocks: z.array(V3ReadingBlock),
  next_cursor: text.nullable(),
  attribution: text,
  limitation: text.nullable(),
  language: text,
  document_revision_id: text,
  expression_id: text,
  redistribution: z.enum(["allowed", "restricted"]),
});
export const V3ReadingPage = z.strictObject({
  ...envelope,
  subject_id: id,
  document_revision_id: text,
  expression_id: text,
  language: text,
  mode: z.enum(["original", "official_translation", "ai_translation"]).nullable(),
  resource_completeness: z.enum(["complete", "partial", "excerpt", "unavailable"]),
  total_blocks: z.int().nonnegative(),
  blocks: z.array(V3ReadingBlock),
  next_cursor: text.nullable(),
  redistribution: z.enum(["allowed", "restricted"]),
  limitation: text.nullable(),
});
export const V3ItemDetail = V3ItemCard.extend({
  ...envelope,
  times: z.array(TimeAssertion),
  reading_zh: V3Reading,
  reading_original: V3Reading.nullable(),
  company_notes: z.array(z.strictObject({ name_zh: text.nullable(), original_name: text, description: text.nullable(), sources: z.array(Attribution) })),
  related_policies: z.array(z.strictObject({ id, title: text, jurisdiction: text.nullable(), document_number: text.nullable() })),
  notice: text.nullable(),
  ai_metadata: Metadata,
});
export const V3EventCard = z.strictObject({
  id,
  revision: z.int().nonnegative(),
  title: text,
  summary: text.nullable(),
  stage: text,
  occurred_time: TimeAssertion,
  representative_id: text.nullable(),
  latest_progress_id: text.nullable(),
  member_count: z.int().nonnegative(),
  independent_source_count: z.int().nonnegative(),
  report_count: z.int().nonnegative(),
  story_id: text.nullable(),
  status: z.enum(["active", "merged"]),
  merged_into: text.nullable(),
});
export const V3Event = V3EventCard.extend({
  ...envelope,
  items: z.array(V3ItemCard),
  relations: z.array(z.strictObject({ event_id: text, relation: z.enum(["updates", "related"]), evidence_ids: z.array(text) })),
});
export const V3Story = z.strictObject({
  ...envelope,
  id,
  title: text,
  summary: text.nullable(),
  events: z.array(V3EventCard),
  timeline: z.array(
    z.strictObject({
      event_id: text,
      item_id: text,
      title: text,
      relation: z.enum(["same_event", "substantive_update", "correction", "related"]),
      time: TimeAssertion,
    }),
  ),
  sources: z.array(Attribution),
});
export const V3ReportCard = z.strictObject({
  id: text,
  type: z.enum(["daily", "weekly", "monthly"]),
  period_key: text,
  title: text,
  summary: text.nullable(),
  period_start: instant,
  period_end: instant,
  timezone: z.literal("Asia/Shanghai"),
  issued_at: instant,
  edition: z.int().positive(),
  item_count: z.int().nonnegative(),
  status: z.enum(["compiled", "synthesizing", "ready", "synthesis_failed"]),
  coverage_note: text,
  ai_label: z.enum(["ai_generated", "ai_assisted_human_edited"]),
});
export const V3Report = V3ReportCard.extend({
  ...envelope,
  sections: z.array(z.strictObject({ title: text, paragraphs: z.array(z.strictObject({ text, item_ids: z.array(text) })) })),
  items: z.array(V3ItemCard),
  limitation: text.nullable(),
  attributions: z.array(Attribution),
  ai_metadata: Metadata,
  corrections: z.array(z.strictObject({ revision: z.int().positive(), reason: text, at: instant })).optional(),
});
export const V3Topic = z.strictObject({
  id: text,
  kind: z.enum(["country", "mineral", "company", "project", "policy"]),
  slug: text,
  title: text,
  summary: text,
  count: z.int().nonnegative(),
});
export const V3ProductUpdate = z.strictObject({
  id: text,
  type: z.strictObject({ code: z.enum(["announcement", "update", "improvement", "retirement"]), label: text }),
  title: text,
  paragraphs: z.array(text),
  published_time: TimeAssertion,
});
export const V3Items = z.strictObject({
  ...envelope,
  items: z.array(V3ItemCard),
  next_cursor: text.nullable(),
  facets: z.strictObject({ sources: z.array(z.strictObject({ id: text, name: text, count: z.number() })), minerals: z.array(text) }).optional(),
});
export const V3Events = z.strictObject({ ...envelope, items: z.array(V3EventCard), next_cursor: text.nullable() });
export const V3Hot = z.strictObject({
  ...envelope,
  computed_at: instant.nullable(),
  rule_version: text.nullable(),
  entries: z.array(
    z.strictObject({
      rank: z.int().positive(),
      event: V3EventCard,
      representative: V3ItemCard,
      independent_source_count: z.int().nonnegative(),
      report_count: z.int().nonnegative(),
    }),
  ),
});
export const V3Saved = z.strictObject({
  ...envelope,
  items: z.array(V3ItemCard),
  events: z.array(V3EventCard),
  policies: z.array(PolicyCard),
  unavailable_ids: z.array(text),
});
export const V3Version = z.strictObject({ content_version: text.nullable(), generated_at: instant, state: z.enum(["available", "empty"]) });
export const V3Snapshot = z.strictObject({
  ...envelope,
  as_of: instant,
  cursor: text,
  count: z.int().nonnegative(),
  has_more: z.boolean(),
  next_page: text.nullable(),
  items: z.array(V3ItemCard),
});
export const V3Changes = z.strictObject({
  ...envelope,
  cursor: text,
  count: z.int().nonnegative(),
  has_more: z.boolean(),
  changes: z.array(
    z.discriminatedUnion("op", [
      z.strictObject({ op: z.literal("upsert"), changed_at: instant, item: V3ItemCard }),
      z.strictObject({ op: z.literal("remove"), changed_at: instant, id: text }),
    ]),
  ),
});
const cursor = { cursor: text.min(1).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) };
export const V3CursorQuery = z.strictObject(cursor);
const filters = {
  view: z.enum(["all", "featured"]).default("all"),
  q: text.trim().min(1).max(200).optional(),
  category: z.enum(CATEGORY_KEYS).optional(),
  jurisdiction: text.optional(),
  mineral: text.optional(),
  source: text.optional(),
  topic: text.optional(),
  on: z.iso.date().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  facets: z.enum(["true", "false"]).optional(),
};
const dates = (q: { on?: string; from?: string; to?: string }) => !(q.on && (q.from || q.to)) && (!q.from || !q.to || q.from <= q.to);
export const V3ItemsQuery = z.strictObject({ ...cursor, ...filters }).refine(dates, "日期条件冲突");
export const V3EventsQuery = z.strictObject({ ...cursor, ...filters, status: z.enum(["active", "merged"]).optional() }).refine(dates, "日期条件冲突");
export const V3ReadingQuery = z.strictObject({
  expression_id: text.optional(),
  cursor: text.min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const V3ReportQuery = V3CursorQuery.extend({ type: z.enum(["daily", "weekly", "monthly"]).default("daily") });
export const V3TopicQuery = V3CursorQuery.extend({ kind: z.enum(["country", "mineral", "company", "project", "policy"]).optional() });
export const V3PolicyReportQuery = V3CursorQuery.extend({
  type: z.enum(["policy_weekly", "policy_monthly"]),
  jurisdiction: text.optional(),
  theme: text.optional(),
});
const response = (body: z.ZodType) => ({
  200: body,
  304: z.undefined(),
  308: z.undefined(),
  400: V3Problem,
  404: V3Problem,
  409: V3Problem,
  410: V3Problem,
  429: V3Problem,
  503: V3Problem,
});
const route = (operationId: string, suffix: string, body: z.ZodType, querystring: z.ZodType = z.strictObject({})) => ({
  method: "GET" as const,
  url: `/api/v3${suffix}`,
  schema: { operationId, querystring, ...(suffix.includes(":id") ? { params: z.strictObject({ id: text.min(1).max(160) }) } : {}), response: response(body) },
});
export const v3Routes = {
  v3Version: route("v3Version", "/version", V3Version),
  v3Items: route("v3Items", "/items", V3Items, V3ItemsQuery),
  v3Item: route("v3Item", "/items/:id", V3ItemDetail),
  v3Reading: route("v3Reading", "/items/:id/reading", V3ReadingPage, V3ReadingQuery),
  v3Saved: route(
    "v3Saved",
    "/saved",
    V3Saved,
    z.strictObject({
      ids: text
        .min(1)
        .max(8099)
        .refine((value) => value.split(",").length <= 100 && value.split(",").every((part) => /^[A-Za-z0-9_-]{1,80}$/.test(part))),
    }),
  ),
  v3Events: route("v3Events", "/events", V3Events, V3EventsQuery),
  v3Event: route("v3Event", "/events/:id", V3Event),
  v3Story: route("v3Story", "/stories/:id", V3Story),
  v3Hot: route("v3Hot", "/hot", V3Hot),
  v3Snapshot: route(
    "v3Snapshot",
    "/featured/snapshot",
    V3Snapshot,
    z.strictObject({ limit: z.coerce.number().int().min(1).max(1000).default(500), page: text.min(1).optional() }),
  ),
  v3Changes: route(
    "v3Changes",
    "/featured/changes",
    V3Changes,
    z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(100), cursor: text.min(1) }),
  ),
  v3Topics: route("v3Topics", "/topics", z.strictObject({ ...envelope, items: z.array(V3Topic), next_cursor: text.nullable() }), V3TopicQuery),
  v3Topic: route("v3Topic", "/topics/:id", V3Topic.extend({ ...envelope, items: z.array(V3ItemCard), next_cursor: text.nullable() }), V3CursorQuery),
  v3Reports: route(
    "v3Reports",
    "/reports",
    z.strictObject({ ...envelope, items: z.array(V3ReportCard), status: z.enum(["available", "empty"]), next_cursor: text.nullable() }),
    V3ReportQuery,
  ),
  v3Report: route("v3Report", "/reports/:id", V3Report),
  v3Changelog: route(
    "v3Changelog",
    "/changelog",
    z.strictObject({ ...envelope, items: z.array(V3ProductUpdate), next_cursor: text.nullable() }),
    V3CursorQuery,
  ),
  v3Jurisdictions: route(
    "v3Jurisdictions",
    "/jurisdictions",
    z.strictObject({ ...envelope, items: PolicyJurisdictionList }),
    z.strictObject({
      kind: z.enum(["country", "subdivision", "organization"]).optional(),
      news_scope: z.enum(["true", "false"]).optional(),
      policy_scope: z.enum(["true", "false"]).optional(),
    }),
  ),
  v3Policies: route("v3Policies", "/policies", PolicyCursorResponse, PolicyCursorQuery),
  v3Policy: route("v3Policy", "/policies/:id", Policy, PolicyDetailQuery),
  v3PolicyScope: route("v3PolicyScope", "/policies/scope", PolicyScopeList),
  v3PolicyReading: route(
    "v3PolicyReading",
    "/policies/:id/reading",
    V3ReadingPage,
    V3ReadingQuery.extend({ policy_version_id: id.optional(), document_revision_id: id.optional() }),
  ),
  v3PolicyHistory: route("v3PolicyHistory", "/policies/:id/history", PolicyHistoryPage, PolicyHistoryQuery),
  v3PolicyThread: route("v3PolicyThread", "/policy-threads/:id", PolicyThread),
  v3PolicyReports: route(
    "v3PolicyReports",
    "/policies/reports",
    z.strictObject({ ...envelope, items: z.array(PolicyReportCard), next_cursor: text.nullable(), status: z.enum(["available", "empty"]) }),
    V3PolicyReportQuery,
  ),
  v3PolicyReport: route("v3PolicyReport", "/policies/reports/:id", PolicyReport, PolicyReportDetailQuery),
};
export const v3Schemas = {
  V3Problem,
  V3ItemCard,
  V3Items,
  V3ItemDetail,
  V3Reading,
  V3ReadingBlock,
  V3ReadingPage,
  V3EventCard,
  V3Event,
  V3Events,
  V3Story,
  V3Hot,
  V3Saved,
  V3Snapshot,
  V3Changes,
  V3ReportCard,
  V3Report,
  V3Topic,
  V3ProductUpdate,
  V3Version,
};
