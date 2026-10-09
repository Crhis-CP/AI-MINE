import { z } from "zod";
import { TimeAssertion } from "../time-assertion.ts";
import { ProblemResponse } from "./common.ts";

const text = z.string().min(1),
  id = text.max(80).regex(/^[A-Za-z0-9_-]+$/),
  url = z.url({ protocol: /^https?$/ });
const ids = z.array(id),
  instant = z.iso.datetime({ offset: true });
const labelled = <T extends z.ZodType>(code: T) => z.strictObject({ code, label: text });
export const PolicyNature = z.enum(["law", "regulation", "amendment", "draft", "notice", "guidance", "treaty", "judgment", "unknown"]);
export const PolicyStage = z.enum(["proposed", "consultation", "adopted", "published", "unknown"]);
export const PolicyTheme = z.enum([
  "investment_company",
  "mineral_rights",
  "land_construction",
  "safety_environment",
  "labour_community",
  "tax_finance",
  "trade_transport",
]);
export const PolicyInterpretationState = z.enum(["basic_facts", "partial", "complete", "withheld"]);
const kind = z.enum(["original", "official_translation", "ai_translation"]);
const repeal = z.enum(["repealed", "partly_repealed", "unknown"]);
const aiLabel = z.enum(["ai_generated", "ai_assisted_human_edited"]);
export const PolicyJurisdiction = z.strictObject({
  code: text,
  label: text,
  kind: z.enum(["country", "subdivision", "organization"]),
  parent: text.optional(),
});
const attribution = z.strictObject({ name: text, url });
const publisher = z.strictObject({ id, name: text });
const legalBrief = z.strictObject({ stage: PolicyStage, in_force: z.enum(["yes", "partial", "no", "unknown"]), repeal });
const state = <T extends z.ZodType>(value: T) => z.strictObject({ value, basis: z.string().nullable(), evidence_ids: ids });
export const PolicyDateArrangement = z.strictObject({
  text,
  time: TimeAssertion.nullable(),
  occurrence: z.enum(["occurred", "planned", "conditional", "unknown"]),
  scope: z.string().nullable(),
  condition: z.string().nullable(),
  evidence_ids: ids,
});
export const PolicyLegalState = z.strictObject({
  nature: state(PolicyNature),
  legislative_stage: state(PolicyStage),
  publication: state(z.enum(["published", "not_published", "unknown"])).extend({ time: TimeAssertion.nullable() }),
  enforcement: state(z.enum(["whole", "partial", "not_in_force", "unknown"])).extend({ arrangements: z.array(PolicyDateArrangement) }),
  applicability: z.array(PolicyDateArrangement),
  deadlines: z.array(PolicyDateArrangement),
  repeal: state(repeal),
});
const sourceCredit = z.strictObject({
  source_id: id,
  publisher,
  title_original: text,
  original_url: url,
  insecure_transport: z.boolean(),
  published_time: TimeAssertion,
});
export const PolicyEvidence = z.strictObject({
  evidence_id: id,
  source: sourceCredit,
  locator: text,
  excerpt: z.string().max(200).nullable(),
  relation: z.enum(["supports", "contradicts", "context"]),
});
export const PolicyImpact = z.strictObject({
  id,
  theme: PolicyTheme,
  region: text,
  legal_actor: text,
  affected_actor: text,
  activity: text,
  condition: text,
  effect_mode: z.enum(["direct", "indirect"]),
  impact: text,
  deadline: TimeAssertion.nullable(),
  exceptions: z.string().nullable(),
  evidence_ids: ids.min(1),
});
export const PolicyCard = z
  .strictObject({
    id,
    title: text.max(250),
    original_title: text,
    jurisdictions: z.array(PolicyJurisdiction).min(1),
    authority: publisher,
    instrument_number: z.string().nullable(),
    nature: labelled(PolicyNature),
    themes: z.array(labelled(PolicyTheme)),
    change_kind: labelled(
      z.enum(["first_publication", "substantive_change", "correction", "repeal", "enforcement", "registration_compilation", "other"]),
    ).nullable(),
    published_time: TimeAssertion,
    sort_time: TimeAssertion.nullable(),
    sort_kind: z.enum(["published", "substantive_change"]).nullable(),
    first_public_at: TimeAssertion,
    first_public_basis: z.enum(["live", "unknown"]),
    source_checked_at: TimeAssertion.nullable(),
    is_backfill: z.boolean(),
    legal_brief: legalBrief,
    interpretation_state: PolicyInterpretationState,
    summary: z.string().max(300).nullable(),
    applicability_summary: z.string().nullable(),
    thread_id: id.nullable(),
    original_url: url,
    attributions: z.array(attribution).min(1),
    ai_label: aiLabel,
  })
  .superRefine((value, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if ((value.sort_time === null) !== (value.sort_kind === null)) issue("sort time and kind must agree");
    if (value.published_time.meaning !== "published") issue("published_time must describe publication");
    if (
      value.sort_time &&
      (!value.sort_time.local_date || value.sort_time.condition_text || !["published", "updated", "formally_published"].includes(value.sort_time.meaning))
    )
      issue("sorting requires a confirmed publication or substantive-change date");
    if (value.first_public_at.meaning !== "site_public" || (value.first_public_basis === "live" && value.first_public_at.precision !== "second"))
      issue("first-public time is a separate system fact");
    if (value.source_checked_at && value.source_checked_at.meaning !== "checked") issue("checked time must remain separate");
    if (value.interpretation_state === "complete" && (value.nature.code === "unknown" || value.legal_brief.stage === "unknown"))
      issue("unknown identity/stage is basic facts only");
  });
export type PolicyCard = z.infer<typeof PolicyCard>;

export const PolicyVersionRef = z.strictObject({ id, version_label: text, expression_ids: ids, current: z.boolean(), legal_brief: legalBrief });
export const PolicyExpression = z
  .strictObject({
    id,
    policy_version_id: id,
    document_revision_id: id,
    language: text,
    kind,
    issuing_body: z.string().nullable(),
    instrument_number: z.string().nullable(),
    checked_at: TimeAssertion.nullable(),
    reading_state: z.enum(["complete", "partial", "restricted", "unavailable"]),
  })
  .refine((value) => value.kind !== "official_translation" || !!value.issuing_body, "official translations need their issuing body");
export const PolicyReadingBlock = z.strictObject({
  block_id: id,
  kind: z.enum(["heading", "paragraph", "list_item", "table", "quote", "footnote"]),
  text: z.string(),
  table_rows: z.array(z.array(z.string())).nullable(),
  evidence_ids: ids,
  links: z.array(z.strictObject({ label: text, href: url })),
});
export const PolicyReadingSummary = z
  .strictObject({
    mode: kind.nullable(),
    state: z.enum(["not_needed", "pending", "in_progress", "complete", "guide_only", "failed_terminal"]),
    completeness: z.enum(["complete", "partial", "excerpt", "unavailable"]),
    completed_blocks: z.int().nonnegative(),
    total_blocks: z.int().nonnegative(),
    blocks: z.array(PolicyReadingBlock).max(0),
    next_cursor: z.string().nullable(),
    attribution: text,
    limitation: z.string().nullable(),
    language: text,
    document_revision_id: id,
    expression_id: id,
    redistribution: z.enum(["allowed", "restricted"]),
  })
  .superRefine((value, ctx) => {
    if (
      value.completed_blocks > value.total_blocks ||
      (["complete", "not_needed"].includes(value.state) &&
        (value.total_blocks === 0 || value.completed_blocks !== value.total_blocks || value.completeness !== "complete" || value.mode === null))
    )
      ctx.addIssue({ code: "custom", message: "readable completeness requires all planned blocks" });
  });
export const Policy = PolicyCard.safeExtend({
  legal_state: PolicyLegalState,
  dates: z.array(TimeAssertion),
  attachment_inventory: z.array(
    z.strictObject({
      title: text,
      url,
      decisive: z.boolean(),
      rights: z.enum(["public", "restricted", "unknown"]),
      status: z.enum(["complete", "missing", "restricted", "not_required", "blocked_capacity"]),
    }),
  ),
  versions: z.array(PolicyVersionRef),
  expressions: z.array(PolicyExpression),
  selected_policy_version_id: id.nullable(),
  selected_expression_id: id.nullable(),
  reading: PolicyReadingSummary.nullable(),
  main_points: z.array(z.strictObject({ text, clause_ref: text, evidence_ids: ids.min(1) })),
  guide: z.string().max(2000).nullable(),
  gaps: z.array(text).max(5),
  impacts: z.array(PolicyImpact),
  sections: z.array(
    z.strictObject({
      title: text,
      text,
      basis: z.enum(["source_fact", "interpretation", "uncertain"]),
      evidence_ids: ids,
      conditions: z.array(text),
      exceptions: z.array(text),
    }),
  ),
  relationships: z.array(
    z.strictObject({
      relation: z.enum(["updates", "corrects", "repeals", "implements", "related"]),
      target_policy_id: id.nullable(),
      target_citation: text,
      evidence_ids: ids.min(1),
    }),
  ),
  related_items: z.array(z.strictObject({ id, title: text })),
  evidence: z.array(PolicyEvidence),
  limitation: text,
  ai_metadata: z.strictObject({ provider: text.describe("Public service provider name, never a model execution identity"), content_id: id }),
}).superRefine((value, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const complete = value.interpretation_state === "complete";
  if (!complete && (value.guide !== null || value.main_points.length || value.impacts.length || value.sections.length))
    issue("basic facts must not expose unqualified interpretation");
  if (
    complete &&
    (!value.guide?.trim() ||
      !value.impacts.length ||
      !value.reading ||
      !["complete", "not_needed"].includes(value.reading.state) ||
      value.legal_state.publication.value === "unknown" ||
      value.attachment_inventory.some((a) => a.decisive && a.status !== "complete"))
  )
    issue("complete interpretation needs its stated public prerequisites");
  const force = { whole: "yes", partial: "partial", not_in_force: "no", unknown: "unknown" } as const;
  if (
    value.nature.code !== value.legal_state.nature.value ||
    value.legal_brief.stage !== value.legal_state.legislative_stage.value ||
    value.legal_brief.repeal !== value.legal_state.repeal.value ||
    value.legal_brief.in_force !== force[value.legal_state.enforcement.value]
  )
    issue("legal brief must copy dimensions, not infer from dates");
  if (value.ai_metadata.content_id !== value.id) issue("AI content marker must identify this document");
  const evidence = new Set(value.evidence.map((e) => e.evidence_id));
  const referenced = [
    ...value.main_points,
    ...value.impacts,
    ...value.sections,
    ...value.relationships,
    value.legal_state.nature,
    value.legal_state.legislative_stage,
    value.legal_state.publication,
    value.legal_state.enforcement,
    value.legal_state.repeal,
    ...value.legal_state.enforcement.arrangements,
    ...value.legal_state.applicability,
    ...value.legal_state.deadlines,
  ];
  if (referenced.some((e) => e.evidence_ids.some((ref) => !evidence.has(ref)))) issue("unknown evidence reference");
  if (new Set(value.expressions.map((e) => e.id)).size !== value.expressions.length || new Set(value.versions.map((v) => v.id)).size !== value.versions.length)
    issue("duplicate version or expression");
  const selected = value.expressions.find((e) => e.id === value.selected_expression_id);
  if (
    (value.selected_expression_id === null) !== (value.selected_policy_version_id === null) ||
    (value.selected_expression_id && (!selected || selected.policy_version_id !== value.selected_policy_version_id))
  )
    issue("selected expression and legal version must match");
  if (value.expressions.some((e) => !value.versions.some((v) => v.id === e.policy_version_id && v.expression_ids.includes(e.id))))
    issue("expression not in its legal version");
  if (value.reading && (!selected || value.reading.expression_id !== selected.id || value.reading.document_revision_id !== selected.document_revision_id))
    issue("reading summary must match the selected immutable expression");
  if (
    complete &&
    (value.themes.some((t) => !value.impacts.some((i) => i.theme === t.code)) || value.impacts.some((i) => !value.themes.some((t) => t.code === i.theme)))
  )
    issue("themes must match public impacts");
});
export type Policy = z.infer<typeof Policy>;

const envelope = { content_version: text, generated_at: instant };
export const PolicyListResponse = z.strictObject({
  ...envelope,
  items: z.array(PolicyCard),
  page: z.int().positive(),
  page_size: z.int().min(1).max(50),
  total: z.int().nonnegative(),
  has_more: z.boolean(),
});
export const PolicyCursorResponse = z.strictObject({ ...envelope, items: z.array(PolicyCard), next_cursor: z.string().nullable() });
export const PolicyScopeList = z.strictObject({
  items: z.array(z.strictObject({ jurisdiction: PolicyJurisdiction, readable_count: z.int().nonnegative() })),
  note: text,
});
export const PolicyJurisdictionList = z.array(
  PolicyJurisdiction.extend({ news_scope: z.boolean(), policy_scope: z.boolean(), news_count: z.int().nonnegative(), policy_count: z.int().nonnegative() }),
);
export const PolicyReadingPage = z
  .strictObject({
    ...envelope,
    subject_id: id,
    document_revision_id: id,
    expression_id: id,
    language: text,
    mode: kind,
    resource_completeness: z.enum(["complete", "partial", "excerpt", "unavailable"]),
    total_blocks: z.int().nonnegative(),
    blocks: z.array(PolicyReadingBlock).max(50),
    next_cursor: z.string().nullable(),
  })
  .refine((v) => v.blocks.length <= v.total_blocks, "loaded nodes must not exceed the source inventory");
export const PolicyHistoryEntry = z.strictObject({
  policy_version_id: id,
  expression_id: id,
  document_revision_id: id,
  language: text,
  instrument_number: z.string().nullable(),
  kind,
  current: z.boolean(),
  first_public_at: TimeAssertion,
  published_time: TimeAssertion,
  original_version: text,
  checked_at: TimeAssertion.nullable(),
});
export const PolicyHistoryPage = z.strictObject({ ...envelope, policy_id: id, items: z.array(PolicyHistoryEntry), next_cursor: z.string().nullable() });
export const PolicyThread = z.strictObject({
  id,
  title: text,
  summary: z.string().nullable(),
  jurisdictions: z.array(PolicyJurisdiction),
  stages: z.array(z.strictObject({ stage_label: text, policy_id: id.nullable(), event_id: id.nullable(), time: TimeAssertion, relation: text })),
  policies: z.array(PolicyCard),
});
export const PolicyReportCard = z
  .strictObject({
    id,
    type: z.enum(["policy_weekly", "policy_monthly"]),
    period_key: text,
    title: text,
    summary: z.string().nullable(),
    period_start: instant,
    period_end: instant,
    timezone: z.literal("Asia/Shanghai"),
    issued_at: instant,
    edition: z.int().positive(),
    correction_of: id.nullable(),
    item_count: z.int().nonnegative(),
    status: z.enum(["compiled", "synthesizing", "ready", "synthesis_failed"]),
    coverage_note: text,
    ai_label: aiLabel,
  })
  .refine((v) => Date.parse(v.period_start) < Date.parse(v.period_end), "report period must be nonempty");
const reportVersion = PolicyHistoryEntry.extend({
  label: z.enum(["period_change", "source_date_unknown", "backfill", "interpretation_update"]),
  summary: z.string().nullable(),
  public_after_period_end: z.boolean(),
});
export const PolicyReport = PolicyReportCard.safeExtend({
  ...envelope,
  groups: z.array(
    z.strictObject({
      kind: z.enum(["domestic", "foreign", "organizations"]),
      documents: z.array(z.strictObject({ policy: PolicyCard, versions: z.array(reportVersion).min(1) })),
    }),
  ),
  pending_interpretations: z.array(PolicyCard),
  coverage: z.array(
    z.strictObject({
      jurisdiction: PolicyJurisdiction,
      registered_source_count: z.int().nonnegative(),
      complete_receipt_count: z.int().nonnegative(),
      incomplete_receipt_count: z.int().nonnegative(),
      missing_receipt_count: z.int().nonnegative(),
      available_count: z.int().nonnegative(),
      failures: z.array(z.strictObject({ category: text, start: instant, end: instant.nullable() })),
    }),
  ),
  next_cursor: z.string().nullable(),
  attributions: z.array(attribution).min(1),
  limitation: text,
  ai_metadata: z.strictObject({ provider: text, content_id: id }),
});
export const PolicyReportList = z.strictObject({
  ...envelope,
  status: z.enum(["available", "empty"]),
  items: z.array(PolicyReportCard),
  page: z.int().positive(),
  page_size: z.int().min(1).max(50),
  total: z.int().nonnegative(),
  has_more: z.boolean(),
});

const filters = {
  q: z.string().max(120).optional(),
  jurisdiction: text.optional(),
  theme: PolicyTheme.optional(),
  nature: PolicyNature.optional(),
  stage: PolicyStage.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
};
const dateOrder = (v: { from?: string; to?: string }) => !v.from || !v.to || v.from <= v.to;
export const PolicyListQuery = z
  .strictObject({ ...filters, page: z.coerce.number().int().positive().default(1), page_size: z.coerce.number().int().min(1).max(50).default(20) })
  .refine(dateOrder, "invalid date interval");
export const PolicyCursorQuery = z
  .strictObject({ ...filters, cursor: text.optional(), limit: z.coerce.number().int().min(1).max(100).default(20) })
  .refine(dateOrder, "invalid date interval");
export const PolicyDetailQuery = z
  .strictObject({ policy_version_id: id.optional(), expression_id: id.optional(), document_revision_id: id.optional() })
  .refine(
    (v) => !v.document_revision_id || !!(v.policy_version_id && v.expression_id),
    "historical selection requires matching version, expression and revision",
  );
export const PolicyReadingQuery = z.strictObject({
  expression_id: id,
  document_revision_id: id,
  cursor: text.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const PolicyHistoryQuery = z.strictObject({ cursor: text.optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });
export const PolicyReportQuery = z.strictObject({
  kind: z.enum(["weekly", "monthly"]),
  jurisdiction: text.optional(),
  theme: PolicyTheme.optional(),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().min(1).max(50).default(20),
});
const policyParams = z.strictObject({ id });
const response = (schema: z.ZodType) => ({
  200: schema,
  304: z.undefined(),
  400: ProblemResponse,
  404: ProblemResponse,
  409: ProblemResponse,
  410: ProblemResponse,
  429: ProblemResponse,
  503: ProblemResponse,
});
const route = (operationId: string, path: string, schema: z.ZodType, querystring?: z.ZodType) => ({
  method: "GET" as const,
  url: path,
  schema: { operationId, ...(path.includes(":id") ? { params: policyParams } : {}), ...(querystring ? { querystring } : {}), response: response(schema) },
});
/** Declaration-only contracts. Runtime handlers activate only with the policy public projection. */
export const policyRoutes = {
  sitePolicies: route("sitePolicies", "/api/site/policies", PolicyListResponse, PolicyListQuery),
  sitePolicyScope: route("sitePolicyScope", "/api/site/policies/scope", PolicyScopeList),
  sitePolicy: route("sitePolicy", "/api/site/policies/:id", Policy, PolicyDetailQuery),
  sitePolicyReading: route("sitePolicyReading", "/api/site/policies/:id/reading", PolicyReadingPage, PolicyReadingQuery),
  sitePolicyHistory: route("sitePolicyHistory", "/api/site/policies/:id/history", PolicyHistoryPage, PolicyHistoryQuery),
  sitePolicyReports: route("sitePolicyReports", "/api/site/policies/reports", PolicyReportList, PolicyReportQuery),
  sitePolicyReport: route("sitePolicyReport", "/api/site/policies/reports/:id", PolicyReport, PolicyHistoryQuery),
  sitePolicyThread: route("sitePolicyThread", "/api/site/policy-threads/:id", PolicyThread),
  siteJurisdictions: route("siteJurisdictions", "/api/site/jurisdictions", PolicyJurisdictionList),
  publicPolicies: route("publicPolicies", "/api/v1/policies", PolicyCursorResponse, PolicyCursorQuery),
  publicPolicy: route("publicPolicy", "/api/v1/policies/:id", Policy, PolicyDetailQuery),
  publicPolicyHistory: route("publicPolicyHistory", "/api/v1/policies/:id/history", PolicyHistoryPage, PolicyHistoryQuery),
};
export const policySchemas = {
  PolicyJurisdiction,
  PolicyCard,
  PolicyLegalState,
  PolicyDateArrangement,
  PolicyEvidence,
  PolicyImpact,
  PolicyVersionRef,
  PolicyExpression,
  PolicyReadingBlock,
  PolicyReadingSummary,
  Policy,
  PolicyListResponse,
  PolicyCursorResponse,
  PolicyScopeList,
  PolicyJurisdictionList,
  PolicyReadingPage,
  PolicyHistoryEntry,
  PolicyHistoryPage,
  PolicyThread,
  PolicyReportCard,
  PolicyReport,
  PolicyReportList,
};
