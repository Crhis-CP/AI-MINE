import { scopeVersion, scopeOutput, scopeReceipt } from "./scope-fixture.ts";
// Public scope and sync through the real api routes: a licence revocation or a withdrawal reaches
// every exit, body pictures reach the page and the full feed only as links, reports stop quoting
// withdrawn items, the hot board drops a withdrawn item at once, item pages follow the site's rule, an
// early release keeps the selected ledger in order, a withdrawal waiting behind an unreleased item
// leaves new snapshots at once, and snapshots answer conditional requests.
import { MCP_TOOL_NAMES } from "@amp/contracts/mcp";
import { CATEGORY_LABELS } from "@amp/industry/taxonomy";
import { beijingDate } from "@amp/contracts/time";
import { ogEtag } from "../apps/api/src/og/render.ts";
import { tag, stub } from "./setup.ts";
import { runBodyTranslation } from "../packages/backend/src/editorial/translation-runtime.ts";
import { isChineseOriginal, TRANSLATION_MANIFEST_FORMAT } from "../packages/backend/src/editorial/translation-readiness.ts";
import { promptVersion, promptText } from "@amp/backend/editorial/prompts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { overrideFields, setVisibility } from "@amp/backend/admin/content";
import { updateSource } from "@amp/backend/admin/sources";
import { upsertMaterial } from "@amp/backend/content/materials";
import { stopBoss } from "@amp/backend/jobs/queue";
import { itemUrl } from "@amp/backend/publication/links";
import { publishArticle, republishSource } from "@amp/backend/publication/publish";
import { computeHotRanking } from "@amp/backend/events/hot";
import { latestHotRanking } from "@amp/backend/events/hot-read";
import { effectiveWatermark } from "@amp/backend/publication/v1";
import { SITE } from "@amp/industry/site";
import { buildApp } from "../apps/api/src/app.ts";

const sql = dbOf("publication");

const T = tag();
const SOURCE = `test-publication-${T}`;
const BODY = `FULLTEXT-${T} `.repeat(40);
const REPORT_KEY = `2099-12-${String(10 + Math.floor(Math.random() * 19))}`;
const provider = await stub((_hit, req) => {
  const { text } = JSON.parse(JSON.parse(req.body).messages[1].content) as { text: string };
  const translated =
    text === "Original heading"
      ? "译文标题"
      : text === "Original full body"
        ? "中文完整正文"
        : `${[...text.matchAll(/⟦\d+⟧/g)].map((m) => m[0]).join(" ")} 合成中文 FULLTEXT-${T}`;
  return { choices: [{ message: { content: JSON.stringify({ text: translated }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "synthetic-publication-fixture";
async function translateFixture(id: string) {
  const version = promptVersion("translate-body");
  const result = await runBodyTranslation(id, {
    id: `${TRANSLATION_MANIFEST_FORMAT}:${version}`,
    model: "deepseek-flash",
    promptVersion: version,
    system: promptText("translate-body"),
  });
  assert.equal(result.status, "translated");
}
const app = await buildApp("public-api");

before(async () => {
  // An interrupted earlier run may have left entries behind the release gate, holding the watermark.
  await sql`UPDATE selected_ledger SET visible_at = now() WHERE visible_at > now()`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${SOURCE}, 'Test publication', 'rss', 'T1', 'editorial', true, true, '2100-01-01')`;
});
after(async () => {
  await sql`DELETE FROM reports WHERE kind = 'daily' AND key = ${REPORT_KEY}`;
  await app.close();
  await provider.close();
  await stopBoss();
  await closeDb();
});

let n = 0;
/** A selected article with full text and a summary. */
async function article(body = BODY, language?: string, sourceId = SOURCE): Promise<string> {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId,
    url: `https://example.com/${T}-${n}`,
    title: `Test ${n}`,
    bodyText: body,
    bodyHtml: `<p>${body}</p>`,
    language: language ?? "en",
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected, prompt_version, receipt_ids, output)
            VALUES (${articleId}, 1, 'rule', 'pass', 'company_project', ${`标题${n}-${T}`}, ${`合成摘要 SUMMARY-${n}-${T}`}, '理由', 90, true, ${scopeVersion}, ${[await scopeReceipt(articleId)]}, ${sql.json(scopeOutput)})`;
  const [source] = await sql`SELECT site_fulltext FROM sources WHERE id=${sourceId}`;
  if (source?.site_fulltext && body && !isChineseOriginal(language ?? null, body)) await translateFixture(articleId);
  return articleId;
}

async function storyFor(id: string, role: "report" | "mention" = "report"): Promise<string> {
  const publicId = randomUUID();
  const [story] = await sql<{ id: number }[]>`
    INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${publicId}, ${`STORY-${T}`}, now(), now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`
    INSERT INTO facts (public_id, story_id, title) VALUES (${`fact-${publicId}`}, ${story!.id}, ${`FACT-${T}`}) RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${id}, ${role})`;
  return publicId;
}

const released = () => ({ releasedAt: new Date(Date.now() - 60_000) });
async function get(url: string, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: "GET", url, headers });
  return { status: res.statusCode, body: res.body, etag: res.headers.etag as string | undefined };
}

test("site reading sends one language per page, and the original page goes with a withdrawal", async () => {
  const id = await article();
  await sql`UPDATE articles SET language = 'en', body_html = '<h2>Original heading</h2><p>Original full body</p>' WHERE id = ${id}`;
  await translateFixture(id);
  await publishArticle(id, released());
  const normal = JSON.parse((await get(`/api/site/items/${id}`)).body);
  const original = JSON.parse((await get(`/api/site/items/${id}/original`)).body);
  assert.equal(normal.bodyLanguage, "zh");
  assert.equal(normal.hasTranslation, true);
  assert.equal(normal.body.original, null);
  assert.ok(normal.body.zh.includes("中文完整正文"));
  assert.equal(normal.outline[0].text, "译文标题");
  assert.equal(original.bodyLanguage, "original");
  assert.equal(original.body.zh, null);
  assert.ok(original.body.original.includes("Original full body"));
  assert.equal(original.outline[0].text, "Original heading");
  await setVisibility(id, { visibility: "withdrawn", reason: "test", version: 0 }, "test");
  assert.equal((await get(`/api/site/items/${id}/original`)).status, 404);
});

test("body pictures reach the item page and the full feed only as links, and the image proxy is closed", async () => {
  const id = await article();
  const picture = `https://example.com/${T}.png?a=1&amp;b=2`;
  const mark = `https://example.com/${T}-mark.png`;
  const html = `<h2><img src="${mark}" alt="mark"> Results</h2><p>${BODY}</p><p><img src="${picture}" alt="Shipments by quarter" width="800" height="400"></p><video src="https://example.com/${T}.mp4" poster="https://example.com/${T}.jpg"></video>`;
  await sql`UPDATE articles SET language = 'en', body_html = ${html} WHERE id = ${id}`;
  await translateFixture(id);
  await publishArticle(id, released());
  const detail = JSON.parse((await get(`/api/site/items/${id}/original`)).body);
  const page = detail.body.original as string;
  // A picture in a heading becomes a link there but does not name the heading in the outline.
  assert.equal(detail.outline[0].text, "Results");
  assert.ok(page.includes(`<h2 id="sec-1"><a href="${mark}" target="_blank" rel="noopener noreferrer">查看配图：mark</a> Results</h2>`), page);
  const feed = (await get("/feed/full.xml")).body.split("<item>").find((item) => item.includes(id));
  for (const body of [page, feed]) {
    assert.ok(body?.includes(`<a href="${picture}" target="_blank" rel="noopener noreferrer">查看配图：Shipments by quarter</a>`), body);
    assert.doesNotMatch(body!, /<img|img-proxy|poster=/);
  }
  // The proxy itself is closed: the api does not serve it.
  assert.equal((await get(`/api/img-proxy?u=${encodeURIComponent(`https://example.com/${T}.png`)}&mode=full`)).status, 404);
});

test("revoking a source's licence takes its articles off every exit", async () => {
  const id = await article();
  await publishArticle(id, released());
  const story = await storyFor(id);
  assert.equal((await get(`/api/site/items/${id}`)).status, 200);
  assert.equal((await get(`/api/site/stories/${story}`)).status, 200);
  assert.ok((await get("/feed/full.xml")).body.includes(`FULLTEXT-${T}`), "full feed carries the body before");
  assert.ok((await get("/api/v1/items?mode=selected")).body.includes(id), "v1 lists the item before");

  const [source] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM sources WHERE id = ${SOURCE}`;
  const patch = { participation_mode: "isolated", site_fulltext: false, syndicate_fulltext: false };
  await updateSource(SOURCE, { patch, version: source!.updated_at.toISOString(), reason: "test" }, "test");
  const [queued] = await sql<{ value: { status: string } }[]>`SELECT value FROM settings WHERE key = ${`republish.source:${SOURCE}`}`;
  assert.equal(queued?.value.status, "queued", "the admin change queues a background republish");

  const result = await republishSource(SOURCE); // what the queued job runs
  assert.ok(result.reduced >= 1);
  assert.equal((await get(`/api/site/items/${id}`)).status, 404);
  assert.equal((await get(`/api/site/stories/${story}`)).status, 404, "the story drops an isolated source's last report");
  assert.equal((await get(`/api/v1/stories/${story}`)).status, 404);
  assert.ok(!(await get("/feed/full.xml")).body.includes(`FULLTEXT-${T}`), "full feed drops the body");
  assert.ok(!(await get("/api/v1/items?mode=selected")).body.includes(id), "v1 drops the item");

  await sql`UPDATE sources SET participation_mode = 'editorial', site_fulltext = true, syndicate_fulltext = true WHERE id = ${SOURCE}`;
});

test("a withdrawn item leaves every report exit", async () => {
  const id = await article();
  await publishArticle(id, released());
  const content = {
    sections: [
      {
        label: "模型",
        items: [{ itemId: id, title: `LEAD-${T}`, summary: `QUOTED-${T}`, sourceUrl: `https://example.com/original-${T}`, sourceName: "Test" }],
      },
    ],
    flashes: [],
  };
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
            VALUES ('daily', ${REPORT_KEY}, now() - interval '1 day', now(), ${sql.json(content as never)}, now(), 'manual')
            ON CONFLICT (kind, key) DO UPDATE SET content = EXCLUDED.content`;
  assert.ok((await get(`/api/v1/dailies/${REPORT_KEY}`)).body.includes(`QUOTED-${T}`), "the report quotes the item before");

  await setVisibility(id, { visibility: "withdrawn", reason: "test", version: 0 }, "test");
  for (const url of [`/api/v1/dailies/${REPORT_KEY}`, `/api/site/reports/daily/${REPORT_KEY}`]) {
    const res = await get(url);
    assert.equal(res.status, 200, url);
    assert.ok(!res.body.includes(`QUOTED-${T}`) && !res.body.includes(`original-${T}`), `${url} still quotes the withdrawn item`);
  }
  for (const url of ["/api/v1/dailies"]) {
    const res = await get(url);
    assert.ok(res.body.includes(REPORT_KEY), `${url} lists the report`);
    assert.ok(!res.body.includes(`LEAD-${T}`), `${url} headlines the withdrawn title`);
  }
});

test("a withdrawal takes down only the stories citing it, including secondary memberships", async () => {
  const id = await article();
  await publishArticle(id, released());
  const stories = [await storyFor(id), await storyFor(id, "mention")];
  const other = await article();
  await publishArticle(other, released());
  const unrelated = await storyFor(other);
  for (const story of stories) {
    assert.ok((await get(`/api/site/stories/${story}`)).body.includes(id));
    assert.ok((await get(`/api/v1/stories/${story}`)).body.includes(id));
  }

  await setVisibility(id, { visibility: "withdrawn", reason: "test", version: 0 }, "test");
  for (const story of stories) {
    assert.equal((await get(`/api/site/stories/${story}`)).status, 404);
    assert.equal((await get(`/api/v1/stories/${story}`)).status, 404);
  }
  assert.equal((await get(`/api/site/stories/${unrelated}`)).status, 200);
});

test("a withdrawn item leaves the hot board and the hot APIs at once, not at the next ranking", async () => {
  const [story] = await sql<{ id: number }[]>`
    INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${`HOT-${T}`}, now() - interval '2 hours', now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`fact-${T}`}, ${story!.id}, ${`HOT-${T}`}) RETURNING id`;
  for (const id of [await article(), await article()]) {
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${id}, 'report')`;
    await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
              VALUES (${story!.id}, ${id}, ${`participant-${id}`}, ${SOURCE}, 'editorial', now() - interval '1 hour')`;
    await publishArticle(id, released());
  }
  await computeHotRanking();
  const rep = (await latestHotRanking())!.entries.find((e) => e.storyId === story!.id)?.representativeItemId;
  assert.ok(rep, "the story is on the board with a representative item");
  const exits = ["/api/v1/hot-topics", "/api/site/hot"];
  for (const url of exits) assert.ok((await get(url)).body.includes(rep!), `${url} shows the item before`);
  const mcp = await app.inject({
    method: "POST",
    url: "/api/mcp",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: MCP_TOOL_NAMES.hot, arguments: { limit: 10 } } },
  });
  assert.ok(mcp.body.includes(`${SITE.name}：${itemUrl(rep!)}`), "MCP hot topics link each event's representative item on the site");

  await setVisibility(rep!, { visibility: "withdrawn", reason: "test", version: 0 }, "test");
  for (const url of exits) assert.ok(!(await get(url)).body.includes(rep!), `${url} still shows the withdrawn item`);
});

test("items without an identified language or Chinese copy, and hot_signal items, have no public page", async () => {
  const SIGNAL = `${SOURCE}-signal`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${SIGNAL}, 'Test signal', 'rss', 'T1', 'hot_signal', true, false, '2100-01-01')`;
  const material = (sourceId: string, name: string) =>
    upsertMaterial({
      sourceId,
      url: `https://example.com/${T}-${name}`,
      title: `${name} ${T}`,
      bodyText: BODY,
      bodyHtml: `<p>${BODY}</p>`,
      bodyStatus: "ok",
      via: "fetch",
      publishedAt: new Date(),
    });
  // An editorial item the model never summarised, and a hot_signal item carrying an imported summary.
  const { articleId: plain } = await material(SOURCE, "plain");
  await publishArticle(plain);
  const { articleId: signal } = await material(SIGNAL, "signal");
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${signal}, 1, 'replay', 'pass', 'industry', ${`信号-${T}`}, ${`SIGNAL-SUMMARY-${T}`}, 80, false)`;
  await publishArticle(signal);

  const page = await get(`/api/site/items/${plain}`);
  assert.equal(page.status, 404, "an item with no identified language or Chinese copy cannot gain a detail page");
  assert.equal((await get(`/api/site/items/${signal}`)).status, 404, "hot_signal material has no page");

  const publicId = randomUUID();
  const [story] = await sql<
    { id: number }[]
  >`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${publicId}, ${`事件-${T}`}, now(), now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`f-${T}`}, ${story!.id}, ${`事实-${T}`}) RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${plain}, 'report'), (${fact!.id}, ${signal}, 'report')`;
  const storyPage = await get(`/api/site/stories/${publicId}`);
  assert.equal(storyPage.status, 404, "an event with no publishable reports cannot expose the material");
  assert.ok(!storyPage.body.includes(signal) && !storyPage.body.includes(`SIGNAL-SUMMARY-${T}`), "and not the hot_signal one");
});

test("one item's failure does not stop a source republish; a passing failure is tried once more", async () => {
  const source = `${SOURCE}-republish`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${source}, 'Test republish', 'rss', 'T1', 'editorial', true, true, '2100-01-01')`;
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push(await article(BODY, undefined, source));
  for (const id of ids) await publishArticle(id, released());
  ids.sort(); // the order republishSource walks
  const visibility = async () =>
    (await sql<{ visibility: string }[]>`SELECT visibility FROM publications WHERE source_id = ${source} ORDER BY article_id`).map((r) => r.visibility);
  assert.deepEqual(await visibility(), ["public", "public", "public"]);
  const trigger = `test_republish_failure_${T}`;
  const counter = `${trigger}_calls`;
  // The first item fails every time; the second only on its first try (a sequence is not rolled back).
  await sql.unsafe(`CREATE SEQUENCE ${counter};
    CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
      IF NEW.article_id = '${ids[0]}' THEN RAISE EXCEPTION 'synthetic publication failure'; END IF;
      IF NEW.article_id = '${ids[1]}' THEN
        IF nextval('${counter}') = 1 THEN RAISE EXCEPTION 'synthetic passing failure'; END IF;
      END IF;
      RETURN NEW;
    END$$;
    CREATE TRIGGER ${trigger} BEFORE INSERT ON publications FOR EACH ROW
      WHEN (NEW.article_id IN ('${ids[0]}', '${ids[1]}')) EXECUTE FUNCTION ${trigger}();`);
  try {
    // Isolating the source changes every item's projection.
    await sql`UPDATE sources SET participation_mode = 'isolated' WHERE id = ${source}`;
    const result = await republishSource(source);
    assert.deepEqual([result.total, result.changed, result.failed, result.failedIds], [3, 2, 1, [ids[0]]]);
    assert.deepEqual(await visibility(), ["public", "withdrawn", "withdrawn"], "the failing item keeps its stored projection; the rest are re-derived");
  } finally {
    await sql.unsafe(`DROP TRIGGER IF EXISTS ${trigger} ON publications; DROP FUNCTION IF EXISTS ${trigger}(); DROP SEQUENCE IF EXISTS ${counter}`);
  }
});

test("an early release keeps the selected ledger in order", async () => {
  const x = await article();
  await publishArticle(x, released());
  const y = await article();
  await publishArticle(y); // still behind the release gate
  await setVisibility(x, { visibility: "withdrawn", reason: "test", version: 0 }, "test");
  await sql`UPDATE articles SET grouped_at = now() WHERE id = ${y}`;
  await publishArticle(y); // grouped: released now

  const [entry] = await sql<{ seq: number }[]>`SELECT max(seq)::int AS seq FROM selected_ledger WHERE article_id = ${y}`;
  assert.ok((await effectiveWatermark()) >= entry!.seq, "the sync watermark covers the released item");
  const snapshot = await get("/api/v1/selected/snapshot?fields=minimal&limit=1000");
  assert.ok(snapshot.body.includes(y), "released item is in the snapshot");
  assert.ok(!snapshot.body.includes(x), "withdrawn item is not");
});

test("a withdrawal waiting behind an unreleased item leaves new snapshots at once, and changes still carry both", async () => {
  const x = await article();
  await publishArticle(x, released());
  const y = await article();
  await publishArticle(y); // behind the release gate: the watermark stays before it
  await setVisibility(x, { visibility: "withdrawn", reason: "test", version: 0 }, "test");

  for (const url of ["/api/v1/selected/snapshot?fields=minimal&limit=1000"]) {
    const body = (await get(url)).body;
    assert.ok(!body.includes(x), `${url} still lists the withdrawn item`);
    assert.ok(!body.includes(y), `${url} lists an item before its release`);
  }
  // A client that saved this snapshot's watermark receives y and x's removal once y is released.
  const snapshot = JSON.parse((await get("/api/v1/selected/snapshot?fields=minimal&limit=1000")).body) as { cursor: string };
  await sql`UPDATE articles SET grouped_at = now() WHERE id = ${y}`;
  await publishArticle(y);
  const changes = JSON.parse((await get(`/api/v1/selected/changes?cursor=${encodeURIComponent(snapshot.cursor)}&limit=100`)).body) as {
    changes: Array<{ op: string; id?: string; item?: { id: string } }>;
  };
  const ours = changes.changes.map((c) => `${c.op}:${c.id ?? c.item?.id}`).filter((c) => c.endsWith(x) || c.endsWith(y));
  assert.deepEqual(ours, [`upsert:${y}`, `remove:${x}`]);
});

test("snapshots answer 304 to their own ETag", async () => {
  for (const url of ["/api/v1/selected/snapshot?fields=minimal&limit=1000"]) {
    const first = await get(url);
    assert.ok(first.etag, `${url} has an ETag`);
    assert.equal((await get(url, { "if-none-match": first.etag! })).status, 304, url);
  }
});

test("v1 story retains website content and fallback ordering without the website-only heat reads", async () => {
  const first = await article();
  const second = await article();
  await publishArticle(first, released());
  await publishArticle(second, released());
  const publicId = await storyFor(first);
  const [story] = await sql<{ id: number }[]>`SELECT id FROM stories WHERE public_id = ${publicId}`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title)
    VALUES (${`v1-development-${T}`}, ${story!.id}, 'Latest development fallback') RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${second}, 'report')`;
  await sql`UPDATE publications SET published_at = now() - interval '1 hour' WHERE article_id = ${first}`;
  await sql`UPDATE stories SET first_report_at = NULL, latest_at = NULL WHERE id = ${story!.id}`;
  const site = JSON.parse((await get(`/api/site/stories/${publicId}`)).body);
  const v1 = JSON.parse((await get(`/api/v1/stories/${publicId}`)).body).story;
  assert.deepEqual(
    {
      publicId: v1.publicId,
      title: v1.title,
      sourceCount: v1.sourceCount,
      reportCount: v1.reportCount,
      firstReportAt: v1.firstReportAt,
      latestAt: v1.latestAt,
      digest: v1.digest,
      digestUpdatedAt: v1.digestUpdatedAt,
    },
    {
      publicId: site.publicId,
      title: site.title,
      sourceCount: site.sourceCount,
      reportCount: site.reportCount,
      firstReportAt: site.firstReportAt,
      latestAt: site.latestAt,
      digest: site.digest,
      digestUpdatedAt: site.digestUpdatedAt,
    },
  );
  assert.equal(v1.latest, "Latest development fallback");
  assert.deepEqual(
    v1.reports,
    site.timeline.slice(0, 50).map((r: any) => ({
      id: r.id,
      title: r.title,
      summary: r.summary,
      source: { name: r.source.name, firstParty: r.source.firstParty },
      publishedAt: r.publishedAt,
      links: { original: r.originalUrl },
    })),
  );
  await sql`UPDATE publications SET visible_after = now() + interval '1 day' WHERE article_id = ${second}`;
  const gated = JSON.parse((await get(`/api/v1/stories/${publicId}`)).body).story;
  assert.deepEqual(
    gated.reports.map((r: any) => r.id),
    [first],
  );
  assert.equal(gated.latest, `FACT-${T}`);
});

test("unchanged republishing preserves freshness, while URL-only changes still reach the projection and ledger", async () => {
  const id = await article();
  await publishArticle(id, released());
  const state = async () => (await sql`SELECT xmin::text AS row_version, updated_at, revision, url FROM publications WHERE article_id = ${id}`)[0]!;
  const before = await state();
  const [ledger] = await sql`SELECT max(seq) AS seq FROM selected_ledger WHERE article_id = ${id}`;
  const unchanged = await publishArticle(id);
  assert.equal(unchanged!.changed, false);
  assert.equal(unchanged!.ledger, null);
  assert.deepEqual({ ...(await state()) }, { ...before }, "no new tuple or freshness timestamp for identical content");
  assert.equal((await sql`SELECT max(seq) AS seq FROM selected_ledger WHERE article_id = ${id}`)[0]!.seq, ledger!.seq);

  const url = `https://example.com/${T}-corrected`;
  await sql`UPDATE articles SET url = ${url} WHERE id = ${id}`;
  // The prefilter sees the source URL too; this fixture records successful evidence for that input.
  await sql`UPDATE analyses SET receipt_ids = ${[await scopeReceipt(id)]} WHERE article_id = ${id}`;
  const result = await publishArticle(id);
  assert.equal(result!.changed, false, "URL is deliberately outside the presentation fingerprint");
  assert.equal(result!.ledger, "upsert", "the public URL change is still recorded for sync clients");
  const changed = await state();
  assert.equal(changed.url, url);
  assert.notEqual(changed.row_version, before.row_version);
  assert.ok(changed.updated_at >= before.updated_at);
  assert.equal(changed.revision, before.revision);
});

test("share images keep detail metadata and access rules while conditional reads avoid body hydration", async () => {
  const id = await article();
  await publishArticle(id, released());
  const d = JSON.parse((await get(`/api/site/items/${id}`)).body);
  const kicker = d.category ? CATEGORY_LABELS[d.category as keyof typeof CATEGORY_LABELS] : "AI 动态";
  const source = d.source.name.replace(/（[^）]*）\s*$/, "");
  const date = beijingDate(d.timelineAt);
  const card = {
    kicker,
    title: d.title,
    subtitle: d.summary,
    meta: `${source} · ${date}`,
  };
  const paths = [[`/og/items/${id}.png`, `"og-${ogEtag(card)}"`]];
  const queries: string[] = [];
  const previous = sql.options.debug;
  sql.options.debug = (_connection, query) => {
    queries.push(query);
  };
  try {
    for (const [path, etag] of paths) {
      const response = await get(path!, { "if-none-match": etag! });
      assert.equal(response.status, 304);
      assert.equal(response.etag, etag);
    }
    assert.equal(queries.length, 1);
    assert.ok(
      queries.every((q) => !/body_html|body_text|translations|fact_articles/.test(q)),
      "cards only load their public metadata",
    );
  } finally {
    sql.options.debug = previous;
  }
  await sql`UPDATE publications SET visibility = 'summary-only' WHERE article_id = ${id}`;
  assert.equal((await get(paths[0]![0]!, { "if-none-match": paths[0]![1]! })).status, 304, "summary-only pages keep the same allowed share summary");
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${id}`;
  for (const [path, etag] of paths) assert.equal((await get(path!, { "if-none-match": etag! })).status, 404, "cached ETags never bypass current visibility");
});

test("minimal sync projection preserves snapshot fields, pagination bindings and ordered changes", async () => {
  const id = await article();
  await publishArticle(id, released());
  await publishArticle(await article(), released());
  const full = JSON.parse((await get("/api/v1/selected/snapshot?fields=default&limit=1000")).body);
  const minimal = JSON.parse((await get("/api/v1/selected/snapshot?fields=minimal&limit=1000")).body);
  const project = (i: any) => ({
    id: i.id,
    title: i.title,
    source: i.source,
    publishedAt: i.publishedAt,
    discoveredAt: i.discoveredAt,
    category: i.category,
    score: i.score,
    selected: i.selected,
  });
  assert.deepEqual(minimal.items, full.items.map(project));
  assert.ok(minimal.items.some((i: any) => i.id === id));
  for (const fields of ["default", "minimal"]) {
    const first = JSON.parse((await get(`/api/v1/selected/snapshot?limit=1${fields === "minimal" ? "&fields=minimal" : ""}`)).body);
    assert.ok(first.nextPage);
    const response = await get(`/api/v1/selected/snapshot?limit=1000&page=${encodeURIComponent(first.nextPage)}`);
    assert.equal(response.status, 200, "continuations inherit the projection from the page token");
    const next = JSON.parse(response.body);
    assert.equal(next.fields, fields);
    assert.equal(next.cursor, first.cursor);
    assert.equal(next.asOf, first.asOf);
    assert.equal(next.hasMore, false);
    assert.deepEqual([...first.items, ...next.items], fields === "minimal" ? minimal.items : full.items);
  }
  const firstPage = JSON.parse((await get("/api/v1/selected/snapshot?fields=minimal&limit=1")).body);
  assert.ok(firstPage.nextPage);
  assert.equal(
    (await get(`/api/v1/selected/snapshot?fields=default&page=${encodeURIComponent(firstPage.nextPage)}`)).status,
    400,
    "page tokens stay bound to the requested projection",
  );
  await sql`UPDATE analyses SET title_zh = '更新标题 Updated sync title', summary_zh = ${"长摘要 large summary ".repeat(200)} WHERE article_id = ${id}`;
  await publishArticle(id, released());
  const getChanges = async (cursor: string) => {
    const response = await get(`/api/v1/selected/changes?cursor=${encodeURIComponent(cursor)}&limit=100`);
    assert.equal(response.status, 200, response.body);
    return JSON.parse(response.body);
  };
  const fullChanges = await getChanges(full.cursor);
  const minimalChanges = await getChanges(minimal.cursor);
  assert.deepEqual(
    minimalChanges.changes,
    fullChanges.changes.map((c: any) => (c.op === "upsert" ? { ...c, item: project(c.item) } : c)),
  );
  assert.equal(minimalChanges.changes.find((c: any) => c.item?.id === id)?.item.title, "更新标题 Updated sync title");
  await setVisibility(id, { visibility: "withdrawn", reason: "sync test", version: 0 }, "test");
  const removed = await getChanges(minimalChanges.cursor);
  assert.ok(removed.changes.some((c: any) => c.op === "remove" && c.id === id));
});

test("site-only source excerpts stay out of machine summaries and historical sync payloads", async () => {
  await sql`UPDATE sources SET syndicate_fulltext = false WHERE id = ${SOURCE}`;
  const cursor = JSON.parse((await get("/api/v1/selected/snapshot?limit=1000")).body).cursor;
  const id = await article();
  const story = await storyFor(id);
  await publishArticle(id, released());
  const excerpt = `SOURCE-EXCERPT-${T}：铜矿项目原始短文。`.repeat(4);
  await sql`UPDATE publications SET summary = NULL, source_excerpt = ${excerpt} WHERE article_id = ${id}`;
  const [fact] = await sql`SELECT f.public_id FROM facts f JOIN stories s ON s.id=f.story_id WHERE s.public_id=${story}`;
  for (const url of [
    `/api/site/items/${id}`,
    "/api/site/timeline",
    "/api/site/pool",
    `/api/site/groups/${fact!.public_id}/reports`,
    `/api/site/stories/${story}`,
  ]) {
    const r = await get(url);
    assert.equal(r.status, 200, url);
    assert.ok(r.body.includes(excerpt), url);
  }
  const machine = [
    "/api/v1/items?mode=all",
    `/api/v1/stories/${story}`,
    "/feed/all.xml",
    "/feed.xml",
    "/feed/full.xml",
    "/api/v1/selected/snapshot?limit=1000",
    `/api/v1/selected/changes?cursor=${encodeURIComponent(cursor)}&limit=100`,
  ];
  for (const url of machine) {
    const r = await get(url);
    assert.equal(r.status, 200, url);
    assert.ok(r.body.includes(id), "the item remains available: " + url);
    assert.ok(!r.body.includes("SOURCE-EXCERPT"), url);
  }
  const item = JSON.parse((await get("/api/v1/items?mode=all")).body).items.find((r: { id: string }) => r.id === id);
  assert.equal(item.summary, null, "the existing nullable field stays present");
  for (const [name, args] of [
    [MCP_TOOL_NAMES.latest, { mode: "all", window: "24h" }],
    [MCP_TOOL_NAMES.story, { public_id: story }],
  ] as const) {
    const r = await app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    });
    assert.equal(r.statusCode, 200);
    assert.ok(r.body.includes(id) && !r.body.includes("SOURCE-EXCERPT"));
  }
  await sql`UPDATE sources SET site_fulltext = false WHERE id = ${SOURCE}`;
  assert.equal(JSON.parse((await get(`/api/site/items/${id}`)).body).summary, null, "source excerpt obeys the current site permission");
  await sql`UPDATE sources SET site_fulltext = true, syndicate_fulltext = true WHERE id = ${SOURCE}`;
});

test("summary-only never falls back to source text after clearing a manual introduction", async () => {
  for (const size of [150, 1800]) {
    const body = "铜矿项目建设公告，列明产量、许可和原始条件。".repeat(90).slice(0, size);
    const id = await article(body, "zh");
    await sql`UPDATE analyses SET summary_zh = NULL WHERE article_id = ${id}`;
    await publishArticle(id, released());
    // The preparation stage has no automatic writer yet; install its explicit read-model fixture.
    // In the activated pipeline publishArticle also derives this field from the confirmed source.
    await sql`UPDATE publications SET source_excerpt = ${`来源摘录：${body.slice(0, 400)}`} WHERE article_id = ${id}`;
    const manual = `人工导读 ${size} ${T}`;
    await overrideFields(id, { fields: { summary: manual }, reason: "fixture introduction", version: 0 }, "test");
    await overrideFields(id, { fields: {}, clear: ["summary"], reason: "fixture clear", version: 1 }, "test");
    const before = JSON.parse((await get(`/api/site/items/${id}`)).body);
    assert.ok(before.summary.includes(body.slice(0, 80)), "public reading retains its permitted source excerpt");
    await setVisibility(id, { visibility: "summary-only", reason: "fixture limitation", version: 2 }, "test");
    const limited = await get(`/api/site/items/${id}`);
    assert.equal(limited.status, 200);
    const detail = JSON.parse(limited.body);
    assert.deepEqual([detail.readingMode, detail.body, detail.summary], ["summary-only", null, null], `source length ${size}`);
    assert.ok(!limited.body.includes(body.slice(0, 80)), "source text does not escape through metadata");
    await overrideFields(id, { fields: { summary: manual }, reason: "fixture authored summary", version: 3 }, "test");
    const authored = JSON.parse((await get(`/api/site/items/${id}`)).body);
    assert.deepEqual([authored.readingMode, authored.body, authored.summary], ["summary-only", null, manual]);
  }
});
