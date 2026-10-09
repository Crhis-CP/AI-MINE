import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { readSourceDateContext, readCurrentSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";
import { crawlFetch, crawlStep, withSourceCrawl, CrawlDeferred, CrawlBlocked } from "../packages/backend/src/acquisition/crawl.ts";
import { saveRobots } from "../packages/backend/src/acquisition/pacing.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
import type { GuardedResponse } from "../packages/backend/src/lib/http-fetch.ts";
const sql = dbOf("acquisition");
let serial = 0,
  clock = Date.now();
after(closeDb);
async function source(host?: string, lane: "news" | "policy" = "news") {
  const id = `crawl-${++serial}`,
    url = `https://${host ?? `${id}.invalid`}/list`;
  await sql`INSERT INTO sources(id,name,kind,lane,enabled,config) VALUES(${id},${id},'web_list',${lane},true,${sql.json({ url })})`;
  await grantDateFixture(id, [url]);
  return (await readSourceDateContext(id))!;
}
function reply(url: string, body = "page", status = 200, headers: Record<string, string> = {}): GuardedResponse {
  const bytes = Buffer.from(body);
  return { url, status, headers: new Headers({ "content-type": "text/plain", ...headers }), body: bytes, text: () => body };
}
async function drain<T>(run: () => Promise<T>, max = 15) {
  for (let i = 0; i < max; i++) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof CrawlDeferred)) throw error;
      clock = Math.max(clock + 1, error.retryAt.getTime());
    }
  }
  throw new Error("deferred job made no progress");
}

test("news and policy share durable host slots, Crawl-delay and sensitive profile take the greater delay", async () => {
  const a = await source("shared.invalid"),
    b = await source("shared.invalid", "policy"),
    calls: number[] = [];
  await saveRobots("https://shared.invalid", 200, "User-agent: *\nCrawl-delay: 6", new Date(clock), null, null);
  const get = async (url: string) => {
    calls.push(clock);
    return reply(url);
  };
  const run = (s: typeof a) => withSourceCrawl(s, `test:${s.id}`, () => crawlFetch(s.config.url), { now: () => new Date(clock), get });
  await run(a);
  await assert.rejects(run(b), (error) => error instanceof CrawlDeferred && error.retryAt.getTime() === calls[0]! + 6000);
  await drain(() => run(b));
  assert.equal(calls[1]! - calls[0]!, 6000);
  a.config.crawlProfile = { sensitive: true };
  await drain(() => run(a));
  assert.equal(calls[2]! - calls[1]!, 10000);
});

test("robots 503 and Retry-After defer without target requests; cached 404 permits only after host spacing", async () => {
  const a = await source();
  let attempts = 0,
    target = 0;
  const get = async (url: string) => {
    if (url.endsWith("/robots.txt")) return ++attempts === 1 ? reply(url, "", 503, { "retry-after": "120" }) : reply(url, "", 404);
    target++;
    return reply(url);
  };
  const run = () => withSourceCrawl(a, `test:${a.id}`, () => crawlFetch(a.config.url), { now: () => new Date(clock), get });
  const start = clock;
  await assert.rejects(run, (error) => error instanceof CrawlDeferred && error.retryAt.getTime() >= start + 120000);
  assert.equal(target, 0);
  await assert.rejects(run, CrawlDeferred);
  assert.equal(attempts, 1);
  await drain(run);
  assert.equal(attempts, 2);
  assert.equal(target, 1);
});

test("multi-page metadata checkpoints survive deferral without storing unlicensed response bodies", async () => {
  const a = await source(),
    current = (await readCurrentSourcePolicy(a.id))!;
  await saveSourcePolicy(
    a.id,
    {
      policy: { ...current, permission_version: 2, permissions: { ...current.permissions, store_fulltext: "deny" } },
      expectedVersion: 1,
      reason: "Synthetic metadata only",
    },
    "test",
  );
  const calls: string[] = [];
  const get = async (url: string) => {
    calls.push(url);
    return reply(url, url.endsWith("/robots.txt") ? "User-agent: *" : "full body");
  };
  const run = () =>
    withSourceCrawl(
      a,
      `test:${a.id}`,
      async () => {
        const first = await crawlStep("list", a.config.url, async () => {
          await crawlFetch(a.config.url);
          return {
            title: "metadata",
            bodyText: "must not persist",
            sourceDateObservation: { raw: "2020-01-01" },
            publishedAt: new Date("2020-01-01T00:00:00Z"),
          };
        });
        assert.equal((await sql`SELECT count(*)::int n FROM acquisition.crawl_requests WHERE url=${a.config.url} AND body IS NOT NULL`)[0].n, 0);
        await crawlStep("detail", `${a.config.url}/detail`, async () => {
          await crawlFetch(`${a.config.url}/detail`);
          return { title: "detail" };
        });
        return first;
      },
      { get, now: () => new Date(clock) },
    );
  const out = await drain(run);
  assert.equal(out.bodyText, undefined);
  assert.equal(out.sourceDateObservation.raw, "2020-01-01");
  assert.equal(out.publishedAt.toISOString(), "2020-01-01T00:00:00.000Z");
  assert.equal(calls.filter((url) => url === a.config.url).length, 1);
  assert.equal(
    (
      await sql`SELECT count(*)::int n FROM acquisition.crawl_requests r JOIN acquisition.crawl_sessions s ON s.id=r.session_id WHERE s.source_id=${a.id} AND r.url NOT LIKE '%/robots.txt' AND r.body IS NOT NULL`
    )[0].n,
    0,
  );
});

test("robots denials, HTML challenges and cross-host redirects never fall through to another route", async () => {
  const a = await source();
  let target = 0;
  await saveRobots(new URL(a.config.url).origin, 200, "User-agent: *\nDisallow: /list", new Date(clock), null, null);
  await assert.rejects(
    withSourceCrawl(a, `deny:${a.id}`, () => crawlFetch(a.config.url), {
      now: () => new Date(clock),
      get: async (url) => {
        target++;
        return reply(url);
      },
    }),
    /robots_disallowed/,
  );
  assert.equal(target, 0);
  await saveRobots(new URL(a.config.url).origin, 404, "", new Date(clock), null, null);
  const run = (res: (url: string) => GuardedResponse) =>
    withSourceCrawl(a, `challenge:${a.id}`, () => crawlFetch(a.config.url), { now: () => new Date(clock), get: async (url) => res(url) });
  await assert.rejects(
    drain(() => run((url) => reply(url, "verify you are human", 200, { "content-type": "text/html" }))),
    CrawlBlocked,
  );
  await assert.rejects(
    drain(() => run((url) => reply(url, "", 302, { location: "https://other.invalid/" }))),
    /redirect_host_changed/,
  );
});

test("one active request per host, independent hosts progress, and process-root restart keeps the reservation", async () => {
  const a = await source("locked.invalid"),
    b = await source("locked.invalid", "policy"),
    other = await source();
  for (const s of [a, other]) await saveRobots(new URL(s.config.url).origin, 404, "", new Date(clock), null, null);
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>((resolve) => {
      release = resolve;
    }),
    entered = new Promise<void>((resolve) => {
      started = resolve;
    });
  const first = withSourceCrawl(a, `slow:${a.id}`, () => crawlFetch(a.config.url), {
    now: () => new Date(clock),
    get: async (url) => {
      started();
      await pending;
      return reply(url);
    },
  });
  await entered;
  let calls = 0,
    reservation: CrawlDeferred | undefined;
  try {
    await withSourceCrawl(b, `slow:${b.id}`, () => crawlFetch(b.config.url), {
      now: () => new Date(clock),
      get: async (url) => {
        calls++;
        return reply(url);
      },
    });
  } catch (error) {
    assert.ok(error instanceof CrawlDeferred);
    reservation = error;
  }
  assert.equal(calls, 0);
  await withSourceCrawl(other, `other:${other.id}`, () => crawlFetch(other.config.url), { now: () => new Date(clock), get: async (url) => reply(url) });
  release();
  await first;
  const { initializeDb } = await import("@amp/backend/db");
  await closeDb();
  await initializeDb("test");
  assert.ok(reservation?.sessionId);
  clock = reservation.retryAt.getTime();
  await withSourceCrawl(b, `slow:${b.id}`, () => crawlFetch(b.config.url), {
    expectedSessionId: reservation.sessionId,
    now: () => new Date(clock),
    get: async (url) => {
      calls++;
      return reply(url);
    },
  });
  assert.equal(calls, 1);
  await assert.rejects(
    withSourceCrawl(b, `slow:${b.id}`, () => crawlFetch(b.config.url), {
      expectedSessionId: reservation.sessionId,
      now: () => new Date(clock),
      get: async (url) => {
        calls++;
        return reply(url);
      },
    }),
    /session_obsolete/,
  );
  assert.equal(calls, 1);
});

test("official acquisition resumes cached main/annex bytes and retains blocked annex as an explicit incomplete original", async () => {
  const { fixture } = await import("./policy-automation-fixture.ts"),
    f = await fixture();
  const sourceRow = (await readSourceDateContext(f.sourceId))!,
    calls: string[] = [];
  const { capturePolicyMaterial } = await import("../packages/backend/src/policy/capture.ts"),
    { readPolicyOriginal } = await import("../packages/backend/src/policy/originals.ts");
  const get = async (url: string) => {
    calls.push(url);
    if (url.endsWith("/robots.txt")) return reply(url, "", 404);
    if (url === `${f.url}/blocked`) return reply(url, "denied", 403);
    if (url !== f.url) return reply(url, "<article>Annex 10</article>", 200, { "content-type": "text/html" });
    const page = await f.get(url);
    page.body = Buffer.from(
      page.body
        .toString()
        .replace("</html>", `<a class="attachment" href="${f.url}/one">One</a><a class="attachment" href="${f.url}/blocked">Blocked</a></html>`),
    );
    return { ...page, text: () => page.body.toString() };
  };
  const result = await drain(() =>
    withSourceCrawl(sourceRow, `official:${f.sourceId}`, () => capturePolicyMaterial(f.sourceId, f.materialId, crawlFetch), {
      get,
      now: () => new Date(clock),
    }),
  );
  assert.equal(result.status, "captured");
  if (result.status !== "captured") return;
  assert.equal(result.state, "incomplete");
  const { readPolicyMetadataObservation } = await import("../packages/backend/src/policy/metadata.ts");
  const observed = await readPolicyMetadataObservation(result.expressionId);
  assert.ok(observed);
  assert.ok(Date.parse(observed.observedAt) < clock, "cached main page keeps the actual earlier acquisition time");
  assert.equal(calls.filter((url) => url === f.url).length, 1);
  assert.equal(calls.filter((url) => url === `${f.url}/one`).length, 1);
  const original = (await readPolicyOriginal(result.expressionId))!;
  assert.equal(original.resources.length, 3);
  assert.equal(original.resources[2]!.reason, "crawl_http_403");
  assert.equal(original.resources[2]!.body, null);
});

test("a held source's body stays deferred without fetching or consuming an extraction attempt", async () => {
  const a = await source();
  const { upsertMaterial } = await import("@amp/backend/content/materials"),
    { extractArticleBody } = await import("@amp/backend/content/extract");
  const m = await upsertMaterial({
    sourceId: a.id,
    url: `${a.config.url}/article`,
    title: "Synthetic pending body",
    via: "fetch",
    language: "en",
    bodyStatus: "pending",
  });
  await sql`UPDATE sources SET enabled=false WHERE id=${a.id}`;
  await assert.rejects(extractArticleBody(m.articleId), (error) => error instanceof CrawlDeferred && error.reason === "collection_paused");
  assert.equal((await sql`SELECT processing_attempts FROM articles WHERE id=${m.articleId}`)[0].processing_attempts, 0);
});

test("an uncertain source-reader receipt keeps its durable read key across retry and profile changes", async () => {
  const a = await source(),
    origin = new URL(a.config.url).origin;
  await saveRobots(origin, 404, "", new Date(clock), null, null);
  const { crawlExternal, crawlReadKey } = await import("../packages/backend/src/acquisition/crawl.ts"),
    { paidRequest } = await import("@amp/backend/providers/receipts");
  let sends = 0;
  const keys: string[] = [];
  const run = () =>
    withSourceCrawl(
      a,
      `reader:${a.id}`,
      () =>
        crawlExternal(a.config.url, "listing", async () => {
          keys.push(crawlReadKey()!);
          return paidRequest(
            {
              service: "jina",
              model: null,
              purpose: "source_listing",
              subject: `source:${a.id}`,
              identity: { url: a.config.url, day: crawlReadKey()! },
              requestSummary: { url: a.config.url },
            },
            async () => {
              sends++;
              throw new Error("synthetic disconnected outcome");
            },
          );
        }),
      { now: () => new Date(clock) },
    );
  for (let i = 0; i < 3; i++) {
    if (i === 2) a.config.crawlProfile = { sensitive: true };
    try {
      await run();
      assert.fail("unknown receipt cannot become a success");
    } catch (error) {
      assert.ok(error instanceof CrawlDeferred);
      clock = error.retryAt.getTime();
    }
  }
  assert.equal(sends, 1);
  assert.equal(new Set(keys).size, 1);
  assert.equal((await sql`SELECT status FROM receipts WHERE subject=${`source:${a.id}`}`)[0].status, "unknown");
});
