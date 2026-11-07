import { AsyncLocalStorage } from "node:async_hooks";
import { SourceCrawlProfile as CrawlProfile } from "@amp/backend/sources/config-keys";
import { ProviderRejectedError } from "@amp/backend/providers/receipts";
import { SITE } from "@amp/industry/site";
import { readCurrentSourcePolicy, evaluateSourcePolicy } from "@amp/backend/admin/sources";
import { setTimeout as delay } from "node:timers/promises";
import {
  ACCEPT,
  DEFAULT_UA,
  DROPPED_RETRY,
  PERMANENT_TRANSPORT_CAUSES,
  decodeBody,
  guardedFetch,
  transportCause,
  type GuardedFetchOptions,
  type GuardedResponse,
} from "../lib/http-fetch.ts";
import { stableJson, sha256 } from "../lib/ids.ts";
import type { SourceRow } from "../sources/types.ts";
import { parseRobots, robotsAllows, robotsRecognized } from "./robots.ts";
import {
  CrawlBlocked,
  CrawlDeferred,
  CrawlTransportFailed,
  claimCrawlRequest,
  crawlClock,
  finishCrawlRequest,
  openCrawlSession,
  finishCrawlSession,
  crawlCheckpoint,
  saveCrawlCheckpoint,
  robotsObservation,
  saveRobots,
  saveRobotsBlocked,
  saveRobotsFailure,
  recordHostTransportFailure,
  type RobotsObservation,
} from "./pacing.ts";
export { CrawlBlocked, CrawlDeferred, CrawlObsolete, CrawlTransportFailed } from "./pacing.ts";
export { SourceCrawlProfile as CrawlProfile } from "@amp/backend/sources/config-keys";
type Get = (url: string, options: GuardedFetchOptions) => Promise<GuardedResponse>;
type Context = {
  sessionId: string;
  source: SourceRow;
  permissionVersion: number | null;
  minimumMs: number;
  /** Per-source override from crawlProfile.timeoutSeconds; otherwise each caller's own timeout (default 20 s). */
  timeoutMs: number | null;
  get: Get;
  now: () => Date;
  virtualClock: boolean;
  /** Short host-pacing waits happen in process; absent under an injected clock unless the test supplies one. */
  sleep: ((ms: number) => Promise<void>) | null;
  signal?: AbortSignal;
};
/** A host wait up to this long is slept in process and the claim retried, instead of a full queue round trip. */
export const SHORT_PACING_WAIT_MS = 5000;
const SHORT_PACING_ROUNDS = 3;
/** RFC 9309 §2.3.1.2: follow at least five consecutive redirects for robots.txt. */
export const ROBOTS_MAX_REDIRECTS = 5;
/** A good robots copy is used while later reads fail, for at most this long after it was read. */
export const ROBOTS_GOOD_COPY_MS = 30 * 86400_000;
const TRANSPORT_BACKOFF_MS = { first: 60_000, max: 30 * 60_000 };
const context = new AsyncLocalStorage<Context>();
export async function withSourceCrawl<T>(
  source: SourceRow,
  scope: string,
  run: () => Promise<T>,
  options: { get?: Get; now?: () => Date; expectedSessionId?: string; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
) {
  options.signal?.throwIfAborted();
  if (context.getStore()) return run();
  const profile = CrawlProfile.parse(source.config.crawlProfile ?? {}),
    permission = await readCurrentSourcePolicy(source.id);
  const binding = sha256(stableJson([source.id, source.kind, source.config, permission?.permission_version ?? null]));
  const sessionId = await openCrawlSession(scope, source.id, binding, options.expectedSessionId);
  const ctx: Context = {
    sessionId,
    source,
    permissionVersion: permission?.permission_version ?? null,
    minimumMs: Math.max(profile.sensitive ? 10000 : 2000, Math.ceil((profile.minimumIntervalSeconds ?? 2) * 1000)),
    timeoutMs: profile.timeoutSeconds ? Math.round(profile.timeoutSeconds * 1000) : null,
    get: options.get ?? guardedFetch,
    now: options.now ?? (() => new Date()),
    virtualClock: !!options.now,
    sleep: options.sleep ?? (options.now ? null : (ms) => delay(ms, undefined, { signal: options.signal })),
    signal: options.signal,
  };
  try {
    const result = await context.run(ctx, run);
    await finishCrawlSession(sessionId);
    return result;
  } catch (error) {
    if (error instanceof CrawlDeferred) error.sessionId = sessionId;
    else await finishCrawlSession(sessionId);
    throw error;
  }
}
const response = (status: number, url: string, headers: Record<string, string>, body: Buffer, fetchedAt?: Date): GuardedResponse => ({
  status,
  fetchedAt: fetchedAt?.toISOString(),
  url,
  headers: new Headers(headers),
  body,
  text: () => decodeBody(body, headers["content-type"] ?? null),
});
async function permitted(
  ctx: Context,
  url: string,
  capability: "fetch" | "process_locally" | "store_metadata" | "store_fulltext",
  resource?: GuardedFetchOptions["sourceResource"],
) {
  ctx.signal?.throwIfAborted();
  url = url.replace(/^https:\/\/r\.jina\.ai\//, "");
  if (ctx.permissionVersion === null) return false;
  return (
    (
      await evaluateSourcePolicy({
        source_id: ctx.source.id,
        expected_permission_version: ctx.permissionVersion,
        lane: ctx.source.lane,
        capability,
        resource: {
          url,
          document_type: resource?.documentType ?? ctx.source.config.policyProfile?.identity?.documentType?.value ?? null,
          attachment: resource?.attachment ?? false,
        },
      })
    ).decision === "allow"
  );
}
function retryAfter(value: string | null, now: Date) {
  if (value && /^\d+(?:\.\d+)?$/.test(value)) return new Date(now.getTime() + Math.ceil(Number(value) * 1000));
  const at = value ? Date.parse(value) : NaN;
  return new Date(Number.isFinite(at) ? Math.max(now.getTime(), at) : now.getTime() + 60_000);
}
const crawlTime = async (ctx: Context) => (ctx.virtualClock ? ctx.now() : crawlClock());
/** Run a step whose host claim may wait; a short wait (≤5 s) is slept in process and the step run again. */
async function shortWait<T>(ctx: Context, step: (now: Date) => Promise<T>): Promise<T> {
  for (let round = 0; ; round++) {
    const now = await crawlTime(ctx);
    try {
      return await step(now);
    } catch (error) {
      if (!(error instanceof CrawlDeferred) || error.reason !== "host_pacing" || !ctx.sleep || round >= SHORT_PACING_ROUNDS) throw error;
      const wait = error.retryAt.getTime() - now.getTime();
      if (wait > SHORT_PACING_WAIT_MS) throw error;
      await ctx.sleep(Math.max(0, wait));
    }
  }
}
async function request(ctx: Context, url: string, opts: GuardedFetchOptions, gap: number, robot = false, cacheValidAfter?: Date): Promise<GuardedResponse> {
  ctx.signal?.throwIfAborted();
  const keyNow = await crawlTime(ctx);
  const key = stableJson([
    url,
    opts.method ?? "GET",
    opts.headers ?? {},
    opts.body ?? null,
    opts.crawlKey ?? null,
    opts.crawlResponseHeaders ?? [],
    robot ? Math.floor(keyNow.getTime() / 86400_000) : null,
  ]);
  const timeoutMs = ctx.timeoutMs ?? opts.timeoutMs ?? 20_000,
    // One dropped connection on a GET is retried once with a fresh budget (guardedFetch); the host lease covers both.
    retryDropped = (opts.method ?? "GET").toUpperCase() === "GET",
    leaseMs = retryDropped ? timeoutMs * 2 + DROPPED_RETRY.afterMs * 2 : timeoutMs;
  // Robots reads wait in robots(), which first checks whether another source stored the file meanwhile.
  const claimNow = (now: Date) => claimCrawlRequest(ctx.sessionId, key, url, gap, ctx.virtualClock ? now : undefined, leaseMs, cacheValidAfter);
  const claim = robot ? await claimNow(keyNow) : await shortWait(ctx, claimNow);
  if ("cached" in claim && claim.cached) {
    if (!robot && claim.cached.status === 200 && !(await permitted(ctx, url, "store_fulltext", opts.sourceResource)))
      throw new CrawlBlocked("crawl_cached_permission_changed");
    return response(Number(claim.cached.status), url, claim.cached.headers, Buffer.from(claim.cached.body), claim.cached.fetched_at);
  }
  const token = claim.token!;
  let released = false,
    transportFinished = false;
  try {
    const res = await ctx.get(url, {
      ...opts,
      timeoutMs,
      signal: ctx.signal ? (opts.signal ? AbortSignal.any([ctx.signal, opts.signal]) : ctx.signal) : opts.signal,
      headers: { ...Object.fromEntries(Object.entries(opts.headers ?? {}).filter(([key]) => key.toLowerCase() !== "user-agent")), "user-agent": DEFAULT_UA },
      followRedirects: false,
      retryDropped,
    });
    transportFinished = true;
    const observed = await crawlTime(ctx);
    const headers = Object.fromEntries(
      [...new Set(["content-type", "location", "retry-after", "etag", "last-modified", ...(opts.crawlResponseHeaders ?? [])])].flatMap((name) =>
        res.headers.has(name) ? [[name, res.headers.get(name)!]] : [],
      ),
    );
    if (res.status === 429 || res.status === 503) {
      const retryAt = retryAfter(res.headers.get("retry-after"), observed);
      await finishCrawlRequest({ ...claim, token, retryAt, status: res.status, now: ctx.virtualClock ? ctx.now() : undefined });
      released = true;
      throw new CrawlDeferred(retryAt, claim.id, `HTTP ${res.status}`);
    }
    const challenge =
      /html/i.test(res.headers.get("content-type") ?? "") &&
      /cf-chl-|window\._cf_chl_opt|verify you are human|checking your browser|<title>\s*(?:just a moment|security verification)|<(?:title|h[1-3])[^>]*>\s*(?:captcha|人机验证|访问验证)\s*</i.test(
        res.body.subarray(0, 64_000).toString(),
      );
    if (challenge || (!robot && (res.status === 403 || res.status === 401))) {
      const code = challenge ? "crawl_challenge" : `crawl_http_${res.status}`;
      await finishCrawlRequest({ ...claim, token, blocked: code, status: res.status, now: ctx.virtualClock ? ctx.now() : undefined });
      released = true;
      throw new CrawlBlocked(code);
    }
    const empty = res.status === 304 || (res.status >= 300 && res.status < 400);
    const mayStore = robot || empty || (await permitted(ctx, url, "store_fulltext", opts.sourceResource));
    await finishCrawlRequest({
      ...claim,
      token,
      now: ctx.virtualClock ? ctx.now() : undefined,
      fetchedAt: observed,
      status: res.status,
      headers,
      body: mayStore ? (empty ? Buffer.alloc(0) : res.body) : null,
      proof:
        !robot && ctx.permissionVersion !== null
          ? {
              sourceId: ctx.source.id,
              lane: ctx.source.lane,
              permissionVersion: ctx.permissionVersion,
              url,
              documentType: opts.sourceResource?.documentType ?? ctx.source.config.policyProfile?.identity?.documentType?.value ?? null,
              attachment: opts.sourceResource?.attachment ?? false,
              fulltext: mayStore && !empty,
            }
          : undefined,
    });
    released = true;
    return { ...res, fetchedAt: observed.toISOString() };
  } catch (error) {
    if (!released) {
      // A body over the caller's cap fails the same way every time. Cooling the whole host down and retrying it
      // forever pins every other page on that host; refuse this request and let the caller record the failure.
      if (error instanceof Error && error.message.startsWith("Response too large")) {
        await finishCrawlRequest({ ...claim, token, blocked: "crawl_response_too_large", now: ctx.virtualClock ? ctx.now() : undefined });
        released = true;
        throw error;
      }
      const now = await crawlTime(ctx),
        cause = ctx.signal?.aborted ? "aborted" : transportCause(error);
      if (transportFinished || cause === "aborted") {
        const retryAt = new Date(now.getTime() + TRANSPORT_BACKOFF_MS.first);
        await finishCrawlRequest({ ...claim, token, retryAt, now: ctx.virtualClock ? ctx.now() : undefined });
        if (transportFinished) throw error;
        throw new CrawlDeferred(retryAt, claim.id, "transport_unavailable", cause);
      }
      // No such domain, an invalid certificate or a refused address will not heal by waiting: fail the run.
      if (PERMANENT_TRANSPORT_CAUSES.has(cause)) {
        await finishCrawlRequest({ ...claim, token, blocked: `transport_${cause}`, now: ctx.virtualClock ? ctx.now() : undefined });
        released = true;
        throw new CrawlTransportFailed(cause, claim.host);
      }
      // Transient: each consecutive failure on the host doubles the wait (1, 2, 4 ... 30 min).
      const failures = await recordHostTransportFailure(claim.host, cause),
        wait = Math.min(TRANSPORT_BACKOFF_MS.max, TRANSPORT_BACKOFF_MS.first * 2 ** Math.max(0, failures - 1)),
        retryAt = new Date(now.getTime() + wait);
      await finishCrawlRequest({ ...claim, token, retryAt, now: ctx.virtualClock ? ctx.now() : undefined });
      released = true;
      throw new CrawlDeferred(retryAt, claim.id, "transport_unavailable", cause);
    }
    throw error;
  }
}
const robotsHtml = (text: string) => /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html|head|body)\b/i.test(text.replace(/^\uFEFF/, ""));
/** Read robots.txt once and store the outcome; the stored observation is returned. */
async function readRobots(ctx: Context, origin: string, previous: RobotsObservation | null, now: Date) {
  let res: GuardedResponse | undefined,
    target = `${origin}/robots.txt`,
    failure: { reason: string; notBefore?: Date } | null = null;
  try {
    for (let hop = 0; ; hop++) {
      // An expired robots observation needs new bytes, even when this session cached its earlier HTTP error.
      // Keep fresh redirect steps resumable across pacing waits without reusing the expired failure.
      res = await request(ctx, target, { maxBytes: 512_000, maxRedirects: 0, headers: { accept: ACCEPT.robots } }, ctx.minimumMs, true, previous?.expires_at);
      if (!(res.status >= 300 && res.status < 400 && res.headers.has("location"))) break;
      if (hop >= ROBOTS_MAX_REDIRECTS) {
        failure = { reason: "robots_redirect_limit" };
        break;
      }
      target = new URL(res.headers.get("location")!, target).toString();
    }
  } catch (error) {
    if (error instanceof CrawlDeferred && error.reason === "host_pacing") throw error;
    if (error instanceof CrawlBlocked) {
      await saveRobotsBlocked(origin, now, error.code);
      throw error;
    }
    if (error instanceof CrawlTransportFailed) {
      await saveRobotsFailure(origin, now, `transport_${error.transportCause}`);
      throw error;
    }
    if (ctx.signal?.aborted) throw error;
    failure =
      error instanceof CrawlDeferred
        ? {
            reason: error.reason === "transport_unavailable" ? `transport_${error.causeCode ?? "other"}` : `robots_http_${error.reason.replace(/^HTTP /, "")}`,
            notBefore: error.retryAt,
          }
        : { reason: "robots_read_error" };
  }
  const checkedAt = res?.fetchedAt ? new Date(res.fetchedAt) : await crawlTime(ctx);
  if (!failure && res) {
    const status = res.status,
      finalUrl = target === `${origin}/robots.txt` ? null : target;
    if (status >= 200 && status < 300) {
      const text = res.text();
      if (robotsHtml(text)) await saveRobots(origin, status, "", checkedAt, null, null, { finalUrl, warning: "robots_html" });
      else if (text.trim() && !robotsRecognized(text))
        await saveRobots(origin, status, "", checkedAt, null, null, { finalUrl, warning: "robots_unrecognized" });
      else await saveRobots(origin, status, text, checkedAt, null, null, { finalUrl });
    } else if (status >= 400 && status < 500) {
      await saveRobots(origin, status, "", checkedAt, null, null, { finalUrl, warning: status === 404 ? null : `robots_http_${status}` });
    } else failure = { reason: `robots_http_${status}` };
  }
  if (failure) await saveRobotsFailure(origin, checkedAt, failure.reason, failure.notBefore);
  return robotsObservation(origin);
}
/**
 * robots.txt per RFC 9309 §2.3.1: 2xx is parsed (an HTML page or text without any rule is treated as empty, with a
 * warning); 4xx means "unavailable", which allows all; 5xx, 429 and network failures keep using the last good copy
 * for up to 30 days, else wait with backoff. A failure never replaces the good copy. Up to five redirects are
 * followed, across hosts, each as its own paced request.
 */
async function robots(ctx: Context, url: string) {
  const origin = new URL(url).origin,
    now = await crawlTime(ctx);
  let observation = await robotsObservation(origin);
  if (!observation || observation.expires_at <= now)
    observation = await shortWait(ctx, async () => {
      // Another source on this origin may have read robots.txt while this one waited for the host.
      const current = await robotsObservation(origin),
        at = await crawlTime(ctx);
      return current && current.expires_at > at ? current : readRobots(ctx, origin, current, at);
    });
  if (observation?.error && observation.error !== "robots_unavailable") throw new CrawlBlocked(observation.error);
  if (!observation) throw new CrawlDeferred(new Date(now.getTime() + 300_000), sha256(origin), "robots_unavailable");
  // While reads fail, the last good copy (status > 0) keeps applying for 30 days. After that, or without one, wait.
  if (observation.error && !(observation.status > 0 && now.getTime() - observation.observed_at.getTime() <= ROBOTS_GOOD_COPY_MS))
    throw new CrawlDeferred(
      observation.retry_at ?? new Date(now.getTime() + 300_000),
      sha256(origin),
      "robots_unavailable",
      observation.failure_reason ?? undefined,
    );
  const rules = parseRobots(observation.body, SITE.crawlerName);
  if (rules.invalidDelay) throw new CrawlBlocked("robots_invalid_crawl_delay");
  if (!robotsAllows(rules, url)) throw new CrawlBlocked("robots_disallowed");
  return Math.max(ctx.minimumMs, rules.delayMs);
}
/** Explicit collector wrapper. Model transports continue to call guardedFetch directly. */
export async function crawlFetch(url: string, opts: GuardedFetchOptions = {}) {
  const ctx = context.getStore();
  if (!ctx) return guardedFetch(url, opts);
  let target = url;
  for (let hop = 0; ; hop++) {
    if (ctx.permissionVersion !== null)
      for (const capability of ["fetch", "store_metadata", "process_locally"] as const)
        if (!(await permitted(ctx, target, capability, opts.sourceResource))) throw new CrawlBlocked(`crawl_permission_${capability}`);
    const gap = await robots(ctx, target),
      res = await request(ctx, target, opts, gap);
    if (!(res.status >= 300 && res.status < 400 && res.headers.has("location"))) return res;
    if (hop >= (opts.maxRedirects ?? 2)) throw new CrawlBlocked("crawl_redirect_limit");
    const next = new URL(res.headers.get("location")!, target),
      before = new URL(target);
    if (next.hostname !== before.hostname || (before.protocol === "https:" && next.protocol !== "https:"))
      // Content redirects stay on the configured host; the message carries the new address for the operator to adopt.
      throw new CrawlBlocked("crawl_redirect_host_changed", next.toString());
    target = next.toString();
  }
}
function encode(value: unknown): unknown {
  if (value instanceof Date) return { $crawlDate: value.toISOString() };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  return value;
}
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && "$crawlDate" in value) return new Date(String(value.$crawlDate));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]));
  }
  return value;
}
/** Parsed metadata checkpoints let a deferred multi-page job resume without refetching its first page. */
export async function crawlStep<T>(name: string, url: string, run: () => Promise<T>): Promise<T> {
  const ctx = context.getStore();
  if (!ctx) return run();
  if (ctx.permissionVersion !== null && !(await permitted(ctx, url, "store_metadata"))) throw new CrawlBlocked("crawl_checkpoint_permission_changed");
  const cached = await crawlCheckpoint(ctx.sessionId, name);
  if (cached) return decode(cached.value) as T;
  const value = await run();
  const fulltext = await permitted(ctx, url, "store_fulltext");
  const clean = (v: unknown): unknown => {
    if (v instanceof Date) return v;
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .filter(([key]) => fulltext || (!["body", "bodyText", "bodyHtml"].includes(key) && !(key === "raw" && "url" in v && "title" in v)))
          .map(([key, item]) => [key, clean(item)]),
      );
    return v;
  };
  const checkpoint = clean(value) as T;
  // Null is "nothing parsed yet", not a resume point. Inserting it becomes SQL NULL and violates value NOT NULL.
  if (checkpoint !== null && checkpoint !== undefined) {
    await saveCrawlCheckpoint(
      ctx.sessionId,
      name,
      encode(checkpoint),
      ctx.permissionVersion !== null
        ? {
            sourceId: ctx.source.id,
            lane: ctx.source.lane,
            permissionVersion: ctx.permissionVersion,
            url: url.replace(/^https:\/\/r\.jina\.ai\//, ""),
            documentType: ctx.source.config.policyProfile?.identity?.documentType?.value ?? null,
            attachment: false,
            fulltext,
          }
        : undefined,
    );
  }
  return checkpoint;
}

export async function crawlFulltextAllowed(url: string) {
  const ctx = context.getStore();
  return !ctx || permitted(ctx, url, "store_fulltext");
}
/** Source-reading providers keep their existing paid transport/receipts, after the original host's robots and pacing gate. */
export async function crawlExternal<T>(url: string, name: string, run: () => Promise<T>): Promise<T> {
  const ctx = context.getStore();
  if (!ctx) return run();
  if (!(await permitted(ctx, url, "store_fulltext"))) throw new CrawlBlocked("crawl_reader_storage_not_permitted");
  const action = async () => {
    const gap = await robots(ctx, url),
      claim = await shortWait(ctx, (now) => claimCrawlRequest(ctx.sessionId, `provider:${name}:${url}`, url, gap, ctx.virtualClock ? now : undefined, 60_000));
    const token = claim.token!;
    try {
      const value = await run();
      await finishCrawlRequest({ ...claim, token, now: ctx.virtualClock ? ctx.now() : undefined });
      return value;
    } catch (error) {
      if (error instanceof ProviderRejectedError && !error.retryable) {
        await finishCrawlRequest({ ...claim, token, blocked: "crawl_external_rejected", now: ctx.virtualClock ? ctx.now() : undefined });
        throw error;
      }
      const retryAt = new Date((await crawlTime(ctx)).getTime() + 60_000);
      // The reader failed, not this host. Keep the wait on this request so it is not fetched again immediately,
      // but do not cool the host: one unreadable page would otherwise hold every other page for a minute.
      await finishCrawlRequest({ ...claim, token, retryAt, coolHost: false, now: ctx.virtualClock ? ctx.now() : undefined });
      throw new CrawlDeferred(retryAt, claim.id, "source_reader_pending");
    }
  };
  return (await permitted(ctx, url, "store_fulltext")) ? crawlStep(`provider:${name}:${url}`, url, action) : action();
}

export const crawlReadKey = () => context.getStore()?.sessionId;
