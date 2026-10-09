import { dbOf, type Db } from "../db.ts";
import { requireOwner, audit, type AdminPrincipal } from "./auth.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { SelectionToolRequest, SelectionToolState } from "@amp/contracts/http/private";
const sql = dbOf("ai-gateway");
export class SelectionConflict extends Error {
  readonly code = "conflict";
}
export class SelectionUnavailable extends Error {
  readonly statusCode = 503;
}
export async function toolState(db: Db = sql, lock = false) {
  if (lock) await db`SELECT pg_advisory_xact_lock_shared(hashtext('selection-tool'))`;
  const [row] = await db<{ expires_at: Date | null; revision: number }[]>`SELECT expires_at,revision FROM ai.selection_tool_control WHERE id=true`;
  if (!row) throw new SelectionUnavailable("校准工具存储尚未准备好");
  return SelectionToolState.parse({
    enabled: !!row.expires_at && row.expires_at.getTime() > Date.now(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    revision: row.revision,
  });
}
export async function selectionTool(principal: AdminPrincipal) {
  return sql.begin(async (tx) => {
    await requireOwner(principal, tx);
    return toolState(tx);
  });
}
export async function requireSelectionTool(principal: AdminPrincipal, db?: Db): Promise<void> {
  if (!db) return sql.begin((tx) => requireSelectionTool(principal, tx));
  await requireOwner(principal, db);
  if (!(await toolState(db, true)).enabled) throw new SelectionConflict("建设期抽样工具未开启或已到期");
}
export async function selectionCommand<T>(
  principal: AdminPrincipal,
  operation: string,
  input: { requestId: string } & Record<string, unknown>,
  run: (db: Db) => Promise<T>,
  needsTool = true,
): Promise<T> {
  return (await sql.begin(async (tx) => {
    await requireOwner(principal, tx);
    if (needsTool) await requireSelectionTool(principal, tx);
    const actor = `account:${principal.userId}`,
      digest = sha256(stableJson([operation, input]));
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`selection-command:${actor}:${input.requestId}`}))`;
    const [prior] = await tx`SELECT request_hash,response FROM ai.selection_commands WHERE actor=${actor} AND request_id=${input.requestId}`;
    if (prior) {
      if (prior.request_hash !== digest) throw new SelectionConflict("操作编号已用于其他内容，请保留草稿并重新确认");
      return prior.response as T;
    }
    const result = await run(tx);
    await tx`INSERT INTO ai.selection_commands(actor,request_id,request_hash,response) VALUES(${actor},${input.requestId},${digest},${tx.json(result as never)})`;
    return result;
  })) as T;
}
export async function changeSelectionTool(value: unknown, principal: AdminPrincipal) {
  const input = SelectionToolRequest.parse(value);
  return selectionCommand(
    principal,
    "tool",
    input,
    async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('selection-tool'))`;
      const before = await toolState(tx);
      if (before.revision !== input.expectedRevision) throw new SelectionConflict("工具状态已变化，请刷新后重新确认");
      if (input.enabled && (!input.expiresAt || Date.parse(input.expiresAt) <= Date.now())) throw new SelectionConflict("开启时须填写未来的结束日期");
      await tx`UPDATE ai.selection_tool_control SET expires_at=${input.enabled ? input.expiresAt : null},revision=revision+1 WHERE id=true`;
      const after = await toolState(tx);
      await audit(`account:${principal.userId}`, "selection.tool", "selection", input.reason, before, after, undefined, tx);
      return after;
    },
    false,
  );
}

export async function withSelectionTool<T>(principal: AdminPrincipal, run: (db: Db) => Promise<T>) {
  return sql.begin(async (tx) => {
    await requireSelectionTool(principal, tx);
    return run(tx);
  }) as Promise<T>;
}
