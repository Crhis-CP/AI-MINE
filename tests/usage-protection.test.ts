import { stub } from "./setup.ts";
import { z } from "zod";
import { chatJson, environmentModelMetadata } from "../packages/backend/src/providers/llm.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import defaults from "../industry/usage-controls.json" with { type: "json" };
import { dbOf, closeDb } from "@amp/backend/db";
import { sha256 } from "@amp/backend/lib/ids";
import { sessionPrincipal, SESSION_COOKIE, type AdminPrincipal } from "@amp/backend/admin/auth";
import { paidRequest, logicalKeyFor, ReceiptUnknownError, UsageProtectionError } from "@amp/backend/providers/receipts";
import { changeUsageProtection, changeUsagePrice, recoverUsageBreaker, usageProtectionOverview } from "../packages/backend/src/admin/usage-protection.ts";
import { evaluateUsageProtection, readUsageProtection, settleUsageAttempt } from "../packages/backend/src/providers/usage-protection.ts";
import { priceQuote } from "../packages/backend/src/providers/usage-pricing.ts";
import { usageMonthly } from "../packages/backend/src/operations/usage-monthly.ts";
import { deliverUsageProtectionEvents } from "../packages/backend/src/operations/usage-protection.ts";
import {
  createModelConnection,
  requestModelConnectionProbe,
  listModelConnections,
  readModelConnectionProbe,
} from "../packages/backend/src/admin/model-registry.ts";
import { runModelConnectionProbe, sweepModelConnectionProbes, registerModelConnectionProbeJobs } from "../packages/backend/src/providers/model-probe.ts";
import { changeOwnerLaneControls, listLaneControls } from "../packages/backend/src/operations/lane-controls.ts";
import { getBoss, stopBoss } from "@amp/backend/jobs/queue";
import { config } from "@amp/backend/config";
const sql = dbOf("ai-gateway");
let owner: AdminPrincipal,
  manager: AdminPrincipal,
  calls = 0,
  index = 0;
const date = (offset = 0) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
before(async () => {
  for (const [name, role] of [
    ["owner", "owner"],
    ["manager", "admin"],
  ] as const) {
    const [user] = await sql`INSERT INTO admin_users(email,display_name) VALUES(${`usage-${name}@synthetic.invalid`},${name}) RETURNING id`;
    await sql`INSERT INTO identity.account_access(user_id,role,models_manage,must_change_password) VALUES(${user!.id},${role},true,false)`;
    await sql`INSERT INTO admin_sessions(id_hash,user_id,csrf_token,expires_at) VALUES(${sha256(`synthetic-usage-${name}`)},${user!.id},'synthetic-csrf',now()+interval '1 hour')`;
    const principal = (await sessionPrincipal(`${SESSION_COOKIE}=synthetic-usage-${name}`))!;
    if (role === "owner") owner = principal;
    else manager = principal;
  }
});
beforeEach(async () => {
  await stopBoss();
  await sql`TRUNCATE receipts CASCADE`;
  await sql`TRUNCATE ai.usage_control_versions,ai.usage_prices,ai.usage_breakers,ai.usage_protection_events,ai.usage_notice_progress,ai.usage_sums`;
  calls = 0;
  index++;
});
after(async () => {
  await stopBoss();
  await closeDb();
});
async function install() {
  return changeUsageProtection({ expected_version: 0, config: defaults, reason: "synthetic initial config", high_risk_confirmed: true }, owner);
}
async function price(amount = "0", service = "usage-fixture", model = "", hash: string | null = null) {
  const current = (await readUsageProtection()).prices.find(
    (p) => p.price.service === service && p.price.model === model && p.price.configuration_hash === hash,
  );
  return changeUsagePrice(
    {
      expected_version: current?.version ?? 0,
      reason: "synthetic price only",
      high_risk_confirmed: true,
      price: {
        service,
        model,
        configuration_hash: hash,
        currency: "CNY",
        input_per_million_micros: model ? "2000000" : null,
        output_per_million_micros: model ? "4000000" : null,
        per_request_micros: model ? null : amount,
        max_request_micros: null,
        image_input_token_bound: null,
        protocol_input_token_allowance: 32,
        basis_url: "https://price.synthetic.invalid",
        observed_on: date(-1),
        valid_until: date(10),
      },
    },
    owner,
  );
}
const request = (key: string, opts: { lane?: "news" | "policy"; capability?: string; source?: string; object?: string; tag?: string } = {}) => ({
  service: "usage-fixture",
  purpose: opts.capability ?? "fixture_capability",
  subject: `fixture:${key}`,
  identity: { key, index },
  attemptTag: opts.tag,
  lane: opts.lane ?? ("news" as "news" | "policy"),
  usageContext: {
    lane: opts.lane ?? ("news" as "news" | "policy"),
    capability: opts.capability ?? "fixture_capability",
    sourceIds: opts.source ? [opts.source] : [],
    object: opts.object ? { kind: (opts.lane === "policy" ? "policy" : "article") as "article" | "policy", id: opts.object } : null,
  },
});
const send = async () => {
  calls++;
  return { response: { ok: true } };
};
async function charge(key: string, amount: string, opts: Parameters<typeof request>[1] = {}) {
  await price(amount);
  return paidRequest(request(key, opts), send);
}

test("missing protection rejects new payment, while an existing paid response remains reusable; only real Owner can configure", async () => {
  await assert.rejects(paidRequest(request("missing"), send), UsageProtectionError);
  assert.equal(calls, 0);
  await assert.rejects(changeUsageProtection({ expected_version: 0, config: defaults, reason: "not Owner", high_risk_confirmed: true }, manager));
  await install();
  assert.equal((await usageProtectionOverview(manager)).can_manage, false);
  assert.equal((await usageProtectionOverview(owner)).can_manage, true);
  await price();
  const original = await paidRequest(request("cached"), send);
  await sql`DELETE FROM ai.usage_control_versions`;
  assert.equal((await paidRequest(request("cached"), send)).receiptId, original.receiptId);
  assert.equal(calls, 1);
  await assert.rejects(paidRequest(request("uncached"), send), UsageProtectionError);
});
test("price evidence, CNY, <=45-day validity, visual upper bound and exact micro arithmetic are enforced", async () => {
  await install();
  await assert.rejects(paidRequest(request("no-price"), send), UsageProtectionError);
  const p = await price("1");
  await assert.rejects(
    changeUsagePrice({ expected_version: p.version, price: { ...p.price, currency: "USD" }, reason: "invalid", high_risk_confirmed: true }, owner),
  );
  await assert.rejects(
    changeUsagePrice({ expected_version: p.version, price: { ...p.price, valid_until: date(60) }, reason: "invalid", high_risk_confirmed: true }, owner),
  );
  const received = await paidRequest(request("expiry-cache"), send);
  await changeUsagePrice(
    {
      expected_version: p.version,
      price: { ...p.price, observed_on: date(-10), valid_until: date(-1) },
      reason: "synthetic expired evidence",
      high_risk_confirmed: true,
    },
    owner,
  );
  assert.equal((await paidRequest(request("expiry-cache"), send)).receiptId, received.receiptId);
  await assert.rejects(paidRequest(request("expired-new"), send), UsageProtectionError);
  await price("0", "usage-fixture", "vision");
  assert.match(
    (await priceQuote(sql, { service: "usage-fixture", model: "vision", bounds: { input_tokens: 20, output_tokens: 20, images: 1 } })).missing!,
    /图像/,
  );
  const quote = (await priceQuote(sql, { service: "usage-fixture", model: "vision", bounds: { input_tokens: 1, output_tokens: 1 } })).quote!;
  let sum = 0n;
  for (let i = 0; i < 100000; i++) sum += BigInt(quote.reserved_micros);
  assert.equal(sum, BigInt(quote.reserved_micros) * 100000n);
});
test("third paid repetition opens only capability/source on its lane; warning does not stop and cache bypasses the gate", async () => {
  await install();
  await price();
  const first = await paidRequest(request("same", { source: "source-a", tag: "0" }), send);
  await paidRequest(request("same", { source: "source-a", tag: "1" }), send);
  await paidRequest(request("same", { source: "source-a", tag: "2" }), send);
  assert.equal((await readUsageProtection()).breakers.find((b) => b.trigger === "repeated_input")!.state, "warning");
  await paidRequest(request("same", { source: "source-a", tag: "3" }), send);
  const open = (await readUsageProtection()).breakers.find((b) => b.state === "open")!;
  assert.equal(open.scope.source_id, "source-a");
  await assert.rejects(paidRequest(request("different", { source: "source-a" }), send), UsageProtectionError);
  await paidRequest(request("different-source", { source: "source-b" }), send);
  await paidRequest(request("policy-free", { lane: "policy", source: "source-a" }), send);
  assert.equal((await paidRequest(request("same", { source: "source-a", tag: "0" }), send)).receiptId, first.receiptId);
  assert.equal(calls, 6);
});
test("object costs distinguish equality from > threshold and do not stop a different material", async () => {
  await install();
  await charge("object-1", "2500000", { object: "article-a" });
  await charge("object-2", "2500000", { object: "article-a" });
  let rows = (await readUsageProtection()).breakers;
  assert.equal(rows.find((b) => b.trigger === "object_cost")!.state, "warning");
  await charge("object-3", "1", { object: "article-a" });
  rows = (await readUsageProtection()).breakers;
  assert.equal(rows.find((b) => b.trigger === "object_cost")!.state, "open");
  await assert.rejects(paidRequest(request("object-4", { object: "article-a" }), send), UsageProtectionError);
  await paidRequest(request("other-object", { object: "article-b" }), send);
});
test("daily no-history warning and > threshold pause only top capabilities covering at least half", async () => {
  await install();
  await charge("a", "140000000", { capability: "cap-a" });
  assert.equal((await readUsageProtection()).breakers.find((b) => b.trigger === "daily_total")!.state, "warning");
  await charge("b", "60000000", { capability: "cap-b" });
  assert.equal((await readUsageProtection()).breakers.filter((b) => b.state === "open").length, 0);
  await charge("c", "1000000", { capability: "cap-c", lane: "policy" });
  const open = (await readUsageProtection()).breakers.filter((b) => b.state === "open");
  assert.deepEqual(
    open.map((b) => b.scope.capability),
    ["cap-a"],
  );
  await assert.rejects(paidRequest(request("a-again", { capability: "cap-a" }), send), UsageProtectionError);
  await paidRequest(request("policy-still-open", { capability: "cap-c", lane: "policy" }), send);
});
test("unknown keeps its reservation; known unbilled release adjusts only its amount, and monthly notices never impose a cap", async () => {
  await install();
  await price("150000000");
  await assert.rejects(
    paidRequest(request("unknown"), async () => {
      calls++;
      throw new Error("synthetic timeout");
    }),
  );
  const [unknown] = await sql<{ attempt_id: string }[]>`SELECT attempt_id::text FROM ai.usage_attempts WHERE state='unknown'`;
  let notice = (await readUsageProtection()).events.filter((e) => e.kind === "usage_notice");
  assert.equal(notice.length, 1);
  assert.equal(notice[0]!.payload.crossed_through_micros, "100000000");
  await sql.begin(async (db) => {
    await db`UPDATE receipt_attempts SET status='failed' WHERE id=${unknown!.attempt_id}`;
    await settleUsageAttempt(db, unknown!.attempt_id, "failed");
  });
  await evaluateUsageProtection();
  assert.equal((await readUsageProtection()).events.filter((e) => e.kind === "usage_notice").length, 1);
  const changed = structuredClone(defaults);
  changed.breaker.daily_no_history_micros = "10000000000";
  await changeUsageProtection({ expected_version: 1, config: changed, reason: "synthetic testing independent notice", high_risk_confirmed: true }, owner);
  await charge("cross-many", "350000000");
  notice = (await readUsageProtection()).events.filter((e) => e.kind === "usage_notice");
  assert.equal(notice.length, 2);
  assert.equal(notice[0]!.payload.crossed_through_micros, "300000000");
  await evaluateUsageProtection();
  assert.equal((await readUsageProtection()).events.filter((e) => e.kind === "usage_notice").length, 2);
  await charge("new-work-after-notice", "1");
});
test("Owner recovery has version CAS and never releases a system/deployment/Owner pause", async () => {
  await install();
  await charge("obj", "6000000", { object: "a" });
  const open = (await readUsageProtection()).breakers.find((b) => b.state === "open")!;
  const controls = await listLaneControls(),
    revision = controls.owner_revisions.find((r) => r.lane === "news" && r.switch === "processing")!.revision;
  await changeOwnerLaneControls(
    {
      lane: "news",
      mode: "processing",
      action: "pause",
      expected_revisions: { processing: revision },
      reason: "synthetic independent pause",
      expires_at: new Date(Date.now() + 60000).toISOString(),
    },
    "synthetic",
  );
  await assert.rejects(recoverUsageBreaker(open.id, { expected_revision: open.revision, reason: "not Owner" }, manager));
  assert.equal((await recoverUsageBreaker(open.id, { expected_revision: open.revision, reason: "fixture recovery" }, owner)).state, "recovered");
  await assert.rejects(recoverUsageBreaker(open.id, { expected_revision: open.revision, reason: "stale" }, owner));
  assert.equal((await listLaneControls()).controls.filter((c) => c.lane === "news" && c.holder === "owner").length, 1);
  await changeOwnerLaneControls(
    { lane: "news", mode: "processing", action: "resume", expected_revisions: { processing: revision + 1 }, reason: "synthetic" },
    "synthetic",
  );
});

test("daily history includes complete zero-spend days and keeps comparisons exact", async () => {
  await install();
  for (const offset of [-3, -1]) {
    const at = new Date(Date.now() + offset * 86400000),
      key = `history-${index}-${offset}`;
    const [receipt] =
      await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status,request,response,attempts,created_at,received_at) VALUES(${key},'history-fixture','historical_capability',${key},'received',${sql.json({ lane: "news" })},${sql.json({ ok: true })},1,${at},${at}) RETURNING id`;
    const [attempt] =
      await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status,response,cost,currency,cost_basis,started_at,finished_at) VALUES(${receipt!.id},1,'history-fixture','received',${sql.json({ ok: true })},'100.000000','CNY','actual',${at},${at}) RETURNING id`;
    await sql`UPDATE receipts SET response_attempt_id=${attempt!.id} WHERE id=${receipt!.id}`;
  }
  await charge("history-equality", "200000000", { capability: "today_capability" });
  assert.equal((await readUsageProtection()).breakers.filter((b) => b.state === "open").length, 0);
  await charge("history-above", "1", { capability: "today_capability" });
  const daily = (await readUsageProtection()).breakers.find((b) => b.trigger === "daily_total" && b.state === "open")!;
  assert.equal(daily.current.history_days, "3");
  assert.equal(daily.current.history_micros, "200000000");
});
test("notification batching is idempotent; unknown delivery is retained and price/usage notices never invoke a model", async () => {
  await install();
  await price();
  for (let n = 0; n < 3; n++) await paidRequest(request("notify", { source: "source-a", tag: String(n) }), send);
  const before = calls;
  let messages = 0;
  await deliverUsageProtectionEvents(new Date(), async () => {
    messages++;
    return "sent";
  });
  const sent = messages;
  await deliverUsageProtectionEvents(new Date(), async () => {
    messages++;
    return "sent";
  });
  assert.equal(messages, sent);
  assert.equal(calls, before);
  await paidRequest(request("notify", { source: "source-a", tag: "3" }), send);
  await deliverUsageProtectionEvents(new Date(), async () => {
    throw new Error("synthetic delivery unknown");
  });
  assert.ok((await readUsageProtection()).events.some((e) => e.delivery_status === "unknown"));
  await deliverUsageProtectionEvents(new Date(), async () => {
    messages++;
    return "sent";
  });
  assert.equal(messages, sent);
});
test("received model connection test survives control-CAS pause and bounded queue sweep resumes the same paid receipt", async () => {
  await install();
  config.modelCallsEnabled = true;
  process.env.MODEL_REGISTRY_ENCRYPTION_KEY = Buffer.alloc(32, 73).toString("base64");
  const c = {
    name: "Synthetic guarded model",
    interface: "openai-compatible",
    endpoint: "https://model.synthetic.invalid/v1",
    model: "synthetic-guard-model",
    input_cny_per_million: "2",
    output_cny_per_million: "4",
    billing_basis: "https://price.synthetic.invalid",
    vision: false,
    json_mode: true,
    secret: "fake-only-connection-key",
    reason: "synthetic",
    owner_confirmed: true,
    supplier_basis: "https://price.synthetic.invalid",
  };
  await assert.rejects(createModelConnection(c, manager));
  const row = await createModelConnection(c, owner);
  assert.ok((await listModelConnections(manager)).connections.some((r) => r.id === row.id));
  await price("0", row.key, c.model, row.configuration_hash);
  const probe = await requestModelConnectionProbe(row.id, { expected_revision: 1, lane: "news" }, owner);
  let physical = 0,
    pausedRevision = 0;
  const transport = async () => {
    physical++;
    const controls = await listLaneControls(),
      revision = controls.owner_revisions.find((r) => r.lane === "news" && r.switch === "processing")!.revision;
    pausedRevision = revision + 1;
    await changeOwnerLaneControls(
      {
        lane: "news",
        mode: "processing",
        action: "pause",
        expected_revisions: { processing: revision },
        reason: "synthetic in-flight pause",
        expires_at: new Date(Date.now() + 60000).toISOString(),
      },
      "synthetic",
    );
    return {
      status: 200,
      headers: new Headers(),
      text: () =>
        JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 4 } }),
    };
  };
  const paused = await runModelConnectionProbe(probe.id, { transport });
  assert.equal(paused.status, "paused");
  assert.ok(paused.receipt_id);
  assert.equal(physical, 1);
  await changeOwnerLaneControls(
    { lane: "news", mode: "processing", action: "resume", expected_revisions: { processing: pausedRevision }, reason: "synthetic resume" },
    "synthetic",
  );
  const same = await requestModelConnectionProbe(row.id, { expected_revision: 1, lane: "news" }, owner);
  assert.equal(same.id, probe.id);
  await registerModelConnectionProbeJobs(await getBoss(), {
    transport: async () => {
      throw new Error("must reuse paid response");
    },
  });
  await sweepModelConnectionProbes();
  let current = paused;
  for (let n = 0; n < 70; n++) {
    current = await readModelConnectionProbe(probe.id, owner);
    if (current.status === "passed") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(current.status, "passed");
  assert.equal(current.receipt_id, paused.receipt_id);
  assert.equal(physical, 1);
  const [attempts] = await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id=${paused.receipt_id!}`;
  assert.equal(attempts!.n, 1);
});

test("all new environment calls bind actual endpoint configuration to each physical attempt and cannot reuse a different endpoint", async () => {
  await install();
  const provider = await stub(() => ({
    model: "reported-synthetic-model",
    choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 4 },
  }));
  try {
    Object.assign(process.env, {
      LLM_MODEL: "requested-synthetic-model",
      LLM_BASE_URL: `${provider.url}/first`,
      LLM_API_KEY: "fake-env-key",
      LLM_JSON_MODE: "true",
      LLM_VISION: "false",
    });
    delete process.env.LLM_EXTRA_JSON;
    config.modelCallsEnabled = true;
    const firstMeta = environmentModelMetadata("default")!;
    await price("0", firstMeta.service, firstMeta.model, firstMeta.configuration_hash);
    const options = {
      model: "default",
      lane: "policy" as const,
      purpose: "policy_verify",
      subject: "policy:synthetic",
      usageObject: { kind: "policy" as const, id: "synthetic-document" },
      promptVersion: "synthetic",
      system: "",
      user: "same input",
      schema: z.strictObject({ ok: z.literal(true) }),
      policyContext: {
        lane: "policy" as const,
        category: "policy_interpret" as const,
        sourceIds: [],
        manifestHash: "synthetic",
        inputFingerprint: "synthetic",
        permissionVersions: {},
        manifest: {},
      },
      beforeRequest: async () => {},
    };
    const first = await chatJson(options);
    process.env.LLM_BASE_URL = `${provider.url}/second`;
    const secondMeta = environmentModelMetadata("default")!;
    assert.notEqual(firstMeta.configuration_hash, secondMeta.configuration_hash);
    await price("0", secondMeta.service, secondMeta.model, secondMeta.configuration_hash);
    const second = await chatJson(options);
    assert.notEqual(first.receiptId, second.receiptId);
    assert.equal(provider.hits(), 2);
    const { readPolicyResponse } = await import("../packages/backend/src/providers/receipts.ts");
    const record = await readPolicyResponse({ receiptId: second.receiptId, attemptId: second.attemptId! });
    assert.equal(record!.configuration_hash, secondMeta.configuration_hash);
    assert.equal(record!.connection_id, null);
    assert.equal(record!.connection_revision, null);
    assert.equal(record!.model, "requested-synthetic-model");
    assert.equal((record!.response as { model: string }).model, "reported-synthetic-model");
  } finally {
    await provider.close();
  }
});

test("legacy unhashed unknown cannot be bypassed by a new config identity; an exact legacy response is still free", async () => {
  await install();
  const provider = await stub(() => {
    throw new Error("legacy migration must not pay");
  });
  try {
    Object.assign(process.env, {
      LLM_MODEL: "legacy-current-model",
      LLM_BASE_URL: `${provider.url}/changed-endpoint`,
      LLM_API_KEY: "fake-legacy-key",
      LLM_JSON_MODE: "true",
      LLM_VISION: "false",
    });
    delete process.env.LLM_EXTRA_JSON;
    config.modelCallsEnabled = true;
    const user = "same legacy input",
      subject = "article:legacy@1",
      purpose = "understand_article";
    const [old] =
      await sql`INSERT INTO receipts(logical_key,service,model,purpose,subject,status,request,attempts) VALUES('synthetic-old-unhashed','previous-service','previous-model',${purpose},${subject},'unknown',${sql.json({ userHash: sha256(user), configuration_hash: "f".repeat(64) })},1) RETURNING id`;
    await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status) VALUES(${old!.id},1,'previous-service','previous-model','unknown')`;
    await assert.rejects(
      chatJson({ model: "default", purpose, subject, promptVersion: "new-recipe", system: "", user, schema: z.strictObject({ ok: z.literal(true) }) }),
      ReceiptUnknownError,
    );
    assert.equal(provider.hits(), 0);
    await sql`UPDATE receipts SET status='failed' WHERE id=${old!.id}`;
    await sql`UPDATE receipt_attempts SET status='failed' WHERE receipt_id=${old!.id}`;
    const identity = {
      model: "legacy-current-model",
      promptVersion: "old-recipe",
      system: sha256(""),
      user: sha256(user),
      temperature: 0.2,
      maxTokens: 1500,
      extra: null,
    };
    const key = logicalKeyFor({ service: "llm", model: "legacy-current-model", purpose, subject, identity });
    const response = { choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 4 } };
    const [r] =
      await sql`INSERT INTO receipts(logical_key,service,model,purpose,subject,status,request,response,attempts) VALUES(${key},'llm','legacy-current-model',${purpose},${subject},'received',${sql.json({ userHash: sha256(user) })},${sql.json(response)},1) RETURNING id`;
    const [a] =
      await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,response,usage) VALUES(${r!.id},1,'llm','legacy-current-model','received',${sql.json(response)},${sql.json(response.usage)}) RETURNING id`;
    await sql`UPDATE receipts SET response_attempt_id=${a!.id} WHERE id=${r!.id}`;
    await sql`DELETE FROM ai.usage_control_versions`;
    const reused = await chatJson({
      model: "default",
      purpose,
      subject,
      promptVersion: "old-recipe",
      system: "",
      user,
      schema: z.strictObject({ ok: z.literal(true) }),
    });
    assert.equal(reused.receiptId, r!.id);
    assert.equal(reused.reused, true);
    assert.equal(provider.hits(), 0);
  } finally {
    await provider.close();
  }
});

test("a news historical gap does not stop a priced policy request; truly unassigned gaps never become a site-wide switch", async () => {
  await install();
  await price("1000000");
  for (const lane of ["news", null]) {
    const key = `old-gap-${index}-${lane}`;
    const [r] =
      await sql`INSERT INTO receipts(logical_key,service,model,purpose,subject,status,request,attempts) VALUES(${key},'old','old-model','fixture_capability',${key},'unknown',${sql.json(lane ? { lane, sourceIds: ["old-news-source"] } : {})},1) RETURNING id`;
    await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status) VALUES(${r!.id},1,'old','old-model','unknown')`;
  }
  await assert.rejects(paidRequest(request("same-news-scope", { source: "old-news-source" }), send), UsageProtectionError);
  await paidRequest(request("qualified-policy", { lane: "policy", source: "old-news-source", object: "policy-document" }), send);
  await paidRequest(request("different-news", { source: "different-source", object: "fresh-material" }), send);
  assert.equal(calls, 2);
  const overview = await readUsageProtection();
  assert.ok(overview.missing.length);
  assert.equal(overview.breakers.filter((b) => b.trigger === "daily_total" && b.state === "open").length, 0);
});
test("eight-decimal unit price is preserved exactly; rounding happens only on the final micro amount", async () => {
  await install();
  const model = {
    name: "High precision fixture",
    interface: "openai-compatible",
    endpoint: "https://model.synthetic.invalid/v1",
    model: "tiny-price",
    input_cny_per_million: "0.12345678",
    output_cny_per_million: "0.00000001",
    billing_basis: "https://price.synthetic.invalid",
    vision: false,
    json_mode: true,
    secret: "synthetic-key",
    reason: "fixture",
    owner_confirmed: true,
    supplier_basis: "https://price.synthetic.invalid",
  };
  process.env.MODEL_REGISTRY_ENCRYPTION_KEY = Buffer.alloc(32, 73).toString("base64");
  const record = await createModelConnection(model, owner);
  const { rateMicros } = await import("../packages/backend/src/providers/usage-pricing.ts");
  const entry = {
    service: record.key,
    model: record.model,
    configuration_hash: record.configuration_hash,
    currency: "CNY",
    input_per_million_micros: rateMicros(model.input_cny_per_million),
    output_per_million_micros: rateMicros(model.output_cny_per_million),
    per_request_micros: null,
    max_request_micros: null,
    image_input_token_bound: null,
    protocol_input_token_allowance: 0,
    basis_url: model.billing_basis,
    observed_on: date(-1),
    valid_until: date(10),
  };
  const stored = await changeUsagePrice({ expected_version: 0, price: entry, reason: "exact synthetic price", high_risk_confirmed: true }, owner);
  assert.equal(stored.price.input_per_million_micros, "123456.78");
  assert.equal(stored.price.output_per_million_micros, "0.01");
  const quoted = await priceQuote(sql, {
    service: record.key,
    model: record.model,
    configurationHash: record.configuration_hash,
    registeredPricing: { input: model.input_cny_per_million, output: model.output_cny_per_million, basis: model.billing_basis },
    bounds: { input_tokens: 1000000, output_tokens: 0 },
  });
  assert.equal(quoted.quote!.reserved_micros, "123457");
  assert.equal(quoted.quote!.price.input_per_million_micros, "123456.78");
});
test("optional research task cap atomically retains in-flight and unknown usage, while free reuse adds no reservation", async () => {
  await install();
  await price("300000");
  const taskBudget = { key: `synthetic-task-${index}`, limit_micros: "800000" };
  const first = await paidRequest({ ...request("task-first"), taskBudget }, send);
  await assert.rejects(
    paidRequest({ ...request("task-unknown"), taskBudget }, async () => {
      calls++;
      throw new Error("unknown");
    }),
  );
  await assert.rejects(
    paidRequest({ ...request("task-third"), taskBudget }, send),
    (e: unknown) => e instanceof UsageProtectionError && e.usageCode === "task_budget_exceeded",
  );
  assert.equal((await paidRequest({ ...request("task-first"), taskBudget }, send)).receiptId, first.receiptId);
  assert.equal(calls, 2);
  await assert.rejects(
    paidRequest({ ...request("task-widen"), taskBudget: { ...taskBudget, limit_micros: "1000000" } }, send),
    (e: unknown) => e instanceof UsageProtectionError && e.usageCode === "task_budget_changed",
  );
  const [row] =
    await sql`SELECT sum(CASE WHEN state='settled' THEN settled_micros ELSE reserved_micros END)::text AS used FROM ai.usage_attempts WHERE task_key=${taskBudget.key}`;
  assert.equal(row!.used, "600000");
});

test("price expiry is notified once per evidence revision; monthly report honors the configured Beijing minute", async () => {
  await install();
  const p = await price();
  await changeUsagePrice(
    { expected_version: p.version, price: { ...p.price, valid_until: date(5) }, reason: "synthetic nearing expiry", high_risk_confirmed: true },
    owner,
  );
  await evaluateUsageProtection();
  await evaluateUsageProtection();
  const [notices] = await sql`SELECT count(*)::int AS n FROM ai.usage_protection_events WHERE id LIKE 'usage-price-expiry:%'`;
  assert.equal(notices!.n, 1);
  await changeUsageProtection(
    { expected_version: 1, config: { ...defaults, usage_report: { push_time: "10:37" } }, reason: "synthetic schedule", high_risk_confirmed: true },
    owner,
  );
  await sql`TRUNCATE ai.usage_monthly_reports`;
  let messages = 0;
  const send = async () => {
    messages++;
    return "sent" as const;
  };
  assert.deepEqual(await usageMonthly(new Date("2026-11-01T02:36:59Z"), send), { deferred: true });
  await usageMonthly(new Date("2026-11-01T02:37:00Z"), send);
  await usageMonthly(new Date("2026-11-01T02:38:00Z"), send);
  assert.equal(messages, 1);
});
