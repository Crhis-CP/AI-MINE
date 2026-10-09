import { randomBytes, timingSafeEqual } from "node:crypto";
import { dbOf, type Db } from "../db.ts";
import { sha256, newShortId } from "../lib/ids.ts";
import { accountNotice } from "./account-notices.ts";
const sql = dbOf("identity");
export class AccountRateLimited extends Error {
  readonly statusCode = 429;
  readonly retryAfterSeconds = 900;
  constructor() {
    super("尝试次数过多，请15分钟后再试。");
  }
}
export class AccountLoginVerification extends Error {
  readonly statusCode = 400;
  constructor() {
    super("登录验证已失效，请刷新登录页后重试。");
  }
}
export const loginAccountHash = (name: string) => sha256(`login:${name.trim().toLowerCase()}`);
const sourceHash = (source: string) => sha256(`source:${source}`);
/** Counters are checked before expensive password derivation. Global traffic delays but never rejects all users. */
export async function consumeAccountAttempt(kind: "login" | "nonce" | "password_change", account: string, source: string) {
  const accountHash = loginAccountHash(account),
    originHash = sourceHash(source);
  const result = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('account-rate'))`;
    const seconds = kind === "nonce" ? 60 : 900;
    const [counts] = await tx<{ account: number; source: number; total: number }[]>`SELECT count(*) FILTER(WHERE account_hash=${accountHash})::int AS account,
   count(*) FILTER(WHERE source_hash=${originHash})::int AS source,count(*)::int AS total FROM identity.auth_attempts
   WHERE kind=${kind} AND at>now()-make_interval(secs=>${seconds})`;
    if ((kind !== "nonce" && counts!.account >= 5) || (kind !== "password_change" && counts!.source >= (kind === "nonce" ? 30 : 20))) return null;
    await tx`INSERT INTO identity.auth_attempts(id,kind,account_hash,source_hash) VALUES(${newShortId(16)},${kind},${accountHash},${originHash})`;
    await tx`DELETE FROM identity.auth_attempts WHERE at<now()-interval '1 day'`;
    return { notice: kind === "login" && counts!.total === 30, delay: kind === "login" ? Math.min(2500, Math.max(0, counts!.total - 29) * 50) : 0 };
  });
  if (!result) throw new AccountRateLimited();
  if (result.notice) await accountNotice("login_traffic", null);
  if (result.delay) await new Promise((resolve) => setTimeout(resolve, result.delay));
}
export async function issueLoginNonce(source: string) {
  await consumeAccountAttempt("nonce", "", source);
  const token = randomBytes(32).toString("base64url"),
    expires = new Date(Date.now() + 5 * 60_000);
  await sql`INSERT INTO identity.login_nonces(token_hash,source_hash,expires_at) VALUES(${sha256(token)},${sourceHash(source)},${expires})`;
  await sql`DELETE FROM identity.login_nonces WHERE expires_at<now()-interval '1 day'`;
  return { token, expires_at: expires.toISOString() };
}
export async function consumeLoginNonce(value: string, cookie: string | undefined, source: string) {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value) || !cookie || !timingSafeEqual(Buffer.from(sha256(value), "hex"), Buffer.from(sha256(cookie), "hex")))
    throw new AccountLoginVerification();
  const rows =
    await sql`UPDATE identity.login_nonces SET used_at=now() WHERE token_hash=${sha256(value)} AND source_hash=${sourceHash(source)} AND used_at IS NULL AND expires_at>now() RETURNING token_hash`;
  if (rows.length !== 1) throw new AccountLoginVerification();
}
export async function clearAccountLoginAttempts(db: Db, loginName: string) {
  await db`DELETE FROM identity.auth_attempts WHERE account_hash=${loginAccountHash(loginName)}`;
}
