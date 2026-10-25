import { installModules, serverModules } from "@amp/backend/modules";
import { CircuitOpenError, enterModelCircuit, recordModelHealth, modelCircuits, modelCircuitKey } from "../packages/backend/src/providers/circuit.ts";
import { recoverUnknownOnce } from "../packages/backend/src/providers/unknown-recovery.ts";
import { providerRejection } from "../packages/backend/src/providers/provider-errors.ts";
import { prepareNewsFallback } from "../packages/backend/src/providers/news-fallback.ts";
import { changeOwnerLaneControls, listLaneControls } from "../packages/backend/src/operations/lane-controls.ts";
import { createPolicyGateway } from "../modules/policy/backend/provider.ts";
import { installPolicyQualityRelease, revokePolicyQualityRelease } from "../modules/policy/backend/domain/quality.ts";
import { modelConfigurationIdentity } from "../packages/backend/src/admin/models.ts";
import { currentInterpretationQualification } from "../modules/policy/backend/domain/fallback-quality.ts";
import { policyModelQualificationKey } from "../modules/policy/backend/domain/model-evidence.ts";
import { promptVersion } from "../packages/backend/src/editorial/prompts.ts";
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { sql, initializeDb, closeDb } from "@amp/backend/db";
import { upsertMaterial, readCurrentBody, newsMaterialBindings } from "@amp/backend/content/materials";
import { config } from "@amp/backend/config";
import { sha256, stableJson } from "@amp/backend/lib/ids";
import { chatJson, ModelOutputError, type RegisteredModelTransport } from "../packages/backend/src/providers/llm.ts";
import { completeReceipt, rejectReceivedResponse, ReceiptUnknownError, ProviderRejectedError } from "../packages/backend/src/providers/receipts.ts";
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
import { ModelFallbackBlocked, ModelContentFiltered, isModelRouteWaiting } from "../packages/backend/src/providers/model-fallback.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
import { readCurrentSourcePolicy, saveSourcePolicy } from "../packages/backend/src/admin/sources.ts";
const root = await initializeDb("test");
process.env.MODEL_REGISTRY_ENCRYPTION_KEY = Buffer.alloc(32, 28).toString("base64");
config.modelCallsEnabled = true;
after(closeDb);
const schema = z.strictObject({ ok: z.literal(true) }),
  events: string[] = [],
  requestTimeouts: number[] = [];
let mode = "ok",
  onPrimary: (() => Promise<void>) | null = null;
const transport: RegisteredModelTransport = async (url, options) => {
  const body = JSON.parse(options.body!),
    which = url.includes("primary") ? "primary" : "backup";
  events.push(which);
  requestTimeouts.push(options.timeoutMs ?? 0);
  const probe = body.max_tokens < 512;
  if (!probe && which === "primary") {
    if (onPrimary) await onPrimary();
    if (mode !== "primary-ok") {
      if (mode === "http-refused") return { status: 401, headers: new Headers(), text: () => "invalid credentials" };
      if (mode === "credit-refused")
        return { status: 429, headers: new Headers(), text: () => JSON.stringify({ error: { code: "CreditLimitExceeded", message: "out of credit" } }) };
      if (["primary-unknown", "both-unknown", "unknown-filter", "unknown-invalid-output"].includes(mode))
        throw new Error("synthetic after-send connection reset");
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
  if (!probe && which === "backup" && mode === "unknown-invalid-output")
    return {
      status: 200,
      headers: new Headers(),
      text: () =>
        JSON.stringify({
          model: "synthetic-model",
          choices: [{ message: { content: "not-json" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 4 },
        }),
    };
  if (!probe && which === "backup" && mode === "unknown-filter")
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
  if (!probe && which === "backup" && ["backup-unknown", "both-unknown"].includes(mode)) throw new Error("synthetic after-send reset");
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
async function fixture(capability: "summarize" | "translate" = "summarize", options: { primaryModel?: string; keepHealth?: boolean } = {}) {
  if (!options.keepHealth) await sql`DELETE FROM ai.model_service_circuits`;
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
        model: kind === "primary" ? (options.primaryModel ?? "synthetic-model") : "synthetic-model",
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
  await sql`DELETE FROM ai.model_routes WHERE capability=${capability}`;
  const [previousBackup] = await sql`SELECT revision FROM ai.model_fallback_routes WHERE capability=${capability}`;
  const routeRevision = Number(previousBackup?.revision ?? 0) + 1;
  await assignRegisteredModel(
    capability,
    { model: primary.key, expected_revision: 0, reason: "SYNTHETIC primary assignment", evaluation_id: null, emergency_confirmed: true },
    owner,
  );
  const promptVersion = (await capabilityPrompt(capability))!,
    base = {
      purpose: capability === "translate" ? "translate_body" : "summarize_article",
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
      capability: capability,
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
    capability,
    { expected_revision: routeRevision - 1, backup_model: backup.key, source_ids: [source], reason: "SYNTHETIC fixture" },
    owner,
  );
  const snapshot = async (id = material.articleId) => {
    const [current] = await newsMaterialBindings([id]);
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
  const call = (name: string, subject = `fallback:${t}:${name}`, timeoutMs?: number) =>
    chatJson({
      ...base,
      model: primary.key,
      subject,
      user: `SYNTHETIC production material ${name}`,
      timeoutMs,
      fallbackPermit,
      ...(capability === "translate" ? { maxRejectedOutputs: 1 as const } : {}),
    });
  return {
    owner,
    source,
    articleId: material.articleId,
    permitFor: async (id: string) => createFallbackPermitPort({ root, snapshot: await snapshot(id), current: () => snapshot(id) }),
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
test("a temporary HTTP failure uses the evaluated alternate while unknown bills and alternate decisions remain durable", async () => {
  mode = "ok";
  const f = await fixture();
  mode = "http";
  let before = events.length;
  const response = await f.call("http");
  assert.equal(response.model, f.backup.key);
  assert.equal((await f.call("http")).receiptId, response.receiptId);
  assert.deepEqual(events.slice(before), ["primary", "backup"]);
  const [httpAttempt] =
    await sql`SELECT a.failure_kind,a.status,u.state FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id JOIN ai.usage_attempts u ON u.attempt_id=a.id WHERE r.subject LIKE ${"%:http"} AND a.service=${f.primary.key}`;
  assert.deepEqual(
    { ...httpAttempt },
    { failure_kind: "provider_outage", status: "failed", state: "failed" },
    "a new explicit provider rejection is distinct from an unknown transport outcome",
  );
  for (const refusal of ["http-refused", "credit-refused"]) {
    mode = refusal;
    before = events.length;
    await assert.rejects(f.call(refusal), (error) => error instanceof ProviderRejectedError && !error.retryable && !isModelRouteWaiting(error));
    assert.deepEqual(events.slice(before), ["primary"], "access or spending refusals need the operator, not another paid supplier");
    await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE service=${f.primary.key} AND subject LIKE ${"%:" + refusal}`;
    assert.deepEqual(
      await recoverUnknownOnce(Date.now(), async () => true),
      { released: 0, requeued: 0 },
      "account refusal is not an unknown network outcome to retry automatically",
    );
  }
  mode = "backup-unknown";
  before = events.length;
  await assert.rejects(f.call("unknown"), ReceiptUnknownError);
  await assert.rejects(f.call("unknown"), ReceiptUnknownError);
  assert.deepEqual(events.slice(before), ["primary", "backup"]);
  mode = "backup-connect";
  before = events.length;
  await assert.rejects(f.call("bounded"));
  await assert.rejects(f.call("bounded"), ProviderRejectedError);
  assert.deepEqual(
    events.slice(before),
    ["primary", "backup", "primary", "backup"],
    "a failed alternate returns to the primary before choosing the evaluated backup again",
  );
});
test("news refusal does not choose another provider; changed input and permissions also stop the alternate", async () => {
  mode = "ok";
  const f = await fixture();
  mode = "filter";
  let before = events.length;
  await assert.rejects(f.call("filter"), ModelContentFiltered);
  assert.deepEqual(events.slice(before), ["primary"]);
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
  mode = "primary-ok";
  assert.equal((await f.call("drift")).model, f.primary.key, "an ineligible alternate does not prevent recovery of the configured primary");
  assert.deepEqual(events.slice(before), ["primary", "backup", "primary"]);
  assert.equal((await modelFallbacks(f.owner)).routes.find((r) => r.capability === "summarize")!.state, "blocked");
});

test("policy gateway requires the alternate's own physical-model quality release and current source language/recipe", async (t) => {
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
  const installed = serverModules();
  t.after(() => installModules(installed));
  installModules([
    ...installed,
    {
      name: "synthetic-policy-step",
      models: { module_fulltext: { label: "合成法规步骤", env: "SYNTHETIC_POLICY_MODULE", lane: "policy", purposes: ["synthetic_policy_module"] } },
    },
  ]);
  await assignRegisteredModel(
    "module_fulltext",
    { model: f.primary.key, expected_revision: 0, reason: "合成模块", evaluation_id: null, emergency_confirmed: true },
    f.owner,
  );
  await changeModelFallback("module_fulltext", route, f.owner);
  const inputFingerprint = sha256(stableJson(prepared.manifest));
  const modulePermit = createFallbackPermitPort({
    root,
    snapshot: { inputFingerprint, manifest: prepared.manifest },
    current: async () => ({ inputFingerprint, manifest: prepared.manifest }),
  });
  const moduleRequest = {
    ...f.base,
    model: f.primary.key,
    purpose: "synthetic_policy_module",
    lane: "policy" as const,
    fallbackPermit: modulePermit,
    policyContext: {
      lane: "policy" as const,
      category: "policy_fulltext" as const,
      sourceIds: [f.source],
      manifestHash: sha256(stableJson(prepared.manifest)),
      inputFingerprint,
      permissionVersions: {},
      manifest: prepared.manifest,
    },
    beforeRequest: async () => {},
  };
  for (const context of [undefined, { language: "en", fulltextRecipe, interpretationRecipe }]) {
    const start = events.length;
    await assert.rejects(
      chatJson({ ...moduleRequest, subject: `policy-module:${tag()}`, user: `SYNTHETIC module ${tag()}`, fallbackPolicy: context }),
      ProviderRejectedError,
    );
    assert.deepEqual(events.slice(start), ["primary"], "missing or mismatched quality context cannot select a backup");
  }
  const moduleStart = events.length;
  const moduleResult = await chatJson({
    ...moduleRequest,
    subject: `policy-module:${tag()}`,
    user: `SYNTHETIC qualified module ${tag()}`,
    fallbackPolicy: { language: "es", fulltextRecipe, interpretationRecipe },
  });
  assert.equal(moduleResult.model, f.backup.key);
  assert.deepEqual(events.slice(moduleStart), ["primary", "backup"]);
  const afterModule = events.length;
  await revokePolicyQualityRelease(release);
  await assert.rejects(gateway.chat({ input: ref, purpose: "policy_fulltext", schema }), ModelFallbackBlocked);
  assert.equal(events.length, afterModule);
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
  assert.equal(requestTimeouts[before], 120_000, "without an evaluated backup the ordinary timeout remains unchanged");
  assert.equal(Object.keys(await modelCircuits()).length, 0, "a route without a backup does not start failover health tracking");
  const known = refused as ModelContentFiltered | null;
  assert.ok(known);
  await rejectReceivedResponse(known.receiptId, "SYNTHETIC downstream rejected filtered output", known.attemptId);
  await assert.rejects(f.call("filter-without-backup"), ModelContentFiltered);
  assert.deepEqual(events.slice(before), ["primary"]);
  const article = `fallback-wait-${tag()}`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at) VALUES(${article},${f.source},${article},${`https://fixture.invalid/${article}`},'synthetic',now(),now())`;
  const { afterFailure } = await import("../packages/backend/src/jobs/content.ts");
  assert.equal((await afterFailure(article, known, 1)).state, "waiting");
  assert.equal((await sql`SELECT processing_attempts FROM articles WHERE id=${article}`)[0]!.processing_attempts, 0);
});
test("pause prevents a backup claim; after resume a recovered primary can finish the request", async () => {
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
  mode = "primary-ok";
  const result = await f.call("pause");
  assert.equal(result.model, f.primary.key);
  assert.equal((await f.call("pause")).receiptId, result.receiptId);
  assert.deepEqual(events.slice(before), ["primary", "primary"]);
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

test("temporary throttling stays distinct from account and spending refusals", () => {
  for (const [service, status, body, expected] of [
    ["deepseek", 503, "service unavailable", "provider_outage"],
    ["deepseek", 429, '{"error":{"code":"rate_limit","message":"try later"}}', "provider_outage"],
    ["deepseek", 401, "invalid key", "provider_refused"],
    ["mimo", 429, '{"code":"CreditLimitExceeded","message":"credit limit"}', "provider_refused"],
    ["zhipu", 429, '{"error":{"code":1113,"message":"account limit"}}', "provider_refused"],
    ["dashscope", 429, '{"code":"insufficient_quota","message":"TPM throttle"}', "provider_outage"],
    ["dashscope", 429, '{"code":"insufficient_quota","message":"Free allocated quota exceeded."}', "provider_refused"],
    ["model:custom.invalid", 429, '{"message":"insufficient account balance"}', "provider_refused"],
    ["model:custom.invalid", 400, "bad request", "provider_refused"],
  ] as const)
    assert.equal(providerRejection(service, status, body).failureKind, expected);
  assert.match(
    providerRejection("mimo", 429, JSON.stringify({ error: { code: "CreditLimitExceeded", message: "x".repeat(900) } })).message,
    /CreditLimitExceeded/,
  );
});

test("a real news scope can continue an unknown primary only through its bound alternate", async () => {
  mode = "ok";
  const f = await fixture(),
    subject = `article:${f.articleId}@1`;
  mode = "primary-unknown";
  const before = events.length;
  const first = await f.call("first-news", subject);
  assert.equal(first.model, f.backup.key);
  assert.equal((await f.call("first-news", subject)).receiptId, first.receiptId);
  await sql`UPDATE ai.model_fallback_resolutions SET accepted_at=NULL WHERE backup_receipt_id=${first.receiptId}`;
  assert.equal((await f.call("first-news", subject)).receiptId, first.receiptId, "a cached result can be checked without paying again");
  const second = await f.call("second-news", subject);
  assert.equal(second.model, f.backup.key, "an accepted alternate resolves the work without erasing its unknown primary bill");
  assert.deepEqual(events.slice(before), ["primary", "backup", "primary", "backup"]);
  await rejectReceivedResponse(second.receiptId, "SYNTHETIC rejected alternate output", second.attemptId);
  assert.equal((await f.call("third-news", subject)).model, f.backup.key, "a distinct input is not blocked by an earlier rejected response");
  assert.equal(events.length, before + 6);
  const unknown =
    await sql`SELECT a.status,u.state FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id JOIN ai.usage_attempts u ON u.attempt_id=a.id WHERE r.subject=${subject} AND a.service=${f.primary.key}`;
  assert.equal(unknown.length, 3);
  assert.ok(unknown.every((row) => row.status === "unknown" && row.state === "unknown"));
  await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE subject=${subject} AND service=${f.primary.key}`;
  const resumed: number[] = [];
  await recoverUnknownOnce(Date.now(), async (row) => {
    resumed.push(row.id);
    return true;
  });
  assert.deepEqual(resumed, [], "a handed-off primary remains for billing and is never automatically revived");
});

test("translation advances past a completed alternate while retaining both unknown primary observations", async () => {
  mode = "ok";
  const f = await fixture("translate"),
    before = events.length;
  mode = "primary-unknown";
  const subject = `article:${f.articleId}@1#0`;
  const first = await f.call("first-translation", subject);
  const second = await f.call("second-translation", `article:${f.articleId}@1#1`);
  assert.equal(first.model, f.backup.key);
  assert.equal(second.model, f.backup.key);
  assert.deepEqual(events.slice(before), ["primary", "backup", "primary", "backup"]);
  const observations =
    await sql`SELECT o.attempt_id,a.status FROM ai.translation_receipt_observations o JOIN receipt_attempts a ON a.id::text=o.attempt_id WHERE o.scope=${`article:${f.articleId}@1`} ORDER BY a.id`;
  assert.deepEqual(
    observations.map((row) => row.status),
    ["unknown", "received", "unknown", "received"],
  );
});

test("only the unknown alternate receives one timed recovery; the primary stays handed off", async () => {
  mode = "ok";
  const f = await fixture(),
    subject = `article:${f.articleId}@1`,
    before = events.length;
  mode = "both-unknown";
  await assert.rejects(f.call("both-unknown", subject), ReceiptUnknownError);
  const [handoff] = await sql`SELECT primary_receipt_id,backup_receipt_id FROM ai.model_fallback_resolutions WHERE backup_model=${f.backup.key}`;
  assert.ok(handoff?.backup_receipt_id);
  await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE id IN (${handoff.primary_receipt_id},${handoff.backup_receipt_id})`;
  const resumed: number[] = [];
  await recoverUnknownOnce(Date.now(), async (row) => {
    resumed.push(row.id);
    return true;
  });
  assert.deepEqual(resumed, [handoff.backup_receipt_id]);
  await assert.rejects(f.call("both-unknown", subject), ReceiptUnknownError);
  assert.deepEqual(events.slice(before), ["primary", "backup", "backup"]);
  await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE id IN (${handoff.primary_receipt_id},${handoff.backup_receipt_id})`;
  assert.deepEqual(await recoverUnknownOnce(Date.now(), async () => true), { released: 0, requeued: 0 });
  const attempts =
    await sql`SELECT a.status,u.state FROM receipt_attempts a JOIN ai.usage_attempts u ON u.attempt_id=a.id WHERE a.receipt_id IN (${handoff.primary_receipt_id},${handoff.backup_receipt_id})`;
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every((row) => row.status === "unknown" && row.state === "unknown"));
});

test("a refused alternate stays unusable without blocking another logical input", async () => {
  mode = "ok";
  const f = await fixture(),
    subject = `article:${f.articleId}@1`,
    before = events.length;
  mode = "unknown-filter";
  let refusedReceipt = 0;
  await assert.rejects(f.call("filtered-alternate", subject), (error) => {
    if (!(error instanceof ModelContentFiltered)) return false;
    refusedReceipt = error.receiptId;
    return true;
  });
  await assert.rejects(f.call("filtered-alternate", subject), ModelContentFiltered);
  assert.deepEqual(events.slice(before), ["primary", "backup"]);
  mode = "primary-unknown";
  assert.equal((await f.call("new-input-after-filter", subject)).model, f.backup.key);
  assert.deepEqual(events.slice(before), ["primary", "backup", "primary", "backup"]);
  const [decision] = await sql`SELECT accepted_at,blocked_reason FROM ai.model_fallback_resolutions WHERE backup_receipt_id=${refusedReceipt}`;
  assert.equal(decision.accepted_at, null);
  assert.equal(decision.blocked_reason, null, "a single content refusal does not revoke the service's quality qualification");
});

test("model configuration cooldown avoids phantom primary attempts and admits one recovery probe across concurrent callers", async () => {
  mode = "ok";
  const f = await fixture(),
    service = modelCircuitKey("model:primary.fixture.invalid", (await modelConfigurationIdentity(f.primary.key)).configuration_hash!);
  mode = "primary-ok";
  const primaryCache = await f.call("healthy-cached-primary");
  mode = "http";
  const before = events.length;
  for (let i = 0; i < 10; i++) await f.call(`outage-${i}`, undefined, i === 0 ? 75_000 : undefined);
  assert.equal(events.length - before, 20);
  assert.deepEqual(requestTimeouts.slice(before, before + 4), [75_000, 75_000, 30_000, 30_000]);
  const open = (await modelCircuits())[service]!;
  assert.equal(open.failures, 10);
  assert.ok(open.openUntil > Date.now());
  const view = (await modelFallbacks(f.owner)).routes.find((row) => row.capability === "summarize")!;
  assert.equal(view.state, "ready");
  assert.match(view.detail!, /主模型暂时不可用/);
  await f.call("cooled-primary");
  assert.deepEqual(events.slice(before + 20), ["backup"]);
  const [decision] =
    await sql`SELECT primary_receipt_id,primary_attempt_id,primary_circuit FROM ai.model_fallback_resolutions WHERE backup_model=${f.backup.key} AND primary_circuit IS NOT NULL`;
  assert.equal(decision.primary_receipt_id, null);
  assert.equal(decision.primary_attempt_id, null);
  assert.equal(decision.primary_circuit.service, service);
  assert.equal((await sql`SELECT id FROM receipts WHERE service=${f.primary.key} AND subject LIKE '%:cooled-primary'`).length, 0);
  const cachedBefore = events.length;
  assert.equal((await f.call("healthy-cached-primary")).receiptId, primaryCache.receiptId);
  await f.call("outage-0", undefined, 75_000);
  assert.equal(events.length, cachedBefore);
  assert.deepEqual((await modelCircuits())[service], open, "cache reuse cannot report the service healthy");
  await sql`UPDATE ai.model_service_circuits SET state=state || ${sql.json({ openUntil: Date.now() - 1, probeUntil: 0 })} WHERE service=${service}`;
  const probes = await Promise.allSettled(Array.from({ length: 6 }, () => sql.begin((tx) => enterModelCircuit(tx, service, 30_000))));
  const admitted = probes.filter((result) => result.status === "fulfilled");
  assert.equal(admitted.length, 1);
  assert.ok(probes.filter((result) => result.status === "rejected").every((result) => result.reason instanceof CircuitOpenError));
  const first = admitted[0]!.value;
  await recordModelHealth(service, { probe: null }, false);
  assert.equal((await modelCircuits())[service]!.probe, first.probe, "old ordinary success cannot close an open circuit");
  await sql`UPDATE ai.model_service_circuits SET state=state || ${sql.json({ probeUntil: Date.now() - 1 })} WHERE service=${service}`;
  const replacement = await sql.begin((tx) => enterModelCircuit(tx, service, 30_000));
  await recordModelHealth(service, first, false);
  assert.equal((await modelCircuits())[service]!.probe, replacement.probe, "an expired probe cannot close a replacement lease");
  await recordModelHealth(service, replacement, true);
  assert.ok((await modelCircuits())[service]!.openUntil > Date.now());
  await sql`UPDATE ai.model_service_circuits SET state=state || ${sql.json({ openUntil: Date.now() - 1, probeUntil: 0 })} WHERE service=${service}`;
  mode = "primary-ok";
  const recovered = await f.call("service-recovered");
  assert.equal(recovered.model, f.primary.key);
  assert.equal((await modelCircuits())[service]!.openUntil, 0);
  assert.equal((await modelCircuits())[service]!.failures, 0);
});

test("an unusable alternate is linked when claimed, before response parsing can fail", async () => {
  mode = "ok";
  const f = await fixture();
  mode = "unknown-invalid-output";
  await assert.rejects(f.call("invalid-alternate"), ModelOutputError);
  const [decision] =
    await sql`SELECT f.primary_receipt_id,f.backup_receipt_id,f.backup_attempt_id,r.status,a.response FROM ai.model_fallback_resolutions f JOIN receipts r ON r.id=f.backup_receipt_id JOIN receipt_attempts a ON a.id=f.backup_attempt_id WHERE f.backup_model=${f.backup.key}`;
  assert.ok(decision?.backup_receipt_id && decision.response);
  assert.equal(decision.status, "failed");
  await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE id=${decision.primary_receipt_id}`;
  assert.deepEqual(
    await recoverUnknownOnce(Date.now(), async () => true),
    { released: 0, requeued: 0 },
    "an actual alternate claim keeps its original request out of automatic replay",
  );
});

test("after an alternate clearly fails, a recovered primary wins and its result is reused", async () => {
  mode = "ok";
  const f = await fixture(),
    before = events.length;
  mode = "backup-connect";
  await assert.rejects(f.call("recover-primary"), ProviderRejectedError);
  mode = "primary-ok";
  const result = await f.call("recover-primary");
  assert.equal(result.model, f.primary.key);
  assert.equal((await f.call("recover-primary")).receiptId, result.receiptId);
  assert.deepEqual(events.slice(before), ["primary", "backup", "primary"]);
});

test("identical paid alternate output is reused for another currently permitted material", async () => {
  mode = "ok";
  const f = await fixture();
  const result = await f.call("shared-output"),
    before = events.length;
  const original = (await readCurrentBody(f.articleId))!;
  const [binding] = await newsMaterialBindings([f.articleId]);
  const other = await upsertMaterial({ sourceId: f.source, url: binding!.url + "/shared", title: original.title, bodyText: original.body_text!, via: "fetch" });
  const reused = await chatJson({
    ...f.base,
    model: f.primary.key,
    subject: `article:${other.articleId}@1`,
    user: "SYNTHETIC production material shared-output",
    fallbackPermit: await f.permitFor(other.articleId),
  });
  assert.equal(reused.receiptId, result.receiptId);
  assert.ok(reused.reused);
  assert.equal(events.length, before, "a current source permit does not require buying identical model text again");
});

test("one unavailable model cannot cool down a healthy model on the same request-quota service", async () => {
  mode = "ok";
  const failing = await fixture();
  mode = "http";
  for (let i = 0; i < 10; i++) await failing.call(`isolated-model-outage-${i}`);
  mode = "ok";
  const healthy = await fixture("translate", { primaryModel: "another-model", keepHealth: true });
  mode = "primary-ok";
  const before = events.length;
  const result = await healthy.call("healthy-sibling-model");
  assert.equal(result.model, healthy.primary.key, "a different model must still reach its healthy primary");
  assert.deepEqual(events.slice(before), ["primary"]);
  const [quota] = await sql`SELECT a.quota_service FROM receipt_attempts a WHERE a.receipt_id=${result.receiptId}`;
  assert.equal(quota.quota_service, "model:primary.fixture.invalid", "availability isolation must not split the shared request budget");
});
