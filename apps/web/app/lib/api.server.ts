// Server-side HTTP client for route loaders. The web process never touches the database;
// SSR reads the api over loopback with keep-alive, one or two requests per page.
import { data, redirect } from "react-router";
import { pageCacheSeconds, READER_PAGE_MARK } from "./cache.server.ts";

const API_BASE = process.env.API_BASE_URL || "http://127.0.0.1:3001";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryAfter: number | null;
  constructor(status: number, code: string | null, retryAfter: number | null) {
    super(`api ${status} ${code ?? ""}`);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export async function apiGet<T>(
  path: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string>; responseHeaders?: Headers; baseUrl?: string },
): Promise<T> {
  const res = await fetch(`${init?.baseUrl ?? API_BASE}${path}`, {
    headers: { accept: "application/json", "x-amp-ssr": "1", ...init?.headers },
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    let code: string | null = null;
    try {
      code = ((await res.json()) as { code?: string }).code ?? null;
    } catch {
      // not JSON
    }
    const retry = res.headers.get("retry-after");
    throw new ApiError(res.status, code, retry ? Number(retry) : null);
  }
  res.headers.forEach((value, name) => init?.responseHeaders?.set(name, value));
  return (await res.json()) as T;
}

/** Maps API failures to route responses. A supplied loader owns parsing and any response-header copying. */
export async function loadOr404<T>(
  path: string | (() => Promise<T>),
  opts: { busyRedirect?: string; responseHeaders?: Headers; signal?: AbortSignal } = {},
): Promise<T> {
  try {
    return typeof path === "function" ? await path() : await apiGet<T>(path, { responseHeaders: opts.responseHeaders, signal: opts.signal });
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    if (error instanceof ApiError) {
      if (error.status === 404) throw data({ message: "not_found" }, { status: 404 });
      if (error.status === 503 && opts.busyRedirect) throw redirect(opts.busyRedirect);
      if (error.status === 400) throw data({ message: "bad_request" }, { status: 400 });
    }
    throw data({ message: "unavailable" }, { status: 503 });
  }
}

export function queryString(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/**
 * Cache headers for a page of selected items: shared caches keep it at most `maxSeconds`, and never
 * past the next pending release in its scope, the same absolute deadline the api gives a proxy or
 * CDN in front. No stale-while-revalidate: a released item must not wait behind a stale copy.
 */
export function releaseBoundCache(refreshAt: string | null, maxSeconds: number, now = Date.now(), upstream?: Headers): Record<string, string> {
  let deadline = Math.floor(now / 1000) + maxSeconds;
  if (refreshAt) deadline = Math.min(deadline, Math.floor(Date.parse(refreshAt) / 1000));
  const sourceDeadline = upstream?.get("X-Accel-Expires");
  if (sourceDeadline?.startsWith("@")) deadline = Math.min(deadline, Number(sourceDeadline.slice(1)));
  if (sourceDeadline === "0" || /(?:no-cache|no-store)/i.test(upstream?.get("Cache-Control") ?? "")) deadline = Math.floor(now / 1000);
  const seconds = Math.max(0, Math.floor(deadline - now / 1000));
  return {
    "Cache-Control": seconds > 0 ? `public, max-age=0, s-maxage=${seconds}` : "no-cache",
    "X-Accel-Expires": seconds > 0 ? `@${deadline}` : "0",
  };
}

/**
 * Headers for a reader page (TASK-0672): its HTML may sit in a shared cache for PAGE_CACHE_SECONDS and then be served
 * stale for as long again while it refreshes. Both periods end by `refreshAt`, the next scheduled release in the page's
 * scope, and by any deadline the API gave (`upstream`), so a release never waits behind the cache. server.ts splits the
 * deadline into the two periods and keeps the page's `.data`, searches and fallbacks uncached.
 */
export function readerPageHeaders(refreshAt: string | null = null, upstream?: Headers, now = Date.now()): Record<string, string> {
  const seconds = pageCacheSeconds();
  const bound = releaseBoundCache(refreshAt, 2 * seconds, now, upstream);
  // A deadline is passed on only when a release or the API ends the two periods early; otherwise both run in full.
  if (bound["X-Accel-Expires"] !== `@${Math.floor(now / 1000) + 2 * seconds}`) return { ...bound, [READER_PAGE_MARK]: "1" };
  return { "Cache-Control": `public, max-age=0, s-maxage=${seconds}`, [READER_PAGE_MARK]: "1" };
}

/** Read and validate HTTP responses without losing status, retry timing or response headers. */
export async function contractResult<T>(result: Response, schema: { parse: (value: unknown) => T }): Promise<T> {
  const response = result;
  const payload = await result.json().catch(() => null);
  const body = payload,
    error = payload;
  if (!response.ok) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
    const retry = response.headers.get("retry-after");
    throw new ApiError(response.status, code, retry ? Number(retry) : null);
  }
  return schema.parse(body);
}
