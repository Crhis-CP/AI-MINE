import "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { readCurrentSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";
import { recordPolicyOriginal, readPolicyOriginal } from "../packages/backend/src/policy/originals.ts";
import type { PolicyOriginalInput } from "../packages/backend/src/policy/types.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
import { roleFixture, denied } from "./role-db-fixture.ts";
import { provisionRoles } from "../scripts/db-roles.ts";

const sql = dbOf("policy"),
  url = "https://source.invalid/original";
let serial = 0,
  sourceId: string;
after(closeDb);
beforeEach(async () => {
  sourceId = `original-${++serial}`;
  await sql`INSERT INTO sources(id,name,kind,lane) VALUES(${sourceId},'Synthetic policy source','external','policy')`;
  await grantDateFixture(sourceId, [url]);
});
const input = (body = "shall not exceed 10"): PolicyOriginalInput => ({
  sourceId,
  permissionVersion: 1,
  identity: { jurisdiction: "AR", authority: sourceId, documentType: "decree", documentNumber: "1/2026", officialUrl: url },
  versionKey: "original-publication",
  language: "es",
  kind: "original",
  officialTitle: "Source title",
  expectedHead: null,
  catalogueClosed: true,
  resources: [
    { url, mediaType: "text/html", attachment: false, required: true, state: "acquired", body: Buffer.from(body), reason: null },
    {
      url: `${url}/annex.pdf`,
      mediaType: "application/pdf",
      attachment: true,
      required: true,
      state: "acquired",
      body: Buffer.from([0, 1, 255, 128]),
      reason: null,
    },
  ],
});
async function changePermission(patch: (current: NonNullable<Awaited<ReturnType<typeof readCurrentSourcePolicy>>>) => Record<string, unknown>) {
  const current = (await readCurrentSourcePolicy(sourceId))!,
    expectedVersion = current.permission_version;
  const policy = { ...current, ...patch(current), permission_version: expectedVersion + 1 };
  return saveSourcePolicy(sourceId, { policy, expectedVersion, reason: "synthetic narrowing" }, "test");
}

test("raw bytes roundtrip; concurrent retries are idempotent, A-B-A is three revisions and late writes cannot replace the head", async () => {
  const value = input(),
    initial = await Promise.all([recordPolicyOriginal(value), recordPolicyOriginal(value)]);
  assert.equal(initial[0].revisionId, initial[1].revisionId);
  assert.equal(initial.filter((row) => row.created).length, 1);
  const read = await readPolicyOriginal(initial[0].expressionId);
  assert.deepEqual(
    read!.resources.map((row) => row.body),
    value.resources.map((row) => row.body),
  );
  assert.equal(read!.manifest.state, "pending_extraction");
  const b = await recordPolicyOriginal({ ...input("shall exceed 11"), expectedHead: initial[0].revisionId });
  await assert.rejects(recordPolicyOriginal(input("late")), /head changed/);
  const a = await recordPolicyOriginal({ ...value, expectedHead: b.revisionId });
  assert.notEqual(a.revisionId, initial[0].revisionId);
  assert.equal((await sql`SELECT count(*)::int AS n FROM policy.document_revisions WHERE expression_id=${a.expressionId}`)[0].n, 3);
  assert.equal((await readPolicyOriginal(a.expressionId))!.revisionId, a.revisionId);
});

test("titles never define identity; authorities and languages stay separate; attachment changes create a new snapshot", async () => {
  const value = input(),
    first = await recordPolicyOriginal(value);
  const renamed = await recordPolicyOriginal({ ...value, officialTitle: "中文标题", expectedHead: first.revisionId });
  assert.equal(renamed.instrumentId, first.instrumentId);
  const language = await recordPolicyOriginal({ ...value, language: "zh", kind: "official_translation" });
  assert.equal(language.instrumentId, first.instrumentId);
  assert.notEqual(language.expressionId, first.expressionId);
  const other = await recordPolicyOriginal({ ...value, identity: { ...value.identity, authority: "other-province" } });
  assert.notEqual(other.instrumentId, first.instrumentId);
  value.resources[1]!.body = Buffer.from("changed annex");
  const revised = await recordPolicyOriginal({ ...value, expectedHead: renamed.revisionId });
  assert.notEqual(revised.revisionId, renamed.revisionId);
});

test("missing annex, unclosed directory and capacity never confer completeness; fetched failures cannot carry bytes", async () => {
  for (const state of ["missing", "blocked_capacity"] as const) {
    const value = input();
    value.identity.documentNumber = state;
    value.resources[1] = { ...value.resources[1]!, state, body: null, reason: "synthetic gap" };
    assert.equal((await recordPolicyOriginal(value)).state, state === "missing" ? "incomplete" : state);
  }
  assert.equal((await recordPolicyOriginal({ ...input(), catalogueClosed: false })).state, "incomplete");
  const bad = input();
  bad.resources[1]!.state = "failed";
  await assert.rejects(recordPolicyOriginal(bad));
});

test("current purpose and attachment scope are checked atomically; narrowing stops processing without deleting evidence", async () => {
  const outside = input();
  outside.identity.officialUrl = "https://other.invalid/identity";
  await assert.rejects(recordPolicyOriginal(outside), /store_metadata/);
  assert.equal((await sql`SELECT count(*)::int AS n FROM policy.document_revisions WHERE source_id=${sourceId}`)[0].n, 0);
  const first = await recordPolicyOriginal(input());
  await changePermission(() => ({ attachments_in_scope: false }));
  await assert.rejects(readPolicyOriginal(first.expressionId), /permission version changed/i);
  await assert.rejects(recordPolicyOriginal({ ...input("changed"), permissionVersion: 2, expectedHead: first.revisionId }), /permission denied/);
  assert.equal((await sql`SELECT count(*)::int AS n FROM policy.document_revisions WHERE expression_id=${first.expressionId}`)[0].n, 1);
  await changePermission((current) => ({ permissions: { ...current.permissions, store_fulltext: "deny" } }));
  await assert.rejects(recordPolicyOriginal({ ...input(), permissionVersion: 3 }), /store_fulltext/);
});

test("real application roles cannot alter history and public readers cannot query the private originals", async (t) => {
  const f = await roleFixture(t);
  await provisionRoles(f.admin, { prefix: f.prefix, apply: true });
  const roles = await f.login();
  for (const table of ["instruments", "versions", "document_revisions", "original_resources"]) {
    await denied(roles.worker, `DELETE FROM policy.${table}`);
    await denied(roles.worker, `UPDATE policy.${table} SET ${table === "original_resources" ? "ordinal=ordinal" : "id=id"}`);
    await denied(roles.public_read, `SELECT * FROM policy.${table}`);
  }
});
