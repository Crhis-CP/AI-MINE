import type { FastifyInstance } from "fastify";
import { routes, AdminSiteInformation, SiteInformation } from "@amp/contracts/http/private";
import { readManagedSiteInformation, saveSiteInformation, protectedSiteInformation } from "@amp/backend/admin/settings";
import { adminHandler } from "./admin-auth.ts";
import { sendProblem } from "../http/respond.ts";
export function registerAdminSite(app: FastifyInstance) {
  app.get(
    routes.adminSiteInformation.url,
    routes.adminSiteInformation,
    adminHandler(async (req, reply, principal) => {
      try {
        return AdminSiteInformation.parse({ information: await readManagedSiteInformation(principal), protected: protectedSiteInformation() });
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 403) throw error;
        return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "网站资料暂时无法读取，请稍后重试。" });
      }
    }),
  );
  app.put(
    routes.saveSiteInformation.url,
    routes.saveSiteInformation,
    adminHandler(async (req, _reply, principal) =>
      SiteInformation.parse(await saveSiteInformation(principal, req.body, String(req.headers["idempotency-key"] ?? ""))),
    ),
  );
}
