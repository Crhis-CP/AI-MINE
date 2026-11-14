// 法规文书的后台控制 (TASK-0610): list, take down, pause, put back; readers see the withdrawal at once.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { changeAdminPolicyPublication, listAdminPolicies } from "../modules/policy/backend/admin.ts";
import { ensureDocument, PolicyReadError } from "../modules/policy/backend/read.ts";

const T = tag();
const A = `pol-admin-a-${T}`,
  B = `pol-admin-b-${T}`;

before(async () => {
  await sql`INSERT INTO publication.policy_documents(id) VALUES(${A}),(${B})`;
});
after(async () => {
  await sql`DELETE FROM publication.policy_documents WHERE id IN (${A},${B})`;
  await closeDb();
});

test("an operator lists documents, takes one down with a reason, and readers get 已下架 at once", async () => {
  const mine = async (state?: "withdrawn" | "paused") => (await listAdminPolicies({ q: `-${T}`, state })).items.map((d) => d.id).sort();
  assert.deepEqual(await mine(), [A, B]);
  assert.deepEqual(await mine("withdrawn"), []);
  await ensureDocument(A);

  const down = await changeAdminPolicyPublication(A, { withdrawn: true, reason: "来源方要求撤下" }, "owner:test");
  assert.equal(down?.withdrawn, true);
  assert.equal(down?.publishing_paused, false);
  assert.equal(down?.title, null, "a document without a public edition has no title");
  assert.deepEqual(await mine("withdrawn"), [A]);
  await assert.rejects(ensureDocument(A), (error: unknown) => error instanceof PolicyReadError && error.status === 410);
  const [log] = await sql<{ actor: string; reason: string }[]>`
    SELECT actor,reason FROM audit_log WHERE subject=${`policy:${A}`} AND action='policy.publication' ORDER BY id DESC LIMIT 1`;
  assert.deepEqual({ ...log }, { actor: "owner:test", reason: "来源方要求撤下" });

  const back = await changeAdminPolicyPublication(A, { withdrawn: false, reason: "来源方同意恢复" }, "owner:test");
  assert.equal(back?.withdrawn, false);
  await ensureDocument(A);
});

test("pausing further publication is separate from taking down; bad requests change nothing", async () => {
  const paused = await changeAdminPolicyPublication(B, { paused: true, reason: "等来源方更正" }, "owner:test");
  assert.equal(paused?.publishing_paused, true);
  assert.equal(paused?.withdrawn, false, "what readers see stays");
  await ensureDocument(B);
  assert.deepEqual(
    (await listAdminPolicies({ q: `-${T}`, state: "paused" })).items.map((d) => d.id),
    [B],
  );

  await assert.rejects(changeAdminPolicyPublication(B, { reason: "没有说明要改什么" }, "owner:test"), { statusCode: 400 });
  await assert.rejects(changeAdminPolicyPublication(B, { withdrawn: true, reason: " " }, "owner:test"));
  assert.equal(await changeAdminPolicyPublication(`missing-${T}`, { withdrawn: true, reason: "不存在" }, "owner:test"), null);
  const [row] = await sql<{ withdrawn: boolean }[]>`SELECT withdrawn FROM publication.policy_documents WHERE id=${B}`;
  assert.equal(row!.withdrawn, false);
});
