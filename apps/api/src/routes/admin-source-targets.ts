import type { FastifyInstance } from "fastify";
import { routes, SourceTargetsQuery } from "@amp/contracts/http/private";
import { sourceTargets } from "@amp/backend/admin/sources";
import { adminHandler } from "./admin-auth.ts";
import { sendProblem } from "../http/respond.ts";
export function registerSourceTargets(app: FastifyInstance) {
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
