// Production web server: built client assets, the shared redirect table and SSR. Api-owned paths are
// proxied to the api process, so one port serves the whole site; a reverse proxy in front may also send
// them to the api directly.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import path from "node:path";
import { createRequestListener } from "@react-router/node";
import { isApiOwned, resolveRedirect } from "@amp/contracts/http-policy";
import { assertWebEnvironment } from "./runtime-env.ts";
import { apiBaseFor, apiForwardHeaders } from "./api-target.ts";
import { webHostPolicy } from "./host-policy.ts";
import {
  bucketFor,
  buildAsset,
  clientAddress,
  clientHeaderName,
  fromOutside,
  guardLimits,
  ORIGIN_SECRET_HEADER,
  MAX_URL_LENGTH,
  ObserveTally,
  OriginTally,
  originEnforced,
  originSecret,
  RateLimiter,
  rateLimitObserved,
  refuse,
  securityHeaders,
} from "./request-guard.ts";

assertWebEnvironment();
const hostPolicy = webHostPolicy();

const PORT = Number(process.env.WEB_PORT || process.env.PORT || 3000);
const HOST = process.env.WEB_HOST || "127.0.0.1";
/**
 * Whether a reverse proxy in front (Caddy, nginx) records the visitor in X-Forwarded-For. Without one
 * the header is never believed: a visitor could name any address and slip past the api's per-visitor
 * limits (sign-in attempts, feedback).
 */
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
/** Per-visitor request limits and the headers every response carries (TASK-0583). */
const LIMITS = guardLimits();
const limiter = LIMITS ? new RateLimiter(LIMITS) : null;
/** Observe mode (RATE_LIMIT_OBSERVE=on): count, log hourly, refuse nothing (Owner 2026-11-08). */
const OBSERVE = limiter && rateLimitObserved() ? new ObserveTally() : null;
if (OBSERVE) setInterval(() => console.log(JSON.stringify({ level: "info", msg: "rate limit observe", window: "1h", ...OBSERVE.take() })), 3_600_000).unref();
/** The client-address header a CDN in front sets (CLIENT_IP_HEADER); also what the api's own per-visitor limits see. */
const CLIENT_HEADER = clientHeaderName();
/** The secret the CDN adds when it fetches from us (TASK-0586): the client-address header is believed only with it. */
const ORIGIN_SECRET = originSecret();
const ORIGIN_ENFORCED = originEnforced();
if (CLIENT_HEADER && !ORIGIN_SECRET)
  console.warn(JSON.stringify({ level: "warn", msg: "CLIENT_IP_HEADER is ignored without ORIGIN_SECRET (the secret header the CDN adds)" }));
if (!limiter && TRUST_PROXY && process.env.RATE_LIMIT !== "off")
  console.warn(
    JSON.stringify({ level: "warn", msg: "rate limit off: behind a CDN set CLIENT_IP_HEADER and ORIGIN_SECRET (or RATE_LIMIT=on behind a single proxy)" }),
  );
/** How requests arrived, logged hourly, so the CDN setup can be checked without an access log. */
const tally = new OriginTally();
if (CLIENT_HEADER || ORIGIN_SECRET)
  setInterval(() => console.log(JSON.stringify({ level: "info", msg: "origin check", window: "1h", ...tally.take() })), 3_600_000).unref();
const SECURITY_HEADERS = securityHeaders(process.env.SITE_URL);
let sharedAddressWarned = false;
const CLIENT_DIR = {
  public: path.resolve(import.meta.dirname, "build/public/client"),
  private: path.resolve(import.meta.dirname, "build/private/client"),
};
/** Browsers keep a page at most this long, so a withdrawal reaches them within minutes. */
const BROWSER_MAX_SECONDS = 300;
/** How long a browser may keep data it fetched on a link press, to answer the click that follows. */
const PREFETCH_REUSE_SECONDS = 5;
/** A browser prefetch (`<link rel="prefetch">`): Chromium sends Sec-Purpose / Purpose, Firefox X-moz. */
function prefetchRequest(req: import("node:http").IncomingMessage): boolean {
  return [req.headers["sec-purpose"], req.headers.purpose, req.headers["x-moz"]].some((value) => /\bprefetch\b/i.test(String(value ?? "")));
}

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

// Built JavaScript has no source declaration and is absent before the two builds.
// @ts-expect-error generated build
const publicBuild = await import("./build/public/server/index.js");
// @ts-expect-error generated build
const privateBuild = await import("./build/private/server/index.js");
const ssr = {
  public: createRequestListener({ build: publicBuild, mode: "production" }),
  private: createRequestListener({ build: privateBuild, mode: "production" }),
};

class BadRequest extends Error {}

/** Hashed build assets are immutable; anything else from the client build gets a short cache. */
async function serveStatic(clientDir: string, pathname: string, res: import("node:http").ServerResponse): Promise<boolean> {
  if (pathname.includes("..") || pathname.endsWith("/")) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new BadRequest("malformed percent-encoding");
  }
  const file = path.join(clientDir, decoded);
  if (!file.startsWith(`${clientDir}${path.sep}`)) return false;
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return false;
  const immutable = pathname.startsWith("/assets/");
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "Content-Length": info.size,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(file).pipe(res);
  return true;
}

// One bad request must never take the process down: answer it and keep serving.
const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    const bad = error instanceof BadRequest || error instanceof URIError;
    if (!bad)
      console.error(
        JSON.stringify({ level: "error", msg: "web request failed", path: (req.url ?? "").split("?")[0]!.slice(0, 200), error: String(error).slice(0, 500) }),
      );
    if (res.headersSent) return res.destroy();
    res.writeHead(bad ? 400 : 500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(bad ? "Bad request" : "Internal error");
  });
});

/** Public navigation returns all matched loaders, so `_routes` never changes a cached answer. */
function pageCache(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  const url = new URL(req.url ?? "/", "http://web.local");
  const pathname = decodeURIComponent(url.pathname).replace(/\.data$/, "");
  const publicRead = (req.method === "GET" || req.method === "HEAD") && !/^\/admin(?:\/|$)/i.test(pathname);
  if (publicRead && url.pathname.endsWith(".data")) {
    url.searchParams.delete("_routes");
    req.url = url.pathname + url.search;
  }

  // React Router uses the same route headers for HTML and single-fetch data. Apply the final
  // status here: a route's successful cache policy must never cache its error or action result.
  const writeHead = res.writeHead.bind(res);
  res.writeHead = ((status: number, messageOrHeaders?: string | import("node:http").OutgoingHttpHeaders, headers?: import("node:http").OutgoingHttpHeaders) => {
    const outgoing = typeof messageOrHeaders === "string" ? headers : messageOrHeaders;
    for (const [name, value] of Object.entries(outgoing ?? {})) if (value !== undefined) res.setHeader(name, value);
    const cc = String(res.getHeader("Cache-Control") ?? "");
    // A link pressed a moment ago fetched this page's data ahead of the click (IntentLink). A page that is never
    // stored for freshness (withdrawals apply on the next read) would make the browser drop that answer and ask
    // again on the click: two reads and no head start. Only that press-time answer may be kept, privately and for
    // PREFETCH_REUSE_SECONDS; every other read of the page stays uncached.
    if (
      publicRead &&
      status === 200 &&
      !res.hasHeader("Set-Cookie") &&
      url.pathname.endsWith(".data") &&
      prefetchRequest(req) &&
      /^\s*no-store\s*$/i.test(cc)
    ) {
      res.removeHeader("Expires");
      res.setHeader("Cache-Control", `private, max-age=${PREFETCH_REUSE_SECONDS}`);
      res.setHeader("X-Accel-Expires", "0");
    } else if (!publicRead || status !== 200 || res.hasHeader("Set-Cookie") || !cc || /(?:private|no-store)/i.test(cc)) {
      res.removeHeader("Expires");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Accel-Expires", "0");
    } else {
      const now = new Date();
      const nowSeconds = Math.floor(now.getTime() / 1000);
      const sharedSeconds = Number(cc.match(/(?:^|,)\s*s-maxage=(\d+)/i)?.[1] ?? 0);
      const expires = String(res.getHeader("X-Accel-Expires") ?? `@${nowSeconds + sharedSeconds}`);
      // A sibling loader may have delayed this response after the selected loader set its TTL.
      const seconds =
        /(?:^|,)\s*no-cache(?:,|$)/i.test(cc) || expires === "0" ? 0 : Math.max(0, Math.min(sharedSeconds, Number(expires.slice(1)) - nowSeconds));
      res.setHeader("Date", now.toUTCString());
      res.setHeader("X-Accel-Expires", seconds > 0 ? expires : "0");
      // Reuse intent-prefetched data in the browser within the same shared-cache deadline (capped).
      // Never serve it beyond that deadline, including while revalidating or on an error.
      const directives = cc
        .split(",")
        .map((value) => value.trim())
        .filter((value) => !/^(?:max-age|s-maxage|stale-while-revalidate|stale-if-error|must-revalidate)(?:=|$)/i.test(value));
      res.setHeader(
        "Cache-Control",
        seconds > 0 ? `${directives.join(", ")}, max-age=${Math.min(seconds, BROWSER_MAX_SECONDS)}, s-maxage=${seconds}, must-revalidate` : "no-cache",
      );
    }
    return typeof messageOrHeaders === "string" ? writeHead(status, messageOrHeaders) : writeHead(status);
  }) as typeof res.writeHead;
}

async function handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  const raw = req.url ?? "/";
  if (raw.length > MAX_URL_LENGTH) return refuse(res, 414);
  const group = hostPolicy(req, res);
  if (!group) return;
  const qi = raw.indexOf("?");
  const pathname = qi >= 0 ? raw.slice(0, qi) : raw;
  const search = qi >= 0 ? raw.slice(qi) : "";

  const visitor = clientAddress(req, TRUST_PROXY, CLIENT_HEADER, ORIGIN_SECRET);
  if (CLIENT_HEADER || ORIGIN_SECRET) {
    const outside = fromOutside(req, visitor);
    const sealed = tally.count(req, CLIENT_HEADER, ORIGIN_SECRET, outside);
    // ORIGIN_ENFORCE=on: only the CDN may fetch from the outside; the server's own direct checks pass.
    if (ORIGIN_ENFORCED && !sealed && outside) return refuse(res, 403);
  }
  if (limiter) {
    const bucket = bucketFor(req.method, pathname, isApiOwned(pathname), buildAsset(pathname));
    if (bucket && visitor.distinct) {
      const taken = limiter.take(visitor.address, bucket);
      if (!taken.ok) {
        if (!OBSERVE) return refuse(res, 429, taken.retryAfter);
        OBSERVE.record(visitor.address, bucket);
      }
    } else if (bucket && !sharedAddressWarned) {
      // A private address is the server's own (or, behind a proxy that is not trusted, the proxy shared by every
      // visitor). Say once that requests go unlimited, so a production setup without TRUST_PROXY=true is noticed.
      sharedAddressWarned = true;
      console.warn(JSON.stringify({ level: "warn", msg: "rate limit skipped for a private address; behind a proxy set TRUST_PROXY=true" }));
    }
  }

  // In the two-host configuration, private-page links to reader pages leave the private origin.
  if (group === "private" && (req.method === "GET" || req.method === "HEAD") && /^(?:\/|\/all|\/(?:items|story)\/[^/]+)$/.test(pathname)) {
    const target = new URL(process.env.SITE_URL || "http://localhost:3000");
    target.pathname = pathname;
    target.search = search;
    res.writeHead(302, { Location: target.href });
    return res.end();
  }

  const decision = resolveRedirect(pathname, search);
  if (decision) {
    for (const [k, v] of Object.entries(decision.headers)) res.setHeader(k, v);
    if (decision.location) res.setHeader("Location", decision.location);
    res.statusCode = decision.status;
    return res.end(decision.location ? undefined : decision.status === 410 ? "Gone" : "Not found");
  }

  if (isApiOwned(pathname)) {
    // The visitor's address, decided here: the one the trusted proxy saw (the last X-Forwarded-For
    // entry), or this connection's own. Both headers carry only that.
    const client = visitor.address;
    const target = new URL(apiBaseFor());
    const headers: import("node:http").IncomingHttpHeaders = { ...apiForwardHeaders(raw, req.headers), "x-forwarded-for": client, "x-real-ip": client };
    // The CDN's secret stays here: the api never needs it.
    // Removed whether or not a secret is configured, so it never reaches the api even while the setup is incomplete.
    delete headers[ORIGIN_SECRET_HEADER];
    if (ORIGIN_SECRET) delete headers[ORIGIN_SECRET.header];
    const upstream = httpRequest({ hostname: target.hostname, port: target.port, path: raw, method: req.method, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => {
      res.statusCode = 502;
      res.end("api unavailable");
    });
    return req.pipe(upstream);
  }

  const assetPath = group === "private" && pathname.startsWith("/admin/assets/") ? pathname.slice("/admin".length) : pathname;
  if ((req.method === "GET" || req.method === "HEAD") && pathname.includes(".") && (await serveStatic(CLIENT_DIR[group], assetPath, res))) return;
  pageCache(req, res);
  return ssr[group](req, res);
}

process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({ level: "error", msg: "unhandled rejection", error: String(reason).slice(0, 500) }));
});

server.keepAliveTimeout = 65_000;
// A client that sends its headers or body too slowly (a slow-connection attack) is cut off instead of holding a socket.
server.headersTimeout = 30_000;
server.requestTimeout = 120_000;
server.listen(PORT, HOST, () =>
  console.log(JSON.stringify({ level: "info", msg: "web started", port: (server.address() as import("node:net").AddressInfo).port, pid: process.pid })),
);

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
