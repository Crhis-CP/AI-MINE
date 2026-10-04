import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import { isCategoryKey, isChannelKey } from "@amp/contracts/taxonomy";
import { webEnvironment } from "../apps/web/runtime-env.ts";
import { openLog, ROOT, start } from "../scripts/verify/lib.ts";
import { stopSiteProcesses } from "../scripts/verify/site-processes.ts";
import { FIXED_TIME } from "./time.ts";

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

/** Real production web, isolated public/private synthetic HTTP upstreams; no DB/model credentials. */
export async function startBrowserSite(logFile: string) {
  for (const group of ["public", "private"]) {
    if (!existsSync(path.join(ROOT, `apps/web/build/${group}/server/index.js`))) throw new Error("Production public/private builds are required");
  }
  const calls: Array<{ role: string; path: string; method: string }> = [];
  let privateAuthority = "";
  const api = (role: string) =>
    createServer((req, res) => {
      const url = new URL(req.url!, "http://fixture");
      calls.push({ role, path: req.url!, method: req.method! });
      res.setHeader("content-type", "application/json");
      if (role === "private") {
        if (req.headers["x-forwarded-host"] === privateAuthority && url.pathname === "/api/auth/options")
          return res.end(JSON.stringify({ password: true, feishu: true }));
        res.statusCode = 404;
        return res.end("{}");
      }
      const query = url.searchParams;
      const channel = query.get("channel"),
        category = query.get("category");
      const filters = {
        channel: isChannelKey(channel) ? channel : "all",
        category: isCategoryKey(category) ? category : null,
        tag: query.get("tag"),
        topic: null,
      };
      if (url.pathname === "/api/health" || url.pathname === "/api/site/meta") return res.end(JSON.stringify({ ok: true, changelogVersion: FIXED_TIME }));
      if (url.pathname === "/api/site/pool")
        return res.end(
          JSON.stringify(
            publicSchemas.PoolResponse.parse({
              filters: { ...filters, q: query.get("q"), tab: query.get("tab") === "relevance" ? "relevance" : "time" },
              items: [],
              page: 1,
              pageCount: 0,
              total: 0,
              todayCount: 0,
              freshness: FIXED_TIME,
              generatedAt: FIXED_TIME,
            }),
          ),
        );
      if (url.pathname === "/api/site/timeline")
        return res.end(
          JSON.stringify(
            publicSchemas.TimelineResponse.parse({
              filters,
              cards: [],
              nextCursor: null,
              refreshAt: null,
              hot: [],
              dayCounts: {},
              generatedAt: FIXED_TIME,
            }),
          ),
        );
      if (["/icon.png", "/favicon.ico"].includes(url.pathname)) {
        res.setHeader("content-type", url.pathname.endsWith("png") ? "image/png" : "image/x-icon");
        return res.end(readFileSync(path.join(ROOT, "industry/brand", url.pathname.slice(1))));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  const publicApi = api("public"),
    privateApi = api("private"),
    reservation = createServer();
  const children: ReturnType<typeof start>[] = [];
  const close = async () => {
    await stopSiteProcesses(children);
    for (const server of [publicApi, privateApi, reservation]) {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  try {
    const publicPort = await listen(publicApi),
      privatePort = await listen(privateApi),
      port = await listen(reservation);
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const publicOrigin = `http://127.0.0.1:${port}`,
      privateOrigin = `http://private.localhost:${port}`;
    privateAuthority = new URL(privateOrigin).host;
    const env = webEnvironment({
      PATH: process.env.PATH,
      NODE_ENV: "production",
      WEB_HOST: "127.0.0.1",
      WEB_PORT: String(port),
      SITE_URL: publicOrigin,
      PRIVATE_HOST: "private.localhost",
      TRUST_PROXY: "false",
      API_BASE_URL: `http://127.0.0.1:${publicPort}`,
      PRIVATE_API_BASE_URL: `http://127.0.0.1:${privatePort}`,
    });
    children.push(start(process.execPath, ["--import", path.join(ROOT, "e2e/web-clock.ts"), "apps/web/server.ts"], { env, log: openLog(logFile) }));
    for (let count = 0; count < 100; count++) {
      if (children[0]!.exitCode !== null) throw new Error("Production web child exited before readiness");
      const ready = await fetch(`${publicOrigin}/api/health`)
        .then((r) => r.ok)
        .catch(() => false);
      if (ready) return { publicOrigin, privateOrigin, badOrigin: `http://localhost:${port}`, calls, close };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Production web did not become ready");
  } catch (error) {
    await close();
    throw error;
  }
}
