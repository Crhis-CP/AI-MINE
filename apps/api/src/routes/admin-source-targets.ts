import type { FastifyInstance } from "fastify";
import { routes, SourceTargetsQuery } from "@amp/contracts/http/private";
import { sourceTargets, sourceCoverage, exportSourceTargets } from "@amp/backend/admin/sources";
import { adminHandler } from "./admin-auth.ts";
import { sendProblem } from "../http/respond.ts";
export function registerSourceTargets(app: FastifyInstance) {
  app.get(
    routes.sourceCoverage.url,
    routes.sourceCoverage,
    adminHandler(async (req, reply) => {
      try {
        return await sourceCoverage();
      } catch {
        return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "覆盖记录暂时无法读取，请稍后刷新" });
      }
    }),
  );
  app.post(
    routes.exportSourceTargets.url,
    routes.exportSourceTargets,
    adminHandler(async (req, reply, principal) => {
      try {
        return await exportSourceTargets(principal);
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 403) throw error;
        return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "对账导出暂时无法生成，请稍后重试" });
      }
    }),
  );
  app.get(
    routes.sourceTargets.url,
    routes.sourceTargets,
    adminHandler(async (req, reply) => {
      const query = SourceTargetsQuery.safeParse(req.query);
      if (!query.success) return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "请核对原表筛选条件" });
      try {
        return await sourceTargets(query.data);
      } catch {
        return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "当前对账证据暂时无法读取，请稍后刷新" });
      }
    }),
  );
}
