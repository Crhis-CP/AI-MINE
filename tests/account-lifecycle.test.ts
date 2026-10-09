import assert from "node:assert/strict";
import { test } from "node:test";
import { injectDb } from "@amp/backend/db";
import { SESSION_COOKIE, sessionPrincipal, requireOwner, requireCapability } from "@amp/backend/admin/auth";
import {
  provisionFirstOwner,
  recoverOwnerPassword,
  namedPasswordLogin,
  changeOwnPassword,
  createAdministrator,
  changeAdministrator,
  listAccounts,
} from "../packages/backend/src/admin/accounts.ts";
import { issueLoginNonce, consumeLoginNonce, consumeAccountAttempt } from "../packages/backend/src/admin/account-login.ts";
import { publicRoleFixture } from "./public-role-fixture.ts";
import { denied } from "./role-db-fixture.ts";

test("named accounts, forced password changes, role revocation, capacity race and one-use Owner recovery use real auth role", async (t) => {
  const f = await publicRoleFixture(t),
    dbs = await f.login(),
    dispose = injectDb({ identity: dbs.auth });
  t.after(dispose);
  const setup = await provisionFirstOwner({ loginName: "SYNTHETIC.OWNER", displayName: "合成负责人", reason: "isolated test only" });
  const initial = await namedPasswordLogin(setup.loginName, setup.temporaryPassword, "/admin/accounts", undefined, "synthetic-origin");
  const principal = await sessionPrincipal(`${SESSION_COOKIE}=${initial.token}`);
  assert.ok(principal?.mustChangePassword);
  assert.equal(initial.returnTo, "/admin/account");
  await assert.rejects(requireOwner(principal));
  await assert.rejects(namedPasswordLogin(setup.loginName, setup.temporaryPassword, "/admin", undefined, "synthetic-origin"));
  const ownerPassword = "Synthetic Owner password 138";
  await changeOwnPassword(
    principal,
    {
      current_password: setup.temporaryPassword,
      new_password: ownerPassword,
      password_confirmation: ownerPassword,
      expected_revision: principal.accessRevision,
    },
    "synthetic-origin",
  );
  assert.equal(await sessionPrincipal(`${SESSION_COOKIE}=${initial.token}`), null);
  const token = (await namedPasswordLogin(setup.loginName, ownerPassword, "/admin/accounts", undefined, "synthetic-origin")).token;
  const owner = await sessionPrincipal(`${SESSION_COOKIE}=${token}`);
  assert.ok(owner);
  await requireOwner(owner);
  const admin = await createAdministrator(
    owner,
    {
      login_name: "Reader.One",
      display_name: "合成管理员",
      password: "Synthetic admin secret 138",
      password_confirmation: "Synthetic admin secret 138",
      confirmed: true,
    },
    "synthetic-create-138",
  );
  assert.equal(admin.login_name, "reader.one");
  const replay = await createAdministrator(
    owner,
    {
      login_name: "reader.one",
      display_name: "合成管理员",
      password: "Synthetic admin secret 138",
      password_confirmation: "Synthetic admin secret 138",
      confirmed: true,
    },
    "synthetic-create-138",
  );
  assert.equal(replay.id, admin.id);
  await assert.rejects(
    createAdministrator(
      owner,
      {
        login_name: "reader.changed",
        display_name: "合成管理员",
        password: "Synthetic admin secret 138",
        password_confirmation: "Synthetic admin secret 138",
        confirmed: true,
      },
      "synthetic-create-138",
    ),
  );
  assert.ok(admin.must_change_password);
  const admLogin = await namedPasswordLogin("READER.ONE", "Synthetic admin secret 138", "/admin", undefined, "synthetic-other"),
    temporary = await sessionPrincipal(`${SESSION_COOKIE}=${admLogin.token}`);
  assert.ok(temporary);
  await changeOwnPassword(
    temporary,
    {
      current_password: "Synthetic admin secret 138",
      new_password: "Updated admin secret 138",
      password_confirmation: "Updated admin secret 138",
      expected_revision: temporary.accessRevision,
    },
    "synthetic-other",
  );
  const before = (await listAccounts(owner)).accounts.find((a) => a.id === admin.id)!;
  const granted = await changeAdministrator(owner, admin.id, { action: "grant_models", expected_revision: before.revision, confirmed: true });
  const manager = await sessionPrincipal(
    `${SESSION_COOKIE}=${(await namedPasswordLogin("reader.one", "Updated admin secret 138", "/admin", undefined, "synthetic-other")).token}`,
  );
  assert.ok(manager);
  await requireCapability(manager, "models.manage");
  await assert.rejects(requireOwner(manager));
  await assert.rejects(changeAdministrator(owner, setup.userId, { action: "disable", expected_revision: owner.accessRevision, confirmed: true }));
  await changeAdministrator(owner, admin.id, { action: "disable", expected_revision: granted.revision, confirmed: true });
  await assert.rejects(requireCapability(manager, "models.manage"));
  await assert.rejects(namedPasswordLogin("reader.one", "Updated admin secret 138", "/admin", undefined, "synthetic-other"));
  await assert.rejects(
    createAdministrator(owner, {
      login_name: "reader.one",
      display_name: "禁止复用",
      password: ownerPassword,
      password_confirmation: ownerPassword,
      confirmed: true,
    }),
  );
  const [count] = await dbs.auth`SELECT count(*)::int AS n FROM admin_users`;
  await dbs.auth`UPDATE identity.account_policy SET max_accounts=${count.n + 1}`;
  const races = await Promise.allSettled(
    ["capacity.a", "capacity.b"].map((login_name) =>
      createAdministrator(owner, { login_name, display_name: login_name, password: ownerPassword, password_confirmation: ownerPassword, confirmed: true }),
    ),
  );
  assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
  await denied(dbs.private_ops, "SELECT password_hash FROM identity.password_accounts");
  await denied(dbs.public_read, "SELECT * FROM identity.login_nonces");
  await dbs.auth`UPDATE admin_sessions SET last_seen_at=now()-interval '31 minutes' WHERE user_id=${setup.userId}`;
  assert.equal(await sessionPrincipal(`${SESSION_COOKIE}=${token}`), null);
  const recovered = await recoverOwnerPassword("isolated synthetic recovery drill");
  assert.equal(await sessionPrincipal(`${SESSION_COOKIE}=${token}`), null);
  const recovery = await namedPasswordLogin(recovered.loginName, recovered.temporaryPassword, "/admin", undefined, "synthetic-recovery");
  assert.equal(recovery.returnTo, "/admin/account");
  await assert.rejects(namedPasswordLogin(recovered.loginName, recovered.temporaryPassword, "/admin", undefined, "synthetic-recovery"));
  const [row] = await dbs.auth`SELECT password_hash FROM identity.password_accounts WHERE user_id=${setup.userId}`;
  assert.match(row.password_hash, /^\$argon2id\$/);
  const audits = JSON.stringify(await dbs.auth`SELECT before,after,reason FROM audit_log WHERE action LIKE 'auth.%'`);
  for (const secret of [setup.temporaryPassword, recovered.temporaryPassword, ownerPassword]) assert.ok(!audits.includes(secret));
});

test("single-use login nonce and per-account/source rate controls are persistent and do not globally deny", async (t) => {
  const f = await publicRoleFixture(t),
    dbs = await f.login(),
    dispose = injectDb({ identity: dbs.auth });
  t.after(dispose);
  const n = await issueLoginNonce("source-a");
  await assert.rejects(consumeLoginNonce(n.token, n.token, "other-source"));
  await assert.rejects(consumeLoginNonce(n.token, "wrong", "source-a"));
  await consumeLoginNonce(n.token, n.token, "source-a");
  await assert.rejects(consumeLoginNonce(n.token, n.token, "source-a"));
  for (let i = 0; i < 5; i++) await consumeAccountAttempt("login", "same-user", `source-${i}`);
  await assert.rejects(consumeAccountAttempt("login", "same-user", "source-next"), (e) => (e as { statusCode: number }).statusCode === 429);
  for (let i = 0; i < 20; i++) await consumeAccountAttempt("login", `account-${i}`, "same-source");
  await assert.rejects(consumeAccountAttempt("login", "other-account", "same-source"));
  await dbs.auth`INSERT INTO identity.auth_attempts(id,kind,account_hash,source_hash) SELECT 'synthetic-load-'||n,'login','other-'||n,'else-'||n FROM generate_series(1,31)n`;
  await consumeAccountAttempt("login", "unaffected-user", "unaffected-source");
});

test("private HTTP binds one-use login nonce, forced-change scope, Owner account routes and CSRF; outage retains cookie", async (t) => {
  const { buildApp } = await import("../apps/api/src/app.ts"),
    { config } = await import("@amp/backend/config");
  const f = await publicRoleFixture(t),
    dbs = await f.login(),
    dispose = injectDb({ identity: dbs.auth });
  t.after(dispose);
  const originalHost = config.privateHost,
    originalDev = config.devAdmin;
  config.privateHost = "account.example.test";
  config.devAdmin = null;
  const app = await buildApp("private-api"),
    publicApp = await buildApp("public-api");
  t.after(async () => {
    await app.close();
    await publicApp.close();
    config.privateHost = originalHost;
    config.devAdmin = originalDev;
  });
  const headers = { host: "internal", "x-forwarded-host": "account.example.test" };
  const setup = await provisionFirstOwner({ loginName: "http.owner", displayName: "合成负责人", reason: "isolated HTTP test" });
  const nonce = await app.inject({ url: "/api/auth/password-nonce", headers });
  assert.equal(nonce.statusCode, 200, nonce.body);
  const nonceCookie = String(nonce.headers["set-cookie"]).split(";")[0]!,
    payload = { login_name: setup.loginName, password: setup.temporaryPassword, login_nonce: nonce.json().token, return: "/admin/accounts" };
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/password", headers, payload })).headers.location?.includes("verification"), true);
  const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { ...headers, cookie: nonceCookie }, payload });
  assert.equal(login.statusCode, 303);
  assert.equal(login.headers.location, "/admin/account");
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!,
    sessionHeaders = { ...headers, cookie };
  const me = await app.inject({ url: "/api/admin/me", headers: sessionHeaders });
  assert.equal(me.json().mustChangePassword, true);
  assert.equal(me.json().owner, false);
  assert.equal((await app.inject({ url: "/api/admin/accounts", headers: sessionHeaders })).statusCode, 403);
  const current = await app.inject({ url: "/api/admin/account", headers: sessionHeaders });
  assert.equal(current.statusCode, 200, current.body);
  assert.ok(!current.body.includes("password_hash"));
  const change = {
    current_password: setup.temporaryPassword,
    new_password: "HTTP synthetic changed password",
    password_confirmation: "HTTP synthetic changed password",
    expected_revision: current.json().account.revision,
  };
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/account/password", headers: sessionHeaders, payload: change })).statusCode, 403);
  const changed = await app.inject({
    method: "POST",
    url: "/api/admin/account/password",
    headers: { ...sessionHeaders, "x-csrf-token": me.json().csrf },
    payload: change,
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.deepEqual(changed.json(), { changed: true, signed_out: true });
  assert.equal((await app.inject({ url: "/api/admin/me", headers: sessionHeaders })).statusCode, 401);
  assert.equal((await publicApp.inject({ url: "/api/admin/accounts", headers })).statusCode, 404);
  dispose();
  const fail = injectDb({
    identity: (() => {
      throw new Error("synthetic unavailable");
    }) as unknown as typeof dbs.auth,
  });
  try {
    const unavailable = await app.inject({ url: "/api/admin/me", headers: sessionHeaders });
    assert.equal(unavailable.statusCode, 503);
    assert.equal(unavailable.headers["set-cookie"], undefined);
  } finally {
    fail();
  }
});
