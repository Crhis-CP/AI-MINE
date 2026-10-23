import { MetalPrices, routes } from "@amp/contracts/http/public";
import { sendJsonWithEtag, sendProblem } from "@amp/backend/http";
import { loadMetalPrices } from "./backend/read.ts";
import { defineServerModule } from "@amp/backend/modules";
import { refreshMetalPrices } from "./backend/refresh.ts";
import { metalFindings } from "./backend/alerts.ts";
/** Keep the existing queue identity and source update frequency. */
export default defineServerModule({
  name: "metals",
  alerts: metalFindings,
  http(app) {
    app.get(routes.siteMetalPrices.url, routes.siteMetalPrices, async (request, reply) => {
      try {
        const prices = MetalPrices.parse(await loadMetalPrices());
        const { generatedAt: _generatedAt, ...content } = prices;
        return sendJsonWithEtag(request, reply, prices, { etagPrefix: "metals", etagOf: content, cacheControl: "public, max-age=300, s-maxage=300" });
      } catch (error) {
        request.log.error({ err: error, path: request.url.split("?")[0] }, "site api error");
        return sendProblem(request, reply, { status: 503, code: "temporarily_unavailable", detail: "temporarily unavailable", retryAfter: 10 });
      }
    });
  },
  schedules: [
    { name: "metals.prices", cron: "*/30 * * * *", missed: "once", when: () => process.env.COLLECT_ENABLED !== "false", run: () => refreshMetalPrices() },
  ],
});
