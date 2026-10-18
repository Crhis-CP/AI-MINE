import { installUsageFixtureForService } from "./usage-protection-fixture.ts";
// Every rule a source's config names is applied, and a name the collector does not implement fails the
// fetch. Configs that carried adapters and detail rules a collector does not implement used to fall
// back silently (junk titles, RSS entries outside the source's URL rules, dates from the wrong place).
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@amp/backend/config";
import { closeDb, sql } from "@amp/backend/db";
import { stopBoss, type getBoss, QUEUES } from "@amp/backend/jobs/queue";
import { extractArticleBody, readable } from "@amp/backend/content/extract";
import { collectSource } from "./crawl-fixture.ts";
import { withSourceCrawl, CrawlDeferred } from "../packages/backend/src/acquisition/crawl.ts";
import { saveRobots } from "../packages/backend/src/acquisition/pacing.ts";
import { registerExtractionJobs } from "@amp/backend/jobs/content";
import { readSourceDateContext, updateSource } from "@amp/backend/admin/sources";
import { grantDateFixture } from "./source-date-fixture.ts";

const T = tag();
const LONG = `${"A card label that swallowed the summary of the article it links to, ".repeat(2)}${T}`;
let jinaDetailReads = 0;
let jinaListingReads = 0;
const pageReads = new Map<string, number>();
const ARTICLE_BODY = "A complete article with enough material to preserve the same extraction result without downloading it twice. ".repeat(6);
const html = (head: string, body: string) => `<html><head>${head}</head><body>${body}</body></html>`;
const pages: Record<string, (base: string) => string> = {
  "/feed.xml": () =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>` +
    ["news/a", "business/b"]
      .map((p) => `<item><title>Entry ${p} ${T}</title><link>https://example.org/rules-${T}/${p}</link><pubDate>${new Date().toUTCString()}</pubDate></item>`)
      .join("") +
    `</channel></rss>`,
  "/list.html": () =>
    html("", `<ul><li><a href="/p/a-${T}">Short clean title ${T}</a><time>2026-09-20</time></li><li><a href="/p/b-${T}">${LONG}</a></li></ul>`),
  [`/p/a-${T}`]: () =>
    html(
      `<meta name="description" content="Summary of A"><meta property="article:published_time" content="2026-01-01T00:00:00Z">`,
      `<h1>Detail heading A</h1><p class="byline"><time datetime="2026-09-21T08:00:00Z">Sep 21</time></p>`,
    ),
  [`/p/b-${T}`]: () =>
    html(
      `<meta name="description" content="Summary of B"><meta property="article:published_time" content="2026-01-01T00:00:00Z">`,
      `<article><h1>Detail heading B ${T}</h1><p>${ARTICLE_BODY}</p></article>`,
    ),
  [`/j/1-${T}`]: () => html(`<meta property="article:published_time" content="2026-09-27T01:00:00Z">`, "<p>one</p>"),
  [`/j/2-${T}`]: () => html(`<meta property="article:published_time" content="2026-09-27T02:00:00Z">`, "<p>two</p>"),
};
// Jina Reader: GET /<target URL> answers the rendering, with its header lines.
const jina = (base: string, target: string) => {
  const md = target.endsWith(`/jlist-${T}`)
    ? `[Short Jina title ${T}](${base}/j/1-${T})\n\n[${LONG}](${base}/j/2-${T})`
    : `# Heading from Jina ${T}\n\nThe article.`;
  if (target.endsWith(`/jlist-${T}`)) jinaListingReads += 1;
  else jinaDetailReads += 1;
  return `Title: Page\nURL Source: ${target}\nPublished Time: 2026-09-27T00:00:00Z\nMarkdown Content:\n${md}`;
};
const server = http.createServer((req, res) => {
  const path = req.url ?? "";
  pageReads.set(path, (pageReads.get(path) ?? 0) + 1);
  const body = path.startsWith("/http") ? jina(base, path.slice(1)) : Object.hasOwn(pages, path) ? pages[path]!(base) : null;
  res.writeHead(body === null ? 404 : 200, { "content-type": path.endsWith(".xml") ? "application/rss+xml" : "text/html; charset=utf-8" });
  res.end(body ?? "");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
process.env.JINA_BASE_URL = base;
process.env.JINA_API_KEY = "test-key";

const SOURCES = {
  unsupported: { kind: "rss", config: { feedUrl: `${base}/feed.xml`, adapter: "feed_cards" } },
  denied: { kind: "rss", config: { feedUrl: `${base}/feed.xml`, denyUrlPrefixes: [`https://example.org/rules-${T}/business/`] } },
  detail: {
    kind: "web_list",
    config: {
      url: `${base}/list.html`,
      parseMode: "html",
      itemSelector: "li",
      linkSelector: "a",
      titleSelector: "a",
      publishedAtSelector: "time",
      detail: {
        maxFetches: 10,
        titleSelector: "h1",
        summarySelector: 'meta[name="description"]',
        publishedAtAuthoritative: true,
        publishedAtSelector: ".byline time",
      },
    },
  },
  jina: {
    kind: "web_list",
    config: {
      url: `https://r.jina.ai/${base}/jlist-${T}`,
      parseMode: "markdown",
      allowUrlPrefixes: [`${base}/j/`],
      detail: { maxFetches: 5, titleRegex: "^# (.+)$" },
    },
  },
};
const id = (name: keyof typeof SOURCES) => `test-rules-${name}-${T}`;
let savedJina: Array<{ per_minute: number; per_hour: number; per_day: number }> = [];
before(async () => {
  await installUsageFixtureForService("jina");
  savedJina = await sql`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'jina'`;
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service = 'jina'`;
  const cursor = sql.json({ initializedAt: new Date().toISOString() });
  for (const [name, s] of Object.entries(SOURCES)) {
    await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
              VALUES (${id(name as keyof typeof SOURCES)}, ${name}, ${s.kind}, ${sql.json(s.config)}, 'T1', 'editorial', ${cursor}, '2100-01-01')`;
    await grantDateFixture(id(name as keyof typeof SOURCES), [base, "https://example.org"]);
  }
});
after(async () => {
  for (const b of savedJina)
    await sql`UPDATE budgets SET per_minute = ${b.per_minute}, per_hour = ${b.per_hour}, per_day = ${b.per_day} WHERE service = 'jina'`;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

const articles = (sourceId: string) =>
  sql<{ url: string; title: string; excerpt: string | null; published_at: Date | null; revision: number }[]>`
    SELECT url, title, excerpt, published_at, revision FROM articles WHERE source_id = ${sourceId} ORDER BY url`;

test("a config entry the collector does not implement fails the fetch instead of being ignored", async () => {
  const run = await collectSource(id("unsupported"), { force: true });
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /unsupported config: adapter/);
  assert.equal((await articles(id("unsupported"))).length, 0, "nothing collected by a fallback parse");
  const [row] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM sources WHERE id = ${id("denied")}`;
  await assert.rejects(
    updateSource(id("denied"), { patch: { config: { ...SOURCES.denied.config, detail: { titleFoo: "h1" } } }, version: row!.updated_at.toISOString() }, "test"),
    /不支持的配置项：detail\.titleFoo/,
    "the admin refuses it before it is saved",
  );
});

test("feed entries outside the source's URL rules are skipped", async () => {
  assert.equal((await collectSource(id("denied"), { force: true })).status, "ok");
  assert.deepEqual(
    (await articles(id("denied"))).map((a) => a.url),
    [`https://example.org/rules-${T}/news/a`],
  );
});

test("detail rules fill what the listing lacks, and a detail title survives the next listing", async () => {
  for (let run = 0; run < 2; run++) assert.equal((await collectSource(id("detail"), { force: true })).status, "ok");
  const [a, b] = await articles(id("detail"));
  assert.deepEqual(
    [a!.title, a!.excerpt, a!.published_at?.toISOString(), a!.revision],
    [`Short clean title ${T}`, "Summary of A", undefined, 1],
    "a clean listing title stays; contradictory publication metadata leaves the source date pending",
  );
  assert.deepEqual(
    [b!.title, b!.excerpt, b!.published_at?.toISOString(), b!.revision],
    [`Detail heading B ${T}`, "Summary of B", "2026-01-01T00:00:00.000Z", 1],
    "a label that swallowed its summary takes the page's heading; explicit head publication metadata remains evidence without a byline; the listing does not revise it back",
  );
});

test("a Jina listing is read on every fetch, and buys a detail rendering only where a regex rule needs it", async () => {
  assert.equal((await collectSource(id("jina"), { force: true })).status, "ok");
  const rows = await articles(id("jina"));
  assert.deepEqual(
    rows.map((r) => [r.title, r.published_at?.toISOString()]),
    [
      [`Short Jina title ${T}`, "2026-09-27T01:00:00.000Z"],
      [`Heading from Jina ${T}`, "2026-09-27T02:00:00.000Z"],
    ],
    "the title regex reads Jina's text; dates come from the pages' own HTML",
  );
  assert.equal(jinaDetailReads, 1, "one paid detail rendering: only the long title needed one");
  assert.equal((await collectSource(id("jina"), { force: true })).status, "ok");
  assert.deepEqual([jinaListingReads, jinaDetailReads], [2, 1], "every fetch reads the listing afresh; known articles buy no detail");
});

test("detail HTML supplies the ordinary extracted body once, while short pages keep extraction pending", async () => {
  const rows = await sql<{ id: string; url: string; body_html: string | null; body_text: string | null; body_status: string }[]>`
    SELECT id, url, body_html, body_text, body_status FROM articles WHERE source_id = ${id("detail")} ORDER BY url`;
  const [short, full] = rows;
  assert.equal(short!.body_status, "pending", "an unconfirmed body retains the original extraction fallback");
  const expected = readable(pages[`/p/b-${T}`]!(base), `${base}/p/b-${T}`)!;
  assert.deepEqual([full!.body_html, full!.body_text, full!.body_status], [expected.html, expected.text, "ok"]);
  assert.equal(await extractArticleBody(full!.id, false), "skipped");
  assert.equal(pageReads.get(`/p/b-${T}`), 1, "known listings and extraction never download the same confirmed body again");
});

test("extracting the same body text preserves revision and still schedules its first analysis", async () => {
  const [body] = await sql`SELECT id,revision FROM articles WHERE source_id=${id("detail")} AND url=${`${base}/p/b-${T}`}`;
  assert.ok(body);
  await sql`UPDATE articles SET body_status='pending',body_html=NULL,processing_state='new',language='en' WHERE id=${body.id}`;
  await sql`DELETE FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=${body.id}`;
  let handle!: (jobs: { data: { articleId: string; lane: "news" } }[]) => Promise<{ state: string; retryAt?: string }>;
  await registerExtractionJobs({
    work: async (name: string, _options: unknown, run: typeof handle) => {
      if (name === QUEUES.extractBody) handle = run;
    },
  } as unknown as Awaited<ReturnType<typeof getBoss>>);
  const source = (await readSourceDateContext(id("detail")))!;
  let clock = Date.now() + 2 * 86400000;
  await saveRobots(base, 404, "", new Date(clock), null, null);
  let result: { state: string; retryAt?: string } | undefined;
  for (let n = 0; n < 10; n++) {
    try {
      result = await withSourceCrawl(source, `same-body:${body.id}`, () => handle([{ data: { articleId: body.id, lane: "news" } }]), {
        now: () => new Date(clock),
      });
    } catch (error) {
      if (!(error instanceof CrawlDeferred)) throw error;
      clock = error.retryAt.getTime() + 1;
      continue;
    }
    if (result.state !== "deferred") break;
    clock = Date.parse(result.retryAt!) + 1;
  }
  assert.equal(result?.state, "ok");
  const [stored] = await sql`SELECT revision,body_status FROM articles WHERE id=${body.id}`;
  assert.equal(stored.revision, body.revision);
  assert.equal(stored.body_status, "ok");
  assert.equal((await sql`SELECT id FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=${body.id} AND state='created'`).length, 1);
});

test("an unprovable presentation keeps its prior body while later feed entries still import", async () => {
  const sourceId = `presentation-${T}`,
    articleUrl = `${base}/presentation-old`,
    published = new Date().toUTCString();
  let target = "old",
    extra = false;
  pages["/presentation.xml"] = () => `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Presentation fixture</title>
    <item><title>Representation ${T}</title><link>${articleUrl}</link><pubDate>${published}</pubDate><content:encoded><![CDATA[<p>Mining <a href="${base}/${target}">report</a> ${ARTICLE_BODY}</p>]]></content:encoded></item>
    ${extra ? `<item><title>New entry ${T}</title><link>${base}/presentation-new</link><pubDate>${published}</pubDate><content:encoded><![CDATA[<p>${ARTICLE_BODY}</p>]]></content:encoded></item>` : ""}</channel></rss>`;
  await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode,cursor) VALUES(${sourceId},'Presentation fixture','rss',${sql.json({ feedUrl: base + "/presentation.xml" })},'T1','editorial',${sql.json({ initializedAt: new Date().toISOString() })})`;
  await grantDateFixture(sourceId, [base]);
  assert.equal((await collectSource(sourceId, { force: true })).created, 1);
  const [prior] = await sql`SELECT id,revision,body_html FROM articles WHERE source_id=${sourceId} AND url=${articleUrl}`;
  await sql`INSERT INTO translations(article_id,lang,revision,complete,origin,body_html) VALUES(${prior.id},'zh',${prior.revision},false,'model','<p>尚无可核对记录的旧译文</p>')`;
  target = "new";
  extra = true;
  const result = await collectSource(sourceId, { force: true });
  assert.equal(result.status, "ok");
  assert.equal(result.created, 1);
  const [run] = await sql`SELECT detail FROM fetch_runs WHERE source_id=${sourceId} ORDER BY started_at DESC,id DESC LIMIT 1`;
  assert.equal(run.detail.presentationFailureCount, 1);
  assert.equal(run.detail.presentationFailures[0].url, articleUrl);
  assert.equal((await sql`SELECT body_html FROM articles WHERE id=${prior.id}`)[0].body_html, prior.body_html);
});
