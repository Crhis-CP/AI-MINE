import { prepareNewsFallback } from "../packages/backend/src/providers/news-fallback.ts";
import { changeOwnerLaneControls, listLaneControls } from "../packages/backend/src/operations/lane-controls.ts";
import { createPolicyGateway } from "../modules/policy/backend/provider.ts";
import { installPolicyQualityRelease, revokePolicyQualityRelease } from "../modules/policy/backend/domain/quality.ts";
import { currentInterpretationQualification } from "../modules/policy/backend/domain/fallback-quality.ts";
import { policyModelQualificationKey } from "../modules/policy/backend/domain/model-evidence.ts";
import { promptVersion } from "../packages/backend/src/editorial/prompts.ts";
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { dbOf, initializeDb, closeDb } from "@amp/backend/db";
import { upsertMaterial, readCurrentBody, newsMaterialBindings } from "@amp/backend/content/materials";
import { config } from "@amp/backend/config";
import { sha256, stableJson } from "@amp/backend/lib/ids";
import { chatJson, type RegisteredModelTransport } from "../packages/backend/src/providers/llm.ts";
import { completeReceipt, rejectReceivedResponse, ReceiptUnknownError, ReceiptPhysicalLimitError } from "../packages/backend/src/providers/receipts.ts";
import {
  createModelConnection,
  requestModelConnectionProbe,
  assignRegisteredModel,
  disableModelConnection,
} from "../packages/backend/src/admin/model-registry.ts";
import { runModelConnectionProbe } from "../packages/backend/src/providers/model-probe.ts";
import { importSelectBenchRun } from "../packages/backend/src/admin/selectbench.ts";
import { approveModelRoute, capabilityPrompt } from "../packages/backend/src/providers/model-fallback-quality.ts";
import { changeModelFallback, modelFallbacks } from "../packages/backend/src/admin/model-fallback.ts";
import { createFallbackPermitPort } from "../packages/backend/src/providers/model-fallback-permit.ts";
import { ModelFallbackBlocked, ModelContentFiltered } from "../packages/backend/src/providers/model-fallback.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
import { readCurrentSourcePolicy, saveSourcePolicy } from "../packages/backend/src/admin/sources.ts";
const sql = dbOf("ai-gateway"),
  root = await initializeDb("test");
process.env.MODEL_REGISTRY_ENCRYPTION_KEY = Buffer.alloc(32, 28).toString("base64");
config.modelCallsEnabled = true;
after(closeDb);
const schema = z.strictObject({ ok: z.literal(true) }),
  events: string[] = [];
let mode = "ok",
  onPrimary: (() => Promise<void>) | null = null;
const transport: RegisteredModelTransport = async (url, options) => {
  const body = JSON.parse(options.body!),
    which = url.includes("primary") ? "primary" : "backup";
  events.push(which);
  const probe = body.max_tokens < 512;
  if (!probe && which === "primary") {
    if (onPrimary) await onPrimary();
    if (mode !== "primary-ok") {
      if (mode === "http") return { status: 503, headers: new Headers(), text: () => "unconfirmed billing" };
      if (mode === "filter")
        return {
          status: 200,
          headers: new Headers(),
          text: () =>
            JSON.stringify({
              model: "synthetic-model",
              choices: [{ message: { content: "" }, finish_reason: "content_filter" }],
              usage: { prompt_tokens: 20, completion_tokens: 0 },
            }),
        };
      throw Object.assign(new Error("synthetic pre-send refused"), { code: "ECONNREFUSED" });
    }
  }
  if (!probe && which === "backup" && mode === "backup-unknown") throw new Error("synthetic after-send reset");
  if (!probe && which === "backup" && mode === "backup-connect") throw Object.assign(new Error("synthetic pre-send refused"), { code: "ECONNREFUSED" });
  return {
    status: 200,
    headers: new Headers(),
    text: () =>
      JSON.stringify({
        model: mode === "drift" && !probe ? "changed-reported-model" : "synthetic-model",
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 4 },
      }),
  };
};
async function fixture() {
  const t = tag(),
    source = `fallback-${t}`,
    url = `https://source.invalid/${t}`;
  await sql`INSERT INTO sources(id,name,kind,lane,enabled) VALUES(${source},${source},'external','news',false)`;
  await grantDateFixture(source, [url]);
  const materialInput = { sourceId: source, url, title: "SYNTHETIC stored original", bodyText: "fixture stored original", via: "fetch" as const };
  const material = await upsertMaterial(materialInput);
  const [user] = await sql`INSERT INTO admin_users(email,display_name) VALUES(${`${t}@fixture.invalid`},'SYNTHETIC Owner') RETURNING id`;
  await sql`DELETE FROM identity.account_access WHERE role='owner'`;
  await sql`INSERT INTO identity.account_access(user_id,role,models_manage,active,revision,must_change_password) VALUES(${user!.id},'owner',false,true,1,false)`;
  const owner = { userId: Number(user!.id), name: "SYNTHETIC Owner", csrf: "fixture", dev: false, accessRevision: 1 };
  const create = async (kind: string) => {
    const r = await createModelConnection(
      {
        name: `SYNTHETIC ${kind}`,
        interface: "openai-compatible",
        endpoint: `https://${kind}.fixture.invalid/v1`,
        model: "synthetic-model",
        input_cny_per_million: "0",
        output_cny_per_million: "0",
        billing_basis: "https://fixture.invalid/pricing",
        vision: false,
        json_mode: true,
        secret: "fake-key",
        owner_confirmed: true,
        supplier_basis: "https://fixture.invalid/terms",
        reason: "SYNTHETIC fixture only",
      },
      owner,
    );
    await installUsageFixtureForModel(r.key, sql);
    const probe = await requestModelConnectionProbe(r.id, { expected_revision: 1, lane: "news" }, owner);
    assert.equal((await runModelConnectionProbe(probe.id, { transport })).status, "passed");
    return r;
  };
  const primary = await create("primary"),
    backup = await create("backup");
  await sql`DELETE FROM ai.model_routes WHERE capability='summarize'`;
  const [previousBackup] = await sql`SELECT revision FROM ai.model_fallback_routes WHERE capability='summarize'`;
  const routeRevision = Number(previousBackup?.revision ?? 0) + 1;
  await assignRegisteredModel(
    "summarize",
    { model: primary.key, expected_revision: 0, reason: "SYNTHETIC primary assignment", evaluation_id: null, emergency_confirmed: true },
    owner,
  );
  const promptVersion = (await capabilityPrompt("summarize"))!,
    base = {
      purpose: "summarize_article",
      schema,
      system: "SYNTHETIC fixture only",
      promptVersion,
      lane: "news" as const,
      sourceIds: [source],
      registeredTransport: transport,
    };
  const evaluationMaterial = await upsertMaterial({ ...materialInput, url: `${url}/evaluation`, bodyText: "SYNTHETIC held-out material" });
  const evaluationBody = (await readCurrentBody(evaluationMaterial.articleId))!;
  const evaluationInput = await prepareNewsFallback({
    root,
    expected: evaluationBody,
    current: () => readCurrentBody(evaluationMaterial.articleId),
    articles: [evaluationBody],
  });
  assert.ok(evaluationInput);
  const evaluationRequest = { system: base.system, user: evaluationBody.body_text! };
  const evaluation = await chatJson({
    ...base,
    ...evaluationRequest,
    model: backup.key,
    subject: `article:${evaluationMaterial.articleId}@${evaluationBody.revision}`,
    fallbackPermit: evaluationInput(evaluationRequest),
    usagePurpose: "evaluation",
  });
  await completeReceipt(sql, evaluation.receiptId);
  const run = await importSelectBenchRun(
    {
      models: { [backup.key]: { summary: { n: 1 }, cases: [{ caseId: t, title: "SYNTHETIC", gold: "ok", decision: "ok", receiptId: evaluation.receiptId }] } },
    },
    "SYNTHETIC no actual Owner approval",
    `admin:${owner.userId}`,
  );
  await approveModelRoute(
    {
      runId: run.id,
      capability: "summarize",
      modelKey: backup.key,
      goldHash: sha256(stableJson([[t, "ok"]])),
      reviewEvidence: "SYNTHETIC isolation only; no actual Owner approval",
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      heldOutReviewed: true,
      sealedReviewed: true,
      shadowReviewed: true,
      canaryReviewed: true,
      qualityAccepted: true,
      reason: "SYNTHETIC fixture",
    },
    owner,
  );
  await changeModelFallback(
    "summarize",
    { expected_revision: routeRevision - 1, backup_model: backup.key, source_ids: [source], reason: "SYNTHETIC fixture" },
    owner,
  );
  const snapshot = async () => {
    const [current] = await newsMaterialBindings([material.articleId]);
    assert.ok(current?.content_hash);
    return {
      inputFingerprint: sha256(stableJson(current)),
      manifest: {
        schema_version: 1 as const,
        kind: "source_materials" as const,
        lane: "news" as const,
        materials: [
          {
            source_id: current.source_id,
            material_id: current.id,
            revision: current.revision,
            content_hash: current.content_hash,
            resource: { url: current.url, document_type: null, attachment: false },
          },
        ],
        upstream_artifacts: [],
      },
    };
  };
  const fallbackPermit = createFallbackPermitPort({ root, snapshot: await snapshot(), current: snapshot });
  const call = (name: string) =>
    chatJson({ ...base, model: primary.key, subject: `fallback:${t}:${name}`, user: `SYNTHETIC production material ${name}`, fallbackPermit });
  return {
    owner,
    source,
    primary,
    backup,
    call,
    routeRevision,
    base,
    changeInput: async () => {
      const changed = await upsertMaterial({ ...materialInput, bodyText: "changed" });
      assert.equal(changed.revision, material.revision + 1);
    },
  };
}
test("one qualified alternate has independent real receipts and is recovered free; denied configuration stays unselectable", async () => {
  mode = "ok";
  const f = await fixture(),
    before = events.length;
  const result = await f.call("one");
  assert.equal(result.model, f.backup.key);
  assert.deepEqual(events.slice(before), ["primary", "backup"]);
  const repeats = await Promise.all([f.call("one"), f.call("one")]);
  assert.ok(repeats.every((r) => r.reused && r.receiptId === result.receiptId));
  assert.equal(events.length, before + 2);
  const [proof] =
    await sql`SELECT a.failure_kind,a.status,r.backup_receipt_id FROM ai.model_fallback_resolutions r JOIN receipt_attempts a ON a.id=r.primary_attempt_id WHERE r.backup_receipt_id=${result.receiptId}`;
  assert.equal(proof!.failure_kind, "connect_before_send");
  assert.equal(proof!.status, "failed");
  await assert.rejects(disableModelConnection(f.backup.id, { expected_revision: 1, reason: "cannot disable active backup" }, f.owner));
  await assert.rejects(changeModelFallback("summarize", { expected_revision: 0, backup_model: null, source_ids: [], reason: "stale" }, f.owner), /其他操作/);
  const view = await modelFallbacks(f.owner),
    row = view.routes.find((r) => r.capability === "summarize")!;
  assert.equal(row.state, "ready");
  assert.ok(row.choices.some((c) => !c.eligible && c.reason));
});
test("HTTP billing uncertainty and unknown alternate never retry or hop again", async () => {
  mode = "ok";
  const f = await fixture();
  mode = "http";
  let before = events.length;
  await assert.rejects(f.call("http"), ReceiptUnknownError);
  await assert.rejects(f.call("http"), ReceiptUnknownError);
  assert.deepEqual(events.slice(before), ["primary"]);
  mode = "backup-unknown";
  before = events.length;
  await assert.rejects(f.call("unknown"), ReceiptUnknownError);
  await assert.rejects(f.call("unknown"), ReceiptUnknownError);
  assert.deepEqual(events.slice(before), ["primary", "backup"]);
  mode = "backup-connect";
  before = events.length;
  await assert.rejects(f.call("bounded"));
  await assert.rejects(f.call("bounded"), ReceiptPhysicalLimitError);
  assert.deepEqual(events.slice(before), ["primary", "backup"]);
});
test("known-cost filtering can use the admitted alternate; input and permission changes cannot", async () => {
  mode = "ok";
  const f = await fixture();
  mode = "filter";
  let before = events.length;
  const result = await f.call("filter");
  assert.equal(result.model, f.backup.key);
  assert.deepEqual(events.slice(before), ["primary", "backup"]);
  mode = "ok";
  before = events.length;
  onPrimary = async () => f.changeInput();
  await assert.rejects(f.call("changed"), /材料版本已变化/);
  assert.deepEqual(events.slice(before), ["primary"]);
  onPrimary = null;
  const fresh = await fixture();
  before = events.length;
  onPrimary = async () => {
    const p = (await readCurrentSourcePolicy(fresh.source))!;
    await saveSourcePolicy(
      fresh.source,
      { expectedVersion: p.permission_version, policy: { ...p, permissions: { ...p.permissions, external_model: "deny" } }, reason: "SYNTHETIC denial" },
      "fixture",
    );
  };
  await assert.rejects(fresh.call("denied"), /许可未通过/);
  assert.deepEqual(events.slice(before), ["primary"]);
  onPrimary = null;
});
test("actual response identity drift blocks the assigned backup and retains paid evidence", async () => {
  mode = "ok";
  const f = await fixture();
  mode = "drift";
  const before = events.length;
  await assert.rejects(f.call("drift"), ModelFallbackBlocked);
  await assert.rejects(f.call("drift"), ModelFallbackBlocked);
  assert.deepEqual(events.slice(before), ["primary", "backup"]);
  assert.equal((await modelFallbacks(f.owner)).routes.find((r) => r.capability === "summarize")!.state, "blocked");
});

test("policy gateway requires the alternate's own physical-model quality release and current source language/recipe", async () => {
  mode = "ok";
  const f = await fixture();
  await sql`UPDATE sources SET lane='policy' WHERE id=${f.source}`;
  await sql`DELETE FROM ai.model_routes WHERE capability='policy_fulltext'`;
  await assignRegisteredModel(
    "policy_fulltext",
    { model: f.primary.key, expected_revision: 0, reason: "SYNTHETIC policy primary", evaluation_id: null, emergency_confirmed: true },
    f.owner,
  );
  const route = { expected_revision: 0, backup_model: f.backup.key, source_ids: [f.source], reason: "SYNTHETIC policy backup" };
  await assert.rejects(changeModelFallback("policy_fulltext", route, f.owner), /质量资格/);
  const [probe] = await sql`SELECT t.receipt_id,t.attempt_id::text FROM ai.model_connection_tests t WHERE t.connection_id=${f.backup.id} AND t.status='passed'`;
  const key = policyModelQualificationKey({
    receiptId: Number(probe!.receipt_id),
    attemptId: probe!.attempt_id,
    service: f.backup.key,
    requestedModel: f.backup.model,
    reportedModel: "synthetic-model",
    configurationHash: f.backup.configuration_hash,
    connectionId: f.backup.id,
    connectionRevision: 1,
  })!;
  const fulltextRecipe = `${promptVersion("policy-fulltext")}/candidate-v1`,
    interpretationRecipe = currentInterpretationQualification();
  const release = await installPolicyQualityRelease({
    sourceIds: [f.source],
    languages: ["es"],
    fulltextRecipe,
    interpretationRecipe,
    models: [key],
    reviewedBy: "owner",
    reviewEvidence: "SYNTHETIC local fixture; no actual Owner approval",
    evaluationHash: sha256("fixture"),
    reviewedAt: new Date(Date.now() - 1000).toISOString(),
    validUntil: new Date(Date.now() + 86400000).toISOString(),
  });
  await changeModelFallback("policy_fulltext", route, f.owner);
  const ref = { id: f.source, version: "1" },
    prepared = {
      manifest: {
        schema_version: 1 as const,
        kind: "source_materials" as const,
        lane: "policy" as const,
        materials: [
          {
            source_id: f.source,
            material_id: f.source,
            revision: 1,
            content_hash: sha256("synthetic original"),
            resource: { url: `https://source.invalid/${f.source.slice("fallback-".length)}`, document_type: null, attachment: false },
          },
        ],
        upstream_artifacts: [],
      },
      system: "SYNTHETIC policy",
      user: `SYNTHETIC ${f.source}`,
      promptVersion: promptVersion("policy-fulltext"),
      recipeVersion: fulltextRecipe,
      controlRevision: "1",
      processingAllowed: true,
    };
  const gateway = createPolicyGateway({
    root,
    registeredTransport: transport,
    fallbackPolicy: { language: "es", fulltextRecipe, interpretationRecipe },
    resolve: async () => structuredClone(prepared),
  });
  const before = events.length,
    result = await gateway.chat({ input: ref, purpose: "policy_fulltext", schema });
  assert.equal(result.model, f.backup.key);
  assert.deepEqual(events.slice(before), ["primary", "backup"]);
  await revokePolicyQualityRelease(release);
  await assert.rejects(gateway.chat({ input: ref, purpose: "policy_fulltext", schema }), ModelFallbackBlocked);
  assert.equal(events.length, before + 2);
});

test("filtered output remains reusable after rejection and route waits do not consume article failure attempts", async () => {
  mode = "ok";
  const f = await fixture();
  await changeModelFallback("summarize", { expected_revision: f.routeRevision, backup_model: null, source_ids: [], reason: "SYNTHETIC no alternate" }, f.owner);
  mode = "filter";
  const before = events.length;
  let refused: ModelContentFiltered | null = null;
  await assert.rejects(f.call("filter-without-backup"), (error) => {
    if (error instanceof ModelContentFiltered) {
      refused = error;
      return true;
    }
    return false;
  });
  const known = refused as ModelContentFiltered | null;
  assert.ok(known);
  await rejectReceivedResponse(known.receiptId, "SYNTHETIC downstream rejected filtered output", known.attemptId);
  await assert.rejects(f.call("filter-without-backup"), ModelContentFiltered);
  assert.deepEqual(events.slice(before), ["primary"]);
  const article = `fallback-wait-${tag()}`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at) VALUES(${article},${f.source},${article},${`https://fixture.invalid/${article}`},'synthetic',now(),now())`;
  const { afterFailure } = await import("../packages/backend/src/jobs/content.ts");
  assert.equal((await afterFailure(article, known)).state, "waiting");
  assert.equal((await sql`SELECT processing_attempts FROM articles WHERE id=${article}`)[0]!.processing_attempts, 0);
});
test("pause after primary failure prevents a backup claim and resumes the same one-shot decision later", async () => {
  mode = "ok";
  const f = await fixture(),
    controls = await listLaneControls(),
    revision = controls.owner_revisions.find((r) => r.lane === "news" && r.switch === "processing")!.revision;
  onPrimary = async () => {
    await changeOwnerLaneControls(
      {
        lane: "news",
        mode: "processing",
        action: "pause",
        reason: "SYNTHETIC inter-send pause",
        expected_revisions: { processing: revision },
        expires_at: new Date(Date.now() + 60000).toISOString(),
      },
      "synthetic",
    );
  };
  const before = events.length;
  try {
    await assert.rejects(f.call("pause"));
    assert.deepEqual(events.slice(before), ["primary"]);
  } finally {
    onPrimary = null;
    await changeOwnerLaneControls(
      { lane: "news", mode: "processing", action: "resume", reason: "SYNTHETIC resume", expected_revisions: { processing: revision + 1 } },
      "synthetic",
    );
  }
  const resumed = (await modelFallbacks(f.owner)).routes.find((r) => r.capability === "summarize")!;
  assert.equal(resumed.state, "ready", JSON.stringify(resumed));
  const decisions = await sql`SELECT backup_model,blocked_reason FROM ai.model_fallback_resolutions WHERE backup_model=${f.backup.key}`;
  assert.equal(decisions.length, 1, `decision after pause: ${JSON.stringify(decisions)}`);
  assert.equal((await f.call("pause")).model, f.backup.key);
  assert.deepEqual(events.slice(before), ["primary", "backup"]);
});

test("real news material preparation consumes the same fallback gateway and rejects a changed stored revision", async () => {
  mode = "ok";
  const f = await fixture(),
    article = `news-fallback-${tag()}`,
    body = "SYNTHETIC immutable stored news body";
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,body_text,body_status,content_hash,discovered_at,timeline_at) VALUES(${article},${f.source},${article},${`https://source.invalid/${f.source.slice("fallback-".length)}`},'synthetic',${body},'ok',${sha256(body)},now(),now())`;
  const current = async () => {
    const [row] = await sql<{ id: string; revision: number; body_text: string }[]>`SELECT id,revision,body_text FROM articles WHERE id=${article}`;
    return row ?? null;
  };
  const expected = (await current())!,
    prepare = await prepareNewsFallback({ root, expected, current, articles: [{ id: article, revision: expected.revision }] });
  assert.ok(prepare);
  const request = { system: f.base.system, user: body },
    options = { ...f.base, ...request, model: f.primary.key, subject: `article:${article}@${expected.revision}`, fallbackPermit: prepare(request) };
  const before = events.length,
    result = await chatJson(options);
  assert.equal(result.model, f.backup.key);
  assert.deepEqual(events.slice(before), ["primary", "backup"]);
  await sql`UPDATE articles SET revision=revision+1,body_text='changed',content_hash=${sha256("changed")} WHERE id=${article}`;
  await assert.rejects(chatJson(options), ModelFallbackBlocked);
  assert.equal(events.length, before + 2);
});
