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
  demoPolicyHistory,
  demoPolicyComparison,
  demoPolicyScope,
  demoInformation,
  demoJurisdictions,
  demoMeta,
  demoMetalPrices,
  demoNewsMap,
  demoPool,
  demoStats,
  demoSuggestions,
  demoTimeline,
  demoItemDetail,
  demoStory,
  DEMO_ITEMS,
} from "./demo-reader.ts";
import { demoTopic, demoTopics } from "./demo-topics.ts";
import { readFileSync } from "node:fs";
import { type ChangelogCopyEdit, type ChangelogRelease, mergeReleaseRecords, validateChangelog, validateReleaseNote } from "@amp/backend/site/meta";

/**
 * The changelog as readers will see it after the next release: the history file, the 2026-11-06 major update in its
 * reader copy (its registered record lives only on the production server), and the pending release note as it will
 * register (shown here at a sample time).
 */
function demoChangelog() {
  const file = (name: string) => JSON.parse(readFileSync(new URL(`../industry/${name}`, import.meta.url), "utf8"));
  const major = (file("changelog-copy-edits.json") as ChangelogCopyEdit[]).find((edit) => edit.copy?.version === "2026.11");
  if (!major?.copy?.kind) throw new Error("the 2026.11 reader copy is missing");
  const shipped = { date: major.date, time: major.time, kind: major.copy.kind, version: major.copy.version, title: major.copy.title, body: major.copy.body };
  const pending = { ...validateReleaseNote(file("release-note.json").note), date: "2026-11-07", time: "09:30" };
  const record = (release: ChangelogRelease) => ({ sha: "0".repeat(40), publishedAt: `${release.date}T00:00:00.000Z`, noteHash: "0".repeat(64), release });
  return mergeReleaseRecords(validateChangelog(file("changelog.json")), [record(shipped), record(pending)]);
}

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
    case "/api/site/changelog":
      return send(res, 200, demoChangelog());
    case "/api/site/content-version":
      return send(res, 200, demoContentVersion);
    case "/api/site/timeline":
      return send(res, 200, demoTimeline(filters));
    case "/api/site/pool":
      return send(
        res,
        200,
        demoPool({ ...filters, q: q.get("q"), tab: q.get("tab") === "relevance" ? "relevance" : "time", jurisdiction: q.get("jurisdiction") }),
      );
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
    case "/api/site/metal-prices":
      return send(res, 200, demoMetalPrices);
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
    case "/api/site/topics":
      return send(res, 200, demoTopics);
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
  const topic = url.pathname.match(/^\/api\/site\/topics\/([\w-]+)$/);
  if (topic) {
    const page = demoTopic(topic[1] ?? "");
    return page ? send(res, 200, page) : send(res, 404, { code: "not_found" });
  }
  const policy = url.pathname.match(/^\/api\/site\/policies\/([\w-]+)(?:\/(reading|history|compare))?$/);
  if (policy) {
    const [, id = "", part] = policy;
    const body =
      part === "reading"
        ? demoPolicyReading(id, q.get("expression_id"), q.get("document_revision_id"))
        : part === "history"
          ? demoPolicyHistory(id)
          : part === "compare"
            ? demoPolicyComparison(id, q.get("from"), q.get("to"))
            : demoPolicy(id, q.get("expression_id"));
    return body ? send(res, 200, body) : send(res, 404, { code: "not_in_demo" });
  }
  const story = url.pathname.startsWith("/api/site/stories/") ? demoStory(decodeURIComponent(url.pathname.slice("/api/site/stories/".length))) : null;
  if (story) return send(res, 200, story);
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
