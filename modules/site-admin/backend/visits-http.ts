import type { FastifyInstance, FastifyRequest } from "fastify";
import { routes } from "@amp/contracts/http/private";
import { VISIT_BEACON_PATH, VisitBeacon } from "@amp/contracts/http/public";
import { config } from "@amp/backend/config";
import { adminHandler } from "@amp/backend/admin/http";
import { sendProblem } from "@amp/backend/http";
import { flushVisits, recordVisit, visitOverview } from "./visits.ts";

const ownHosts = (req: FastifyRequest) => {
  const hosts = [String(req.headers.host ?? "")];
  try {
    hosts.push(new URL(config.siteUrl).host);
  } catch {
    // An unparsable SITE_URL only means its host is not excluded from the referring sites.
  }
  return hosts.filter(Boolean);
};

/**
 * Reader page-view beacon. Always 204 with no body and no cookie, whether or not the view counts, so a page never
 * learns or waits for anything. The client address is req.ip: the web server forwards the address it decided
 * (TRUST_PROXY), the same one the public rate limits use.
 */
export function registerVisitBeacon(app: FastifyInstance) {
  app.post(VISIT_BEACON_PATH, { bodyLimit: 4096 }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const site = req.headers["sec-fetch-site"];
    if (site === undefined || site === "same-origin") {
      let body: unknown = req.body;
      try {
        if (typeof body === "string") body = JSON.parse(body);
      } catch {
        body = null;
      }
      const beacon = VisitBeacon.safeParse(body);
      if (beacon.success)
        recordVisit({
          path: beacon.data.path,
          referrer: beacon.data.referrer ?? null,
          address: req.ip ?? "",
          userAgent: String(req.headers["user-agent"] ?? ""),
          headers: req.headers,
          ownHosts: ownHosts(req),
        });
    }
    return reply.code(204).send();
  });
  // Write what is buffered when the api stops, so a release does not lose the last seconds.
  app.addHook("onClose", async () => {
    await flushVisits();
  });
}

/** 访问概况: any signed-in operator (owner or admin) may read it; it holds counts only. */
export function registerVisitOverview(app: FastifyInstance) {
  app.get(
    routes.adminVisits.url,
    routes.adminVisits,
    adminHandler(async (req, reply) => {
      try {
        return await visitOverview();
      } catch (error) {
        req.log.error({ err: error }, "visit overview failed");
        return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "访问统计暂时无法读取，请稍后重试。", retryAfter: 30 });
      }
    }),
  );
}
