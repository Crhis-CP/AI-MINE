import { buildApp } from "../apps/api/src/app.ts";
import { config } from "@amp/backend/config";
import { stub } from "./setup.ts";
import { ensureEmbeddings } from "@amp/backend/providers/embeddings";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { paidRequest } from "@amp/backend/providers/receipts";
import { upsertMaterial } from "@amp/backend/content/materials";
import { publishArticle, republishSource } from "@amp/backend/publication/publish";
import { stopBoss } from "@amp/backend/jobs/queue";
import {
  changeOwnerLaneControls,
  changeSystemLaneControl,
  listLaneControls,
  runtimeControlSnapshot,
  RuntimeControlPaused,
  RuntimeControlStale,
} from "../packages/backend/src/operations/lane-controls.ts";
const sql = dbOf("ops"),
  expires = () => new Date(Date.now() + 3600_000).toISOString();
after(async () => {
  await stopBoss();
  await closeDb();
});
async function owner(lane: "news" | "policy" | "all", mode: "processing" | "automatic", action: "pause" | "resume") {
  const revisions = (await listLaneControls()).owner_revisions.filter((r) => r.lane === lane);
  return changeOwnerLaneControls(
    {
      lane,
      mode,
      action,
      reason: "Synthetic control runtime",
      ...(action === "pause" ? { expires_at: expires() } : {}),
      expected_revisions: {
        processing: revisions.find((r) => r.switch === "processing")!.revision,
        ...(mode === "automatic" ? { collection: revisions.find((r) => r.switch === "collection")!.revision } : {}),
      },
      confirm_all: true,
    },
    "test-owner",
  );
}
test("claim stops before creating attempts; in-flight cost remains received and resume reuses it without a new send", async () => {
  let calls = 0;
  const outcome = () => ({ response: { ok: true }, usage: { total_tokens: 1 }, cost: { amount: 0.1, currency: "CNY", basis: "actual" as const } });
  const input = { service: "synthetic-runtime", purpose: "control-test", subject: "control-before-claim", lane: "news" as const, identity: { case: "new" } };
  await owner("news", "processing", "pause");
  await assert.rejects(
    paidRequest(input, async () => {
      calls++;
      return outcome();
    }),
    RuntimeControlPaused,
  );
  assert.equal(calls, 0);
  assert.equal((await sql`SELECT count(*)::int n FROM receipts WHERE subject=${input.subject}`)[0].n, 0);
  await paidRequest({ ...input, lane: "policy", subject: "other-lane", identity: { case: "policy" } }, async () => outcome());
  await paidRequest({ ...input, service: "jina", model: null, subject: "collection-continues", identity: { case: "reader" } }, async () => outcome());
  await owner("news", "processing", "resume");
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const inflight = paidRequest(input, async () => {
    calls++;
    entered.resolve();
    await release.promise;
    return outcome();
  });
  const rejected = assert.rejects(inflight, RuntimeControlStale);
  await entered.promise;
  await owner("news", "processing", "pause");
  release.resolve();
  await rejected;
  const [record] = await sql`SELECT status,cost,request FROM receipts WHERE subject=${input.subject}`;
  assert.equal(record.status, "received");
  assert.equal(Number(record.cost), 0.1);
  assert.equal(record.request.lane, "news");
  const reused = await paidRequest(input, async () => {
    calls++;
    return outcome();
  });
  assert.equal(reused.reused, true);
  assert.equal(calls, 1);
  await owner("news", "processing", "resume");
  assert.equal(
    (
      await paidRequest(input, async () => {
        calls++;
        return outcome();
      })
    ).reused,
    true,
  );
  assert.equal(calls, 1);
  assert.equal((await sql`SELECT count(*)::int n FROM receipt_attempts WHERE receipt_id=${reused.receiptId}`)[0].n, 1);
  const stale = await runtimeControlSnapshot("news", ["processing"]);
  await owner("news", "processing", "pause");
  await owner("news", "processing", "resume");
  await assert.rejects(
    paidRequest({ ...input, subject: "old-multistep", identity: { case: "old-multistep" }, runtimeControl: stale }, async () => outcome()),
    RuntimeControlStale,
  );
  assert.equal((await sql`SELECT count(*)::int n FROM receipts WHERE subject='old-multistep'`)[0].n, 0);
});
test("collection CAS rejects stale stored material while publication pause preserves existing readers and still permits removal", async () => {
  await sql`INSERT INTO sources(id,name,kind,lane,participation_mode,tier,site_fulltext) VALUES('control-source','Synthetic control','external','news','editorial','T1',true)`;
  const material = {
    sourceId: "control-source",
    url: "https://source.invalid/mining/control",
    title: "合成矿业资讯",
    language: "zh-CN",
    bodyText: "合成矿业事实材料，仅用于验证运行控制，来源正文保持完整。",
    via: "fetch" as const,
  };
  const collection = await runtimeControlSnapshot("news", ["collection"]);
  await owner("news", "automatic", "pause");
  await assert.rejects(upsertMaterial(material, undefined, collection), RuntimeControlStale);
  assert.equal((await sql`SELECT count(*)::int n FROM articles WHERE source_id='control-source'`)[0].n, 0);
  await owner("news", "automatic", "resume");
  const saved = await upsertMaterial(material);
  await publishArticle(saved.articleId);
  const [prior] = await sql`SELECT * FROM publications WHERE article_id=${saved.articleId}`;
  assert.equal(prior.visibility, "public");
  await changeSystemLaneControl({
    lane: "news",
    switches: ["publication"],
    action: "pause",
    reason: "Synthetic publication hold",
    actor: "test-system",
    expiresAt: expires(),
    expected: { publication: 0 },
  });
  const next = await upsertMaterial({ ...material, url: `${material.url}-new` });
  await assert.rejects(publishArticle(next.articleId), RuntimeControlPaused);
  assert.equal((await sql`SELECT visibility FROM publications WHERE article_id=${saved.articleId}`)[0].visibility, "public");
  const bulk = await republishSource("control-source");
  assert.equal(bulk.deferred, 1);
  assert.equal(bulk.failed, 0);
  await sql`INSERT INTO editorial_overrides(article_id,fields,visibility,updated_by) VALUES(${saved.articleId},'{}','withdrawn','synthetic-owner')`;
  await publishArticle(saved.articleId);
  assert.equal((await sql`SELECT visibility FROM publications WHERE article_id=${saved.articleId}`)[0].visibility, "withdrawn");
  await changeSystemLaneControl({
    lane: "news",
    switches: ["publication"],
    action: "resume",
    reason: "Synthetic restore",
    actor: "test-system",
    expected: { publication: 1 },
  });
  await publishArticle(next.articleId);
  assert.equal((await sql`SELECT visibility FROM publications WHERE article_id=${next.articleId}`)[0].visibility, "public");
});

test("in-flight embedding cannot persist across pause and reuses the same recorded response on resume", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const provider = await stub(async () => {
    entered.resolve();
    await release.promise;
    return { data: [{ index: 0, embedding: [0.5, 0.5] }], usage: { total_tokens: 1 } };
  });
  const oldUrl = process.env.DASHSCOPE_BASE_URL,
    oldKey = process.env.DASHSCOPE_API_KEY;
  process.env.DASHSCOPE_BASE_URL = provider.url;
  process.env.DASHSCOPE_API_KEY = "synthetic-control-key";
  try {
    const result = ensureEmbeddings("article", [{ id: "runtime-vector", text: "Synthetic mining fact" }]);
    const rejected = assert.rejects(result, RuntimeControlStale);
    await entered.promise;
    await owner("news", "processing", "pause");
    release.resolve();
    await rejected;
    assert.equal((await sql`SELECT count(*)::int n FROM embeddings WHERE ref_id='runtime-vector'`)[0].n, 0);
    await owner("news", "processing", "resume");
    assert.deepEqual((await ensureEmbeddings("article", [{ id: "runtime-vector", text: "Synthetic mining fact" }])).get("runtime-vector"), [0.5, 0.5]);
    assert.equal(provider.hits(), 1);
  } finally {
    if (oldUrl === undefined) delete process.env.DASHSCOPE_BASE_URL;
    else process.env.DASHSCOPE_BASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = oldKey;
    await provider.close();
  }
});

test("private control routes require a session and CSRF, reject another holder, and remain absent from public API", async () => {
  const previous = { admin: config.devAdmin, host: config.privateHost };
  config.privateHost = "private.controls.test";
  config.devAdmin = null;
  const app = await buildApp("private-api"),
    pub = await buildApp("public-api");
  try {
    assert.equal((await app.inject({ url: "/api/admin/lane-controls", headers: { "x-forwarded-host": config.privateHost } })).statusCode, 401);
    config.devAdmin = { displayName: "Synthetic authenticated operator" };
    const get = await app.inject({ url: "/api/admin/lane-controls", headers: { "x-forwarded-host": config.privateHost } });
    assert.equal(get.statusCode, 200);
    const revision = get.json().owner_revisions.find((r: { lane: string; switch: string }) => r.lane === "policy" && r.switch === "processing").revision;
    const payload = {
      lane: "policy",
      mode: "processing",
      action: "pause",
      reason: "Synthetic private action",
      expires_at: expires(),
      expected_revisions: { processing: revision },
    };
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/admin/lane-controls/actions", headers: { "x-forwarded-host": config.privateHost }, payload })).statusCode,
      403,
    );
    const bad = await app.inject({
      method: "POST",
      url: "/api/admin/lane-controls/actions",
      headers: { "x-forwarded-host": config.privateHost, "x-csrf-token": "dev" },
      payload: { ...payload, holder: "deploy" },
    });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().detail, /请核对/);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/lane-controls/actions",
          headers: { "x-forwarded-host": config.privateHost, "x-csrf-token": "dev" },
          payload,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/lane-controls/actions",
          headers: { "x-forwarded-host": config.privateHost, "x-csrf-token": "dev" },
          payload,
        })
      ).statusCode,
      409,
    );
    assert.equal((await pub.inject({ url: "/api/admin/lane-controls" })).statusCode, 404);
    await owner("policy", "processing", "resume");
  } finally {
    await app.close();
    await pub.close();
    config.devAdmin = previous.admin;
    config.privateHost = previous.host;
  }
});
