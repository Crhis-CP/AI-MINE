import type { FastifyInstance } from "fastify";
import { routes, SiteInformation } from "@amp/contracts/http/public";
import { loadSiteInformation } from "@amp/backend/site/stats";
import { sendJsonWithEtag, sendProblem } from "../http/respond.ts";
export function registerSiteInformation(app: FastifyInstance) {
  app.get(routes.siteInformation.url, routes.siteInformation, async (req, reply) => {
    try {
      return sendJsonWithEtag(req, reply, SiteInformation.parse(await loadSiteInformation()), {
        etagPrefix: "site-information",
        cacheControl: "public, max-age=0, must-revalidate",
      });
    } catch {
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "网站资料暂时不可用，请稍后重试。" });
    }
  });
}
