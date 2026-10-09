import { AsyncLocalStorage } from "node:async_hooks";
import { SourceCrawlProfile as CrawlProfile } from "@amp/backend/sources/config-keys";
import { ProviderRejectedError } from "@amp/backend/providers/receipts";
import { SITE } from "@amp/industry/site";
import { readCurrentSourcePolicy, evaluateSourcePolicy } from "@amp/backend/admin/sources";
import { DEFAULT_UA, decodeBody, guardedFetch, type GuardedFetchOptions, type GuardedResponse } from "../lib/http-fetch.ts";
import { stableJson, sha256 } from "../lib/ids.ts";
import type { SourceRow } from "../sources/types.ts";
import { parseRobots, robotsAllows } from "./robots.ts";
import {
  CrawlBlocked,
  CrawlDeferred,
  claimCrawlRequest,
  crawlClock,
  finishCrawlRequest,
  openCrawlSession,
  finishCrawlSession,
  crawlCheckpoint,
  saveCrawlCheckpoint,
  robotsObservation,
  saveRobots,
} from "./pacing.ts";
export { CrawlBlocked, CrawlDeferred, CrawlObsolete } from "./pacing.ts";
export { SourceCrawlProfile as CrawlProfile } from "@amp/backend/sources/config-keys";
type Get = (url: string, options: GuardedFetchOptions) => Promise<GuardedResponse>;
type Context = { sessionId: string; source: SourceRow; permissionVersion: number | null; minimumMs: number; get: Get; now: () => Date; virtualClock: boolean };
const context = new AsyncLocalStorage<Context>();
export async function withSourceCrawl<T>(
  source: SourceRow,
  scope: string,
  run: () => Promise<T>,
  options: { get?: Get; now?: () => Date; expectedSessionId?: string } = {},
) {
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
    get: options.get ?? guardedFetch,
    now: options.now ?? (() => new Date()),
    virtualClock: !!options.now,
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
async function request(ctx: Context, url: string, opts: GuardedFetchOptions, gap: number, robot = false): Promise<GuardedResponse> {
  const now = await crawlTime(ctx);
  const key = stableJson([url, opts.method ?? "GET", opts.headers ?? {}, opts.body ?? null, robot ? Math.floor(now.getTime() / 86400_000) : null]);
  const claim = await claimCrawlRequest(ctx.sessionId, key, url, gap, ctx.virtualClock ? now : undefined, opts.timeoutMs ?? 20_000);
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
      headers: { ...Object.fromEntries(Object.entries(opts.headers ?? {}).filter(([key]) => key.toLowerCase() !== "user-agent")), "user-agent": DEFAULT_UA },
      followRedirects: false,
      retryDropped: false,
    });
    transportFinished = true;
    const observed = await crawlTime(ctx);
    const headers = Object.fromEntries(
      ["content-type", "location", "retry-after", "etag", "last-modified"].flatMap((name) => (res.headers.has(name) ? [[name, res.headers.get(name)!]] : [])),
    );
    if (res.status === 429 || res.status === 503) {
      const retryAt = retryAfter(res.headers.get("retry-after"), observed);
      await finishCrawlRequest({ ...claim, token, retryAt, now: ctx.virtualClock ? ctx.now() : undefined });
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
      const retryAt = new Date((await crawlTime(ctx)).getTime() + 60_000);
      await finishCrawlRequest({ ...claim, token, retryAt, now: ctx.virtualClock ? ctx.now() : undefined });
      if (transportFinished) throw error;
      throw new CrawlDeferred(retryAt, claim.id, "transport_unavailable");
    }
    throw error;
  }
}
async function robots(ctx: Context, url: string) {
  const origin = new URL(url).origin,
    now = await crawlTime(ctx);
  let observation = await robotsObservation(origin);
  if (!observation || observation.expires_at <= now) {
    let res: GuardedResponse;
    try {
      let target = `${origin}/robots.txt`;
      for (let hop = 0; ; hop++) {
        res = await request(ctx, target, { maxBytes: 512_000, maxRedirects: 0 }, ctx.minimumMs, true);
        if (!(res.status >= 300 && res.status < 400 && res.headers.has("location"))) break;
        const next = new URL(res.headers.get("location")!, target),
          current = new URL(target);
        if (hop >= 2 || next.hostname !== current.hostname || (current.protocol === "https:" && next.protocol !== "https:"))
          throw new CrawlBlocked("robots_redirect_not_approved");
        target = next.toString();
      }
    } catch (error) {
      if (error instanceof CrawlDeferred && error.reason === "host_pacing") throw error;
      if (error instanceof CrawlBlocked) {
        await saveRobots(origin, 0, "", now, null, error.code);
        throw error;
      }
      const retryAt = error instanceof CrawlDeferred ? error.retryAt : new Date(now.getTime() + 300_000);
      await saveRobots(origin, 0, "", now, retryAt, "robots_unavailable");
      throw new CrawlDeferred(retryAt, sha256(origin), "robots_unavailable");
    }
    const error = (res.status === 200 && !/<(?:!doctype|html)\b/i.test(res.text())) || res.status === 404 ? null : "robots_unavailable";
    const checkedAt = res.fetchedAt ? new Date(res.fetchedAt) : await crawlTime(ctx);
    await saveRobots(origin, res.status, res.status === 200 ? res.text() : "", checkedAt, error ? new Date(checkedAt.getTime() + 300_000) : null, error);
    observation = await robotsObservation(origin);
  }
  if (observation?.error && observation.error !== "robots_unavailable") throw new CrawlBlocked(observation.error);
  if (!observation || observation.error)
    throw new CrawlDeferred(observation?.retry_at ?? new Date(now.getTime() + 300_000), sha256(origin), "robots_unavailable");
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
      throw new CrawlBlocked("crawl_redirect_host_changed");
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
      claim = await claimCrawlRequest(ctx.sessionId, `provider:${name}:${url}`, url, gap, ctx.virtualClock ? ctx.now() : undefined, 60_000);
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
      await finishCrawlRequest({ ...claim, token, retryAt, now: ctx.virtualClock ? ctx.now() : undefined });
      throw new CrawlDeferred(retryAt, claim.id, "source_reader_pending");
    }
  };
  return (await permitted(ctx, url, "store_fulltext")) ? crawlStep(`provider:${name}:${url}`, url, action) : action();
}

export const crawlReadKey = () => context.getStore()?.sessionId;
