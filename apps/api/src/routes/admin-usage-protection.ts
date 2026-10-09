import type { FastifyInstance } from "fastify";
import {
  routes,
  UsageProtectionOverview,
  UsageConfigChange,
  UsageConfigRecord,
  UsagePriceChange,
  UsagePriceRecord,
  UsageBreakerRecovery,
  UsageBreaker,
} from "@amp/contracts/http/private";
import { usageProtectionOverview, changeUsageProtection, changeUsagePrice, recoverUsageBreaker } from "@amp/backend/admin/settings";
import { adminHandler } from "./admin-auth.ts";
import { sendProblem } from "../http/respond.ts";
export function registerUsageProtection(app: FastifyInstance) {
  app.get(
    routes.usageProtection.url,
    { schema: routes.usageProtection.schema },
    adminHandler(async (_req, _reply, principal) => UsageProtectionOverview.parse(await usageProtectionOverview(principal))),
  );
  app.put(
    routes.changeUsageProtection.url,
    { schema: { operationId: routes.changeUsageProtection.schema.operationId, response: routes.changeUsageProtection.schema.response } },
    adminHandler(async (req, reply, principal) => {
      const parsed = UsageConfigChange.safeParse(req.body);
      if (!parsed.success) return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "请填写完整的保护规则、变更原因并确认影响。" });
      return UsageConfigRecord.parse(await changeUsageProtection(parsed.data, principal));
    }),
  );
  app.put(
    routes.changeUsagePrice.url,
    { schema: { operationId: routes.changeUsagePrice.schema.operationId, response: routes.changeUsagePrice.schema.response } },
    adminHandler(async (req, reply, principal) => {
      const parsed = UsagePriceChange.safeParse(req.body);
      if (!parsed.success)
        return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "请填写人民币价格、计费依据与不超过45天的有效期；图像规则不得猜测。" });
      return UsagePriceRecord.parse(await changeUsagePrice(parsed.data, principal));
    }),
  );
  app.post(
    routes.recoverUsageBreaker.url,
    { schema: { operationId: routes.recoverUsageBreaker.schema.operationId, response: routes.recoverUsageBreaker.schema.response } },
    adminHandler(async (req, reply, principal) => {
      const parsed = UsageBreakerRecovery.safeParse(req.body);
      if (!parsed.success) return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "恢复须核对当前状态版本并填写原因。" });
      const { id } = req.params as { id: string };
      return UsageBreaker.parse(await recoverUsageBreaker(id, parsed.data, principal));
    }),
  );
}
