import { requireOwner, audit, actorOf, type AdminPrincipal } from "./auth.ts";
import { dbOf } from "../db.ts";
const sql = dbOf("identity");
export const accountsOperationalSnapshot = () =>
  sql.begin(async (db) => {
    await db`SET LOCAL statement_timeout='2s'`;
    return db`SELECT role,active,models_manage,must_change_password,count(*)::int AS count FROM identity.account_access GROUP BY role,active,models_manage,must_change_password ORDER BY role,active,models_manage,must_change_password`;
  });
export const auditOperationalSnapshot = () =>
  sql.begin(async (db) => {
    await db`SET LOCAL statement_timeout='2s'`;
    const rows = await db<
      { id: string; action: string; at: Date }[]
    >`SELECT id::text,action,created_at AS at FROM audit_log ORDER BY created_at DESC,id DESC LIMIT 101`;
    return rows.map((row) => ({ ...row, action: /^[a-z_]+(?:\.[a-z_]+)*$/.test(row.action) && row.action.length <= 120 ? row.action : "other" }));
  });

/** Owner capability fence and read audit share the auth transaction; caller supplies only the fixed observer read. */
export async function withOwnerOperationalRead<T extends { items: readonly unknown[]; state: string }>(
  principal: AdminPrincipal,
  request: { dataset: string; offset: number },
  read: () => Promise<T>,
) {
  return sql.begin(async (auth) => {
    await requireOwner(principal, auth);
    const result = await read();
    await audit(
      actorOf(principal),
      "ops_mcp.read",
      request.dataset,
      null,
      null,
      { dataset: request.dataset, offset: request.offset, rows: result.items.length, state: result.state },
      undefined,
      auth,
    );
    return result;
  });
}
