import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { stub, gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { config } from "@amp/backend/config";
import { closeDb, dbOf, initializeDb } from "@amp/backend/db";
import { createPolicyGateway, PolicyInputChangedError, type PreparedPolicyInput, type PolicyPurpose } from "../packages/backend/src/providers/policy.ts";
import { ReceiptBusyError, ReceiptUnknownError } from "@amp/backend/providers/receipts";
import { markReceiptsCompleted, chatJson } from "@amp/backend/providers/llm";
import { readCurrentSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";
import { invalidateModelCache } from "@amp/backend/editorial/models";
import { sha256 } from "../packages/backend/src/lib/ids.ts";
import { grantDateFixture } from "./source-date-fixture.ts";

const sql = dbOf("ai-gateway"),
  root = await initializeDb("test");
type ProviderInput = { model: string; messages: { role: string; content: string }[] };
let respond: (body: ProviderInput) => Promise<Record<string, unknown>> = async () => ({});
const seen: ProviderInput[] = [];
const provider = await stub(async (_hit, req) => {
  const body = JSON.parse(req.body) as ProviderInput;
  seen.push(body);
  const extra = await respond(body);
  return {
    id: `local-${seen.length}`,
    choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
    usage: { prompt_tokens: 9, completion_tokens: 3 },
    ...extra,
  };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "synthetic-only", LLM_MODEL: "preserved-configured-model" });
config.modelCallsEnabled = true;
await installUsageFixtureForModel("default", sql);
const schema = z.object({ ok: z.boolean() });
after(async () => {
  await provider.close();
  await closeDb();
});
async function fixture() {
  const id = `policy-gateway-${tag()}`,
    url = `https://source.invalid/${id}`;
  await sql`INSERT INTO sources(id,name,kind,lane,enabled,config) VALUES(${id},${id},'rss','policy',false,'{}')`;
  await grantDateFixture(id, [url]);
  const input: PreparedPolicyInput = {
    manifest: {
      schema_version: 1,
      kind: "source_materials",
      lane: "policy",
      materials: [
        { source_id: id, material_id: id, revision: 1, content_hash: sha256("synthetic original"), resource: { url, document_type: null, attachment: false } },
      ],
      upstream_artifacts: [],
    },
    system: "Synthetic policy test instructions",
    user: `Synthetic original ${id}`,
    promptVersion: "fixture@1",
    recipeVersion: "fixture1",
    controlRevision: "1",
    processingAllowed: true,
  };
  const state = { input, reads: 0, onRead: () => {} };
  const gateway = createPolicyGateway({
    root,
    resolve: async () => {
      state.reads++;
      state.onRead();
      return structuredClone(state.input);
    },
  });
  const run = (purpose: PolicyPurpose = "policy_fulltext", version = "1", timeoutMs?: number) =>
    gateway.chat({ input: { id, version }, purpose, schema, timeoutMs });
  return { id, state, run };
}

test("four explicit policy capabilities keep the configured model, bind manifests and reuse actual responses", async () => {
  respond = async () => ({});
  const f = await fixture(),
    before = seen.length;
  for (const purpose of ["policy_fulltext", "policy_group", "policy_interpret", "policy_verify"] as const) {
    const first = await f.run(purpose),
      again = await f.run(purpose);
    assert.equal(again.receiptId, first.receiptId);
    assert.equal(again.reused, true);
    assert.equal(first.data.ok, true);
    const [bound] = await sql`SELECT request FROM receipts WHERE id=${first.receiptId}`;
    assert.equal(bound!.request.inputFingerprint, first.inputFingerprint);
    assert.equal(bound!.request.permissionVersions[f.id], 1);
    assert.equal("publication_authorized" in first, false);
    await markReceiptsCompleted([first.receiptId]);
  }
  assert.equal(seen.length - before, 4);
  assert.ok(seen.slice(before).every((r) => r.model === "preserved-configured-model"));
  const rows = await sql`SELECT purpose,status,request,usage,cost FROM receipts WHERE subject LIKE ${`policy:${f.id}@%`}`;
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.status, "completed");
    assert.equal(row.request.lane, "policy");
    assert.deepEqual(row.request.manifest, f.state.input.manifest);
    assert.deepEqual(row.request.sourceIds, [f.id]);
    assert.equal(row.usage.prompt_tokens, 9);
    assert.equal(Number(row.cost), 0, "explicit synthetic zero CNY price is recorded rather than a missing price");
  }
});

test("policy permission denial, input changes and manual processing pause prevent sends", async () => {
  respond = async () => ({});
  const f = await fixture(),
    before = seen.length;
  f.state.input.processingAllowed = false;
  await assert.rejects(f.run(), /paused/);
  f.state.input.processingAllowed = true;
  process.env.POLICY_GROUP_MODEL = "unregistered-policy-model";
  try {
    await assert.rejects(f.run("policy_group"), /Unknown configured policy model/);
  } finally {
    delete process.env.POLICY_GROUP_MODEL;
  }
  const policy = (await readCurrentSourcePolicy(f.id))!;
  await saveSourcePolicy(
    f.id,
    {
      expectedVersion: policy.permission_version,
      policy: { ...policy, permissions: { ...policy.permissions, external_model: "deny" } },
      reason: "synthetic denial",
    },
    "test",
  );
  await assert.rejects(f.run(), /permit denied/);
  const changed = await fixture();
  changed.state.onRead = () => {
    if (changed.state.reads > 1) changed.state.input.user += "changed";
  };
  await assert.rejects(changed.run(), /input changed|permit denied/);
  assert.equal(seen.length, before);
  await assert.rejects(
    chatJson({ model: "default", purpose: "policy_verify", subject: "bypass", system: "s", user: "u", promptVersion: "x", schema }),
    /policy gateway/,
  );
});

test("pause or permission revocation during a call retains paid usage but returns no promotable candidate", async () => {
  for (const mode of ["pause", "permission"]) {
    const f = await fixture(),
      started = gate(),
      finish = gate();
    respond = async () => {
      started.open();
      await finish.promise;
      return {};
    };
    const pending = assert.rejects(f.run(), PolicyInputChangedError);
    await started.promise;
    if (mode === "pause") f.state.input.processingAllowed = false;
    else {
      const policy = (await readCurrentSourcePolicy(f.id))!;
      await saveSourcePolicy(
        f.id,
        {
          expectedVersion: policy.permission_version,
          policy: { ...policy, permissions: { ...policy.permissions, external_model: "deny" } },
          reason: "synthetic revoke",
        },
        "test",
      );
    }
    finish.open();
    await pending;
    const [row] =
      await sql`SELECT r.status,a.status AS attempt,a.usage FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id WHERE r.subject=${`policy:${f.id}@1`}`;
    assert.equal(row!.status, "received");
    assert.equal(row!.attempt, "received");
    assert.equal(row!.usage.completion_tokens, 3);
  }
});

test("a pending source blocks another grouping or model route while independent sources continue", async () => {
  const f = await fixture(),
    started = gate(),
    finish = gate();
  respond = async (body) => {
    if (String(body.messages.at(-1)!.content).includes(f.id)) {
      started.open();
      await finish.promise;
    }
    return {};
  };
  const first = f.run();
  await started.promise;
  try {
    f.state.input.recipeVersion = "changed-group";
    process.env.POLICY_GROUP_MODEL = "deepseek-flash";
    process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
    process.env.DEEPSEEK_API_KEY = "synthetic-only";
    await installUsageFixtureForModel("deepseek-flash", sql);
    invalidateModelCache();
    await assert.rejects(f.run("policy_group", "2"), ReceiptBusyError);
    const other = await fixture();
    assert.equal((await other.run()).data.ok, true);
  } finally {
    delete process.env.POLICY_GROUP_MODEL;
    finish.open();
  }
  await assert.rejects(first, PolicyInputChangedError);
});

test("unknown outcome cannot be repurchased by changing version, input or model", async () => {
  const f = await fixture(),
    finish = gate();
  let calls = 0;
  respond = async () => {
    calls++;
    await finish.promise;
    return {};
  };
  try {
    await assert.rejects(f.run("policy_fulltext", "1", 40));
    f.state.input.user += " regrouped";
    f.state.input.recipeVersion = "2";
    process.env.POLICY_VERIFY_MODEL = "deepseek-flash";
    process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
    process.env.DEEPSEEK_API_KEY = "synthetic-only";
    await installUsageFixtureForModel("deepseek-flash", sql);
    await assert.rejects(f.run("policy_verify", "new"), ReceiptUnknownError);
    assert.equal(calls, 1);
    assert.equal((await sql`SELECT status FROM receipts WHERE subject=${`policy:${f.id}@1`}`)[0]!.status, "unknown");
  } finally {
    delete process.env.POLICY_VERIFY_MODEL;
    finish.open();
  }
});

test("missing usage blocks new payments but still allows free reuse of the received response", async () => {
  respond = async () => ({ usage: null });
  const f = await fixture(),
    before = seen.length;
  const first = await f.run();
  assert.equal((await f.run()).receiptId, first.receiptId);
  await assert.rejects(f.run("policy_group"), ReceiptUnknownError);
  assert.equal(seen.length - before, 1);
});
