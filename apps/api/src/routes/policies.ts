import type { FastifyInstance } from "fastify";
import {
  policyRoutes,
  PolicyListQuery,
  PolicyCursorQuery,
  PolicyDetailQuery,
  PolicyReadingQuery,
  PolicyHistoryQuery,
  PolicyReportQuery,
  PolicyReportDetailQuery,
} from "@amp/contracts/http/public";
import { listPolicies, policyScope, policyDetail, policyReading, policyHistory, policyThread, PolicyReadError } from "@amp/backend/publication/timeline";
import { listPolicyReports, policyReport } from "@amp/backend/publication/timeline";
import { InvalidCursorError } from "@amp/backend/lib/cursor";
import { applyPublicHeaders, sendJsonWithEtag, sendProblem } from "../http/respond.ts";

export function registerPolicies(app: FastifyInstance) {
  const handlers: Record<string, (id: string, q: unknown) => Promise<unknown>> = {
    sitePolicies: (_id, q) => listPolicies(PolicyListQuery.parse(q)),
    publicPolicies: (_id, q) => listPolicies(PolicyCursorQuery.parse(q), true),
    sitePolicyScope: () => policyScope(),
    siteJurisdictions: () => policyScope(true),
    sitePolicy: (id, q) => policyDetail(id, PolicyDetailQuery.parse(q)),
    publicPolicy: (id, q) => policyDetail(id, PolicyDetailQuery.parse(q), true),
    sitePolicyReading: (id, q) => policyReading(id, PolicyReadingQuery.parse(q)),
    sitePolicyHistory: (id, q) => policyHistory(id, PolicyHistoryQuery.parse(q)),
    publicPolicyHistory: (id, q) => policyHistory(id, PolicyHistoryQuery.parse(q)),
    sitePolicyThread: (id) => policyThread(id),
    sitePolicyReports: (_id, q) => listPolicyReports(PolicyReportQuery.parse(q)),
    sitePolicyReport: (id, q) => policyReport(id, PolicyReportDetailQuery.parse(q)),
  };
  for (const route of Object.values(policyRoutes))
    app.get(route.url, { schema: { operationId: route.schema.operationId, response: route.schema.response } }, async (req, reply) => {
      if (route.url.startsWith("/api/v1/")) applyPublicHeaders(reply);
      try {
        const params = "params" in route.schema ? route.schema.params!.safeParse(req.params) : { success: true as const, data: { id: "" } };
        const query = "querystring" in route.schema ? route.schema.querystring!.safeParse(req.query) : { success: true as const, data: {} };
        if (!params.success || !query.success) throw new PolicyReadError(400, "invalid_request");
        const data = await handlers[route.schema.operationId]!(params.data.id, query.data);
        route.schema.response[200].parse(data);
        const stable =
          data && typeof data === "object" && !Array.isArray(data) ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== "generated_at")) : data;
        return sendJsonWithEtag(req, reply, data, { etagPrefix: route.schema.operationId, cacheControl: "no-store", etagOf: stable });
      } catch (error) {
        if (error instanceof PolicyReadError)
          return sendProblem(req, reply, { status: error.status, code: error.code, detail: error.code, title: error.status === 410 ? "Gone" : undefined });
        if (error instanceof InvalidCursorError) return sendProblem(req, reply, { status: 400, code: "invalid_cursor", detail: "Invalid policy cursor" });
        req.log.error({ err: error }, "policy read failed");
        return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "Policy data is temporarily unavailable", retryAfter: 10 });
      }
    });
}
