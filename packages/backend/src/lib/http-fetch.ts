// Outbound HTTP for collectors, the image proxy and the paid APIs: SSRF guard, routing, limits.
import net from "node:net";
import { addAbortListener } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Agent, type ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { config } from "../config.ts";
import { assertPublicUrl, guardedLookup } from "./url.ts";
import { createEgressProxy, createEgressResolver, OUTBOUND_HTTP_OPTIONS } from "./egress-proxy.ts";
import { SITE } from "@amp/industry/site";

/**
 * Where a request leaves the host. "egress" (collection, bodies and images) goes
 * through the egress proxy when EGRESS_PROXY_URL is set (for example a rule-based proxy that connects
 * .cn and .local names and Chinese or private addresses directly and sends the rest abroad); the names
 * and address literals such a proxy would connect directly are connected here instead, so the
 * connect-time address check still applies. Proxy traffic resolves through the proxy and connects
 * only to the checked address. Empty means a direct connection. "direct" is for model
 * calls and paid APIs called straight (Dajiala). This dispatcher is per request: it is not installed
 * as HTTP_PROXY, so plain fetch (unregistered models and embeddings) does not use it.
 */
/** Explicit source request preference; it does not declare the returned content language. */
export const languageHeaders = (language: string | undefined): Record<string, string> => (language ? { "accept-language": language } : {});

export type EgressRoute = "egress" | "direct";

let proxyAgent: ProxyAgent | null = null;
let directAgent: Agent | null = null;
let resolveEgress: ReturnType<typeof createEgressResolver> | null = null;

function egressResolver() {
  resolveEgress ??= createEgressResolver(config.egressProxyUrl!);
  return resolveEgress;
}

function proxied(url: URL, route: EgressRoute): boolean {
  if (route !== "egress" || !config.egressProxyUrl) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return net.isIP(host) === 0 && !host.endsWith(".cn") && !host.endsWith(".local");
}

function dispatcherFor(viaProxy: boolean): Dispatcher | undefined {
  if (viaProxy) {
    proxyAgent ??= createEgressProxy(config.egressProxyUrl!, egressResolver());
    return proxyAgent;
  }
  if (config.allowPrivateNetworkFetch) return undefined;
  // Direct connections resolve through the guarded lookup: the address actually dialled is checked.
  directAgent ??= new Agent({ ...OUTBOUND_HTTP_OPTIONS, connect: { lookup: guardedLookup as never } });
  return directAgent;
}

export interface GuardedFetchOptions {
  method?: string;
  /** Separate physical directory verification from a resumable earlier page read. */
  crawlKey?: string;
  crawlResponseHeaders?: string[];
  /** Explicit collector resource binding; unused by model transports. */
  sourceResource?: { documentType: string | null; attachment: boolean };
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
  /** Follow redirects manually so every hop passes the SSRF guard. */
  maxRedirects?: number;
  /** Collector scheduler handles each redirect as its own paced request. Other transports keep existing behavior. */
  followRedirects?: boolean;
  /** Explicitly bind URLs that may themselves contain credentials to their original origin. */
  redirectPolicy?: "same-origin";
  /** "egress" by default; see EgressRoute. */
  route?: EgressRoute;
  /** GET only: repeat a dropped connection once with a fresh time budget; not timeouts, connect failures or HTTP errors. */
  retryDropped?: boolean;
}

export interface GuardedResponse {
  fetchedAt?: string;
  status: number;
  url: string;
  headers: Headers;
  body: Buffer;
  text(): string;
}

/** How the collectors introduce themselves: the site's own crawler name and address (industry/site.ts). */
export const DEFAULT_UA = `Mozilla/5.0 (compatible; ${SITE.crawlerName}/1.0; +${config.siteUrl}/about)`;

export const DROPPED_RETRY = { afterMs: 3000 };

/** What each collector request honestly asks for. The user agent stays DEFAULT_UA; nothing imitates a browser. */
export const ACCEPT = {
  html: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  feed: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
  json: "application/json, */*;q=0.5",
  robots: "text/plain, */*;q=0.5",
} as const;

export function droppedConnection(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
  return ["UND_ERR_SOCKET", "ECONNRESET", "EPIPE"].includes(code ?? "");
}

/** Causes that waiting does not heal: the run fails (fail count, backoff) instead of deferring. */
export const PERMANENT_TRANSPORT_CAUSES = new Set(["dns_not_found", "certificate_invalid", "address_blocked"]);
const TRANSPORT_CODES: [RegExp, string][] = [
  [/^ENOTFOUND$/, "dns_not_found"],
  [/^(EAI_AGAIN|EAI_FAIL|ESERVFAIL|ETIMEOUT_DNS)$/, "dns_temporary"],
  [
    /^(CERT_|ERR_TLS_CERT_ALTNAME_INVALID$|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_VERIFY_LEAF_SIGNATURE$|UNABLE_TO_GET_ISSUER_CERT|HOSTNAME_MISMATCH$)/,
    "certificate_invalid",
  ],
  [/^(ERR_SSL_|EPROTO$|ERR_TLS_)/, "tls_handshake"],
  [/^(ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|TimeoutError)$/, "timeout"],
  [/^(ECONNRESET|UND_ERR_SOCKET|EPIPE|ECONNABORTED|UND_ERR_CLOSED)$/, "connection_reset"],
  [/^ECONNREFUSED$/, "connection_refused"],
  [/^(EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ENETDOWN)$/, "network_unreachable"],
  [/^EBLOCKED$/, "address_blocked"],
];
/**
 * Classify a pre-response transport error for collectors: the first code found along the cause chain (undici wraps
 * the socket/TLS/DNS error in "fetch failed"), or the error name for aborts by the request deadline.
 */
export function transportCause(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const e = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    for (const value of [e.code, e.name]) if (typeof value === "string") for (const [pattern, cause] of TRANSPORT_CODES) if (pattern.test(value)) return cause;
    if (typeof e.message === "string") {
      if (/^Blocked (host|private address|protocol)/.test(e.message)) return "address_blocked";
      if (/proxy/i.test(e.message)) return "proxy_error";
    }
    current = e.cause;
  }
  return "other";
}

export async function guardedFetch(input: string, opts: GuardedFetchOptions = {}): Promise<GuardedResponse> {
  opts.signal?.throwIfAborted();
  const firstAttempt = { receivedHttpError: false };
  try {
    return await fetchOnce(input, opts, firstAttempt);
  } catch (error) {
    if (!opts.retryDropped || firstAttempt.receivedHttpError || (opts.method ?? "GET").toUpperCase() !== "GET" || !droppedConnection(error)) throw error;
    await delay(DROPPED_RETRY.afterMs * (1 + Math.random()), undefined, { signal: opts.signal });
    return fetchOnce(input, opts);
  }
}

async function fetchOnce(input: string, opts: GuardedFetchOptions, attempt?: { receivedHttpError: boolean }): Promise<GuardedResponse> {
  // One budget includes DNS, every redirect and the body. Restarting it at each hop allowed a
  // nominal 20 s image request to occupy the API for minutes. A retry gets its own complete budget;
  // only source listings (including admin preview) and direct body extraction opt in.
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const route = opts.route ?? "egress";
  const check = (target: string) =>
    withinDeadline(assertPublicUrl(target, config.allowPrivateNetworkFetch, proxied(new URL(target), route) ? egressResolver() : undefined), signal);
  let url = await check(input);
  const maxRedirects = opts.maxRedirects ?? 5;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const headers = new Headers({ "user-agent": DEFAULT_UA, "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" });
  for (const [name, value] of Object.entries(opts.headers ?? {})) headers.set(name, value);
  const publicHeaders = new Set([
    "accept",
    "accept-language",
    "accept-encoding",
    "user-agent",
    "cache-control",
    "if-modified-since",
    "if-none-match",
    "range",
    "if-range",
  ]);
  const originBound =
    opts.redirectPolicy === "same-origin" || opts.body !== undefined || Object.keys(opts.headers ?? {}).some((name) => !publicHeaders.has(name.toLowerCase()));
  const initialOrigin = url.origin;
  let method = (opts.method ?? "GET").toUpperCase();
  let requestBody = opts.body;
  for (let hop = 0; ; hop++) {
    const res = await undiciFetch(url, {
      method,
      headers: Object.fromEntries(headers),
      body: requestBody,
      redirect: "manual",
      dispatcher: dispatcherFor(proxied(url, route)),
      signal,
    });
    // A truncated error page is still an HTTP error, not permission to retry (including Retry-After).
    if (attempt) attempt.receivedHttpError = res.status >= 400;
    if (opts.followRedirects !== false && [301, 302, 303, 307, 308].includes(res.status) && res.headers.get("location")) {
      // Release the connection even when the next URL is refused or the redirect limit is reached.
      await res.body?.cancel();
      if (hop >= maxRedirects) throw new Error(`Too many redirects for ${input}`);
      const next = new URL(res.headers.get("location")!, url);
      if (originBound && next.origin !== initialOrigin) throw new Error("Blocked cross-origin redirect for a protected request");
      url = await check(next.toString());
      if (((res.status === 301 || res.status === 302) && method === "POST") || (res.status === 303 && method !== "GET" && method !== "HEAD")) {
        method = "GET";
        requestBody = undefined;
        for (const name of ["content-encoding", "content-language", "content-location", "content-type", "content-length"]) headers.delete(name);
      }
      continue;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    if (res.body) {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new Error(`Response too large from ${url.hostname}`);
        chunks.push(Buffer.from(chunk));
      }
    }
    const body = Buffer.concat(chunks);
    return {
      status: res.status,
      url: url.toString(),
      headers: res.headers as unknown as Headers,
      body,
      text: () => decodeBody(body, res.headers.get("content-type")),
    };
  }
}

/** DNS lookup cannot be cancelled, but a timed-out lookup must never continue into a fetch. */
async function withinDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let subscription: ReturnType<typeof addAbortListener> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        subscription = addAbortListener(signal, () => reject(signal.reason));
      }),
    ]);
  } finally {
    subscription?.[Symbol.dispose]();
  }
}

export function decodeBody(body: Buffer, contentType: string | null): string {
  const m = /charset=([\w-]+)/i.exec(contentType ?? "");
  let charset = m?.[1]?.toLowerCase() ?? "utf-8";
  if (!m) {
    const head = body.subarray(0, 2048).toString("latin1");
    const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) ?? /encoding=["']([\w-]+)["']/i.exec(head);
    if (meta) charset = meta[1]!.toLowerCase();
  }
  let text: string;
  try {
    text = new TextDecoder(charset === "gb2312" ? "gbk" : charset).decode(body);
  } catch {
    text = body.toString("utf8");
  }
  // A character lost on the way reads as one U+FFFD however many of its bytes were garbled (some
  // feeds send two or three for one character), so text cut to a length keeps the same cut.
  return text.replace(/\uFFFD+/g, "\uFFFD");
}
