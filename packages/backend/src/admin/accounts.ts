import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { dbOf, type Db } from "../db.ts";
import { config } from "../config.ts";
import {
  AccountCreateRequest,
  AccountActionRequest,
  AccountPasswordChangeRequest,
  AccountRecord,
  AccountList,
  CurrentAccount,
} from "@amp/contracts/http/private";
import { AccountLoginName } from "@amp/contracts/http/private";
import { hashAccountPassword, verifyAccountPassword } from "./account-crypto.ts";
import { consumeAccountAttempt, clearAccountLoginAttempts } from "./account-login.ts";
import { requireOwner, readAccountAccess, lockAccountAccess, AccountPermissionDenied } from "./account-access.ts";
import { audit, createAccountSession, LoginRejected, safeReturn, type AdminPrincipal } from "./auth.ts";
import { accountCommand } from "./account-commands.ts";
import { accountNotice } from "./account-notices.ts";
const sql = dbOf("identity");
const INVALID = "账号或密码不正确，请检查后重试。";
export class AccountInputError extends Error {
  readonly statusCode = 400;
}
export class AccountStateConflict extends Error {
  readonly code = "conflict";
  constructor() {
    super("账号已存在，或当前状态不允许此操作，请刷新后重试。");
  }
}
const idOf = (principal: AdminPrincipal) => {
  if (principal.dev || !Number.isSafeInteger(principal.userId) || !principal.userId) throw new AccountPermissionDenied();
  return principal.userId;
};
const asIso = (value: Date | null) => value?.toISOString() ?? null;
async function accountRows(db: Db = sql, id?: number) {
  const rows =
    await db`SELECT u.id,p.login_name,u.display_name,u.email,u.last_login_at,a.role,a.active,a.models_manage,a.must_change_password,a.revision,p.user_id IS NOT NULL AS managed
   FROM admin_users u LEFT JOIN identity.account_access a ON a.user_id=u.id LEFT JOIN identity.password_accounts p ON p.user_id=u.id
   WHERE (${id ?? null}::bigint IS NULL OR u.id=${id ?? null}) ORDER BY (a.role='owner') DESC NULLS LAST,u.id`;
  return rows.map((r) =>
    AccountRecord.parse({
      id: Number(r.id),
      login_name: r.login_name ?? r.email,
      display_name: r.display_name ?? r.login_name ?? r.email ?? `管理员 ${r.id}`,
      role: r.role ?? "admin",
      active: r.active ?? true,
      models_manage: r.role === "owner" || !!r.models_manage,
      must_change_password: !!r.must_change_password,
      revision: r.revision ?? 0,
      managed: r.managed,
      last_login_at: asIso(r.last_login_at),
    }),
  );
}
export async function listAccounts(principal: AdminPrincipal) {
  return sql.begin(async (tx) => {
    await requireOwner(principal, tx);
    const [policy] = await tx`SELECT max_accounts FROM identity.account_policy WHERE id=1`;
    return AccountList.parse({ accounts: await accountRows(tx), limit: policy!.max_accounts });
  });
}
export async function currentAccount(principal: AdminPrincipal) {
  const id = idOf(principal),
    account = (await accountRows(sql, id))[0];
  if (!account?.active) throw new AccountPermissionDenied();
  return CurrentAccount.parse({ account, password_login: account.managed || account.login_name === "admin@local" });
}
async function checkCapacity(db: Db) {
  await db`SELECT pg_advisory_xact_lock(hashtext('account-capacity'))`;
  const [count] = await db`SELECT count(*)::int AS n FROM admin_users`;
  const [limit] = await db`SELECT max_accounts FROM identity.account_policy WHERE id=1 FOR SHARE`;
  if (!limit || count!.n >= limit.max_accounts) throw new AccountStateConflict();
}
async function freeLoginName(db: Db, name: string, ownId?: number) {
  const [row] = await db`SELECT id FROM admin_users WHERE lower(email)=${name} AND (${ownId ?? null}::bigint IS NULL OR id<>${ownId ?? null})`;
  if (row) throw new AccountStateConflict();
}
function conflict(error: unknown): never {
  if ((error as { code?: string }).code === "23505") throw new AccountStateConflict();
  throw error;
}
export async function createAdministrator(principal: AdminPrincipal, input: unknown, commandKey?: string) {
  const value = AccountCreateRequest.parse(input);
  await requireOwner(principal);
  const hash = await hashAccountPassword(value.password);
  try {
    return await accountCommand(principal, commandKey, "create", value, async (tx) => {
      await requireOwner(principal, tx);
      await checkCapacity(tx);
      await freeLoginName(tx, value.login_name);
      const [u] = await tx`INSERT INTO admin_users(display_name) VALUES(${value.display_name}) RETURNING id`;
      await tx`INSERT INTO identity.account_access(user_id,role,must_change_password) VALUES(${u!.id},'admin',true)`;
      await tx`INSERT INTO identity.password_accounts(user_id,login_name,password_hash) VALUES(${u!.id},${value.login_name},${hash})`;
      await audit(
        `admin:${idOf(principal)}`,
        "auth.account.create",
        `account:${u!.id}`,
        null,
        null,
        { login_name: value.login_name, display_name: value.display_name },
        undefined,
        tx,
      );
      return (await accountRows(tx, Number(u!.id)))[0]!;
    });
  } catch (error) {
    return conflict(error);
  }
}
export async function changeAdministrator(principal: AdminPrincipal, userId: number, input: unknown, commandKey?: string) {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new AccountInputError("请选择有效账号。");
  const value = AccountActionRequest.parse(input);
  await requireOwner(principal);
  const hash = value.action === "reset_password" ? await hashAccountPassword(value.password!) : null;
  const result = await accountCommand(principal, commandKey, `account:${userId}`, value, async (tx) => {
    await requireOwner(principal, tx);
    await lockAccountAccess(tx, userId, true);
    const [user] = await tx`SELECT id FROM admin_users WHERE id=${userId}`;
    if (!user) throw new AccountStateConflict();
    const current = await readAccountAccess(userId, tx);
    if (current?.role === "owner" || userId === principal.userId) throw new AccountPermissionDenied();
    if ((current?.revision ?? 0) !== value.expected_revision) throw new AccountStateConflict();
    if (value.action === "reset_password") {
      const updated =
        await tx`UPDATE identity.password_accounts SET password_hash=${hash},credential_revision=credential_revision+1,one_use=false,temporary_expires_at=NULL,temporary_used_at=NULL,changed_at=now() WHERE user_id=${userId} RETURNING user_id`;
      if (!updated.length) throw new AccountInputError("该账号尚未设置密码登录，请建立具名账号后再重置。");
    }
    const active = value.action === "enable" ? true : value.action === "disable" ? false : (current?.active ?? true);
    const manage = value.action === "grant_models" ? true : value.action === "revoke_models" ? false : (current?.models_manage ?? false);
    const force = value.action === "reset_password" ? true : (current?.must_change_password ?? false);
    await tx`INSERT INTO identity.account_access(user_id,role,active,models_manage,must_change_password,revision) VALUES(${userId},'admin',${active},${manage},${force},1)
   ON CONFLICT(user_id) DO UPDATE SET active=EXCLUDED.active,models_manage=EXCLUDED.models_manage,must_change_password=EXCLUDED.must_change_password,revision=identity.account_access.revision+1`;
    await tx`DELETE FROM admin_sessions WHERE user_id=${userId}`;
    await audit(
      `admin:${idOf(principal)}`,
      `auth.account.${value.action}`,
      `account:${userId}`,
      null,
      null,
      { active, models_manage: manage, password_reset: !!hash },
      undefined,
      tx,
    );
    return (await accountRows(tx, userId))[0]!;
  });
  return result;
}
function legacyMatch(password: string) {
  const expected = config.adminPassword;
  const a = createHmac("sha256", "admin-password").update(password).digest(),
    b = createHmac("sha256", "admin-password")
      .update(expected ?? "")
      .digest();
  return !!expected && expected.length >= 12 && timingSafeEqual(a, b);
}
type PasswordRow = {
  user_id: number;
  login_name: string;
  password_hash: string;
  credential_revision: number;
  one_use: boolean;
  temporary_expires_at: Date | null;
  temporary_used_at: Date | null;
};
export async function namedPasswordLogin(loginName: string, password: string, returnTo: string, userAgent: string | undefined, source: string) {
  const submitted = AccountLoginName.safeParse(loginName);
  const name = submitted.success ? submitted.data : "invalid-login-name";
  await consumeAccountAttempt("login", name, source);
  const [stored] = await sql<
    PasswordRow[]
  >`SELECT user_id,login_name,password_hash,credential_revision,one_use,temporary_expires_at,temporary_used_at FROM identity.password_accounts WHERE login_name=${name}`;
  const verified = await verifyAccountPassword(password, stored?.password_hash ?? null);
  const legacy = !stored && name === "admin@local" && password.length <= 256 && legacyMatch(password);
  if (!submitted.success || (!verified && !legacy)) {
    await audit("anonymous", "auth.login.failed", null, null, null, { login_name: name });
    throw new LoginRejected(INVALID);
  }
  return sql.begin(async (tx) => {
    let userId = stored ? Number(stored.user_id) : null;
    if (userId === null) {
      const [user] =
        await tx`INSERT INTO admin_users(email,display_name) VALUES('admin@local','管理员') ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id`;
      userId = Number(user!.id);
    }
    await lockAccountAccess(tx, userId, true);
    const access = await readAccountAccess(userId, tx);
    if (access && !access.active) throw new LoginRejected(INVALID);
    const [current] = await tx<
      PasswordRow[]
    >`SELECT user_id,login_name,password_hash,credential_revision,one_use,temporary_expires_at,temporary_used_at FROM identity.password_accounts WHERE user_id=${userId} FOR UPDATE`;
    if (stored ? !current || current.credential_revision !== stored.credential_revision || current.password_hash !== stored.password_hash : !!current)
      throw new LoginRejected(INVALID);
    if (current?.one_use && (current.temporary_used_at || !current.temporary_expires_at || current.temporary_expires_at.getTime() <= Date.now()))
      throw new LoginRejected(INVALID);
    if (current?.one_use) await tx`UPDATE identity.password_accounts SET temporary_used_at=now() WHERE user_id=${userId}`;
    const token = await createAccountSession(userId, userAgent, tx);
    await audit(`admin:${userId}`, "auth.login", null, null, null, { method: stored ? "named_password" : "legacy_password" }, undefined, tx);
    return {
      token,
      userId,
      returnTo: access?.must_change_password
        ? "/admin/account"
        : access?.role === "admin" && safeReturn(returnTo) === "/admin"
          ? "/admin/content"
          : safeReturn(returnTo),
    };
  });
}
export async function changeOwnPassword(principal: AdminPrincipal, input: unknown, source: string) {
  const id = idOf(principal),
    value = AccountPasswordChangeRequest.parse(input);
  await consumeAccountAttempt("password_change", String(id), source);
  const [credential] = await sql<
    PasswordRow[]
  >`SELECT user_id,login_name,password_hash,credential_revision,one_use,temporary_expires_at,temporary_used_at FROM identity.password_accounts WHERE user_id=${id}`;
  const [user] = await sql`SELECT email FROM admin_users WHERE id=${id}`;
  const valid = await verifyAccountPassword(value.current_password, credential?.password_hash ?? null);
  if (!valid && !(user?.email === "admin@local" && !credential && legacyMatch(value.current_password))) throw new AccountInputError("当前密码不正确。");
  const hash = await hashAccountPassword(value.new_password);
  await sql.begin(async (tx) => {
    await lockAccountAccess(tx, id, true);
    const access = await readAccountAccess(id, tx);
    if ((access?.revision ?? 0) !== value.expected_revision || (principal.accessRevision ?? 0) !== (access?.revision ?? 0) || access?.active === false)
      throw new AccountStateConflict();
    const [current] = await tx<PasswordRow[]>`SELECT * FROM identity.password_accounts WHERE user_id=${id} FOR UPDATE`;
    if ((credential?.credential_revision ?? 0) !== (current?.credential_revision ?? 0)) throw new AccountStateConflict();
    if (current)
      await tx`UPDATE identity.password_accounts SET password_hash=${hash},credential_revision=credential_revision+1,one_use=false,temporary_expires_at=NULL,temporary_used_at=NULL,changed_at=now() WHERE user_id=${id}`;
    else await tx`INSERT INTO identity.password_accounts(user_id,login_name,password_hash) VALUES(${id},'admin@local',${hash})`;
    await tx`INSERT INTO identity.account_access(user_id,role,must_change_password) VALUES(${id},'admin',false) ON CONFLICT(user_id) DO UPDATE SET must_change_password=false,revision=identity.account_access.revision+1`;
    await tx`DELETE FROM admin_sessions WHERE user_id=${id}`;
    await audit(`admin:${id}`, "auth.password.change", `account:${id}`, null, null, { password_changed: true }, undefined, tx);
  });
  return { changed: true as const, signed_out: true as const };
}
/** Protected server setup only. No HTTP route calls this and no current identity is implicitly promoted. */
export async function provisionFirstOwner(input: { loginName: string; displayName: string; existingUserId?: number; reason: string }) {
  const name = AccountLoginName.parse(input.loginName);
  if (!input.displayName.trim() || input.displayName.length > 120 || !input.reason.trim()) throw new AccountInputError("请明确负责人身份及开通依据。");
  const password = randomBytes(18).toString("base64url"),
    hash = await hashAccountPassword(password);
  const id = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('account-owner'))`;
    if ((await tx`SELECT user_id FROM identity.account_access WHERE role='owner'`).length) throw new AccountStateConflict();
    let id = input.existingUserId;
    if (id !== undefined) {
      const [u] = await tx`SELECT id FROM admin_users WHERE id=${id}`;
      if (!u) throw new AccountStateConflict();
      await lockAccountAccess(tx, id, true);
    } else {
      await checkCapacity(tx);
      const [u] = await tx`INSERT INTO admin_users(display_name) VALUES(${input.displayName}) RETURNING id`;
      id = Number(u!.id);
    }
    await freeLoginName(tx, name, id);
    await tx`INSERT INTO identity.password_accounts(user_id,login_name,password_hash,one_use,temporary_expires_at) VALUES(${id},${name},${hash},true,now()+interval '15 minutes')`;
    await tx`INSERT INTO identity.account_access(user_id,role,must_change_password) VALUES(${id},'owner',true) ON CONFLICT(user_id) DO UPDATE SET role='owner',active=true,must_change_password=true,revision=identity.account_access.revision+1`;
    await tx`UPDATE admin_users SET display_name=${input.displayName} WHERE id=${id}`;
    await tx`DELETE FROM admin_sessions WHERE user_id=${id}`;
    await audit("server-setup", "auth.owner.provision", `account:${id}`, input.reason, null, { initial_password: true }, undefined, tx);
    return id!;
  });
  return { userId: id, loginName: name, temporaryPassword: password, expiresInSeconds: 900 };
}
export async function recoverOwnerPassword(reason: string) {
  if (!reason.trim()) throw new AccountInputError("请填写恢复依据。");
  const password = randomBytes(18).toString("base64url"),
    hash = await hashAccountPassword(password);
  const result = await sql.begin(async (tx) => {
    const [owner] = await tx`SELECT user_id FROM identity.account_access WHERE role='owner'`;
    if (!owner) throw new AccountStateConflict();
    const id = Number(owner.user_id);
    await lockAccountAccess(tx, id, true);
    const [account] =
      await tx`UPDATE identity.password_accounts SET password_hash=${hash},credential_revision=credential_revision+1,one_use=true,temporary_expires_at=now()+interval '15 minutes',temporary_used_at=NULL,changed_at=now() WHERE user_id=${id} RETURNING login_name`;
    if (!account) throw new AccountStateConflict();
    await tx`UPDATE identity.account_access SET must_change_password=true,revision=revision+1 WHERE user_id=${id}`;
    await tx`DELETE FROM admin_sessions WHERE user_id=${id}`;
    await clearAccountLoginAttempts(tx, account.login_name);
    await audit("server-recovery", "auth.owner.recover", `account:${id}`, reason, null, { temporary_password: true }, undefined, tx);
    return { userId: id, loginName: String(account.login_name), temporaryPassword: password, expiresInSeconds: 900 };
  });
  await accountNotice("owner_recovery", `account:${result.userId}`);
  return result;
}
export async function passwordLoginAvailable() {
  return !!config.adminPassword || (await sql`SELECT 1 FROM identity.password_accounts LIMIT 1`).length > 0;
}
