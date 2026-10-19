import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { readSourceDateContext } from "@amp/backend/admin/sources";
import { crawlFetch, withSourceCrawl, CrawlDeferred, CrawlBlocked } from "../packages/backend/src/acquisition/crawl.ts";
import type { GuardedResponse } from "../packages/backend/src/lib/http-fetch.ts";
import { grantDateFixture } from "./source-date-fixture.ts";

after(closeDb);
let serial = 0;
const initialTime = Date.parse("2030-01-15T12:00:00Z");
function reply(url: string, status: number, body = "", headers: Record<string, string> = {}): GuardedResponse {
  return { url, status, headers: new Headers({ "content-type": "text/plain", ...headers }), body: Buffer.from(body), text: () => body };
}
async function fixture(minimumIntervalSeconds = 2) {
  const id = `robots-recovery-${++serial}`,
    url = `https://${id}.invalid/article`;
  await sql`INSERT INTO sources(id,name,kind,lane,enabled,config) VALUES(${id},${id},'web_list','news',true,${sql.json({ url, crawlProfile: { minimumIntervalSeconds } })})`;
  await grantDateFixture(id, [url]);
  const source = (await readSourceDateContext(id))!;
  let clock = initialTime;
  const run = (get: (url: string) => Promise<GuardedResponse>, work = () => crawlFetch(url)) =>
    withSourceCrawl(source, `robots-recovery:${id}`, work, { get, now: () => new Date(clock) });
  return {
    id,
    url,
    run,
    now: () => clock,
    advance: (at: number) => {
      clock = Math.max(clock + 1, at);
    },
  };
}
async function deferred(run: () => Promise<unknown>, reason: string) {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof CrawlDeferred);
    assert.equal(error.reason, reason);
    return error;
  }
  assert.fail(`Expected ${reason}`);
}
async function resume(f: Awaited<ReturnType<typeof fixture>>, run: () => Promise<GuardedResponse>, max = 12) {
  for (let n = 0; n < max; n++) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof CrawlDeferred)) throw error;
      assert.ok(error.retryAt.getTime() > f.now(), "a resumed robots check must not reuse an already expired retry time");
      f.advance(error.retryAt.getTime());
    }
  }
  assert.fail("Robots recovery did not finish");
}

for (const failure of [
  { status: 500, body: "temporarily unavailable" },
  { status: 502, body: "bad gateway" },
  { status: 504, body: "gateway timeout" },
  { status: 200, body: "<!doctype html><html><body>temporarily unavailable</body></html>" },
]) {
  test(`robots ${failure.status} ${failure.status === 200 ? "HTML" : "failure"} is fetched again after retry expiry in the same session`, async () => {
    const f = await fixture();
    let robotsRequests = 0,
      contentRequests = 0;
    const get = async (url: string) => {
      if (url.endsWith("/robots.txt")) return ++robotsRequests === 1 ? reply(url, failure.status, failure.body) : reply(url, 404);
      contentRequests++;
      return reply(url, 200, "Recovered article");
    };
    const run = () => f.run(get),
      first = await deferred(run, "robots_unavailable");
    assert.equal(first.retryAt.getTime(), initialTime + 300_000);
    assert.equal(contentRequests, 0);
    await deferred(run, "robots_unavailable");
    assert.equal(robotsRequests, 1, "the negative observation still delays requests before its expiry");
    f.advance(first.retryAt.getTime());
    const page = await resume(f, run);
    assert.equal(page.text(), "Recovered article");
    assert.equal(robotsRequests, 2);
    assert.equal(contentRequests, 1);
    assert.equal(page.fetchedAt, new Date(f.now()).toISOString());
  });
}

test("repeated robots HTTP failures reuse one reservation and move the retry deadline forward", async () => {
  const f = await fixture();
  let requests = 0;
  const run = () =>
    f.run(async (url) => {
      assert.ok(url.endsWith("/robots.txt"));
      requests++;
      return reply(url, 502, "temporarily unavailable");
    });
  for (let n = 0; n < 3; n++) {
    const error = await deferred(run, "robots_unavailable");
    assert.equal(error.retryAt.getTime(), f.now() + 300_000);
    assert.equal(requests, n + 1);
    f.advance(error.retryAt.getTime());
  }
  const [count] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM acquisition.crawl_requests r
    JOIN acquisition.crawl_sessions s ON s.id=r.session_id WHERE s.source_id=${f.id}`;
  assert.equal(count!.n, 1, "retry expiry must not create a new reservation on every failure");
});

test("robots recovery keeps new redirect checkpoints across a host delay longer than the failure cache", async () => {
  const f = await fixture(360),
    redirected = new URL("/robots-policy", f.url).toString(),
    calls: string[] = [];
  let observations = 0;
  const get = async (url: string) => {
    calls.push(url);
    if (url.endsWith("/robots.txt")) return reply(url, 302, "", { location: redirected });
    if (url === redirected) return reply(url, ++observations === 1 ? 502 : 404);
    return reply(url, 200, "Recovered after paced redirect");
  };
  const page = await resume(f, () => f.run(get));
  assert.equal(page.text(), "Recovered after paced redirect");
  assert.equal(calls.filter((url) => url.endsWith("/robots.txt")).length, 2);
  assert.equal(calls.filter((url) => url === redirected).length, 2);
  assert.equal(calls.filter((url) => url === f.url).length, 1);
});

const boundaries: { name: string; status: number; body: string; headers: Record<string, string>; code: string }[] = [
  { name: "disallow", status: 200, body: "User-agent: *\nDisallow: /article", headers: {}, code: "robots_disallowed" },
  { name: "challenge", status: 200, body: "<html><title>Just a moment</title></html>", headers: { "content-type": "text/html" }, code: "crawl_challenge" },
  { name: "cross-host redirect", status: 302, body: "", headers: { location: "https://other.invalid/robots.txt" }, code: "robots_redirect_not_approved" },
];
for (const boundary of boundaries) {
  test(`fresh robots recovery still refuses ${boundary.name} before content is requested`, async () => {
    const f = await fixture();
    let requests = 0;
    const run = () =>
      f.run(async (url) => {
        assert.ok(url.endsWith("/robots.txt"));
        return ++requests === 1 ? reply(url, 502) : reply(url, boundary.status, boundary.body, boundary.headers);
      });
    f.advance((await deferred(run, "robots_unavailable")).retryAt.getTime());
    await assert.rejects(run, (error) => error instanceof CrawlBlocked && error.code === boundary.code);
    assert.equal(requests, 2);
  });
}

test("a fresh robots 403 remains unavailable and never fetches content", async () => {
  const f = await fixture();
  let requests = 0;
  const run = () =>
    f.run(async (url) => {
      assert.ok(url.endsWith("/robots.txt"));
      return reply(url, ++requests === 1 ? 502 : 403);
    });
  f.advance((await deferred(run, "robots_unavailable")).retryAt.getTime());
  const again = await deferred(run, "robots_unavailable");
  assert.equal(requests, 2);
  assert.equal(again.retryAt.getTime(), f.now() + 300_000);
});
