// Admin identity: the admin password (ADMIN_PASSWORD), or optionally Feishu OAuth with an allowlist of
// union_ids / emails; opaque sessions stored hashed, and an audit trail for every manual change.
// Development may impersonate an admin with DEV_AUTH_ROLE=admin; production refuses to start with it.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config, credential, isProduction } from "../config.ts";
import { dbOf, type Db } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { lockAccountAccess, readAccountAccess } from "./account-access.ts";

const sql = dbOf("identity");

export const SESSION_COOKIE = isProduction ? "__Host-amp_admin" : "amp_admin";
export const LOGIN_NONCE_COOKIE = isProduction ? "__Host-amp_login_nonce" : "amp_login_nonce";
export const STATE_COOKIE = "amp_oauth_state";
export const SESSION_DAYS = 0.5;
/** Register this callback in the Feishu open platform when Feishu sign-in is used. */
export const CALLBACK_URL = `${config.siteUrl}/api/auth/callback`;

/** Feishu sign-in is offered only when its app is configured. */
export function feishuLoginConfigured(): boolean {
  return !!credential("integrations", "FEISHU_LOGIN_APP_ID") && !!credential("integrations", "FEISHU_LOGIN_APP_SECRET");
}

export interface AdminPrincipal {
  userId: number | null;
  name: string;
  csrf: string;
  dev: boolean;
  accessRevision?: number | null;
  mustChangePassword?: boolean;
}

function secret(): string {
  const s = credential("auth", "SESSION_SECRET");
  if (!s) throw new Error("SESSION_SECRET is not configured");
  return s;
}

function sign(value: string): string {
  return `${value}.${createHmac("sha256", secret()).update(value).digest("base64url")}`;
}

function unsign(signed: string | undefined): string | null {
  if (!signed) return null;
  const i = signed.lastIndexOf(".");
  if (i <= 0) return null;
  const value = signed.slice(0, i);
  const expected = Buffer.from(sign(value).slice(i + 1));
  const given = Buffer.from(signed.slice(i + 1));
  return expected.length === given.length && timingSafeEqual(expected, given) ? value : null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        /* Malformed cookies do not invalidate other cookies. */
      }
    }
  }
  return out;
}

export function cookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${name === STATE_COOKIE ? "Lax" : "Strict"}; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

/** Where to send the browser to sign in; the signed state also carries where to return. */
export function loginRedirect(returnTo: string): { url: string; stateCookie: string } {
  const appId = credential("integrations", "FEISHU_LOGIN_APP_ID");
  if (!appId) throw new Error("FEISHU_LOGIN_APP_ID is not configured");
  const state = `${randomBytes(16).toString("base64url")}|${safeReturn(returnTo)}`;
  const url = `https://passport.feishu.cn/suite/passport/oauth/authorize?${new URLSearchParams({ client_id: appId, redirect_uri: CALLBACK_URL, response_type: "code", state: sign(state) })}`;
  return { url, stateCookie: sign(state) };
}

/** Only admin paths on this site; anything else (other hosts, protocol-relative) falls back to /admin. */
export function safeReturn(target: string): string {
  let path = target;
  // A proxy's login redirect may pass the whole original URL; keep only its path and query.
  if (/^https?:\/\//i.test(path)) {
    try {
      const u = new URL(path);
      path = `${u.pathname}${u.search}`;
    } catch {
      return "/admin";
    }
  }
  return /^\/admin(\/|\?|$)/.test(path) && !path.startsWith("//") ? path : "/admin";
}

interface FeishuUser {
  union_id?: string;
  email?: string;
  enterprise_email?: string;
  name?: string;
}

async function feishuUser(code: string): Promise<FeishuUser> {
  const appId = credential("integrations", "FEISHU_LOGIN_APP_ID");
  const appSecret = credential("integrations", "FEISHU_LOGIN_APP_SECRET");
  if (!appId || !appSecret) throw new Error("Feishu login app is not configured");
  const tokenRes = await fetch("https://passport.feishu.cn/suite/passport/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: appId, client_secret: appSecret, code, redirect_uri: CALLBACK_URL }),
    signal: AbortSignal.timeout(15_000),
  });
  const token = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!token.access_token) throw new Error(`Feishu token exchange failed: ${token.error ?? tokenRes.status}`);
  const userRes = await fetch("https://passport.feishu.cn/suite/passport/oauth/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(15_000),
  });
  return (await userRes.json()) as FeishuUser;
}

export class LoginRejected extends Error {}

export async function createAccountSession(userId: number, userAgent: string | undefined, db?: Db): Promise<string> {
  const create = async (tx: Db) => {
    await lockAccountAccess(tx, userId);
    const access = await readAccountAccess(userId, tx);
    if (access?.active === false) throw new LoginRejected("账号或密码不正确，请检查后重试。");
    const token = randomBytes(32).toString("base64url");
    await tx`INSERT INTO admin_sessions(id_hash,user_id,csrf_token,expires_at,user_agent,last_seen_at) VALUES(${sha256(token)},${userId},${randomBytes(18).toString("base64url")},now()+interval '12 hours',${userAgent?.slice(0, 300) ?? null},now())`;
    await tx`UPDATE admin_users SET last_login_at=now() WHERE id=${userId}`;
    return token;
  };
  return db ? create(db) : sql.begin(create);
}

/** OAuth callback: verify state, identify the Feishu user, admit only allowlisted admins. */
export async function completeLogin(code: string, state: string, stateCookie: string | undefined, userAgent: string | undefined) {
  const expected = unsign(stateCookie);
  const given = unsign(state);
  if (!expected || !given || expected !== given) throw new LoginRejected("登录状态已失效，请重新登录");
  const returnTo = given.split("|")[1] ?? "/admin";
  const u = await feishuUser(code);
  const email = (u.enterprise_email ?? u.email ?? "").toLowerCase() || null;
  const allowed = (u.union_id && config.adminUnionIds.includes(u.union_id)) || (email && config.adminEmails.includes(email));
  if (!allowed) throw new LoginRejected("这个飞书账号没有后台权限");
  const [existing] = await sql<{ id: number }[]>`
    SELECT u.id FROM admin_users u WHERE (${u.union_id ?? null}::text IS NOT NULL AND u.feishu_union_id = ${u.union_id ?? null}) OR
      (${email}::text IS NOT NULL AND u.email = ${email} AND u.email<>'admin@local' AND u.feishu_union_id IS NULL
       AND NOT EXISTS(SELECT 1 FROM identity.password_accounts p WHERE p.user_id=u.id)
       AND NOT EXISTS(SELECT 1 FROM identity.account_access a WHERE a.user_id=u.id AND a.role='owner'))
      ORDER BY (u.feishu_union_id=${u.union_id ?? null}) DESC NULLS LAST LIMIT 1`;
  const [user] = existing
    ? await sql<{ id: number }[]>`UPDATE admin_users SET feishu_union_id = coalesce(feishu_union_id, ${u.union_id ?? null}), email = coalesce(email, ${email}),
        display_name = coalesce(${u.name ?? null}, display_name) WHERE id = ${existing.id} RETURNING id`
    : await sql<
        { id: number }[]
      >`INSERT INTO admin_users (feishu_union_id, email, display_name) VALUES (${u.union_id ?? null}, ${email}, ${u.name ?? null}) RETURNING id`;
  const token = await createAccountSession(user!.id, userAgent);
  await audit(`admin:${user!.id}`, "auth.login", null, null, null, { union_id: u.union_id ?? null });
  return { token, returnTo, userId: user!.id };
}

/** Legacy callers retain the reserved login name; explicit accounts never fall back to its environment password. */
export async function passwordLogin(password: string, returnTo: string, userAgent: string | undefined, loginName = "admin@local", source = "internal") {
  const { namedPasswordLogin } = await import("./accounts.ts");
  return namedPasswordLogin(loginName, password, returnTo, userAgent, source);
}

export async function sessionPrincipal(cookieHeader: string | undefined): Promise<AdminPrincipal | null> {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (token) {
    const [row] = await sql<
      { user_id: number; csrf_token: string; name: string | null; email: string | null; access_revision: number | null; must_change_password: boolean | null }[]
    >`
      WITH live AS (
       UPDATE admin_sessions s SET last_seen_at=now()
       WHERE s.id_hash=${sha256(token)} AND s.expires_at>now() AND s.created_at>now()-interval '12 hours'
        AND coalesce(s.last_seen_at,s.created_at)>now()-interval '30 minutes'
        AND NOT EXISTS(SELECT 1 FROM identity.account_access a WHERE a.user_id=s.user_id AND NOT a.active)
       RETURNING s.user_id,s.csrf_token
      ) SELECT s.user_id, s.csrf_token, u.display_name AS name, u.email,access.revision AS access_revision,access.must_change_password FROM live s JOIN admin_users u ON u.id = s.user_id
      LEFT JOIN identity.account_access access ON access.user_id=u.id
      WHERE (access.user_id IS NULL OR access.active)`;
    if (row)
      return {
        userId: row.user_id,
        name: row.name ?? row.email ?? `admin:${row.user_id}`,
        csrf: row.csrf_token,
        dev: false,
        accessRevision: row.access_revision,
        mustChangePassword: row.must_change_password ?? false,
      };
  }
  if (config.devAdmin && !isProduction) return { userId: null, name: config.devAdmin.displayName, csrf: "dev", dev: true };
  return null;
}

export async function endSession(cookieHeader: string | undefined) {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (token) await sql`DELETE FROM admin_sessions WHERE id_hash = ${sha256(token)}`;
}

/** Every manual change: who, when, what, why. */
export async function audit(
  actor: string,
  action: string,
  subject: string | null,
  reason: string | null,
  before: unknown,
  after: unknown,
  requestId?: string,
  db: Db = sql,
) {
  await db`INSERT INTO audit_log (actor, action, subject, reason, before, after, request_id)
            VALUES (${actor}, ${action}, ${subject}, ${reason}, ${before === null || before === undefined ? null : db.json(before as never)},
                    ${after === null || after === undefined ? null : db.json(after as never)}, ${requestId ?? null})`;
}

export function actorOf(p: AdminPrincipal): string {
  return p.dev ? `dev:${p.name}` : `admin:${p.userId}`;
}

export { currentCapability, requireCapability, requireOwner, AccountPermissionDenied } from "./account-access.ts";

export { listAccounts, currentAccount, createAdministrator, changeAdministrator, changeOwnPassword, passwordLoginAvailable } from "./accounts.ts";
export { issueLoginNonce, consumeLoginNonce, AccountRateLimited, AccountLoginVerification } from "./account-login.ts";
