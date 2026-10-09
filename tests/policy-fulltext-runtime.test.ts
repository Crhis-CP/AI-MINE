import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { stub, gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { stripTags } from "@amp/backend/lib/text";
import { after, test } from "node:test";
import { closeDb, dbOf, initializeDb } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { readPolicyResponse } from "@amp/backend/providers/receipts";
import { recordPolicyOriginal, readPolicyOriginal } from "../packages/backend/src/policy/originals.ts";
import { runPolicyFulltext } from "../packages/backend/src/policy/fulltext-runtime.ts";
import { setPolicyProcessingPaused, readPolicyFulltextRun } from "../packages/backend/src/policy/fulltext-store.ts";
import type { PolicyOriginalInput } from "../packages/backend/src/policy/types.ts";
import { grantDateFixture } from "./source-date-fixture.ts";

const sql = dbOf("policy"),
  root = await initializeDb("test");
type Part = { partId: string; sourceHash: string; source: string; format: string };
let transform = (part: Part) => ({
  partId: part.partId,
  sourceHash: part.sourceHash,
  classification: "facts",
  facts: [{ statement: "许可适用条件", role: "scope", quote: stripTags(part.source) }],
  zh: part.source.replaceAll("Permit applies at", "许可适用量为"),
});
let beforeResponse = async () => {};
let extraParts: Part[] = [];
let usage: { prompt_tokens: number; completion_tokens: number } | null = { prompt_tokens: 50, completion_tokens: 20 };
const requests: { parts: Part[] }[] = [];
const provider = await stub(async (_hit, req) => {
  const body = JSON.parse(req.body),
    input = JSON.parse(body.messages.at(-1).content);
  requests.push(input);
  await beforeResponse();
  return {
    id: `synthetic-${requests.length}`,
    choices: [{ message: { content: JSON.stringify({ parts: [...input.parts, ...extraParts].map(transform) }) }, finish_reason: "stop" }],
    usage,
  };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "synthetic-test-only", LLM_MODEL: "unchanged-policy-fixture-model" });
config.modelCallsEnabled = true;
await installUsageFixtureForModel("default", sql);
const profile = { bodySelector: "article", attachmentSelector: null, maxBytes: 2_000_000, maxResources: 8, maxPages: 40, maxTextBytes: 2_000_000 };
async function original(count = 1) {
  const id = `runtime-${tag()}`,
    url = `https://source.invalid/${id}`;
  await sql`INSERT INTO sources(id,name,kind,lane,enabled) VALUES(${id},${id},'external','policy',false)`;
  await grantDateFixture(id, [url]);
  const value: PolicyOriginalInput = {
    sourceId: id,
    permissionVersion: 1,
    identity: { jurisdiction: "AR", authority: id, documentType: "decree", documentNumber: "fixture-1", officialUrl: url },
    versionKey: "official-1",
    language: "en",
    kind: "original",
    officialTitle: "Synthetic mining decree",
    expectedHead: null,
    catalogueClosed: true,
    resources: [
      {
        url,
        mediaType: "text/html; charset=utf-8",
        attachment: false,
        required: true,
        state: "acquired",
        body: Buffer.from(`<article>${Array.from({ length: count }, (_, i) => `<p>Permit applies at ${i + 10} kg.</p>`).join("")}</article>`),
        reason: null,
      },
    ],
  };
  return { value, record: await recordPolicyOriginal(value) };
}
after(async () => {
  await provider.close();
  await closeDb();
});

test("complete originals resume by checkpoint and real responses; actual resource sequence is never fabricated", async () => {
  const f = await original(13),
    before = requests.length;
  const first = await runPolicyFulltext(f.record.expressionId, profile, { root, maxRequests: 1 });
  assert.equal(first.status, "incomplete");
  assert.equal("acceptedParts" in first && first.acceptedParts, 12);
  const second = await runPolicyFulltext(f.record.expressionId, profile, { root, maxRequests: 1 });
  assert.equal(second.status, "program_validated");
  assert.equal("acceptedParts" in second && second.acceptedParts, 13);
  assert.equal(requests.length - before, 2);
  const [checkpoint] = await sql`SELECT receipt_id,attempt_id FROM policy.fulltext_parts WHERE part_id=${requests[before]!.parts[0]!.partId}`;
  const receipt = await readPolicyResponse({ receiptId: checkpoint!.receipt_id, attemptId: checkpoint!.attempt_id });
  assert.equal(receipt?.purpose, "policy_fulltext");
  assert.equal(receipt?.knownUsage, true);
  assert.equal(await readPolicyResponse({ receiptId: checkpoint!.receipt_id, attemptId: "not-an-attempt" }), null);
  const reused = await runPolicyFulltext(f.record.expressionId, profile, { root });
  assert.equal(reused.status, "program_validated");
  assert.ok("runId" in reused && (await readPolicyFulltextRun(reused.runId))?.run.snapshot.sequence === 1);
  assert.equal(requests.length - before, 2);
  const rows = await sql`SELECT request FROM receipts WHERE request->'sourceIds' ? ${f.value.sourceId}`;
  for (const row of rows)
    for (const material of row.request.manifest.materials) {
      assert.equal(material.revision, 1);
      assert.match(material.material_id, /^[a-f0-9]{64}$/);
      assert.equal(material.content_hash, (await readPolicyOriginal(f.record.expressionId))!.resources[0]!.sha256);
    }
  assert.equal(
    (
      await sql`SELECT count(*)::int n FROM policy.fulltext_parts WHERE part_id IN ${sql(requests.slice(before).flatMap((r) => r.parts.map((p) => p.partId)))}`
    )[0]!.n,
    13,
  );
  assert.equal("semantic_verified" in reused && reused.semantic_verified, false);
  assert.equal("runtime_authorization" in reused && reused.runtime_authorization, "none");
});

test("a checkpoint write crash reuses the received raw response without buying another call", async () => {
  const f = await original(),
    before = requests.length;
  await sql.unsafe(
    `CREATE FUNCTION policy.fixture_fail_part() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture checkpoint crash'; END $$; CREATE TRIGGER fixture_fail_part BEFORE INSERT ON policy.fulltext_parts FOR EACH ROW EXECUTE FUNCTION policy.fixture_fail_part();`,
  );
  try {
    await assert.rejects(runPolicyFulltext(f.record.expressionId, profile, { root }), /fixture checkpoint crash/);
  } finally {
    await sql.unsafe("DROP TRIGGER fixture_fail_part ON policy.fulltext_parts; DROP FUNCTION policy.fixture_fail_part();");
  }
  const recovered = await runPolicyFulltext(f.record.expressionId, profile, { root });
  assert.equal(recovered.status, "program_validated");
  assert.equal(requests.length - before, 1);
});

test("two known paid failures remain capped after regrouping and another original revision", async () => {
  const f = await original(),
    before = requests.length,
    normal = transform;
  transform = (p) => ({ ...normal(p), sourceHash: "0".repeat(64) });
  try {
    await runPolicyFulltext(f.record.expressionId, profile, { root, maxRequests: 2 });
    assert.equal(requests.length - before, 2);
    const revision = await recordPolicyOriginal({
      ...f.value,
      expectedHead: f.record.revisionId,
      resources: [{ ...f.value.resources[0]!, body: Buffer.from("<article><p>Permit applies at 10 kg.</p><p>Permit applies at 30 kg.</p></article>") }],
    });
    assert.equal((await readPolicyOriginal(revision.expressionId))!.sequence, 2);
    const capped = await runPolicyFulltext(revision.expressionId, profile, { root, maxRequests: 2 });
    assert.equal(capped.status, "blocked_retry_limit");
    assert.equal(requests.length - before, 2);
  } finally {
    transform = normal;
  }
});

test("pause while paid work is in flight leaves receipts but no promoted checkpoint; explicit resume reuses it", async () => {
  const f = await original(),
    started = gate(),
    finish = gate(),
    before = requests.length;
  beforeResponse = async () => {
    started.open();
    await finish.promise;
  };
  const pending = runPolicyFulltext(f.record.expressionId, profile, { root });
  await started.promise;
  await setPolicyProcessingPaused(f.record.expressionId, { expectedVersion: 1, paused: true, reason: "synthetic pause", actor: "test" });
  finish.open();
  assert.equal((await pending).status, "stale");
  beforeResponse = async () => {};
  assert.equal((await runPolicyFulltext(f.record.expressionId, profile, { root })).status, "paused");
  assert.equal((await sql`SELECT count(*)::int n FROM policy.fulltext_parts WHERE part_id IN ${sql(requests[before]!.parts.map((p) => p.partId))}`)[0]!.n, 0);
  await setPolicyProcessingPaused(f.record.expressionId, { expectedVersion: 2, paused: false, reason: "synthetic resume", actor: "test" });
  assert.equal((await runPolicyFulltext(f.record.expressionId, profile, { root })).status, "program_validated");
  assert.equal(requests.length - before, 1);
});

test("open extraction gaps never reach the paid gateway", async () => {
  const f = await original(),
    before = requests.length;
  const missing = await recordPolicyOriginal({ ...f.value, expectedHead: f.record.revisionId, catalogueClosed: false });
  assert.equal((await runPolicyFulltext(missing.expressionId, profile, { root })).status, "incomplete");
  assert.equal(requests.length, before);
});

test("an unknown usage receipt blocks the next part request without repeating the completed parts", async () => {
  const f = await original(13),
    before = requests.length;
  usage = null;
  try {
    const blocked = await runPolicyFulltext(f.record.expressionId, profile, { root, maxRequests: 2 });
    assert.equal(blocked.status, "blocked_unknown");
    assert.equal(requests.length - before, 1);
    assert.equal((await runPolicyFulltext(f.record.expressionId, profile, { root })).status, "blocked_unknown");
    assert.equal(requests.length - before, 1);
  } finally {
    usage = { prompt_tokens: 50, completion_tokens: 20 };
  }
});

test("a newer immutable original rejects the in-flight old result and uses the actual next sequence", async () => {
  const f = await original(),
    started = gate(),
    finish = gate();
  beforeResponse = async () => {
    started.open();
    await finish.promise;
  };
  const pending = runPolicyFulltext(f.record.expressionId, profile, { root });
  await started.promise;
  const next = await recordPolicyOriginal({
    ...f.value,
    expectedHead: f.record.revisionId,
    resources: [{ ...f.value.resources[0]!, body: Buffer.from("<article><p>Permit applies at 25 kg.</p></article>") }],
  });
  finish.open();
  assert.equal((await pending).status, "stale");
  beforeResponse = async () => {};
  const current = await runPolicyFulltext(next.expressionId, profile, { root });
  assert.equal(current.status, "program_validated");
  const rows = await sql`SELECT request FROM receipts WHERE request->'sourceIds' ? ${f.value.sourceId} ORDER BY id`;
  assert.deepEqual(
    rows.map((r) => r.request.manifest.materials[0].revision),
    [1, 2],
  );
  assert.equal(rows[0]!.request.manifest.materials[0].material_id, rows[1]!.request.manifest.materials[0].material_id);
});

test("a model cannot smuggle an unrequested part of the same plan into a paid checkpoint", async () => {
  const f = await original(13),
    before = requests.length;
  beforeResponse = async () => {
    const [row] = await sql`SELECT plan FROM policy.fulltext_runs WHERE expression_id=${f.record.expressionId}`;
    extraParts = [row!.plan.parts[12]];
  };
  try {
    const partial = await runPolicyFulltext(f.record.expressionId, profile, { root, maxRequests: 1 });
    assert.equal(partial.status, "incomplete");
    assert.equal("acceptedParts" in partial && partial.acceptedParts, 12);
    assert.equal((await sql`SELECT count(*)::int n FROM policy.fulltext_parts WHERE part_id=${extraParts[0]!.partId}`)[0]!.n, 0);
  } finally {
    beforeResponse = async () => {};
    extraParts = [];
  }
  const complete = await runPolicyFulltext(f.record.expressionId, profile, { root, maxRequests: 1 });
  assert.equal(complete.status, "program_validated");
  assert.equal(requests.length - before, 2);
  assert.equal(requests[before + 1]!.parts.length, 1);
});
