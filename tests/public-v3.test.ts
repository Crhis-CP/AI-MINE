import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { dbOf, closeDb } from "@amp/backend/db";
import { v3Envelope, v3Items, effectiveWatermark } from "@amp/backend/publication/v1";
import { buildApp } from "../apps/api/src/app.ts";
const sql = dbOf("publication"),
  source = `v3-${tag()}`,
  id = `${source}-a`,
  second = `${source}-b`;
const app = await buildApp("public-api");
after(async () => {
  await app.close();
  await closeDb();
});
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,config,site_fulltext,syndicate_fulltext) VALUES(${source},'API 合成来源','rss','{}',true,false)`;
  for (const [index, article] of [id, second].entries()) {
    const at = new Date(`2025-01-0${index + 1}T12:00:00+08:00`),
      html = Array.from({ length: 23 }, (_, i) => `<p>第${i + 1}段合成正文，保持完整顺序。</p>`).join("");
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,published_at,language,body_status,body_text,body_html,raw)
      VALUES(${article},${source},${article},${`https://example.invalid/${article}`},'铜矿公开材料',${at},${at},${at},'zh','ok','中文测试材料',${html},'{}')`;
    await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,published_at,discovered_at,timeline_at,sort_at,visibility,eligible,selected,body_mode,syndicate,tags)
      VALUES(${article},'铜矿公开材料','中文合成导读',${source},'news',${`https://example.invalid/${article}`},${at},${at},${at},${at},'public',true,false,'full',true,ARRAY['铜'])`;
  }
});
const get = async (url: string) => {
  const response = await app.inject({ url, method: "GET" });
  return { response, body: response.json() };
};

test("v3 all-library search reads older than seven days, pages with bound cursors, and rejects invalid filters", async () => {
  const first = await get(`/api/v3/items?source=${source}&limit=1`);
  assert.equal(first.response.statusCode, 200, first.response.body);
  assert.equal(first.response.headers["access-control-allow-origin"], "*");
  assert.equal(first.response.headers["cache-control"], "no-store");
  assert.equal(first.body.items.length, 1);
  assert.ok(first.body.next_cursor);
  assert.match(first.body.next_cursor, /^cv3\./);
  const tampered = first.body.next_cursor.slice(0, -1) + (first.body.next_cursor.endsWith("a") ? "b" : "a");
  const rejected = await get(`/api/v3/items?source=${source}&limit=1&cursor=${encodeURIComponent(tampered)}`);
  assert.equal(rejected.response.statusCode, 400);
  assert.equal(rejected.body.code, "invalid_cursor");
  assert.equal(first.body.items[0].attributions[0].name, "API 合成来源");
  assert.equal(first.body.items[0].published_time.precision, "unknown", "legacy timestamp does not become fabricated source proof");
  const next = await get(`/api/v3/items?source=${source}&limit=1&cursor=${encodeURIComponent(first.body.next_cursor)}`);
  assert.equal(next.response.statusCode, 200);
  assert.equal(next.body.items.length, 1);
  assert.notEqual(next.body.items[0].id, first.body.items[0].id);
  assert.equal(next.body.next_cursor, null);
  const changed = await get(`/api/v3/items?source=${source}&mineral=金&limit=1&cursor=${encodeURIComponent(first.body.next_cursor)}`);
  assert.equal(changed.response.statusCode, 400);
  assert.equal(changed.body.code, "invalid_cursor");
  for (const query of ["unknown=1", "limit=101", "on=2026-01-01&from=2026-01-01", "source=a&source=b"])
    assert.equal((await get(`/api/v3/items?${query}`)).response.statusCode, 400);
});

test("machine reading is restricted by default and qualified continuation binds the current revision", async () => {
  const restricted = await get(`/api/v3/items/${id}`);
  assert.equal(restricted.response.statusCode, 200, restricted.response.body);
  assert.equal(restricted.body.reading_zh.redistribution, "restricted");
  assert.deepEqual(restricted.body.reading_zh.blocks, []);
  await sql`UPDATE sources SET syndicate_fulltext=true WHERE id=${source}`;
  const reading = await get(`/api/v3/items/${id}/reading?limit=20`);
  assert.equal(reading.response.statusCode, 200, reading.response.body);
  assert.equal(reading.body.blocks.length, 20);
  assert.ok(reading.body.next_cursor);
  assert.doesNotMatch(JSON.stringify(reading.body.blocks), /<p>|<script/);
  const next = await get(
    `/api/v3/items/${id}/reading?limit=20&expression_id=${reading.body.expression_id}&cursor=${encodeURIComponent(reading.body.next_cursor)}`,
  );
  assert.equal(next.response.statusCode, 200);
  assert.equal(next.body.blocks.length, 3);
  assert.equal(next.body.next_cursor, null);
  await sql`UPDATE articles SET body_html='<p>已更正的正文。</p>',revision=revision+1 WHERE id=${id}`;
  const changed = await get(`/api/v3/items/${id}/reading?expression_id=${reading.body.expression_id}&cursor=${encodeURIComponent(reading.body.next_cursor)}`);
  assert.equal(changed.response.statusCode, 409);
  assert.equal(changed.body.code, "revision_changed");
});

test("withdrawn objects leave saved results, detail and list on the next origin read", async () => {
  const before = await app.inject({ method: "GET", url: `/api/v3/items?source=${source}` });
  assert.equal(before.statusCode, 200);
  const etag = before.headers.etag;
  assert.equal(typeof etag, "string");
  const unchanged = await app.inject({ method: "GET", url: `/api/v3/items?source=${source}`, headers: { "if-none-match": etag! } });
  assert.equal(unchanged.statusCode, 304);
  assert.equal(unchanged.body, "");
  assert.equal(unchanged.headers["cache-control"], "no-store");
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${id}`;
  const revised = await app.inject({ method: "GET", url: `/api/v3/items?source=${source}`, headers: { "if-none-match": etag! } });
  assert.equal(revised.statusCode, 200);
  assert.notEqual(revised.headers.etag, etag);
  assert.ok(!revised.json().items.some((item: { id: string }) => item.id === id));
  const freshness = await app.inject({ method: "GET", url: "/api/v3/freshness", headers: { "if-none-match": "*" } });
  assert.equal(freshness.statusCode, 200);
  assert.equal(freshness.headers["cache-control"], "no-store");
  assert.equal(freshness.headers.etag, undefined);

  const saved = await get(`/api/v3/saved?ids=${id},${second}`);
  assert.equal(saved.response.statusCode, 200, saved.response.body);
  assert.deepEqual(saved.body.unavailable_ids, [id]);
  assert.deepEqual(
    saved.body.items.map((item: { id: string }) => item.id),
    [second],
  );
  assert.equal((await get(`/api/v3/items/${id}`)).response.statusCode, 404);
  const list = await get(`/api/v3/items?source=${source}`);
  assert.deepEqual(
    list.body.items.map((item: { id: string }) => item.id),
    [second],
  );
});

test("implemented public collections respond and generated v3 OpenAPI excludes site heat, prices and private paths", async () => {
  for (const route of [
    "/api/v3/version",
    "/api/v3/hot",
    "/api/v3/events",
    "/api/v3/topics",
    "/api/v3/reports?type=weekly",
    "/api/v3/changelog",
    "/api/v3/jurisdictions",
    "/api/v3/policies",
    "/api/v3/policies/scope",
    "/api/v3/policies/reports?type=policy_weekly",
    "/api/v3/featured/snapshot",
  ]) {
    const result = await get(route);
    assert.equal(result.response.statusCode, 200, `${route}: ${result.response.body}`);
    assert.doesNotMatch(JSON.stringify(result.body), /"(?:heat|trend|trendPct|participantCount|spark|token_usage|prompt)"/);
  }
  const api = await get("/openapi-v3.json");
  assert.equal(api.response.statusCode, 200);
  assert.ok(Object.keys(api.body.paths).length >= 25);
  assert.ok(Object.keys(api.body.paths).every((path) => path.startsWith("/api/v3/")));
  assert.doesNotMatch(JSON.stringify(api.body), /MetalPrices|\/api\/admin|suppression_epoch|withdrawalVersion/);
  const actual = JSON.parse(readFileSync(new URL("../reference/contracts/v3.openapi.json", import.meta.url), "utf8"));
  assert.deepEqual(api.body, actual);
  for (const status of ["200", "304"])
    assert.deepEqual(Object.keys(api.body.paths["/api/v3/items"].get.responses[status].headers).sort(), ["Cache-Control", "ETag"]);
  for (const status of ["429", "503"])
    assert.deepEqual(Object.keys(api.body.paths["/api/v3/items"].get.responses[status].headers).sort(), ["Cache-Control", "Retry-After"]);
  assert.equal(api.body.paths["/api/v3/freshness"].get.responses["200"].headers.ETag, undefined);
});

test("non-empty event, development, report and topic projections resolve their current public members", async () => {
  const eventId = "14a9d8d2-99bf-4803-91d3-1e204f63c509";
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories(public_id,title,summary) VALUES(${eventId},'公开合成事件','事件摘要') RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,story_id,title) VALUES(${`${source}-fact`},${story!.id},'公开事件进展') RETURNING id`;
  await sql`UPDATE publications SET story_id=${story!.id},fact_id=${fact!.id} WHERE article_id=${second}`;
  await sql`INSERT INTO fact_articles(fact_id,article_id) VALUES(${fact!.id},${second})`;
  for (const path of [`/api/v3/events/${eventId}`, `/api/v3/stories/${eventId}`]) {
    const response = await get(path);
    assert.equal(response.response.statusCode, 200, response.response.body);
    assert.doesNotMatch(response.response.body, /"(?:heat|spark|whyHot|trend)"/);
  }
  const events = await get(`/api/v3/events?source=${source}`);
  assert.equal(events.response.statusCode, 200, events.response.body);
  assert.equal(events.body.items[0].id, eventId);
  const [cited] = await sql<{ revision: number }[]>`SELECT revision FROM publications WHERE article_id=${second}`;
  const content = {
    generationStatus: "ready",
    corrections: [
      { revision: 1, reason: "PRIVATE_FREEFORM_REASON", at: "2026-10-11T01:30:00Z" },
      { revision: 2, reason: "引用报道已更正，本期内容随之更新。", at: "2026-10-12T01:30:00Z", actor: "PRIVATE_ACTOR", audit_reason: "PRIVATE_AUDIT_REASON" },
      { revision: -1, reason: "PRIVATE_INVALID_ROW", at: "not-a-date" },
    ],
    lead: { title: "报告标题", leadParagraph: "报告导语" },
    sections: [
      {
        label: "企业与项目",
        summary: "本期有一条材料",
        items: [
          {
            itemId: second,
            publicationRevision: cited!.revision,
            title: "报告引用",
            summary: "引用导读",
            sourceName: "API 合成来源",
            sourceUrl: `https://example.invalid/${second}`,
          },
        ],
      },
    ],
    flashes: [],
  };
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,revision) VALUES('daily','2026-10-12',now()-interval '1 day',now(),${sql.json(content)},now(),2)`;
  const report = await get("/api/v3/reports/daily%3A2026-10-12");
  assert.equal(report.response.statusCode, 200, report.response.body);
  assert.equal(report.body.items[0].id, second);
  assert.equal(report.body.status, "ready");
  assert.equal(report.body.edition, 2);
  assert.deepEqual(report.body.corrections, [
    { revision: 1, reason: "本期内容已更正，请以当前版本为准。", at: "2026-10-11T01:30:00.000Z" },
    { revision: 2, reason: "引用报道已更正，本期内容随之更新。", at: "2026-10-12T01:30:00.000Z" },
  ]);
  assert.doesNotMatch(report.response.body, /PRIVATE_|audit_reason/);
  const siteReport = await get("/api/site/reports/daily/2026-10-12");
  assert.equal(siteReport.response.statusCode, 200);
  assert.doesNotMatch(siteReport.response.body, /PRIVATE_|audit_reason/);
  const topic = await get("/api/v3/topics/copper");
  assert.equal(topic.response.statusCode, 200, topic.response.body);
  assert.ok(topic.body.items.some((item: { id: string }) => item.id === second));
  const missing = await get("/api/v3/no-such-endpoint");
  assert.equal(missing.response.statusCode, 404);
  assert.deepEqual(Object.keys(missing.body).sort(), ["code", "message", "request_id"]);
  assert.equal((await app.inject({ method: "OPTIONS", url: "/api/v3/items" })).statusCode, 204);
});

test("a scheduled featured release advances the public version without another database write", async () => {
  const gate = new Date("2030-01-01T00:00:00.000Z"),
    before = new Date(gate.getTime() - 1);
  await sql`UPDATE publications SET selected=true,visible_after=${gate} WHERE article_id=${second}`;
  const [head] = await sql<{ next: number }[]>`SELECT (coalesce(max(seq),0)+1)::int AS next FROM selected_ledger`;
  await sql`INSERT INTO selected_ledger(seq,article_id,op,payload,visible_at) VALUES(${head!.next},${second},'upsert',${sql.json({ id: second })},${new Date(gate.getTime() + 60_000)})`;
  await sql`INSERT INTO selected_ledger(seq,article_id,op,payload,visible_at) VALUES(${head!.next + 1},${second},'upsert',${sql.json({ id: second })},${gate})`;
  assert.equal(await effectiveWatermark(before), await effectiveWatermark(gate), "an earlier pending entry still blocks the contiguous sync watermark");
  const first = await v3Envelope(before),
    released = await v3Envelope(gate);
  assert.notEqual(first.content_version, released.content_version);
  assert.deepEqual((await v3Items({ view: "featured", source, limit: 20 }, before)).items, []);
  const live = await v3Items({ view: "featured", source, limit: 20 }, gate);
  assert.ok(live.items.some((item) => item.id === second));
  assert.equal(live.content_version, released.content_version);
  assert.equal((await v3Envelope(gate)).content_version, released.content_version, "no later write or version churn is needed");
});
