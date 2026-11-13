// 法规文书的后台控制 (TASK-0610): an operator lists the public policy documents and takes one down or pauses its
// further publication. Reading is for any signed-in operator; changing is for the Owner and needs a reason.
import { z } from "zod";
import { ProblemResponse } from "./common.ts";

export const AdminPolicyDocument = z.strictObject({
  id: z.string().min(1).max(200),
  /** The Chinese title readers see; null when the document has no public edition yet. */
  title: z.string().nullable(),
  original_title: z.string().nullable(),
  /** Taken down by a person: readers get “已下架” and the lists leave it out. */
  withdrawn: z.boolean(),
  /** New editions of this document are not published while this is on; what readers already see stays. */
  publishing_paused: z.boolean(),
  /** Left out by the instrument rule, not by a person. */
  automatic_excluded: z.boolean(),
  first_public_at: z.iso.datetime().nullable(),
  updated_at: z.iso.datetime(),
});
export const AdminPolicyList = z.strictObject({ items: z.array(AdminPolicyDocument).max(200), total: z.number().int().nonnegative() });
export const AdminPolicyQuery = z.strictObject({
  q: z.string().trim().max(120).optional(),
  state: z.enum(["all", "withdrawn", "paused"]).optional(),
});
/** At least one of withdrawn and paused is given; the handler rejects a change that names neither. */
export const AdminPolicyPublicationChange = z.strictObject({
  withdrawn: z.boolean().optional(),
  paused: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500),
});

// The query is not a named schema: a registered querystring cannot be resolved by the document generator.
export const policyAdminSchemas = { AdminPolicyDocument, AdminPolicyList, AdminPolicyPublicationChange };
const errors = { 400: ProblemResponse, 401: ProblemResponse, 403: ProblemResponse, 404: ProblemResponse, 503: ProblemResponse };
export const policyAdminRoutes = {
  adminPolicies: {
    method: "GET" as const,
    url: "/api/admin/policies",
    schema: { operationId: "adminPolicies", querystring: AdminPolicyQuery, response: { 200: AdminPolicyList, ...errors } },
  },
  adminPolicyPublication: {
    method: "POST" as const,
    url: "/api/admin/policies/:id/publication",
    schema: {
      operationId: "adminPolicyPublication",
      params: z.strictObject({ id: z.string().min(1).max(200) }),
      body: AdminPolicyPublicationChange,
      response: { 200: AdminPolicyDocument, ...errors },
    },
  },
};
