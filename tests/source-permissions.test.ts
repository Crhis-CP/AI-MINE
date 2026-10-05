import assert from "node:assert/strict";
import { verify as verifySignature } from "node:crypto";
import { test, type TestContext } from "node:test";
import type { z } from "zod";
import { SourcePolicySchema, type IssueProcessingPermitInputSchema, type SignedProcessingPermit } from "@amp/contracts/source-policy";
import { initializeDb, closeDb, dbOf } from "@amp/backend/db";
import path from "node:path";
import { provisionRoles } from "../scripts/db-roles.ts";
import { quote } from "../scripts/db-roles/grants.ts";
import { roleFixture, denied } from "./role-db-fixture.ts";
import {
  appendSourcePolicy,
  readCurrentSourcePolicy,
  readCurrentPublicPolicy,
  lockCurrentSourcePolicies,
} from "../packages/backend/src/sources/permission-store.ts";
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

test("private creation confirms an explicit scope atomically and the real evaluator checks each current use", async (t) => {
  await import("./setup.ts");
  await closeDb();
  const f = await roleFixture(t);
  await provisionRoles(f.admin, { prefix: f.prefix, apply: true });
  const sessions = await f.login();
  await initializeDb("private-api", { DATABASE_URL_PRIVATE_OPS: f.urlFor("private_ops"), DATABASE_URL_AUTH: f.urlFor("auth"), DATABASE_POOL_MAX: "4" });
  await f.admin.unsafe("ALTER TABLE public.sources ADD COLUMN IF NOT EXISTS source_date_config_hash text");
  const { config } = await import("@amp/backend/config");
  const { buildApp } = await import("../apps/api/src/app.ts");
  const { evaluateSourcePolicy, saveSourcePolicy } = await import("@amp/backend/admin/sources");
  const { stopBoss } = await import("@amp/backend/jobs/queue");
  const original = { adminPassword: config.adminPassword, devAdmin: config.devAdmin, privateHost: config.privateHost };
  Object.assign(config, { adminPassword: "synthetic-policy-password-012345", devAdmin: null, privateHost: "private.policy.test" });
  const app = await buildApp("private-api");
  const forwarded = { "x-forwarded-host": "private.policy.test" };
  const payload = {
    id: "policy-created-source",
    name: "合成来源",
    kind: "rss",
    config: { feedUrl: "https://source.invalid/mining/feed.xml" },
    permission_scope: { hosts: ["source.invalid"], path_prefixes: ["/mining/"], document_types: ["news"], excluded_content: [] },
    attachments_in_scope: false,
  };
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers: forwarded, payload: {} })).statusCode, 401);
    const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: forwarded, payload: { password: config.adminPassword } });
    assert.equal(login.statusCode, 303);
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const who = await app.inject({ url: "/api/admin/me", headers: { ...forwarded, cookie } });
    const headers = { ...forwarded, cookie, "x-csrf-token": who.json().csrf as string };
    const post = (value: unknown) => app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: value as never });
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers: { ...forwarded, cookie }, payload })).statusCode, 403);
    assert.equal((await post({ ...payload, permission_scope: undefined })).statusCode, 400);
    assert.equal((await post({ ...payload, enabled: true })).statusCode, 400);
    const created = await post(payload);
    assert.equal(created.statusCode, 200, created.body);
    assert.equal("source_date_config_hash" in created.json().source, false, "internal date CAS identity is not an implicit HTTP field");
    assert.equal(created.json().source.enabled, false);
    assert.equal(created.json().source.health, "paused");
    assert.equal(created.json().source.next_fetch_at, null);
    assert.equal(created.json().source.site_fulltext, true);
    assert.equal(created.json().source.syndicate_fulltext, false);
    const detail = await app.inject({ url: `/api/admin/sources/${payload.id}`, headers });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal("source_date_config_hash" in detail.json().source, false);
    const initial = SourcePolicySchema.parse(detail.json().permission);
    assert.equal(initial.permission_version, 1);
    assert.ok(Object.values(initial.permissions).every((decision) => decision === "allow"));
    assert.equal(initial.evidence[0].kind, "owner_declared");
    assert.equal(initial.evidence[0].valid_until, null);
    assert.equal(initial.expires_at, null);
    assert.match(initial.reviewed_by, /^admin:\d+$/);
    const scope = { url: "https://source.invalid/mining/item", document_type: "news", attachment: false };
    const now = Date.parse("2030-01-01T00:00:00Z");
    const evaluate = async (capability: string, version = 1, resource = scope) => {
      const result = await evaluateSourcePolicy({ source_id: payload.id, expected_permission_version: version, lane: "news", capability, resource }, now);
      return { ...result, reason: "reason" in result ? result.reason : undefined };
    };
    for (const capability of Object.keys(initial.permissions)) assert.equal((await evaluate(capability)).decision, "allow");
    for (const resource of [
      { ...scope, url: "https://other.invalid/mining/item" },
      { ...scope, url: "https://source.invalid/other/item" },
      { ...scope, document_type: "policy" },
      { ...scope, attachment: true },
    ])
      assert.equal((await evaluate("external_model", 1, resource)).reason, "resource_mismatch");
    const duplicate = await post({ ...payload, id: "duplicate-other-id", site_fulltext: false });
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.equal(duplicate.json().created, false);
    assert.equal((await readCurrentSourcePolicy(payload.id))?.permission_version, 1, "duplicate joining never changes an existing policy");
    const narrowedId = "explicit-narrow-source";
    assert.equal(
      (await post({ ...payload, id: narrowedId, config: { feedUrl: "https://source.invalid/mining/second.xml" }, site_fulltext: false })).statusCode,
      200,
    );
    const narrowed = await readCurrentSourcePolicy(narrowedId);
    assert.equal(narrowed?.permissions.public_original_fulltext, "deny");
    assert.equal(narrowed?.permissions.public_translation, "deny");
    assert.equal(narrowed?.permissions.external_model, "allow");
    const concurrent = await Promise.all(
      ["parallel-source-one", "parallel-source-two"].map((id) => post({ ...payload, id, config: { feedUrl: "https://source.invalid/mining/concurrent.xml" } })),
    );
    assert.ok(concurrent.every((r) => r.statusCode === 200));
    assert.equal(concurrent.filter((r) => r.json().created).length, 1);
    assert.equal(
      (await sessions.worker`SELECT count(*) AS n FROM sources.source_policy_current WHERE source_id IN ('parallel-source-one','parallel-source-two')`)[0].n,
      1,
    );
    await f.admin.unsafe(`REVOKE INSERT ON public.audit_log FROM ${quote(f.roles.private_ops)}`);
    try {
      assert.equal(
        (await post({ ...payload, id: "rollback-created-source", config: { feedUrl: "https://source.invalid/mining/rollback.xml" } })).statusCode,
        500,
      );
    } finally {
      await f.admin.unsafe(`GRANT INSERT ON public.audit_log TO ${quote(f.roles.private_ops)}`);
    }
    assert.equal((await sessions.worker`SELECT count(*) AS n FROM sources WHERE id='rollback-created-source'`)[0].n, 0);
    assert.equal((await sessions.worker`SELECT count(*) AS n FROM sources.source_policy_versions WHERE source_id='rollback-created-source'`)[0].n, 0);

    await f.run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { initializeDb, closeDb } from '@amp/backend/db';
      import { ensureQueue, QUEUES, stopBoss } from '@amp/backend/jobs/queue';
      try { await initializeDb('worker'); await ensureQueue(QUEUES.republishSource); }
      finally { await stopBoss(); await closeDb(); }
    `,
      ],
      { DATABASE_URL_WORKER: f.urlFor("worker"), DATABASE_URL_BACKUP: f.urlFor("backup") },
    );
    const editLegacy = async (patch: Record<string, unknown>) => {
      const current = await app.inject({ url: `/api/admin/sources/${payload.id}`, headers });
      return app.inject({
        method: "PATCH",
        url: `/api/admin/sources/${payload.id}`,
        headers,
        payload: { patch, version: current.json().source.updated_at, reason: "synthetic narrowing" },
      });
    };
    await f.admin.unsafe(`REVOKE INSERT ON public.audit_log FROM ${quote(f.roles.private_ops)}`);
    try {
      assert.equal((await editLegacy({ site_fulltext: false })).statusCode, 500);
    } finally {
      await f.admin.unsafe(`GRANT INSERT ON public.audit_log TO ${quote(f.roles.private_ops)}`);
    }
    assert.equal((await readCurrentSourcePolicy(payload.id))?.permission_version, 1);
    assert.equal((await sessions.worker`SELECT site_fulltext FROM sources WHERE id=${payload.id}`)[0].site_fulltext, true);
    assert.equal((await editLegacy({ site_fulltext: false })).statusCode, 200);
    assert.equal((await readCurrentSourcePolicy(payload.id))?.permission_version, 2);
    assert.equal((await evaluate("public_original_fulltext", 2)).reason, "purpose_denied");
    assert.equal((await editLegacy({ site_fulltext: true })).statusCode, 409, "legacy flag cannot resurrect denied/unknown full text");
    assert.equal((await sessions.worker`SELECT site_fulltext FROM sources WHERE id=${payload.id}`)[0].site_fulltext, false);
    const inTransaction = await sessions.worker.begin(async (tx) => {
      await lockCurrentSourcePolicies(tx, [{ sourceId: payload.id, permissionVersion: 2 }]);
      return evaluateSourcePolicy({ source_id: payload.id, expected_permission_version: 2, lane: "news", capability: "fetch", resource: scope }, undefined, tx);
    });
    assert.equal(inTransaction.decision, "allow", "evaluation shares the caller's one-connection transaction");
    let version = 2;
    const replace = async (change: (policy: typeof initial) => void) => {
      const policy = structuredClone(initial);
      change(policy);
      await saveSourcePolicy(payload.id, { policy, expectedVersion: version, reason: "synthetic verification only" }, initial.reviewed_by);
      version++;
    };
    await replace((p) => {
      p.permissions.external_model = "deny";
    });
    assert.equal((await evaluate("external_model", 1)).reason, "version_changed");
    assert.equal((await evaluate("external_model", version)).reason, "purpose_denied");
    assert.equal((await evaluate("public_summary", version)).decision, "allow");
    await replace((p) => {
      p.permissions.external_model = "unknown";
    });
    assert.equal((await evaluate("external_model", version)).reason, "permission_unknown");
    await replace((p) => {
      p.conditions = ["attribution_required"];
    });
    assert.equal((await evaluate("external_model", version)).decision, "unknown");
    await replace((p) => {
      p.scope.excluded_content = ["third-party photos"];
    });
    assert.equal((await evaluate("public_summary", version)).decision, "unknown");
    await replace((p) => {
      p.evidence[0].scope.path_prefixes = ["/elsewhere/"];
    });
    assert.equal((await evaluate("external_model", version)).reason, "resource_mismatch");
    await replace((p) => {
      p.evidence[0].capabilities = p.evidence[0].capabilities.filter((purpose: string) => purpose !== "external_model" && purpose !== "public_translation");
      p.evidence.push({
        ...p.evidence[0],
        kind: "written_authorization",
        capabilities: ["external_model", "public_translation"],
        valid_until: new Date(now + 1000).toISOString(),
      });
    });
    for (const capability of ["external_model", "public_translation"]) {
      assert.equal((await evaluate(capability, version)).expires_at, new Date(now + 1000).toISOString());
      const expired = await evaluateSourcePolicy(
        { source_id: payload.id, expected_permission_version: version, lane: "policy", capability, resource: scope },
        now + 1000,
      );
      assert.equal("reason" in expired && expired.reason, "permission_expired");
    }
    await replace(() => {});
    assert.equal((await sessions.worker`SELECT site_fulltext FROM sources WHERE id=${payload.id}`)[0].site_fulltext, false);
    assert.equal((await editLegacy({ site_fulltext: false })).statusCode, 200);
    version++;
    assert.equal((await evaluate("public_translation", version)).reason, "purpose_denied", "explicit false still narrows a newly relaxed policy");
    assert.equal((await editLegacy({ site_fulltext: false })).statusCode, 200);
    assert.equal((await readCurrentSourcePolicy(payload.id))?.permission_version, version, "already-denied false is idempotent for permission versions");
    await f.admin.unsafe(`REVOKE SELECT ON sources.source_policy_versions FROM ${quote(f.roles.private_ops)}`);
    try {
      assert.equal((await evaluate("external_model", version)).reason, "verification_unavailable");
    } finally {
      await f.admin.unsafe(`GRANT SELECT ON sources.source_policy_versions TO ${quote(f.roles.private_ops)}`);
    }
    await app.close();
    await stopBoss();
    await closeDb();
    await initializeDb("public-api", { DATABASE_URL_PUBLIC_READ: f.urlFor("public_read"), DATABASE_URL_FEEDBACK_WRITE: f.urlFor("feedback_write") });
    assert.equal((await evaluate("public_summary", version)).decision, "allow", "public checking uses only the approved current projection");
    assert.equal((await evaluate("external_model", version)).reason, "verification_unavailable", "public login cannot read private purposes/evidence");
  } finally {
    await app.close();
    await stopBoss();
    await closeDb();
    Object.assign(config, original);
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

test("real permission storage is immutable, CAS/audit atomic, fenced and recoverable with the backup login", async (t) => {
  await import("./setup.ts"); // Fix the parent's credential directory before importing private administration.
  await closeDb();
  const f = await roleFixture(t);
  const migration = "sources/202610040001_source_permissions.sql";
  const previous = await f.admin`SELECT name,sha256,applied_at FROM schema_migrations WHERE name<>${migration} ORDER BY name`;
  assert.equal((await f.admin`SELECT count(*) AS n FROM sources.source_policy_current`)[0].n, 0, "fresh migration starts empty");
  // Recreate the exact pre-permission state in this fixture's own fresh database, then upgrade it.
  await f.admin.unsafe("DROP TABLE sources.source_policy_current; DROP TABLE sources.source_policy_versions; DROP SCHEMA sources");
  await f.admin`DELETE FROM schema_migrations WHERE name=${migration}`;
  await f.admin`INSERT INTO public.sources(id,name,kind,enabled,site_fulltext) VALUES
    ('source_fixture','permission fixture','external',false,true),('unrecorded_fixture','unrecorded fixture','external',false,false)`;
  await f.run(process.execPath, ["scripts/migrate.ts"], { DATABASE_URL: f.urlFor() });
  assert.deepEqual(await f.admin`SELECT name,sha256,applied_at FROM schema_migrations WHERE name<>${migration} ORDER BY name`, previous);
  assert.equal((await f.admin`SELECT site_fulltext FROM sources WHERE id='unrecorded_fixture'`)[0].site_fulltext, false);
  await provisionRoles(f.admin, { prefix: f.prefix, apply: true });
  const sessions = await f.login();
  await initializeDb("private-api", { DATABASE_URL_PRIVATE_OPS: f.urlFor("private_ops"), DATABASE_URL_AUTH: f.urlFor("auth"), DATABASE_POOL_MAX: "4" });
  const { saveSourcePolicy, updateSource } = await import("@amp/backend/admin/sources");
  const { stopBoss } = await import("@amp/backend/jobs/queue");
  const edit = (expectedVersion: number | null, policy = structuredClone(sourcePolicyExample)) =>
    saveSourcePolicy("source_fixture", { policy, expectedVersion, reason: "synthetic owner instruction" }, "admin:42");
  try {
    assert.equal(await readCurrentSourcePolicy("unrecorded_fixture", sessions.worker), null, "migration never manufactures an owner declaration");
    for (const policy of [{}, { source_id: "source_fixture" }, { permission_version: 1 }, { source_id: null, permission_version: 1 }]) {
      await assert.rejects(
        sessions.private_ops`INSERT INTO sources.source_policy_versions(source_id,permission_version,policy,policy_hash)
        VALUES('source_fixture',1,${sessions.private_ops.json(policy)},${"0".repeat(64)})`,
        (e: { code?: string }) => e.code === "23514",
      );
    }
    const first = await Promise.allSettled([edit(null), edit(null)]);
    assert.equal(first.filter((r) => r.status === "fulfilled").length, 1, "only one concurrent first version commits");
    assert.equal(first.filter((r) => r.status === "rejected" && r.reason.code === "conflict").length, 1);
    for (const projection of [{}, { source_id: "source_fixture" }, { source_id: null, permission_version: 1 }]) {
      await assert.rejects(
        sessions.private_ops`UPDATE sources.source_policy_current SET public_policy=${sessions.private_ops.json(projection)}
        WHERE source_id='source_fixture'`,
        (e: { code?: string }) => e.code === "23514",
      );
    }
    assert.equal((await sessions.worker`SELECT count(*) AS n FROM sources.source_policy_versions`)[0].n, 1);
    assert.equal((await sessions.private_ops`SELECT count(*) AS n FROM audit_log WHERE action='source.permission'`)[0].n, 1);
    const policy = await readCurrentSourcePolicy("source_fixture", sessions.worker);
    assert.equal(policy?.reviewed_by, "admin:42");
    assert.equal(policy?.expires_at, null);
    const publicPolicy = await readCurrentPublicPolicy("source_fixture", sessions.public_read);
    assert.deepEqual(Object.keys(publicPolicy!.permissions).sort(), ["public_excerpt", "public_original_fulltext", "public_summary", "public_translation"]);
    assert.ok(!("evidence" in publicPolicy!) && !("reviewed_by" in publicPolicy!) && !("external_model" in publicPolicy!.permissions));
    await denied(sessions.public_read, "SELECT policy FROM sources.source_policy_versions");
    for (const login of [sessions.worker, sessions.private_ops]) {
      await denied(login, "UPDATE sources.source_policy_versions SET policy='{}'");
      await denied(login, "DELETE FROM sources.source_policy_versions");
    }
    const narrow = structuredClone(sourcePolicyExample);
    narrow.permissions.public_translation = "deny";
    await edit(1, narrow);
    assert.equal((await readCurrentPublicPolicy("source_fixture", sessions.public_read))?.permissions.public_translation, "deny");
    await assert.rejects(edit(1), { code: "conflict" });
    const beforeAuditFailure = await readCurrentSourcePolicy("source_fixture", sessions.worker);
    await f.admin.unsafe(`REVOKE INSERT ON public.audit_log FROM ${quote(f.roles.private_ops)}`);
    try {
      await assert.rejects(edit(2), (e: { code?: string }) => e.code === "42501");
    } finally {
      await f.admin.unsafe(`GRANT INSERT ON public.audit_log TO ${quote(f.roles.private_ops)}`);
    }
    assert.deepEqual(await readCurrentSourcePolicy("source_fixture", sessions.worker), beforeAuditFailure);
    assert.equal((await sessions.worker`SELECT count(*) AS n FROM sources.source_policy_versions`)[0].n, 2, "failed audit rolls back history and pointer");

    const waiting = async (role: string) => {
      for (let tries = 0; tries < 100; tries++) {
        const [row] = await f.admin`SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
          WHERE l.locktype='advisory' AND NOT l.granted AND a.usename=${role}) AS blocked`;
        if (row.blocked) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail("expected a real advisory lock wait");
    };
    const held = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    const reader = sessions.worker.begin(async (tx) => {
      await lockCurrentSourcePolicies(tx, [{ sourceId: "source_fixture", permissionVersion: 2 }]);
      held.resolve();
      await resume.promise;
      await tx`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
        VALUES('permitted_result','source_fixture','permitted_result','https://source.invalid/mining/result','synthetic result',now(),now())`;
    });
    await held.promise;
    const editor = edit(2, narrow);
    try {
      await waiting(f.roles.private_ops);
      assert.equal((await readCurrentPublicPolicy("source_fixture", sessions.public_read))?.permission_version, 2);
    } finally {
      resume.resolve();
    }
    await reader;
    await editor;
    assert.equal((await sessions.worker`SELECT count(*) AS n FROM articles WHERE id='permitted_result'`)[0].n, 1);

    const changed = Promise.withResolvers<void>(),
      commit = Promise.withResolvers<void>();
    const writer = sessions.private_ops.begin(async (tx) => {
      await appendSourcePolicy(tx, 3, { ...narrow, permission_version: 4 });
      changed.resolve();
      await commit.promise;
    });
    await changed.promise;
    const stale = sessions.worker.begin(async (tx) => {
      await lockCurrentSourcePolicies(tx, [{ sourceId: "source_fixture", permissionVersion: 3 }]);
      await tx`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
        VALUES('stale_result','source_fixture','stale_result','https://source.invalid/mining/stale','must not commit',now(),now())`;
    });
    const rejected = assert.rejects(stale, { code: "conflict" });
    try {
      await waiting(f.roles.worker);
    } finally {
      commit.resolve();
    }
    await writer;
    await rejected;
    assert.equal((await sessions.worker`SELECT count(*) AS n FROM articles WHERE id='stale_result'`)[0].n, 0);

    const oldSnapshot = sessions.worker.begin("isolation level repeatable read", async (tx) => {
      const current = await readCurrentSourcePolicy("source_fixture", tx);
      await edit(4, narrow);
      return lockCurrentSourcePolicies(tx, [{ sourceId: "source_fixture", permissionVersion: current!.permission_version }]);
    });
    await assert.rejects(oldSnapshot, /read committed/);

    await f.run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { initializeDb, closeDb } from '@amp/backend/db';
      import { ensureQueue, QUEUES, stopBoss } from '@amp/backend/jobs/queue';
      try { await initializeDb('worker'); await ensureQueue(QUEUES.republishSource); }
      finally { await stopBoss(); await closeDb(); }
    `,
      ],
      { DATABASE_URL_WORKER: f.urlFor("worker"), DATABASE_URL_BACKUP: f.urlFor("backup") },
    );
    const beforeEdit = (await sessions.private_ops`SELECT * FROM sources WHERE id='source_fixture'`)[0];
    const patch = {
      name: "changed fixture",
      enabled: true,
      interval_minutes: 17,
      tier: "T1",
      participation_mode: "hot_signal",
      first_party: true,
      owner_entity_id: "fixture_owner",
      site_fulltext: false,
      syndicate_fulltext: false,
      tags: ["synthetic"],
      config: {},
    };
    const afterEdit = await updateSource("source_fixture", { patch, version: beforeEdit.updated_at.toISOString(), reason: "same behavior" }, "admin:42");
    for (const [key, value] of Object.entries(patch)) assert.deepEqual(afterEdit![key], value);
    assert.ok(afterEdit!.next_fetch_at instanceof Date);
    const clear = await updateSource(
      "source_fixture",
      { patch: { owner_entity_id: null, tags: [] }, version: afterEdit!.updated_at.toISOString() },
      "admin:42",
    );
    assert.equal(clear!.owner_entity_id, null);
    assert.deepEqual(clear!.tags, []);
    assert.equal(clear!.name, patch.name, "omitted fields are preserved");
    assert.deepEqual(await updateSource("source_fixture", { patch: {}, version: clear!.updated_at.toISOString() }, "admin:42"), clear);
    await assert.rejects(updateSource("source_fixture", { patch: { name: undefined }, version: clear!.updated_at.toISOString() }, "admin:42"), /Undefined/);
    await assert.rejects(updateSource("source_fixture", { patch: { id: "overwrite" }, version: clear!.updated_at.toISOString() }, "admin:42"));
    const audits = await sessions.private_ops`SELECT actor,after FROM audit_log WHERE action='source.update' ORDER BY id`;
    assert.equal(audits.length, 2, "empty/invalid edits do not produce an audit");
    assert.equal(audits[0].actor, "admin:42");
    assert.deepEqual(audits[0].after, patch);
    assert.equal((await sessions.private_ops`SELECT value FROM settings WHERE key='republish.source:source_fixture'`)[0].value.status, "queued");
    assert.equal((await sessions.worker`SELECT count(*) AS n FROM pgboss.job WHERE data->>'sourceId'='source_fixture'`)[0].n, 1);

    const archive = path.join(f.dir, "permissions.dump"),
      restored = `${f.prefix}_restore_test`;
    await f.run("pg_dump", ["--format=custom", "--file", archive, f.urlFor("backup")]);
    await f.createDatabase(restored);
    await f.run("pg_restore", ["--no-owner", "--no-acl", "--dbname", f.urlFor(undefined, restored), archive]);
    const restoredDb = f.open(f.urlFor(undefined, restored));
    assert.deepEqual(await readCurrentSourcePolicy("source_fixture", restoredDb), await readCurrentSourcePolicy("source_fixture", sessions.worker));
    assert.deepEqual(
      await restoredDb`SELECT policy_hash FROM sources.source_policy_versions ORDER BY permission_version`,
      await sessions.worker`SELECT policy_hash FROM sources.source_policy_versions ORDER BY permission_version`,
    );
  } finally {
    await stopBoss();
    await closeDb();
  }
});
