import assert from "node:assert/strict";
import { verify as verifySignature } from "node:crypto";
import { test, type TestContext } from "node:test";
import type { z } from "zod";
import type { IssueProcessingPermitInputSchema, SignedProcessingPermit } from "@amp/contracts/source-policy";
import { initializeDb, closeDb, dbOf } from "@amp/backend/db";
import { queueConnection } from "../packages/backend/src/db-bootstrap.ts";
import { createPermitIssuer } from "../packages/backend/src/sources/permissions.ts";
import { createPermitVerifier, permitMessage, type PermitPorts } from "../packages/backend/src/providers/permissions.ts";
import { signedPermitExample, sourcePolicyExample, permitRequest as request, permitTestState } from "./permission-fixture.ts";

const env = { DATABASE_URL: "postgres://fixture@127.0.0.1:1/permit_crypto_test" };
type Request = z.infer<typeof IssueProcessingPermitInputSchema>;
async function fixture(t: TestContext) {
  const root = await initializeDb("test", env);
  t.after(closeDb);
  const { state, ports }: ReturnType<typeof permitTestState> & { ports: PermitPorts } = permitTestState(root);
  const issuer = createPermitIssuer(ports, 1000),
    verifier = createPermitVerifier(issuer.identity, ports);
  t.after(() => {
    verifier.close();
    issuer.close();
  });
  const issued = await issuer.issueProcessingPermit(request());
  assert.ok(issued.ok);
  return { root, state, ports, issuer, verifier, permit: issued.permit };
}

test("real Ed25519 signs the entire canonical envelope, exposing only a public identity", async (t) => {
  const f = await fixture(t);
  assert.equal(f.issuer.identity.key.type, "public");
  assert.deepEqual(Object.keys(f.issuer).sort(), ["close", "identity", "issueProcessingPermit"]);
  assert.equal("abort" in f.root, false);
  assert.ok(verifySignature(null, Buffer.from(permitMessage(f.permit)), f.issuer.identity.key, Buffer.from(f.permit.signature, "base64url")));
  assert.equal((await f.verifier.verify(f.permit, request())).ok, true);
  const reordered = {
    signature: f.permit.signature,
    binding: { ...f.permit.binding, resource: { attachment: false, document_type: null, url: f.permit.binding.resource.url } },
    payload: { ...f.permit.payload },
    issuer_id: f.permit.issuer_id,
    algorithm: f.permit.algorithm,
    schema_version: 1,
    credential_expires_at: f.permit.credential_expires_at,
  };
  assert.equal((await f.verifier.verify(reordered, request())).ok, true, "key order does not change canonical signing bytes");
  for (const field of ["issued_at", "credential_expires_at", "issuer_id"])
    assert.equal((await f.issuer.issueProcessingPermit({ ...request(), [field]: "caller-chosen" })).ok, false);
  f.verifier.close();
  assert.deepEqual(await f.verifier.verify(f.permit, request()), { ok: false, reason: "lifecycle_revoked" });
  f.issuer.close();
  assert.deepEqual(await f.issuer.issueProcessingPermit(request()), { ok: false, reason: "lifecycle_revoked" });
  assert.equal(f.root.aborted, false, "closing one authority does not close the database root");
});

test("signed field tampering and another genuine issuer cannot pass or query current permissions", async (t) => {
  const f = await fixture(t),
    before = f.state.inputCalls;
  const changes: Array<(wire: SignedProcessingPermit) => void> = [
    (p) => {
      p.payload.lane = "policy";
    },
    (p) => {
      p.payload.permission_version++;
    },
    (p) => {
      p.binding.input_fingerprint = "3".repeat(64);
    },
    (p) => {
      p.binding.resource.url += "/other";
    },
    (p) => {
      p.credential_expires_at = "2099-01-01T00:00:00Z";
    },
    (p) => {
      p.signature = "A".repeat(86);
    },
  ];
  for (const change of changes) {
    const wire: SignedProcessingPermit = structuredClone(f.permit);
    change(wire);
    assert.deepEqual(await f.verifier.verify(wire, request()), { ok: false, reason: "invalid_signature" });
  }
  assert.equal(f.state.inputCalls, before);
  const other = createPermitIssuer(f.ports, 1000);
  t.after(other.close);
  const token = await other.issueProcessingPermit(request());
  assert.ok(token.ok);
  assert.deepEqual(await f.verifier.verify(token.permit, request()), { ok: false, reason: "untrusted_issuer" });
});

test("expected and current source, lane, purpose, material, input, version and scope are all bound", async (t) => {
  const f = await fixture(t);
  const cases: Array<[Partial<Request>, string]> = [
    [{ source_id: "other" }, "source_mismatch"],
    [{ lane: "policy" }, "lane_mismatch"],
    [{ capability: "public_summary" }, "purpose_mismatch"],
    [{ permission_version: 2 }, "version_changed"],
    [{ binding: { ...signedPermitExample.binding, revision: 2 } }, "material_mismatch"],
    [{ binding: { ...signedPermitExample.binding, content_hash: "3".repeat(64) } }, "material_mismatch"],
    [{ binding: { ...signedPermitExample.binding, input_fingerprint: "3".repeat(64) } }, "input_mismatch"],
  ];
  for (const [patch, reason] of cases) assert.deepEqual(await f.verifier.verify(f.permit, { ...request(), ...patch }), { ok: false, reason });
  f.state.input.binding.input_fingerprint = "4".repeat(64);
  assert.deepEqual(await f.verifier.verify(f.permit, request()), { ok: false, reason: "input_mismatch" });
  f.state.input = { source_id: "source_fixture", lane: "news", binding: request().binding };
  f.state.policy.permission_version = 2;
  assert.deepEqual(await f.verifier.verify(f.permit, request()), { ok: false, reason: "version_changed" });
  f.state.policy.permission_version = 1;
  f.state.policy.scope = { ...sourcePolicyExample.scope, hosts: ["other.invalid"] };
  assert.deepEqual(await f.verifier.verify(f.permit, request()), { ok: false, reason: "resource_mismatch" });
});

test("revocation, lookup failure and both expiry layers fail closed even while a lookup is pending", async (t) => {
  const f = await fixture(t),
    allowed = structuredClone(f.state.policy);
  f.state.policy = { ...f.state.policy, decision: "deny", reason: "purpose_denied" };
  assert.deepEqual(await f.verifier.verify(f.permit, request()), { ok: false, reason: "purpose_denied" });
  f.state.fail = true;
  assert.deepEqual(await f.verifier.verify(f.permit, request()), { ok: false, reason: "verification_unavailable" });
  f.state.fail = false;
  const originalEvaluate = f.ports.policy.evaluate;
  f.ports.policy.evaluate = async () => {
    throw new Error("synthetic policy lookup failure");
  };
  assert.deepEqual(await f.verifier.verify(f.permit, request()), { ok: false, reason: "verification_unavailable" });
  f.ports.policy.evaluate = originalEvaluate;
  f.state.now += 1000;
  assert.deepEqual(await f.verifier.verify(f.permit, request()), { ok: false, reason: "credential_expired" });
  f.state.now -= 1000;
  f.state.policy = {
    ...allowed,
    decision: "allow",
    scope: sourcePolicyExample.scope,
    permission_version: 1,
    expires_at: new Date(f.state.now + 500).toISOString(),
  };
  const token = await f.issuer.issueProcessingPermit(request());
  assert.ok(token.ok);
  f.state.now += 500;
  assert.deepEqual(await f.verifier.verify(token.permit, request()), { ok: false, reason: "permission_expired" });
  f.state.policy.expires_at = null;
  f.state.now -= 500;
  const evaluate = f.ports.policy.evaluate;
  f.ports.policy.evaluate = async (input) => {
    const result = await evaluate(input);
    f.state.now += 1000;
    return result;
  };
  assert.deepEqual(await f.verifier.verify(f.permit, request()), { ok: false, reason: "credential_expired" });
});

test("real database-root reentry, close, failed initialization and replacement revoke old issuers", async (t) => {
  const f = await fixture(t);
  assert.equal(await initializeDb("test", env), f.root);
  let release!: () => void;
  f.ports.inputs.resolve = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return structuredClone(f.state.input);
  };
  const pending = f.issuer.issueProcessingPermit(request());
  await closeDb();
  assert.equal(f.root.aborted, true);
  release();
  assert.deepEqual(await pending, { ok: false, reason: "lifecycle_revoked" });
  await assert.rejects(initializeDb("test", {}), /Missing/);
  const next = await initializeDb("test", env);
  assert.notEqual(next, f.root);
  assert.equal(next.aborted, false);
  assert.deepEqual(await f.verifier.verify(f.permit, request()), { ok: false, reason: "lifecycle_revoked" });
  assert.deepEqual(await f.issuer.issueProcessingPermit(request()), { ok: false, reason: "lifecycle_revoked" });
  assert.throws(() => createPermitVerifier(f.issuer.identity, { ...f.ports, root: next }), /current root/);
});

test("root lifetime is stable for reentry, refuses reconfiguration and cannot survive close or replacement", async () => {
  const root = await initializeDb("test", env);
  try {
    assert.equal(await initializeDb("test", env), root);
    await assert.rejects(initializeDb("test", { ...env }), /already initialized/);
    await assert.rejects(initializeDb("worker", env), /already initialized/);
    assert.equal(root.aborted, false, "rejected reconfiguration does not destroy the running root");
    assert.equal("abort" in root || "access" in root || "environment" in root, false);
    const closing = closeDb();
    assert.equal(root.aborted, true, "revocation starts before pool cleanup settles");
    await closing;
    await assert.rejects(initializeDb("test", {}), /Missing/);
    assert.throws(() => dbOf("sources").options, /not injected/);
    const next = await initializeDb("test", env);
    assert.notEqual(next, root);
    assert.equal(next.aborted, false);
    await closeDb();
    assert.equal(next.aborted, true);
  } finally {
    await closeDb();
  }
});

test("abort listeners observe revoked capabilities and share the already registered close operation", async () => {
  const root = await initializeDb("test", env);
  const sql = dbOf("sources");
  let nested: Promise<void> | undefined, reentry: Promise<AbortSignal> | undefined;
  let queueReadable = true,
    databaseReadable = true;
  root.addEventListener(
    "abort",
    () => {
      try {
        queueConnection();
      } catch {
        queueReadable = false;
      }
      try {
        void sql.options;
      } catch {
        databaseReadable = false;
      }
      reentry = initializeDb("test", env);
      void reentry.catch(() => {});
      nested = closeDb();
    },
    { once: true },
  );
  const closing = closeDb();
  assert.equal(closeDb(), closing, "concurrent callers receive the same close operation");
  await closing;
  const reentryRejected = await reentry!.then(
    () => false,
    () => true,
  );
  assert.deepEqual(
    { sharedClosing: nested === closing, reentryRejected, queueReadable, databaseReadable },
    { sharedClosing: true, reentryRejected: true, queueReadable: false, databaseReadable: false },
  );
});
