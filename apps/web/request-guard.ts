// Request guard for the one public entry (TASK-0583, Owner 2026-11-07: protect the site against vulnerability probing
// and request floods). Every request reaches this web process, so the per-visitor limits, the security headers and
// the oversized-URL refusal live here once. Static build files are not counted: one page load fetches many of them.
// A shared CDN or firewall in front (still an Owner decision) would absorb large floods; this guard keeps one
// visitor from monopolising the server and the database meanwhile.
import { isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";

type Environment = Readonly<Record<string, string | undefined>>;

/** What a request is counted against: a page (HTML or its data), an api read, or a write of any kind. */
export type Bucket = "page" | "api" | "write";

export interface GuardLimits {
  /** Requests per visitor per window for each bucket. */
  page: number;
  api: number;
  write: number;
  windowMs: number;
}

/**
 * Per visitor per minute. A reader turning pages, prefetching links and loading filters stays far below these; a
 * search engine crawling at a polite rate does too. The write limit covers feedback, visit counts and sign-in.
 */
export const DEFAULT_LIMITS: GuardLimits = { page: 240, api: 600, write: 30, windowMs: 60_000 };
/** Longer request targets are refused before any routing: no page or api of the site needs them. */
export const MAX_URL_LENGTH = 8192;
/** Distinct visitors remembered at once; the oldest windows are dropped first beyond this. */
export const MAX_TRACKED = 50_000;

const positive = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** Limits from the environment (RATE_LIMIT_PAGE / _API / _WRITE per minute), or null when RATE_LIMIT=off. */
export function guardLimits(env: Environment = process.env): GuardLimits | null {
  if (env.RATE_LIMIT === "off") return null;
  return {
    page: positive(env.RATE_LIMIT_PAGE, DEFAULT_LIMITS.page),
    api: positive(env.RATE_LIMIT_API, DEFAULT_LIMITS.api),
    write: positive(env.RATE_LIMIT_WRITE, DEFAULT_LIMITS.write),
    windowMs: DEFAULT_LIMITS.windowMs,
  };
}

/**
 * A hashed build file (`/assets/…`, `/admin/assets/…` on the private host): the only files the web process serves
 * from disk. Any other path with an extension (feeds, sitemaps, robots.txt, icons, or a probe for `/x.php`) is an
 * api or page request that may reach the database, so it is counted (Codex review #379).
 */
export function buildAsset(pathname: string): boolean {
  return /^\/(?:admin\/)?assets\//.test(pathname);
}

/** The bucket a request is counted against; null for build files, which are never counted. */
export function bucketFor(method: string | undefined, pathname: string, apiOwned: boolean, staticFile: boolean): Bucket | null {
  const read = method === "GET" || method === "HEAD";
  if (!read) return "write";
  if (apiOwned || pathname.startsWith("/api/")) return "api";
  return staticFile ? null : "page";
}

function privateAddress(address: string): boolean {
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  const lower = address.toLowerCase();
  return lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
}

/**
 * The visitor's address and whether it names one outside visitor. Behind a trusted proxy it is the last
 * X-Forwarded-For entry (the address the proxy saw); otherwise the connection's own. A private or loopback address
 * is never limited: without a trusted proxy it is the proxy itself, shared by every visitor; with one it is the
 * server's own checks (release and health probes), which the proxy records truthfully and no outsider can claim.
 */
export function clientAddress(req: IncomingMessage, trustProxy: boolean): { address: string; distinct: boolean } {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const address = trustProxy && forwarded.length ? forwarded[forwarded.length - 1]! : (req.socket.remoteAddress ?? "");
  return { address, distinct: address !== "" && !privateAddress(address) };
}

/** Fixed-window counters per visitor and bucket, bounded in memory. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly limits: GuardLimits;
  private readonly now: () => number;
  private readonly maxTracked: number;

  constructor(limits: GuardLimits, now: () => number = Date.now, maxTracked = MAX_TRACKED) {
    this.limits = limits;
    this.now = now;
    this.maxTracked = maxTracked;
  }

  /** Counts one request; when over the limit, the seconds until the visitor's window ends. */
  take(address: string, bucket: Bucket): { ok: true } | { ok: false; retryAfter: number } {
    const key = `${bucket}|${address}`;
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || now - window.start >= this.limits.windowMs) {
      this.windows.delete(key);
      window = { start: now, count: 0 };
      this.windows.set(key, window);
      if (this.windows.size > this.maxTracked) this.prune(now);
    }
    window.count += 1;
    if (window.count <= this.limits[bucket]) return { ok: true };
    return { ok: false, retryAfter: Math.max(1, Math.ceil((window.start + this.limits.windowMs - now) / 1000)) };
  }

  get size(): number {
    return this.windows.size;
  }

  private prune(now: number) {
    for (const [key, window] of this.windows) if (now - window.start >= this.limits.windowMs) this.windows.delete(key);
    // Still too many live windows (a flood from many addresses): drop the oldest. Map order is insertion order.
    for (const key of this.windows.keys()) {
      if (this.windows.size <= this.maxTracked) break;
      this.windows.delete(key);
    }
  }
}

/**
 * Headers every response carries. HSTS only when the site is served over HTTPS (never on a local http setup), and
 * without includeSubDomains, so no other host under the domain is forced onto HTTPS by this site.
 */
export function securityHeaders(siteUrl: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "X-Frame-Options": "DENY",
  };
  if (siteUrl?.startsWith("https://")) headers["Strict-Transport-Security"] = "max-age=31536000";
  return headers;
}

/** Answers a refused request: plain text, never cached, with the wait when it is a rate limit. */
export function refuse(res: ServerResponse, status: 414 | 429, retryAfter?: number) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store");
  if (retryAfter !== undefined) res.setHeader("Retry-After", String(retryAfter));
  res.end(status === 429 ? "请求过于频繁，请稍后再试。Too many requests, please retry later." : "URI too long");
}
