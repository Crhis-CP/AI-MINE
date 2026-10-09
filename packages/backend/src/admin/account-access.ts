import { dbOf, type Db } from "../db.ts";
import type { AdminPrincipal } from "./auth.ts";
const sql = dbOf("identity");
export class AccountPermissionDenied extends Error {
  readonly statusCode = 403;
  readonly code = "forbidden";
  constructor() {
    super("当前账号没有权限完成此操作。");
  }
}
export type AccountAccess = {
  user_id: number;
  role: "owner" | "admin";
  models_manage: boolean;
  active: boolean;
  revision: number;
  must_change_password: boolean;
};
/** All mutations and commit-time capability checks use this same user-specific fence. */
export async function lockAccountAccess(db: Db, userId: number, exclusive = false) {
  const [transaction] = await db`SHOW transaction_isolation`;
  if (transaction?.transaction_isolation !== "read committed") throw new Error("Account capability checks require read committed transactions");
  if (exclusive) await db`SELECT pg_advisory_xact_lock(hashtext(${`account-access:${userId}`}))`;
  else await db`SELECT pg_advisory_xact_lock_shared(hashtext(${`account-access:${userId}`}))`;
}
export async function readAccountAccess(userId: number, db: Db = sql): Promise<AccountAccess | null> {
  const [row] = await db<
    AccountAccess[]
  >`SELECT user_id,role,models_manage,active,revision,must_change_password FROM identity.account_access WHERE user_id=${userId}`;
  return row ?? null;
}
async function allowed(principal: AdminPrincipal, capability: string, db: Db) {
  if (principal.dev || !Number.isSafeInteger(principal.userId) || !principal.userId || !Number.isSafeInteger(principal.accessRevision)) return false;
  await lockAccountAccess(db, principal.userId);
  const current = await readAccountAccess(principal.userId, db);
  if (!current?.active || current.must_change_password || current.revision !== principal.accessRevision) return false;
  return capability === "owner" ? current.role === "owner" : capability === "models.manage" && (current.role === "owner" || current.models_manage);
}
export async function currentCapability(principal: AdminPrincipal, capability: string, db?: Db) {
  return db ? allowed(principal, capability, db) : sql.begin((tx) => allowed(principal, capability, tx));
}
export async function requireCapability(principal: AdminPrincipal, capability: string, db?: Db) {
  if (!(await currentCapability(principal, capability, db))) throw new AccountPermissionDenied();
}
export async function requireOwner(principal: AdminPrincipal, db?: Db) {
  await requireCapability(principal, "owner", db);
}
