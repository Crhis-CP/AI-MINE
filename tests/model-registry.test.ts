import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { dbOf, closeDb } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { publicApiCredentialNames, environmentProblems } from "@amp/config";
import {
  createModelConnection,
  updateModelConnection,
  disableModelConnection,
  requestModelConnectionProbe,
  assignRegisteredModel,
  listModelConnections,
  type ModelRegistryGuards,
} from "../packages/backend/src/admin/model-registry.ts";
import { runModelConnectionProbe, queueModelConnectionProbe, registerModelConnectionProbeJobs } from "../packages/backend/src/providers/model-probe.ts";
import { sealModelSecret, openModelSecret } from "../packages/backend/src/providers/model-vault.ts";
import { chatJson, type RegisteredModelTransport } from "../packages/backend/src/providers/llm.ts";
import { modelFor } from "../packages/backend/src/editorial/models.ts";
import { changeOwnerLaneControls, listLaneControls } from "../packages/backend/src/operations/lane-controls.ts";
import { resolveRegisteredModel } from "../packages/backend/src/providers/model-registry.ts";
import { getBoss, stopBoss } from "@amp/backend/jobs/queue";
import { readModelConnectionProbe } from "../packages/backend/src/admin/model-registry.ts";
const sql = dbOf("ai-gateway");
process.env.MODEL_REGISTRY_ENCRYPTION_KEY = Buffer.alloc(32, 87).toString("base64");
config.modelCallsEnabled = true;
const owner = { userId: 123, name: "test-owner", csrf: "fake", dev: false },
  manager = { ...owner, userId: 124 };
const guards: ModelRegistryGuards = {
  async manage(p) {
    assert.ok([123, 124].includes(p.userId!));
  },
  async owner(p) {
    if (p.userId !== 123) throw Object.assign(new Error("owner required"), { statusCode: 403 });
  },
};
const secret = 'fake-registry-only-secret"quoted';
const connection = {
  name: "Synthetic test only",
  interface: "openai-compatible" as const,
  endpoint: "https://fixture.invalid/v1",
  model: "synthetic-model",
  input_cny_per_million: "2",
  output_cny_per_million: "4",
  billing_basis: "https://fixture.invalid/prices",
  vision: false,
  json_mode: true,
};
const create = () =>
  createModelConnection(
    { ...connection, secret, owner_confirmed: true, supplier_basis: "https://fixture.invalid/quote", reason: "synthetic fixture" },
    owner,
    guards,
  );
let calls = 0;
const transport: RegisteredModelTransport = async (_url, options) => {
  calls++;
  assert.equal(options.maxRedirects, 0);
  assert.equal(options.route, "direct");
  const request = JSON.parse(options.body!);
  assert.equal(request.model, "synthetic-model");
  return {
    status: 200,
    headers: new Headers(),
    text: () =>
      JSON.stringify({
        id: `synthetic-${calls}`,
        echo: secret,
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      }),
  };
};
async function passing() {
  const row = await create(),
    probe = await requestModelConnectionProbe(row.id, { expected_revision: row.revision, lane: "news" }, owner, guards);
  const result = await runModelConnectionProbe(probe.id, { transport });
  assert.equal(result.status, "passed");
  return row;
}
after(async () => {
  await stopBoss();
  await closeDb();
});
test("vault is authenticated and bound to the connection; protected key cannot enter public or isolated processes", () => {
  const sealed = sealModelSecret(secret, "connection:secret-version");
  assert.equal(openModelSecret(sealed, "connection:secret-version"), secret);
  assert.throws(() => openModelSecret(sealed, "other"));
  assert.throws(() => openModelSecret({ ...sealed, ciphertext: Buffer.alloc(32).toString("base64") }, "connection:secret-version"));
  assert.deepEqual(publicApiCredentialNames({ MODEL_REGISTRY_ENCRYPTION_KEY: "fake" }), ["MODEL_REGISTRY_ENCRYPTION_KEY"]);
  assert.ok(environmentProblems("web", { MODEL_REGISTRY_ENCRYPTION_KEY: "fake" }).length);
  assert.ok(environmentProblems("fetcher", { MODEL_REGISTRY_ENCRYPTION_KEY: "fake" }).length);
});
test("missing guard/key and missing prices fail closed; manager cannot create or replace secrets", async () => {
  await assert.rejects(createModelConnection({}, owner));
  await assert.rejects(
    createModelConnection({ ...connection, secret, owner_confirmed: true, supplier_basis: "https://fixture.invalid/quote", reason: "test" }, manager, guards),
  );
  await assert.rejects(createModelConnection({ ...connection, input_cny_per_million: undefined, secret }, owner, guards));
  const key = process.env.MODEL_REGISTRY_ENCRYPTION_KEY!;
  delete process.env.MODEL_REGISTRY_ENCRYPTION_KEY;
  await assert.rejects(create());
  assert.equal((await listModelConnections(owner, guards)).storage, "storage_unavailable");
  process.env.MODEL_REGISTRY_ENCRYPTION_KEY = key;
  const row = await create();
  await assert.rejects(
    updateModelConnection(
      row.id,
      { ...connection, expected_revision: 1, reason: "test", secret: "replacement", owner_confirmed: true, supplier_basis: "https://fixture.invalid/quote" },
      manager,
      guards,
    ),
  );
  await assert.rejects(
    updateModelConnection(
      row.id,
      {
        ...connection,
        endpoint: "https://another.invalid/v1",
        expected_revision: 1,
        reason: "test",
        owner_confirmed: true,
        supplier_basis: "https://fixture.invalid/quote",
      },
      manager,
      guards,
    ),
  );
  const changed = await updateModelConnection(row.id, { ...connection, name: "Changed", secret: "", expected_revision: 1, reason: "test" }, manager, guards);
  assert.equal(changed.fingerprint, row.fingerprint);
  assert.equal(changed.revision, 2);
  await assert.rejects(updateModelConnection(row.id, { ...connection, expected_revision: 1, reason: "stale" }, manager, guards));
});
test("one tiny gateway trial accounts physical estimate and reuses its receipt without exposing plaintext", async () => {
  const before = calls,
    row = await create();
  const probe = await requestModelConnectionProbe(row.id, { expected_revision: 1, lane: "policy" }, manager, guards);
  assert.equal(calls, before);
  const completed = await runModelConnectionProbe(probe.id, { transport });
  assert.equal(completed.status, "passed");
  await runModelConnectionProbe(probe.id, { transport });
  assert.equal(calls, before + 1);
  const [receipt] =
    await sql`SELECT r.request,a.response,a.cost,a.currency,a.cost_basis FROM receipts r JOIN receipt_attempts a ON a.id=r.response_attempt_id WHERE r.id=${completed.receipt_id!}`;
  assert.equal(receipt!.request.usage_purpose, "experiment");
  assert.equal(receipt!.request.lane, "policy");
  assert.equal(Number(receipt!.cost), 0.004);
  assert.equal(receipt!.cost_basis, "estimated");
  assert.equal(receipt!.currency, "CNY");
  assert.ok(!JSON.stringify(receipt).includes(secret));
  assert.equal(receipt!.response.echo, "[redacted]");
  const [storage] = await sql`SELECT sealed_secret FROM ai.model_connections WHERE id=${row.id}`;
  assert.ok(!JSON.stringify(storage).includes(secret));
  const audits = await sql`SELECT before,after FROM audit_log WHERE subject=${row.id}`;
  assert.ok(!JSON.stringify(audits).includes(secret));
  assert.ok(!JSON.stringify(await listModelConnections(owner, guards)).includes("ciphertext"));
});
test("CAS routing requires test, explicit emergency/evaluation and score calibration; active connection cannot disable", async () => {
  const row = await create();
  const input = { model: row.key, expected_revision: 0, reason: "test", evaluation_id: null, emergency_confirmed: true };
  await assert.rejects(assignRegisteredModel("translate", input, manager, guards));
  const probe = await requestModelConnectionProbe(row.id, { expected_revision: 1, lane: "news" }, manager, guards);
  await runModelConnectionProbe(probe.id, { transport });
  await assert.rejects(assignRegisteredModel("translate", { ...input, emergency_confirmed: false }, manager, guards));
  await assert.rejects(assignRegisteredModel("score", input, manager, guards));
  const assigned = await assignRegisteredModel("translate", input, manager, guards);
  assert.equal(assigned.unevaluated, true);
  assert.equal(await modelFor("translate"), row.key);
  await assert.rejects(
    updateModelConnection(row.id, { ...connection, model: "changed-model", expected_revision: 1, reason: "cannot bypass route" }, manager, guards),
  );
  await assert.rejects(assignRegisteredModel("translate", input, manager, guards));
  await assert.rejects(disableModelConnection(row.id, { expected_revision: 1, reason: "test" }, manager, guards));
  const result = await chatJson({
    model: await modelFor("translate"),
    purpose: "synthetic_registry",
    subject: "test",
    promptVersion: "test",
    system: "",
    user: "fixture",
    schema: z.strictObject({ ok: z.literal(true) }),
    registeredTransport: transport,
  });
  assert.equal(result.data.ok, true);
});
test("replacement invalidates passing proof and captured old secret; new key appears only as new fingerprint", async () => {
  const row = await passing(),
    resolved = await resolveRegisteredModel(row.key);
  const changed = await updateModelConnection(
    row.id,
    {
      ...connection,
      secret: "replacement-fake-key",
      expected_revision: 1,
      reason: "replace",
      owner_confirmed: true,
      supplier_basis: "https://fixture.invalid/quote",
    },
    owner,
    guards,
  );
  assert.notEqual(changed.fingerprint, row.fingerprint);
  assert.equal(changed.test_status, "untested");
  await assert.rejects(sql.begin(async (tx) => resolved!.assertCurrent(tx)));
  await assert.rejects(resolveRegisteredModel(row.key));
});
test("unknown outcome remains tied to original test across configuration changes and repeated clicks", async () => {
  const row = await create(),
    probe = await requestModelConnectionProbe(row.id, { expected_revision: 1, lane: "news" }, owner, guards);
  let hits = 0;
  const unknown = await runModelConnectionProbe(probe.id, {
    transport: async () => {
      hits++;
      throw new Error(secret);
    },
  });
  assert.equal(unknown.status, "unknown");
  assert.ok(unknown.receipt_id);
  await updateModelConnection(row.id, { ...connection, expected_revision: 1, name: "Changed after timeout", reason: "test" }, manager, guards);
  const again = await requestModelConnectionProbe(row.id, { expected_revision: 2, lane: "news" }, manager, guards);
  assert.equal(again.id, probe.id);
  await runModelConnectionProbe(again.id, { transport });
  assert.equal(hits, 1);
  const [receipt] = await sql`SELECT error FROM receipts WHERE id=${unknown.receipt_id!}`;
  assert.ok(!receipt!.error.includes(secret));
});
test("missing usage does not pass; processing pause and circuit block test payment", async () => {
  const row = await create(),
    probe = await requestModelConnectionProbe(row.id, { expected_revision: 1, lane: "news" }, owner, guards);
  const unknown = await runModelConnectionProbe(probe.id, {
    transport: async () => ({
      status: 200,
      headers: new Headers(),
      text: () => JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }),
    }),
  });
  assert.equal(unknown.status, "unknown");
  const other = await create(),
    p2 = await requestModelConnectionProbe(other.id, { expected_revision: 1, lane: "news" }, owner, guards);
  const pausedBefore = calls,
    controls = await listLaneControls(),
    revision = controls.owner_revisions.find((r) => r.lane === "news" && r.switch === "processing")!.revision;
  await changeOwnerLaneControls(
    {
      lane: "news",
      mode: "processing",
      action: "pause",
      reason: "synthetic",
      expected_revisions: { processing: revision },
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
    "synthetic",
  );
  assert.equal((await runModelConnectionProbe(p2.id, { transport })).status, "paused");
  assert.equal(calls, pausedBefore);
  await changeOwnerLaneControls(
    { lane: "news", mode: "processing", action: "resume", reason: "synthetic", expected_revisions: { processing: revision + 1 } },
    "synthetic",
  );
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES(${other.key},0,0,0)`;
  assert.equal((await runModelConnectionProbe(p2.id, { transport })).status, "paused");
  assert.equal(calls, pausedBefore);
});

test("actual pg-boss worker consumes a durable test without HTTP-side payment or extra retries", async () => {
  const row = await create(),
    probe = await requestModelConnectionProbe(row.id, { expected_revision: 1, lane: "policy" }, owner, guards),
    before = calls;
  const boss = await getBoss();
  await registerModelConnectionProbeJobs(boss, { transport });
  await queueModelConnectionProbe(probe);
  let current = probe;
  for (let i = 0; i < 80; i++) {
    current = await readModelConnectionProbe(probe.id, owner, guards);
    if (current.status === "passed") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(current.status, "passed");
  assert.equal(calls, before + 1);
  await queueModelConnectionProbe(current);
  assert.equal(calls, before + 1);
});

test("configuration hash binds evaluation and output identity; price edits do not repay cached content", async () => {
  const row = await passing();
  const opts = {
    model: row.key,
    purpose: "synthetic_registry",
    subject: "cache-case",
    promptVersion: "test",
    system: "",
    user: row.id,
    schema: z.strictObject({ ok: z.literal(true) }),
    registeredTransport: transport,
  };
  const first = await chatJson(opts);
  const changed = await updateModelConnection(
    row.id,
    { ...connection, input_cny_per_million: "20", expected_revision: 1, reason: "price only" },
    manager,
    guards,
  );
  assert.equal(changed.configuration_hash, row.configuration_hash);
  const probe = await requestModelConnectionProbe(row.id, { expected_revision: 2, lane: "news" }, manager, guards);
  await runModelConnectionProbe(probe.id, { transport });
  const before = calls,
    reused = await chatJson(opts);
  assert.equal(reused.receiptId, first.receiptId);
  assert.equal(calls, before);
  const [receipt] = await sql`SELECT request,cost FROM receipts WHERE id=${first.receiptId}`;
  assert.equal(receipt!.request.configuration_hash, row.configuration_hash);
  assert.equal(receipt!.request.pricing.input, "2");
  assert.equal(Number(receipt!.cost), 0.004);
  const evalId = `registry-eval-${row.id}`;
  await sql`INSERT INTO selectbench_runs(id,label,sample_size,models,summary) VALUES(${evalId},'synthetic',1,${[row.key]},${sql.json({ model_configurations: { [row.key]: "old-version" } })})`;
  const assignment = { model: row.key, expected_revision: 0, evaluation_id: evalId, emergency_confirmed: false, reason: "eval fixture" };
  await assert.rejects(assignRegisteredModel("digest", assignment, manager, guards));
  await sql`UPDATE selectbench_runs SET summary=${sql.json({ model_configurations: { [row.key]: row.configuration_hash } })} WHERE id=${evalId}`;
  assert.equal((await assignRegisteredModel("digest", assignment, manager, guards)).unevaluated, false);
});

test("each physical retry binds its own revision, fingerprint and prices; policy proof reads the actual attempt", async () => {
  const row = await passing();
  const opts = {
    model: row.key,
    purpose: "synthetic_retry",
    subject: `retry:${row.id}`,
    promptVersion: "test",
    system: "",
    user: row.id,
    schema: z.strictObject({ ok: z.literal(true) }),
  };
  await assert.rejects(chatJson({ ...opts, registeredTransport: async () => ({ status: 503, headers: new Headers(), text: () => "unavailable" }) }));
  const changed = await updateModelConnection(
    row.id,
    {
      ...connection,
      input_cny_per_million: "20",
      secret: "second-fake-key",
      expected_revision: 1,
      reason: "retry configuration",
      owner_confirmed: true,
      supplier_basis: "https://fixture.invalid/quote",
    },
    owner,
    guards,
  );
  const probe = await requestModelConnectionProbe(row.id, { expected_revision: 2, lane: "policy" }, owner, guards);
  await runModelConnectionProbe(probe.id, { transport });
  const second = await chatJson({ ...opts, registeredTransport: transport });
  const attempts = await sql<
    { revision: number; fingerprint: string; pricing: { input: string } }[]
  >`SELECT ms.connection_revision AS revision,ms.key_fingerprint AS fingerprint,ms.pricing FROM ai.model_attempt_snapshots ms JOIN receipt_attempts a ON a.id=ms.attempt_id WHERE a.receipt_id=${second.receiptId} ORDER BY a.attempt`;
  assert.deepEqual(
    attempts.map((a) => a.revision),
    [1, 2],
  );
  assert.deepEqual(
    attempts.map((a) => a.pricing.input),
    ["2", "20"],
  );
  assert.deepEqual(
    attempts.map((a) => a.fingerprint),
    [row.fingerprint, changed.fingerprint],
  );
  const [original] = await sql`SELECT request FROM receipts WHERE id=${second.receiptId}`;
  assert.equal(original!.request.connection_revision, 1);
  const { readPolicyResponse } = await import("../packages/backend/src/providers/receipts.ts");
  const policy = await chatJson({
    ...opts,
    subject: `policy:${row.id}`,
    purpose: "policy_verify",
    registeredTransport: transport,
    policyContext: {
      lane: "policy",
      category: "policy_interpret",
      sourceIds: [],
      manifestHash: "synthetic",
      inputFingerprint: "synthetic",
      permissionVersions: {},
      manifest: {},
    },
    beforeRequest: async () => {},
  });
  const actual = await readPolicyResponse({ receiptId: policy.receiptId, attemptId: policy.attemptId! });
  assert.equal(actual!.configuration_hash, changed.configuration_hash);
  assert.equal(actual!.connection_revision, 2);
  assert.equal(actual!.connection_id, row.id);
});
