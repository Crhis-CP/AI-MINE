// Local demo API for the reader site: serves the synthetic data in e2e/demo-reader.ts so the production web
// build can be run, screenshotted and reviewed without a database, models or credentials. Read-only, loopback only.
//
//   node e2e/demo-api.ts            # http://127.0.0.1:3001
//   DEMO_API_PORT=3101 node e2e/demo-api.ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isCategoryKey, isChannelKey } from "@amp/contracts/taxonomy";
import {
  demoContentVersion,
  demoDailyArchive,
  demoDailyIndex,
  demoDailyLatestPage,
  demoDailyReport,
  demoHot,
  demoPolicies,
  demoPolicy,
  demoPolicyReading,
  demoPolicyScope,
  demoInformation,
  demoJurisdictions,
  demoMeta,
  demoNewsMap,
  demoPool,
  demoStats,
  demoSuggestions,
  demoTimeline,
  demoItemDetail,
  DEMO_ITEMS,
} from "./demo-reader.ts";

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

/** Answers the public reader reads the demo pages need; everything else is a plain 404, never a write. */
export function demoReaderApi(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://demo.invalid");
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { code: "read_only_demo" });
  const q = url.searchParams;
  const channel = q.get("channel"),
    category = q.get("category");
  const filters = { channel: isChannelKey(channel) ? channel : "all", category: isCategoryKey(category) ? category : null };
  switch (url.pathname) {
    case "/api/health":
      return send(res, 200, { ok: true });
    case "/api/site/meta":
      return send(res, 200, demoMeta);
    case "/api/site/content-version":
      return send(res, 200, demoContentVersion);
    case "/api/site/timeline":
      return send(res, 200, demoTimeline(filters));
    case "/api/site/pool":
      return send(res, 200, demoPool({ ...filters, q: q.get("q"), tab: q.get("tab") === "relevance" ? "relevance" : "time" }));
    case "/api/site/stats":
      return send(res, 200, demoStats);
    case "/api/site/information":
      return send(res, 200, demoInformation);
    case "/api/site/search/suggestions":
      return send(res, 200, demoSuggestions);
    case "/api/site/news-map": {
      const window = q.get("window") ?? "7d";
      return window === "1d" || window === "7d" || window === "30d" ? send(res, 200, demoNewsMap(window)) : send(res, 400, { code: "invalid_request" });
    }
    case "/api/site/jurisdictions":
      return send(res, 200, demoJurisdictions);
    case "/api/site/items/saved":
      return send(res, 200, { items: DEMO_ITEMS.filter((item) => (q.get("ids") ?? "").split(",").includes(item.id)), unavailableIds: [] });
    case "/api/site/hot":
      return send(res, 200, demoHot);
    case "/api/site/reports/daily":
      return send(res, 200, { items: demoDailyArchive });
    case "/api/site/reports/daily/latest-page":
      return send(res, 200, demoDailyLatestPage);
    case "/api/site/policies":
      return send(
        res,
        200,
        demoPolicies({
          jurisdiction: q.get("jurisdiction") || undefined,
          theme: q.get("theme") || undefined,
          nature: q.get("nature") || undefined,
          stage: q.get("stage") || undefined,
          q: q.get("q") || undefined,
          page: Number.parseInt(q.get("page") ?? "1", 10) || 1,
          page_size: Number.parseInt(q.get("page_size") ?? "20", 10) || 20,
        }),
      );
    case "/api/site/policies/scope":
      return send(res, 200, demoPolicyScope);
  }
  const daily = url.pathname.match(/^\/api\/site\/reports\/daily\/(?:(navigation|months)\/)?([\d-]+)$/);
  if (daily) {
    const [, list, key = ""] = daily;
    if (list === "navigation") return send(res, 200, { items: demoDailyIndex });
    if (list === "months") return send(res, 200, { items: demoDailyIndex.filter((entry) => entry.key.startsWith(key)) });
    const report = demoDailyReport(key);
    return report ? send(res, 200, report) : send(res, 404, { code: "not_in_demo" });
  }
  const policy = url.pathname.match(/^\/api\/site\/policies\/([\w-]+)(\/reading)?$/);
  if (policy) {
    const [, id = "", reading] = policy;
    const body = reading ? demoPolicyReading(id, q.get("expression_id"), q.get("document_revision_id")) : demoPolicy(id, q.get("expression_id"));
    return body ? send(res, 200, body) : send(res, 404, { code: "not_in_demo" });
  }
  const detail = url.pathname.startsWith("/api/site/items/") ? demoItemDetail(decodeURIComponent(url.pathname.slice("/api/site/items/".length))) : null;
  if (detail) return send(res, 200, detail);
  return send(res, 404, { code: "not_in_demo" });
}

export function startDemoReaderApi(port = Number(process.env.DEMO_API_PORT ?? 3001), host = "127.0.0.1") {
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("The demo API listens on loopback only");
  const server = createServer(demoReaderApi);
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://${host}:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (import.meta.main) {
  const { url } = await startDemoReaderApi();
  console.log(`Demo reader API (synthetic data only) at ${url}`);
}
