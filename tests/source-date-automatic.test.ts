import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { closeDb, dbOf } from "@amp/backend/db";
import { saveSourcePolicy, readSourceDateContext, updateSource } from "@amp/backend/admin/sources";
import { sourceDateConfigHash } from "@amp/backend/sources/config-keys";
import { upsertMaterial, updateMaterialSourceDate } from "@amp/backend/content/materials";
import type { SourceDateObservationInput } from "@amp/contracts/time-assertion";
import { sourcePolicyExample } from "./permission-fixture.ts";
import { collectSource } from "@amp/backend/sources/collect";
import { config } from "@amp/backend/config";
import { stopBoss } from "@amp/backend/jobs/queue";
import { fetchDetail } from "@amp/backend/sources/web-list";
import { fetchRss } from "@amp/backend/sources/rss";

const sql = dbOf("content");
after(async () => {
  await stopBoss();
  await closeDb();
});
async function source(sourceConfig: Record<string, unknown> = {}, kind = "rss", scope = sourcePolicyExample.scope) {
  const id = `date-${tag()}`;
  await sql`INSERT INTO sources (id, name, kind, enabled, config) VALUES (${id}, 'Synthetic date source', ${kind}, true, ${sql.json(sourceConfig as never)})`;
  const policy = { ...structuredClone(sourcePolicyExample), source_id: id };
  policy.scope = scope;
  policy.evidence = policy.evidence.map((item) => ({ ...item, scope }));
  await saveSourcePolicy(id, { expectedVersion: null, policy, reason: "Synthetic fixture" }, "test");
  return { id, policy };
}
function observed(sourceId: string, raw: string, version: number) {
  const observation: SourceDateObservationInput = {
    sourceId,
    configHash: sourceDateConfigHash("rss", {}),
    observationId: tag(),
    observedAt: new Date().toISOString(),
    url: `https://source.invalid/mining/${sourceId}`,
    locator: "rss.channel.item[0].pubDate",
    excerpt: `<pubDate>${raw}</pubDate>`,
    origin: "source",
    format: "unknown",
    formatPattern: null,
    language: null,
    publicationBasis: "source_published",
    timezoneEvidence: null,
    raw,
    meaning: "published",
    basis: "rss pubDate field",
    condition_text: null,
    timezone: null,
  };
  return { sourceDateObservation: observation, expectedSourceDateVersion: version, permissionVersion: 1 };
}
const material = (id: string) => ({
  sourceId: id,
  url: `https://source.invalid/mining/${id}`,
  title: "合成铜矿新闻",
  bodyText: "来源完整原文不因补充日期而产生修订。",
  via: "fetch" as const,
});

test("HTML acquisition retains conflicting dates, keeps the configured primary precision, and rejects unrelated JSON-LD", async (t) => {
  let page = "";
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const scope = { hosts: ["127.0.0.1"], path_prefixes: ["/"], document_types: [], excluded_content: [] };
  const { id } = await source({ url: `${base}/list`, detail: { publishedAtSelector: ".pub", publishedAtAuthoritative: true } }, "web_list", scope);
  const current = (await readSourceDateContext(id))!;
  const old = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  t.after(() => {
    config.allowPrivateNetworkFetch = old;
  });
  const raw = " 2026-10-01 ",
    makePage = (meta: string) =>
      `<html><head><meta property="article:published_time" content="${meta}"></head><body><time class="pub">${raw}</time></body></html>`;
  const read = () => fetchDetail(`${base}/article`, current, { date: true, title: false, summary: false });
  page = makePage("2026-10-02T12:00Z");
  const first = await read();
  const m = { ...material(id), url: `${base}/article` };
  const conflict = await upsertMaterial({ ...m, sourceDateObservation: first.sourceDateObservation!, expectedSourceDateVersion: 0, permissionVersion: 1 });
  const stored = async () =>
    (
      await sql`SELECT a.source_date_state, a.source_date_error, o.result, o.observation FROM articles a
    JOIN content.source_date_observations o ON o.id=a.source_date_observation_id WHERE a.id=${conflict.articleId}`
    )[0]!;
  assert.equal((await stored()).source_date_error, "conflicting_candidates");
  assert.equal((await stored()).observation.alternatives[0].raw, "2026-10-02T12:00Z");
  page = makePage("2026-10-01T12:00Z");
  const second = await read();
  const agreed = await upsertMaterial({ ...m, sourceDateObservation: second.sourceDateObservation!, expectedSourceDateVersion: 1, permissionVersion: 1 });
  assert.deepEqual([agreed.revised, agreed.sourceTimeChanged, (await stored()).source_date_state], [false, true, "reliable"]);
  assert.deepEqual([(await stored()).result.evidence.time.raw, (await stored()).result.evidence.time.utc], [raw, null]);
  page = makePage("2026-10-01T13:00");
  const unknownZone = await read();
  await upsertMaterial({ ...m, sourceDateObservation: unknownZone.sourceDateObservation!, expectedSourceDateVersion: 2, permissionVersion: 1 });
  assert.equal((await stored()).source_date_error, "conflicting_candidates", "unknown wall-clock differences cannot be guessed away");
  const noRule = { ...current, config: { url: `${base}/list` } };
  page = `<time datetime="2026-10-01"></time><script type="application/ld+json">{"@type":"NewsArticle","url":"${base}/related","datePublished":"2026-10-01"}</script>`;
  const unrelated = await fetchDetail(`${base}/article`, noRule, { date: true, title: false, summary: false });
  assert.equal(unrelated.sourceDateObservation!.raw, "");
  page = page.replace(`${base}/related`, `${base}/article`);
  const identified = await fetchDetail(`${base}/article`, noRule, { date: true, title: false, summary: false });
  assert.equal(identified.sourceDateObservation!.raw, "2026-10-01");
  const section = await fetchDetail(
    `${base}/article#section`,
    { ...noRule, config: { ...noRule.config, preserveUrlFragment: true } },
    { date: true, title: false, summary: false },
  );
  assert.equal(section.sourceDateObservation!.raw, "", "a whole-page date cannot stand in for a separately identified section");
  page = `<html><head></head><body><aside itemscope itemtype="https://schema.org/NewsArticle" itemid="${base}/other"><time itemprop="datePublished" datetime="2026-10-01">related</time></aside></body></html>`;
  const sidebar = await fetchDetail(`${base}/article`, noRule, { date: true, title: false, summary: false });
  assert.equal(sidebar.sourceDateObservation!.raw, "", "another microdata article's date does not belong to this page");
  page = page.replace(`${base}/other`, `${base}/article`);
  const ownScope = await fetchDetail(`${base}/article`, noRule, { date: true, title: false, summary: false });
  assert.equal(ownScope.sourceDateObservation!.raw, "2026-10-01");
  assert.match(ownScope.sourceDateObservation!.locator, /itemscope:/);
});

test("RDF dc:date is retained as unproved evidence until an explicit source declaration establishes its meaning", async (t) => {
  const raw = " 2026-10-01 ";
  let base = "";
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(
      req.url === "/atom"
        ? `<feed><entry><title>合成更新日期</title><link href="${base}/updated"/><updated>2026-10-01T12:00Z</updated></entry></feed>`
        : `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"><item><title>合成铜矿日期</title><link>${base}/article</link><dc:date>${raw}</dc:date></item></rdf:RDF>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const scope = { hosts: ["127.0.0.1"], path_prefixes: ["/"], document_types: [], excluded_content: [] };
  const { id } = await source({ feedUrl: `${base}/rdf` }, "rss", scope);
  const old = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  t.after(() => {
    config.allowPrivateNetworkFetch = old;
  });
  const candidate = (await fetchRss((await readSourceDateContext(id))!)).candidates[0]!;
  assert.equal(candidate.sourceDateObservation!.raw, raw);
  assert.match(candidate.sourceDateObservation!.locator, /dc:date$/);
  assert.equal(candidate.sourceDateObservation!.publicationBasis, "other");
  assert.equal(candidate.publishedAt, null);
  assert.equal((await collectSource(id)).created, 1);
  const state = async () =>
    (
      await sql`SELECT a.source_date_state, a.source_date_error, o.observation FROM articles a
    JOIN content.source_date_observations o ON o.id=a.source_date_observation_id WHERE a.source_id=${id}`
    )[0]!;
  assert.deepEqual(
    [(await state()).source_date_state, (await state()).source_date_error, (await state()).observation.raw],
    ["pending", "not_source_publication", raw],
  );
  const [row] = await sql`SELECT updated_at FROM sources WHERE id=${id}`;
  await updateSource(
    id,
    {
      version: row!.updated_at.toISOString(),
      patch: {
        config: {
          feedUrl: `${base}/rdf`,
          publishedAtField: "dc:date",
          sourceDate: { meaning: "published", publicationBasis: "source_published", basis: "合成源规范声明：dc:date为本稿首次发布日期" },
        },
      },
    },
    "test",
  );
  assert.equal((await collectSource(id)).status, "ok");
  assert.equal((await state()).source_date_state, "reliable");
  const atom = await fetchRss({ ...(await readSourceDateContext(id))!, config: { feedUrl: `${base}/atom` } });
  assert.equal(atom.candidates[0]!.sourceDateObservation!.raw, "");
  assert.equal(atom.candidates[0]!.publishedAt, null, "Atom updated remains separate from publication");
});

test("real material transaction adds date-only evidence without changing the body revision or fabricating a clock", async () => {
  const { id } = await source(),
    m = material(id);
  const first = await upsertMaterial({ ...m, ...observed(id, "", 0) });
  assert.deepEqual([first.revision, first.sourceDateVersion, first.sourceTimeChanged], [1, 1, false]);
  const input = observed(id, "  2026-10-01  ", 1);
  const dated = await upsertMaterial({ ...m, ...input });
  assert.deepEqual([dated.created, dated.revised, dated.revision, dated.sourceDateVersion, dated.sourceTimeChanged], [false, false, 1, 2, true]);
  const [stored] = await sql`SELECT a.published_at, a.source_date_state, o.result FROM articles a
    JOIN content.source_date_observations o ON o.id=a.source_date_observation_id WHERE a.id=${first.articleId}`;
  assert.equal(stored!.published_at, null);
  assert.equal(stored!.source_date_state, "reliable");
  assert.deepEqual(
    [stored!.result.evidence.time.raw, stored!.result.evidence.time.local_date, stored!.result.evidence.time.utc],
    ["  2026-10-01  ", "2026-10-01", null],
  );
  const repeated = await upsertMaterial({ ...m, ...observed(id, "  2026-10-01  ", 2) });
  assert.deepEqual([repeated.metadataChanged, repeated.sourceTimeChanged, repeated.sourceDateVersion], [false, false, 2]);
  const omitted = await upsertMaterial(m);
  assert.deepEqual([omitted.sourceDateOutcome, omitted.sourceDateVersion], ["unchanged", 2]);
  const changed = await upsertMaterial({ ...m, bodyText: `${m.bodyText}真实正文修订。` });
  assert.deepEqual([changed.revision, changed.sourceDateVersion], [2, 2]);
  assert.equal((await updateMaterialSourceDate(first.articleId, 1, observed(id, "2026-10-02", 2))).sourceDateOutcome, "stale");
});

test("current evidence uses CAS and live source identity/permission; rejected observations do not advance metadata", async () => {
  const { id, policy } = await source(),
    m = material(id);
  const first = await upsertMaterial(m);
  const results = await Promise.all(["2026-09-01", "2026-09-02"].map((raw) => updateMaterialSourceDate(first.articleId, 1, observed(id, raw, 0))));
  assert.deepEqual(results.map((r) => r.sourceDateOutcome).sort(), ["applied", "stale"]);
  const bad = observed(id, "2026-09-03", 1);
  bad.sourceDateObservation.configHash = "0".repeat(64);
  await assert.rejects(updateMaterialSourceDate(first.articleId, 1, bad), /configuration/);
  const outside = observed(id, "2026-09-03", 1);
  outside.sourceDateObservation.url = "https://other.invalid/mining/item";
  await assert.rejects(updateMaterialSourceDate(first.articleId, 1, outside), /permission denied/);
  await sql`UPDATE sources SET enabled=false WHERE id=${id}`;
  await assert.rejects(updateMaterialSourceDate(first.articleId, 1, observed(id, "2026-09-03", 1)), /configuration/);
  await sql`UPDATE sources SET enabled=true WHERE id=${id}`;
  await saveSourcePolicy(
    id,
    { expectedVersion: 1, policy: { ...policy, permissions: { ...policy.permissions, store_metadata: "deny" } }, reason: "Synthetic revocation" },
    "test",
  );
  await assert.rejects(updateMaterialSourceDate(first.articleId, 1, observed(id, "2026-09-03", 1)), /version changed/);
  await assert.rejects(updateMaterialSourceDate(first.articleId, 1, { ...observed(id, "2026-09-03", 1), permissionVersion: 2 }), /permission denied/);
  const [row] = await sql`SELECT source_date_version FROM articles WHERE id=${first.articleId}`;
  assert.equal(Number(row!.source_date_version), 1);
  const [count] = await sql`SELECT count(*) FROM content.source_date_observations WHERE article_id=${first.articleId}`;
  assert.equal(Number(count!.count), 2, "both authorized observations remain immutable, but only one became current");
});

test("RSS intake preserves its raw source date and supplements an unchanged body through the real collector", async (t) => {
  let date = "",
    hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end(
      `<rss><channel><item><title>合成铜矿新闻</title><link>${base}/mining/item</link><pubDate>${date}</pubDate><description>${"完整来源正文。".repeat(70)}</description></item></channel></rss>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    id = `rss-date-${tag()}`;
  const sourceConfig = { feedUrl: `${base}/feed`, summaryIsBody: true, language: "zh" };
  await sql`INSERT INTO sources (id, name, kind, enabled, config, cursor) VALUES
    (${id}, 'Synthetic local feed', 'rss', true, ${sql.json(sourceConfig)}, ${sql.json({ initializedAt: new Date().toISOString() })})`;
  const scope = { hosts: ["127.0.0.1"], path_prefixes: ["/"], document_types: [], excluded_content: [] };
  const policy = structuredClone(sourcePolicyExample);
  policy.source_id = id;
  policy.scope = scope;
  policy.evidence = policy.evidence.map((e) => ({ ...e, scope }));
  await saveSourcePolicy(id, { expectedVersion: null, policy, reason: "Synthetic local server" }, "test");
  const old = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  t.after(() => {
    config.allowPrivateNetworkFetch = old;
  });
  const state = async () =>
    (
      await sql`SELECT a.revision, a.body_status, a.source_date_version, a.source_date_state,
    a.published_at, a.processing_queued_at, o.result FROM articles a JOIN content.source_date_observations o
    ON o.id=a.source_date_observation_id WHERE a.source_id=${id}`
    )[0]!;
  assert.equal((await collectSource(id)).created, 1);
  assert.deepEqual([(await state()).source_date_state, (await state()).body_status], ["pending", "ok"]);
  date = "  2026-10-01  ";
  assert.deepEqual((({ status, created, revised }) => ({ status, created, revised }))(await collectSource(id)), { status: "ok", created: 0, revised: 0 });
  const dated = await state();
  assert.ok(dated.processing_queued_at instanceof Date, "the declared Chinese material actually entered the processing queue");
  assert.deepEqual([dated.revision, Number(dated.source_date_version), dated.published_at, dated.result.evidence.time.raw], [1, 2, null, date]);
  assert.equal((await collectSource(id)).status, "ok");
  const repeated = await state();
  assert.equal(Number(repeated.source_date_version), 2);
  assert.equal(repeated.processing_queued_at.getTime(), dated.processing_queued_at.getTime(), "identical source facts do not enqueue paid analysis again");
  assert.equal(hits, 3);
});

test("JSON intake preserves numeric source spelling before IEEE rounding and checks permission before requests", async (t) => {
  let hits = 0;
  const decimal = `${Date.parse("2026-10-01T12:00:00Z") / 1000}.123456`;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(`{"items":[{"id":"a","title":"铜矿数据一","day":${decimal}},{"id":"b","title":"铜矿数据二","day":1.79e9}]}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sourceConfig = {
    url: `${base}/data`,
    itemsPath: "items",
    titlePaths: ["title"],
    urlTemplate: `${base}/mining/{id}`,
    publishedAtPath: "day",
    publishedAtUnit: "epoch_s",
  };
  const scope = { hosts: ["127.0.0.1"], path_prefixes: ["/"], document_types: [], excluded_content: [] };
  const { id, policy } = await source(sourceConfig, "json_list", scope);
  const old = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  t.after(() => {
    config.allowPrivateNetworkFetch = old;
  });
  assert.equal((await collectSource(id)).created, 2);
  const rows = await sql`SELECT a.source_date_state, a.source_date_error, o.result FROM articles a JOIN content.source_date_observations o
    ON o.id=a.source_date_observation_id WHERE a.source_id=${id} ORDER BY a.url`;
  assert.equal(rows[0]!.result.evidence.time.raw, decimal);
  assert.match(rows[0]!.result.evidence.time.utc, /12:00:00\.1234560*Z$/);
  assert.deepEqual([rows[1]!.result.evidence.time.raw, rows[1]!.source_date_state, rows[1]!.source_date_error], ["1.79e9", "pending", "unrecognized_format"]);
  await saveSourcePolicy(
    id,
    { expectedVersion: 1, policy: { ...policy, permissions: { ...policy.permissions, fetch: "deny" } }, reason: "Synthetic withdrawal" },
    "test",
  );
  const rejected = await collectSource(id);
  assert.equal(rejected.status, "failed");
  assert.match(rejected.error!, /collection denied: fetch/);
  assert.equal(hits, 1, "no request after the permission was revoked");
});
