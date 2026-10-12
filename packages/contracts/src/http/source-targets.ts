import { z } from "zod";
import { ProblemResponse } from "./common.ts";
const count = z.number().int().nonnegative(),
  stamp = z.iso.datetime({ offset: true }).nullable();
export const SourceTargetEvidence = z.strictObject({
  source_id: z.string(),
  name: z.string(),
  lane: z.enum(["news", "policy"]),
  kind: z.string(),
  enabled: z.boolean(),
  health: z.string(),
  entry_url: z.url(),
  fetch_successes_7d: count,
  fetch_failures_7d: count,
  last_fetch_success: stamp,
  material_records: count,
  body_records: count,
  original_records: count,
  last_material_discovery: stamp,
  publication_records: count,
});
export const SourceTarget = z.strictObject({
  id: z.string(),
  record_ids: z.array(z.string()),
  countries: z.array(z.string()),
  country_names: z.array(z.string()),
  subnational: z.array(z.string()),
  institutions: z.array(z.string()),
  source_types: z.array(z.string()),
  topics: z.array(z.string()),
  url: z.string().nullable(),
  records: z.array(z.strictObject({ id: z.string(), sheet: z.string(), row: count, name: z.string(), url: z.string().nullable() })),
  state: z.enum(["unmatched", "configured", "observed", "needs_address"]),
  sources: z.array(SourceTargetEvidence),
});
export const SourceTargetsQuery = z.strictObject({
  q: z.string().max(200).optional(),
  country: z.string().max(30).optional(),
  state: z.enum(["unmatched", "configured", "observed", "needs_address"]).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
});
export const SourceTargetsResponse = z.strictObject({
  page: count,
  page_size: z.literal(50),
  total: count,
  total_targets: count,
  total_original_records: count,
  counts: z.strictObject({ unmatched: count, configured: count, observed: count, needs_address: count }),
  countries: z.array(z.strictObject({ id: z.string(), name: z.string() })),
  coverage: z.array(z.strictObject({ country: z.string(), name: z.string(), total: count, configured: count, observed: count })),
  items: z.array(SourceTarget),
  as_of: z.iso.datetime({ offset: true }),
  limitations: z.array(z.string()),
});
export const sourceTargetsSchemas = { SourceTargetEvidence, SourceTarget, SourceTargetsResponse };
export const sourceTargetsRoutes = {
  sourceTargets: {
    method: "GET" as const,
    url: "/api/admin/source-targets",
    schema: {
      operationId: "sourceTargets",
      querystring: SourceTargetsQuery,
      response: { 200: SourceTargetsResponse, 400: ProblemResponse, 401: ProblemResponse, 403: ProblemResponse, 503: ProblemResponse },
    },
  },
};
