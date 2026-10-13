import type { FastifyInstance } from "fastify";
import { routes } from "@amp/contracts/http/private";
import { modelFallbacks, changeModelFallback } from "@amp/backend/admin/models";
import { adminHandler } from "./admin-auth.ts";
export function registerAdminModelFallback(app: FastifyInstance) {
  app.get(
    routes.modelFallbacks.url,
    routes.modelFallbacks,
    adminHandler(async (_req, _reply, admin) => modelFallbacks(admin)),
  );
  app.put(
    routes.changeModelFallback.url,
    routes.changeModelFallback,
    adminHandler(async (req, _reply, admin) => changeModelFallback((req.params as { capability: string }).capability, req.body, admin)),
  );
}
