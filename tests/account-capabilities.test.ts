import assert from "node:assert/strict";
import { test } from "node:test";
import { injectDb } from "@amp/backend/db";
import { sha256 } from "@amp/backend/lib/ids";
import { sessionPrincipal, SESSION_COOKIE, requireCapability, requireOwner, currentCapability, AccountPermissionDenied } from "@amp/backend/admin/auth";
import { lockAccountAccess } from "../packages/backend/src/admin/account-access.ts";
import { publicRoleFixture } from "./public-role-fixture.ts";
import { denied } from "./role-db-fixture.ts";

test("real session identity and current access revision distinguish Owner, delegated models.manage, legacy admission and dev impersonation", async (t) => {
  const f = await publicRoleFixture(t),
    dbs = await f.login(),
    dispose = injectDb({ identity: dbs.auth });
  t.after(dispose);
  async function user(name: string, role: "owner" | "admin" | null, manage = false, temporary = false) {
    const [u] = await dbs.auth`INSERT INTO admin_users(email,display_name) VALUES(${`${name}@synthetic.test`},${name}) RETURNING id`;
    if (role)
      await dbs.auth`INSERT INTO identity.account_access(user_id,role,models_manage,must_change_password) VALUES(${u.id},${role},${manage},${temporary})`;
    const token = `synthetic-${name}`;
    await dbs.auth`INSERT INTO admin_sessions(id_hash,user_id,csrf_token,expires_at) VALUES(${sha256(token)},${u.id},'synthetic-csrf',now()+interval '1 hour')`;
    const principal = await sessionPrincipal(`${SESSION_COOKIE}=${token}`);
    assert.ok(principal);
    return { principal, token, id: Number(u.id) };
  }
  const owner = await user("owner", "owner"),
    manager = await user("manager", "admin", true),
    legacy = await user("legacy", null),
    temporary = await user("temporary", "admin", true, true);
  await requireOwner(owner.principal);
  await requireCapability(owner.principal, "models.manage");
  await requireCapability(manager.principal, "models.manage");
  await assert.rejects(requireOwner(manager.principal), AccountPermissionDenied);
  await assert.rejects(requireOwner(legacy.principal), AccountPermissionDenied);
  await assert.rejects(requireCapability(temporary.principal, "models.manage"), AccountPermissionDenied);
  assert.equal(await currentCapability({ ...owner.principal, dev: true }, "models.manage"), false);
  assert.equal(await currentCapability({ ...legacy.principal, accessRevision: 1 }, "owner"), false);
  assert.equal(await currentCapability(manager.principal, "unknown.capability"), false);
  await denied(dbs.private_ops, "SELECT email FROM admin_users");
  await denied(dbs.public_read, "SELECT * FROM identity.account_access");
  await denied(dbs.worker, `UPDATE identity.account_access SET role='owner' WHERE user_id=${manager.id}`);
  await dbs.private_ops.begin((tx) => requireCapability(manager.principal, "models.manage", tx));
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const business = dbs.private_ops.begin(async (tx) => {
    await requireCapability(manager.principal, "models.manage", tx);
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  let revoked = false;
  const revoke = dbs.auth.begin(async (tx) => {
    await lockAccountAccess(tx, manager.id, true);
    await tx`UPDATE identity.account_access SET models_manage=false,revision=revision+1 WHERE user_id=${manager.id}`;
    await tx`DELETE FROM admin_sessions WHERE user_id=${manager.id}`;
    revoked = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(revoked, false);
  release.resolve();
  await business;
  await revoke;
  await assert.rejects(
    dbs.private_ops.begin((tx) => requireCapability(manager.principal, "models.manage", tx)),
    AccountPermissionDenied,
  );
  assert.equal(await sessionPrincipal(`${SESSION_COOKIE}=${manager.token}`), null);
  await assert.rejects(dbs.auth`INSERT INTO identity.account_access(user_id,role) VALUES(${legacy.id},'owner')`, /one_account_owner/);
  await assert.rejects(dbs.auth`UPDATE identity.account_access SET active=false WHERE user_id=${owner.id}`, /check constraint/);
});
