import { dbOf, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { hashAccountPassword, verifyAccountPassword } from "./account-crypto.ts";
import { requireOwner } from "./account-access.ts";
import type { AdminPrincipal } from "./auth.ts";
const sql = dbOf("identity");
class AccountCommandConflict extends Error {
  readonly code = "conflict";
  constructor() {
    super("该操作编号已用于其他修改，请刷新账号状态后重新提交。");
  }
}
export async function accountCommand<T>(
  principal: AdminPrincipal,
  key: string | undefined,
  operation: string,
  input: unknown,
  run: (db: Db) => Promise<T>,
): Promise<T> {
  if (key !== undefined && !/^[A-Za-z0-9._:-]{8,200}$/u.test(key)) throw new AccountCommandConflict();
  const digest = sha256(stableJson([operation, input]));
  return (await sql.begin(async (tx) => {
    await requireOwner(principal, tx);
    if (!key) return run(tx);
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`account-command:${principal.userId}:${key}`}))`;
    const [existing] = await tx`SELECT request_hash,response FROM identity.account_commands WHERE user_id=${principal.userId} AND command_key=${key}`;
    if (existing) {
      if (!(await verifyAccountPassword(digest, existing.request_hash))) throw new AccountCommandConflict();
      return existing.response as T;
    }
    const response = await run(tx),
      hash = await hashAccountPassword(digest);
    await tx`INSERT INTO identity.account_commands(user_id,command_key,request_hash,response) VALUES(${principal.userId},${key},${hash},${tx.json(response as never)})`;
    return response;
  })) as T;
}
