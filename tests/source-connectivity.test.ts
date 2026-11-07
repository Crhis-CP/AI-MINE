// TASK-0574: sources connect reliably within robots and permission rules — robots status matrix (RFC 9309), stored
// transport causes, permanent failures, the deferral cap, short host waits in process and honest Accept headers.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { readSourceDateContext } from "@amp/backend/admin/sources";
import { collectSource } from "@amp/backend/sources/collect";
import { crawlFetch, withSourceCrawl, CrawlDeferred, CrawlTransportFailed, ROBOTS_GOOD_COPY_MS } from "../packages/backend/src/acquisition/crawl.ts";
import { robotsObservation, saveRobots, saveRobotsFailure } from "../packages/backend/src/acquisition/pacing.ts";
import { ACCEPT, transportCause, type GuardedFetchOptions, type GuardedResponse } from "../packages/backend/src/lib/http-fetch.ts";
import { fetchRss } from "../packages/backend/src/sources/rss.ts";
import { fetchJsonListConditional } from "../packages/backend/src/sources/json-list.ts";
import { fetchWebList } from "../packages/backend/src/sources/web-list.ts";
import { causeText, fetchErrorText, sourceHealth } from "../packages/backend/src/sources/health.ts";
import { withdrawnReason } from "../packages/backend/src/publication/withdrawals.ts";
import { grantDateFixture } from "./source-date-fixture.ts";

after(closeDb);
let serial = 0;
const start = Date.parse("2031-03-10T04:00:00Z");
function reply(url: string, status: number, body = "", headers: Record<string, string> = {}): GuardedResponse {
  return { url, status, headers: new Headers({ "content-type": "text/plain", ...headers }), body: Buffer.from(body), text: () => body };
}
const fetchFailed = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
async function fixture(kind = "web_list", config: Record<string, unknown> = {}) {
  const id = `connectivity-${++serial}-${Date.now()}`,
    url = `https://${id}.invalid/news`;
  await sql`INSERT INTO sources(id,name,kind,lane,enabled,participation_mode,config)
    VALUES(${id},${id},${kind},'news',true,'editorial',${sql.json({ ...(kind === "rss" ? { feedUrl: url } : { url }), ...config })})`;
  await grantDateFixture(id, [url]);
  const source = (await readSourceDateContext(id))!;
  let clock = start;
  // Short host waits advance the virtual clock unless a test watches them itself.
  const options = (get: (url: string, opts: GuardedFetchOptions) => Promise<GuardedResponse>, sleep?: (ms: number) => Promise<void>) => ({
    get,
    now: () => new Date(clock),
    sleep:
      sleep ??
      (async (ms: number) => {
        clock += ms;
      }),
  });
  return {
    id,
    url,
    origin: new URL(url).origin,
    source,
    options,
    fetch: (get: (url: string, opts: GuardedFetchOptions) => Promise<GuardedResponse>, target = url) =>
      withSourceCrawl(source, `connectivity:${id}`, () => crawlFetch(target), options(get)),
    now: () => clock,
    set: (at: number) => {
      clock = at;
    },
  };
}

for (const status of [401, 403, 410, 412]) {
  test(`robots ${status} means unavailable: everything is allowed and cached for a day`, async () => {
    const f = await fixture();
    const page = await f.fetch(async (url) => (url.endsWith("/robots.txt") ? reply(url, status) : reply(url, 200, "article")));
    assert.equal(page.text(), "article");
    const stored = (await robotsObservation(f.origin))!;
    assert.deepEqual([stored.status, stored.error, stored.warning], [status, null, `robots_http_${status}`]);
    assert.equal(stored.expires_at.getTime() - stored.observed_at.getTime(), 86400_000);
  });
}

for (const body of ["<!DOCTYPE html><html><body>Page not found</body></html>", "﻿  <html><head><title>404</title></head></html>", "just some text"]) {
  test(`a 200 robots page without rules (${body.slice(0, 20)}) is treated as empty with a warning`, async () => {
    const f = await fixture();
    const page = await f.fetch(async (url) => reply(url, 200, url.endsWith("/robots.txt") ? body : "article"));
    assert.equal(page.text(), "article");
    const stored = (await robotsObservation(f.origin))!;
    assert.equal(stored.body, "");
    assert.equal(stored.warning, body.includes("html") ? "robots_html" : "robots_unrecognized");
  });
}

test("a challenge page on robots.txt still blocks: no evasion", async () => {
  const f = await fixture();
  await assert.rejects(
    f.fetch(async (url) => reply(url, 200, "<html><title>Just a moment</title></html>", { "content-type": "text/html" })),
    /crawl_challenge/,
  );
});

test("robots 5xx keeps the last good copy and its rules; the failure is stored beside it, never over it", async () => {
  const f = await fixture();
  await saveRobots(f.origin, 200, "User-agent: *\nDisallow: /private", new Date(f.now() - 3 * 86400_000), null, null);
  f.set(f.now() + 1);
  const calls: string[] = [];
  const get = async (url: string) => {
    calls.push(url);
    return url.endsWith("/robots.txt") ? reply(url, 500, "maintenance") : reply(url, 200, "article");
  };
  // The copy expired a day after it was read: a fresh read is due, fails with 500, and the copy still applies.
  // (A 503 or 429 also cools the whole host for its Retry-After, so the page would wait for that first.)
  assert.equal((await f.fetch(get)).text(), "article");
  await assert.rejects(f.fetch(get, `${f.origin}/private/a`), /robots_disallowed/);
  const stored = (await robotsObservation(f.origin))!;
  assert.equal(stored.status, 200);
  assert.equal(stored.body, "User-agent: *\nDisallow: /private");
  assert.equal(stored.observed_at.getTime(), start - 3 * 86400_000);
  assert.deepEqual([stored.error, stored.failure_count, stored.failure_reason], ["robots_unavailable", 1, "robots_http_500"]);
  assert.equal(calls.filter((url) => url.endsWith("/robots.txt")).length, 1, "the failed read waits 5 minutes before the next try");
});

test("robots 5xx without a good copy waits with backoff and names the cause", async () => {
  const f = await fixture();
  let robots = 0;
  const get = async (url: string) => {
    if (url.endsWith("/robots.txt")) robots++;
    return url.endsWith("/robots.txt") ? reply(url, 500) : reply(url, 200, "article");
  };
  const waits: number[] = [];
  for (let n = 0; n < 3; n++) {
    await assert.rejects(f.fetch(get), (error) => {
      assert.ok(error instanceof CrawlDeferred);
      assert.deepEqual([error.reason, error.causeCode], ["robots_unavailable", "robots_http_500"]);
      waits.push(error.retryAt.getTime() - f.now());
      f.set(error.retryAt.getTime());
      return true;
    });
  }
  assert.deepEqual(waits, [300_000, 900_000, 3_600_000]);
  assert.equal(robots, 3);
});

test("a good copy older than 30 days is not used: collection waits and source health asks for a decision", async () => {
  const f = await fixture();
  const read = new Date(start - 40 * 86400_000),
    failing = new Date(start - 31 * 86400_000);
  await saveRobots(f.origin, 200, "User-agent: *\nAllow: /", read, null, null);
  await saveRobotsFailure(f.origin, failing, "robots_http_503");
  await sql`UPDATE acquisition.robots_observations SET expires_at=${new Date(start + 3600_000)} WHERE origin=${f.origin}`;
  await assert.rejects(
    f.fetch(async (url) => reply(url, 200, "article")),
    (error) => error instanceof CrawlDeferred && error.reason === "robots_unavailable" && error.causeCode === "robots_http_503",
  );
  const groups = await sourceHealth(start);
  const stale = groups.flatMap((g) => g.robots_stale).find((s) => s.id === f.id);
  assert.ok(stale, "30 days of failures become a robots problem for the operator");
  assert.match(stale.robots_note!, /^robots\.txt 返回 503 已 31 天，.+的副本已超过 30 天，暂停访问/);
  assert.equal(
    groups.flatMap((g) => g.robots_fallback).find((s) => s.id === f.id),
    undefined,
  );
  // Three days into a failure the 4-day-old copy still applies, and health says so.
  await saveRobots(f.origin, 200, "User-agent: *\nAllow: /", new Date(start - 4 * 86400_000), null, null);
  await saveRobotsFailure(f.origin, new Date(start - 3 * 86400_000), "robots_http_503");
  const fallback = (await sourceHealth(start)).flatMap((g) => g.robots_fallback).find((s) => s.id === f.id);
  assert.match(fallback?.robots_note ?? "", /^robots\.txt 返回 503 已 3 天，沿用 03-06 的副本/);
  assert.ok(ROBOTS_GOOD_COPY_MS === 30 * 86400_000);
});

test("robots redirects are followed across hosts up to five, recording the final URL; a sixth is a failure", async () => {
  const f = await fixture();
  const hops = (count: number) => async (url: string) => {
    const at = /\/hop(\d+)$/.exec(url),
      n = at ? Number(at[1]) : 0;
    if (url.endsWith("/robots.txt") || at)
      return n < count ? reply(url, 301, "", { location: `https://mirror-${n}.invalid/hop${n + 1}` }) : reply(url, 200, "User-agent: *\nAllow: /");
    return reply(url, 200, "article");
  };
  assert.equal((await f.fetch(hops(5))).text(), "article");
  const stored = (await robotsObservation(f.origin))!;
  assert.equal(stored.final_url, "https://mirror-4.invalid/hop5");
  const g = await fixture();
  await assert.rejects(g.fetch(hops(6)), (error) => error instanceof CrawlDeferred && error.causeCode === "robots_redirect_limit");
});

test("transport causes are classified from the error chain", () => {
  assert.equal(transportCause(fetchFailed("ENOTFOUND")), "dns_not_found");
  assert.equal(transportCause(Object.assign(new Error("getaddrinfo"), { code: "EAI_AGAIN" })), "dns_temporary");
  assert.equal(transportCause(fetchFailed("CERT_HAS_EXPIRED")), "certificate_invalid");
  assert.equal(transportCause(fetchFailed("ERR_TLS_CERT_ALTNAME_INVALID")), "certificate_invalid");
  assert.equal(transportCause(fetchFailed("UND_ERR_CONNECT_TIMEOUT")), "timeout");
  assert.equal(transportCause(new DOMException("The operation was aborted due to timeout", "TimeoutError")), "timeout");
  assert.equal(transportCause(fetchFailed("ECONNRESET")), "connection_reset");
  assert.equal(transportCause(fetchFailed("ECONNREFUSED")), "connection_refused");
  assert.equal(transportCause(new Error("Blocked private address for a.invalid")), "address_blocked");
  assert.equal(transportCause(new Error("something else")), "other");
  assert.equal(causeText("transport_dns_not_found"), "DNS 无法解析（域名不存在）");
  assert.equal(causeText("transport_certificate_invalid"), "证书无效");
  assert.equal(causeText("robots_http_503"), "robots.txt 返回 503");
});

test("a permanent cause fails the collection run instead of deferring, with the cause in source health", async () => {
  const f = await fixture();
  await saveRobots(f.origin, 404, "", new Date(f.now()), null, null);
  const result = await withSourceCrawl(
    f.source,
    `collect:${f.id}`,
    () => collectSource(f.id),
    f.options(async () => {
      throw fetchFailed("ENOTFOUND");
    }),
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /^transport_dns_not_found: /);
  const [source] = await sql<{ fail_count: number; last_error: string }[]>`SELECT fail_count,last_error FROM sources WHERE id=${f.id}`;
  assert.equal(source!.fail_count, 1);
  assert.equal(fetchErrorText(source!.last_error), `DNS 无法解析（域名不存在）（${new URL(f.url).hostname}）`);
  await assert.rejects(
    f.fetch(async () => {
      throw fetchFailed("CERT_HAS_EXPIRED");
    }),
    (error) => error instanceof CrawlTransportFailed && error.transportCause === "certificate_invalid",
  );
});

test("transient causes back off per host, are stored on the run, and the fifth wait in a row becomes a failed run", async () => {
  const f = await fixture();
  await saveRobots(f.origin, 404, "", new Date(f.now()), null, null);
  const get = async (url: string) => {
    if (url.endsWith("/robots.txt")) return reply(url, 404);
    throw fetchFailed("UND_ERR_CONNECT_TIMEOUT");
  };
  const waits: number[] = [];
  for (let n = 1; n <= 5; n++) {
    const result = await withSourceCrawl(f.source, `collect:${f.id}:${n}`, () => collectSource(f.id), f.options(get));
    if (n < 5) {
      assert.equal(result.status, "deferred");
      assert.equal(result.error, "transport_unavailable");
      waits.push(Date.parse(result.retryAt!) - f.now());
      f.set(Date.parse(result.retryAt!));
    } else {
      assert.equal(result.status, "failed");
      assert.match(result.error!, /^deferral_limit transport_unavailable \(timeout\): 5 consecutive waits/);
    }
  }
  assert.deepEqual(waits, [60_000, 120_000, 240_000, 480_000]);
  const runs = await sql<{ status: string; cause: string | null }[]>`
    SELECT status,detail->>'cause' AS cause FROM fetch_runs WHERE source_id=${f.id} ORDER BY id`;
  assert.deepEqual(
    runs.map((r) => [r.status, r.cause]),
    [...Array(4).fill(["skipped", "timeout"]), ["failed", null]],
  );
  const [source] = await sql<{ fail_count: number; last_error: string }[]>`SELECT fail_count,last_error FROM sources WHERE id=${f.id}`;
  assert.equal(source!.fail_count, 1);
  assert.equal(fetchErrorText(source!.last_error), "连续 5 次连不上源站（连接超时）");
  // Any HTTP answer ends the host's streak.
  f.set(f.now() + 3_600_000);
  await f.fetch(async (url) => reply(url, url.endsWith("/robots.txt") ? 404 : 200, "ok"));
  const [host] = await sql<{ transport_failures: number }[]>`SELECT transport_failures FROM acquisition.crawl_hosts WHERE host=${new URL(f.url).hostname}`;
  assert.equal(host!.transport_failures, 0);
});

test("a host wait up to 5 s is slept in process; a longer one still goes back to the queue", async () => {
  for (const [delay, inProcess] of [
    [3, true],
    [6, false],
  ] as const) {
    const f = await fixture();
    await saveRobots(f.origin, 200, `User-agent: *\nCrawl-delay: ${delay}`, new Date(f.now()), null, null);
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
      f.set(f.now() + ms);
    };
    const run = () =>
      withSourceCrawl(
        f.source,
        `pace:${f.id}`,
        async () => {
          await crawlFetch(f.url);
          return (await crawlFetch(`${f.url}/second`)).text();
        },
        f.options(async (url) => reply(url, 200, url.endsWith("/second") ? "second" : "first"), sleep),
      );
    if (inProcess) {
      assert.equal(await run(), "second");
      assert.deepEqual(slept, [delay * 1000]);
    } else {
      await assert.rejects(run(), (error) => error instanceof CrawlDeferred && error.reason === "host_pacing");
      assert.deepEqual(slept, []);
    }
  }
});

test("each request kind asks for what it reads, with the honest crawler name and the per-source timeout", async () => {
  const seen: { url: string; accept?: string; agent?: string; timeoutMs?: number; retryDropped?: boolean }[] = [];
  const get = async (url: string, opts: GuardedFetchOptions) => {
    seen.push({ url, accept: opts.headers?.accept, agent: opts.headers?.["user-agent"], timeoutMs: opts.timeoutMs, retryDropped: opts.retryDropped });
    return url.endsWith("/robots.txt") ? reply(url, 404) : reply(url, 200, "[]", { "content-type": "application/json" });
  };
  const reads: [string, Record<string, unknown>, (source: Awaited<ReturnType<typeof fixture>>["source"]) => Promise<unknown>, string][] = [
    ["rss", {}, (s) => fetchRss(s), ACCEPT.feed],
    ["json_list", { itemsPath: "$" }, (s) => fetchJsonListConditional(s, null), ACCEPT.json],
    ["web_list", { selectors: { item: "a" }, crawlProfile: { timeoutSeconds: 45 } }, (s) => fetchWebList(s), ACCEPT.html],
  ];
  for (const [kind, config, read, accept] of reads) {
    const f = await fixture(kind, config);
    seen.length = 0;
    await withSourceCrawl(f.source, `accept:${f.id}`, () => read(f.source).catch(() => null), f.options(get));
    const robots = seen.find((s) => s.url.endsWith("/robots.txt"))!,
      listing = seen.find((s) => s.url === f.url)!;
    assert.equal(robots.accept, ACCEPT.robots);
    assert.equal(listing.accept, accept, `${kind} Accept`);
    assert.match(listing.agent!, /^Mozilla\/5\.0 \(compatible; .+\/1\.0; \+.+\/about\)$/);
    assert.equal(listing.retryDropped, true, "one dropped GET connection is retried");
    assert.equal(listing.timeoutMs, kind === "web_list" ? 45_000 : 25_000);
  }
});

test("each automatic non-public path has one reason, first match wins", () => {
  const ok = {
    admissionAllowed: true,
    operatorWithdrawn: false,
    isolated: false,
    admitted: true,
    hasMaterial: true,
    language: true,
    chineseCopy: true,
    readingReady: true,
  };
  assert.equal(withdrawnReason(ok), null);
  assert.equal(withdrawnReason({ ...ok, operatorWithdrawn: true, admitted: false }), "manual");
  assert.equal(withdrawnReason({ ...ok, admissionAllowed: false }), "original_post_not_admitted");
  assert.equal(withdrawnReason({ ...ok, isolated: true }), "non_editorial");
  assert.equal(withdrawnReason({ ...ok, admitted: false, hasMaterial: false }), "blocked");
  assert.equal(withdrawnReason({ ...ok, hasMaterial: false }), "no_material");
  assert.equal(withdrawnReason({ ...ok, language: false, readingReady: false }), "language_unknown");
  assert.equal(withdrawnReason({ ...ok, chineseCopy: false, readingReady: false }), "not_ready");
});
