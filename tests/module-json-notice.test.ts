import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { sql, closeDb } from "@amp/backend/db";
import { sendJsonWithEtag, weakEtag } from "@amp/backend/http";
import { installModules, serverModules } from "@amp/backend/modules";
import { stopBoss } from "@amp/backend/jobs/queue";
import { composeDaily } from "@amp/backend/reports/compose";
import { buildApp } from "./site-app.ts";
import { historyMaterial } from "./report-history-fixture.ts";

const helper = Fastify({ logger: false }),
  shared = { value: 1, notice: "原有正文说明" };
let generated = 0;
for (const stable of [false, true])
  helper.get(stable ? "/stable" : "/plain", (req, reply) => {
    const tag = req.headers["x-notice"];
    return sendJsonWithEtag(req, reply, stable ? { ...shared, generated: generated++ } : shared, {
      etagPrefix: "fixture",
      cacheControl: "public, max-age=60",
      ...(stable ? { etagOf: shared } : {}),
      notice: tag ? { notice: { tag }, private: tag !== "public" } : null,
    });
  });
const app = await buildApp("public-api"),
  original = serverModules();
for (const [path, body, notice] of [
  ["/invalid-array", [], { notice: {} }],
  ["/invalid-date", new Date(0), { notice: {} }],
  ["/invalid-notice", shared, { notice: [] }],
  ["/invalid-serialized", shared, { notice: { toJSON: () => "not an object" } }],
  ["/invalid-private", shared, { notice: {}, private: "public" }],
] as const)
  helper.get(path, (req, reply) =>
    sendJsonWithEtag(req, reply, body, {
      etagPrefix: "invalid",
      cacheControl: "public, max-age=60",
      notice: notice as never,
    }),
  );
let calls = 0;
installModules([
  ...original,
  {
    name: "fixture-json-notice",
    notices: {
      json: (req) => {
        calls++;
        const tag = req.headers["x-notice"];
        if (tag === "fail") throw Error("private-fixture-secret");
        return tag ? { notice: { tag }, private: true } : null;
      },
    },
  },
]);
after(async () => {
  installModules(original);
  await helper.close();
  await app.close();
  await stopBoss();
  await closeDb();
});

test("JSON reminders preserve document notice and shared bodies, including etagOf and private cache policy", async () => {
  const plain = await helper.inject("/plain");
  assert.deepEqual(plain.json(), shared);
  assert.equal(plain.headers.etag, weakEtag("fixture", JSON.stringify(shared)));
  for (const url of ["/plain", "/stable"]) {
    const a = await helper.inject({ url, headers: { "x-notice": "a" } });
    assert.deepEqual(a.json().module_notice, { tag: "a" });
    assert.equal(a.json().notice, shared.notice);
    assert.equal(a.headers["cache-control"], "private, no-store");
    const b = await helper.inject({ url, headers: { "x-notice": "b", "if-none-match": String(a.headers.etag) } });
    assert.equal(b.statusCode, 200);
    assert.notEqual(b.headers.etag, a.headers.etag);
    const same = await helper.inject({ url, headers: { "x-notice": "b", "if-none-match": String(b.headers.etag) } });
    assert.equal(same.statusCode, 304);
    assert.equal(same.body, "");
    assert.equal(same.headers["cache-control"], "private, no-store");
    const publicNotice = await helper.inject({ url, headers: { "x-notice": "public" } });
    assert.equal(publicNotice.headers["cache-control"], "public, max-age=60");
    const none = await helper.inject(url);
    assert.equal(Object.hasOwn(none.json(), "module_notice"), false);
    assert.equal(none.headers.etag, plain.headers.etag);
  }
  assert.equal(Object.hasOwn(shared, "module_notice"), false);
});

test("invalid reminder shapes, privacy flags and non-object responses fail instead of silently dropping data", async () => {
  for (const path of ["/invalid-array", "/invalid-date", "/invalid-notice", "/invalid-serialized", "/invalid-private"])
    assert.equal((await helper.inject(path)).statusCode, 500, path);
});

test("declared v1 and v3 success exits carry request reminders without model calls or site/freshness changes", async () => {
  const article = await historyMaterial("2020-03-01", "合成矿山建设"),
    story = randomUUID();
  const [s] = await sql`INSERT INTO stories(public_id,title) VALUES(${story},'合成矿山故事') RETURNING id`;
  const [f] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${randomUUID()},${s.id},'合成矿山建设') RETURNING id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id) VALUES(${f.id},${article})`;
  await sql`UPDATE publications SET fact_id=${f.id},story_id=${s.id} WHERE article_id=${article}`;
  await composeDaily("2020-03-02");
  const snapshot = await app.inject("/api/v1/selected/snapshot");
  assert.equal(snapshot.statusCode, 200, snapshot.body);
  const paths = [
    "/api/v1/items",
    "/api/v1/hot-topics",
    `/api/v1/stories/${story}`,
    "/api/v1/dailies",
    "/api/v1/dailies/latest",
    "/api/v1/dailies/2020-03-02",
    "/api/v1/selected/snapshot",
    `/api/v1/selected/changes?cursor=${encodeURIComponent(snapshot.json().cursor)}`,
    "/api/v3/version",
    "/api/v3/items",
    `/api/v3/items/${article}`,
    "/api/v3/featured/snapshot",
    "/api/v3/policies/scope",
  ];
  const before = (await sql`SELECT count(*)::int AS n FROM receipts`)[0].n;
  for (const url of paths) {
    const baseline = await app.inject(url);
    assert.equal(baseline.statusCode, 200, `${url}: ${baseline.body}`);
  }
  for (const url of paths) {
    const a = await app.inject({ url, headers: { "x-notice": "a" } });
    assert.equal(a.statusCode, 200, `${url}: ${a.body}`);
    assert.deepEqual(a.json().module_notice, { tag: "a" }, url);
    assert.equal(a.headers["cache-control"], "private, no-store");
    const b = await app.inject({ url, headers: { "x-notice": "b", "if-none-match": String(a.headers.etag) } });
    assert.equal(b.statusCode, 200, url);
    assert.deepEqual(b.json().module_notice, { tag: "b" }, url);
  }
  for (const url of ["/api/site/meta", "/api/v3/freshness"]) {
    const count = calls;
    const result = await app.inject({ url, headers: { "x-notice": "fail", "if-none-match": "*" } });
    assert.equal(result.statusCode, url.includes("freshness") ? 200 : 304, result.body);
    assert.equal(calls, count, "no undeclared site/freshness reminder hook");
  }
  const visible = await app.inject({ url: `/api/v3/items/${article}`, headers: { "x-notice": "a" } });
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${article}`;
  const count = calls;
  const withdrawn = await app.inject({ url: `/api/v3/items/${article}`, headers: { "x-notice": "a", "if-none-match": String(visible.headers.etag) } });
  assert.equal(withdrawn.statusCode, 404);
  assert.equal(Object.hasOwn(withdrawn.json(), "module_notice"), false);
  assert.equal(calls, count, "eligibility precedes reminders and conditional responses");
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0].n, before);
});

test("errors never carry reminders and failing reminder providers return a redacted failure", async () => {
  for (const url of ["/api/v1/items?bad=1", "/api/v3/items?bad=1", "/api/v1/stories/missing", "/api/v3/items/missing"]) {
    const count = calls;
    const result = await app.inject({ url, headers: { "x-notice": "a" } });
    assert.ok([400, 404].includes(result.statusCode), result.body);
    assert.equal(Object.hasOwn(result.json(), "module_notice"), false);
    assert.equal(calls, count);
  }
  for (const url of ["/api/v1/items", "/api/v3/version"]) {
    const result = await app.inject({ url, headers: { "x-notice": "fail" } });
    assert.equal(result.statusCode, 503, result.body);
    assert.ok(!result.body.includes("private-fixture-secret"));
    assert.equal(Object.hasOwn(result.json(), "module_notice"), false);
  }
});
