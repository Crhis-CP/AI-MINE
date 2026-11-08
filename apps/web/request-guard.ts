// Request guard for the one public entry (TASK-0583, Owner 2026-11-07: protect the site against vulnerability probing
// and request floods). Every request reaches this web process, so the per-visitor limits, the security headers and
// the oversized-URL refusal live here once. Static build files are not counted: one page load fetches many of them.
// A shared CDN or firewall in front (still an Owner decision) would absorb large floods; this guard keeps one
// visitor from monopolising the server and the database meanwhile.
import { createHash, timingSafeEqual } from "node:crypto";
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

/**
 * Limits from the environment (RATE_LIMIT_PAGE / _API / _WRITE per minute), or null when limiting is off. Limiting
 * needs a per-visitor address, so it is on only when the deployment says where that address comes from:
 * CLIENT_IP_HEADER together with ORIGIN_SECRET (the CDN's client-address header, believed only on requests that
 * carry the secret the CDN adds when it fetches from us, TASK-0586), or RATE_LIMIT=on (served directly, or behind a
 * single proxy whose X-Forwarded-For entry is the visitor). Behind a CDN without them, the last X-Forwarded-For entry
 * is a CDN edge node shared by many readers (Codex review #379), so nothing is limited. RATE_LIMIT=off always wins.
 */
export function guardLimits(env: Environment = process.env): GuardLimits | null {
  if (env.RATE_LIMIT === "off") return null;
  if (env.RATE_LIMIT !== "on" && !(clientHeaderName(env) && originSecret(env))) return null;
  return {
    page: positive(env.RATE_LIMIT_PAGE, DEFAULT_LIMITS.page),
    api: positive(env.RATE_LIMIT_API, DEFAULT_LIMITS.api),
    write: positive(env.RATE_LIMIT_WRITE, DEFAULT_LIMITS.write),
    windowMs: DEFAULT_LIMITS.windowMs,
  };
}

/**
 * RATE_LIMIT_OBSERVE=on: count against the limits but refuse nothing, logging hourly how many requests would have
 * been refused and from how many visitors (never which). Owner 2026-11-08: confirm that limiting never stops a
 * normal reader before it is switched on; readers behind one shared address (an office, a mobile carrier) are the
 * case to watch.
 */
export function rateLimitObserved(env: Environment = process.env): boolean {
  return env.RATE_LIMIT_OBSERVE === "on";
}

/** Requests that would have been refused in observe mode, per bucket, and the distinct visitors behind them. */
export class ObserveTally {
  private readonly refused: Record<Bucket, number> = { page: 0, api: 0, write: 0 };
  private readonly visitors = new Set<string>();
  record(address: string, bucket: Bucket) {
    this.refused[bucket] += 1;
    if (this.visitors.size < MAX_TRACKED) this.visitors.add(address);
  }
  /** The counts so far (addresses are counted, never returned), then zero. */
  take() {
    const out = {
      would_refuse_page: this.refused.page,
      would_refuse_api: this.refused.api,
      would_refuse_write: this.refused.write,
      visitors: this.visitors.size,
    };
    this.refused.page = this.refused.api = this.refused.write = 0;
    this.visitors.clear();
    return out;
  }
}

/** The secret request header the CDN adds when it fetches from this site (TASK-0586). */
export interface OriginSecret {
  header: string;
  digest: Buffer;
}
/** Default name of the secret header; ORIGIN_SECRET_HEADER may name another. */
export const ORIGIN_SECRET_HEADER = "x-origin-auth";

/**
 * The CDN's shared secret (ORIGIN_SECRET, at least 32 characters) and its header, or null. The EdgeOne free plan
 * publishes no origin-pull address list (Codex 2026-11-07), so the origin cannot tell the CDN apart by address; a
 * header only the CDN adds can. Only a digest is kept, so a comparison takes the same time whatever the input.
 */
export function originSecret(env: Environment = process.env): OriginSecret | null {
  const value = env.ORIGIN_SECRET ?? "";
  if (value.length < 32 || /\s/.test(value)) return null;
  const header = (env.ORIGIN_SECRET_HEADER ?? ORIGIN_SECRET_HEADER).trim().toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(header)) return null;
  return { header, digest: createHash("sha256").update(value).digest() };
}

/** Whether the request carries the CDN's secret. */
export function fromOrigin(req: IncomingMessage, secret: OriginSecret | null): boolean {
  if (!secret) return false;
  const raw = req.headers[secret.header];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return false;
  return timingSafeEqual(createHash("sha256").update(value).digest(), secret.digest);
}

/** ORIGIN_ENFORCE=on: requests from outside that lack the secret are refused (the origin answers the CDN alone). */
export function originEnforced(env: Environment = process.env): boolean {
  return env.ORIGIN_ENFORCE === "on" && originSecret(env) !== null;
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

/** The configured client-address header (lower case, a plain header name), or null. */
export function clientHeaderName(env: Environment = process.env): string | null {
  const name = (env.CLIENT_IP_HEADER ?? "").trim().toLowerCase();
  return /^[a-z0-9-]{1,64}$/.test(name) ? name : null;
}

/**
 * The visitor's address and whether it names one outside visitor.
 * - CLIENT_IP_HEADER set and the request carries the CDN's secret, on a connection from our own proxy (a private
 *   address): the header's value. Without the secret the header is ignored, so a visitor reaching the origin
 *   directly cannot name another address (Codex 2026-11-07): it is counted by the address our proxy saw.
 * - Otherwise behind a trusted proxy: the last X-Forwarded-For entry (the address that proxy saw).
 * - Otherwise: the connection's own address.
 * A private or loopback result is never limited: it is the proxy itself, or the server's own checks.
 */
export function clientAddress(
  req: IncomingMessage,
  trustProxy: boolean,
  clientHeader: string | null = null,
  secret: OriginSecret | null = null,
): { address: string; distinct: boolean } {
  const peer = req.socket.remoteAddress ?? "";
  if (clientHeader && peer && privateAddress(peer) && fromOrigin(req, secret)) {
    const raw = req.headers[clientHeader];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim() ?? "";
    if (!value || !isIP(value)) return { address: peer, distinct: false };
    return { address: value, distinct: !privateAddress(value) };
  }
  const forwarded = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const address = trustProxy && forwarded.length ? forwarded[forwarded.length - 1]! : peer;
  return { address, distinct: address !== "" && !privateAddress(address) };
}

/**
 * Hourly counts of how requests arrived, written to the log so the deployment can check the CDN setup without an
 * access log: with the secret, with the client-address header, and from outside without the secret.
 */
export class OriginTally {
  withSecret = 0;
  withClientHeader = 0;
  outsideWithoutSecret = 0;
  count(req: IncomingMessage, clientHeader: string | null, secret: OriginSecret | null, outside: boolean) {
    const sealed = fromOrigin(req, secret);
    if (sealed) this.withSecret += 1;
    if (clientHeader && req.headers[clientHeader] !== undefined) this.withClientHeader += 1;
    if (outside && !sealed) this.outsideWithoutSecret += 1;
    return sealed;
  }
  /** The counts so far, then zero. */
  take() {
    const out = { with_secret: this.withSecret, with_client_header: this.withClientHeader, outside_without_secret: this.outsideWithoutSecret };
    this.withSecret = this.withClientHeader = this.outsideWithoutSecret = 0;
    return out;
  }
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
export function refuse(res: ServerResponse, status: 403 | 414 | 429, retryAfter?: number) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store");
  if (retryAfter !== undefined) res.setHeader("Retry-After", String(retryAfter));
  res.end(status === 429 ? "请求过于频繁，请稍后再试。Too many requests, please retry later." : status === 403 ? "Forbidden" : "URI too long");
}
