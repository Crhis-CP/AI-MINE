import { NotifyTargetScope, NotifyTargetScopes, NotifyTargetScopeUpdate } from "@amp/contracts/http/private";
import { COUNTRIES } from "@amp/industry/jurisdictions";
import { sql } from "../db.ts";
import { actorOf, audit, previousAuditedCommand, requireOwner, type AdminPrincipal } from "../admin/auth.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { DeliveryConflict } from "./deliver.ts";

export async function listTargetScopes() {
  return NotifyTargetScopes.parse({
    items: await sql`
    SELECT key,jurisdiction,updated_at::text AS version,enabled,enabled_at AS "enabledAt"
    FROM notify_targets WHERE purpose IN ('content','country_content') ORDER BY key`.then((rows) =>
      rows.map((row) => ({ ...row, enabledAt: row.enabledAt?.toISOString() ?? null })),
    ),
  });
}

export async function setTargetScope(key: string, value: unknown, principal: AdminPrincipal, command: string) {
  const input = NotifyTargetScopeUpdate.parse(value);
  const actor = actorOf(principal),
    subject = `notify-target:${key}`,
    action = "notify.scope";
  if (!/^[\w-]{8,80}$/.test(command)) throw Object.assign(new Error("请求编号无效"), { statusCode: 400 });
  if (input.jurisdiction !== null && !COUNTRIES.some((country) => country.id === input.jurisdiction))
    throw Object.assign(new Error("不支持的国家"), { statusCode: 400 });
  if (key === "feishu-content-main" && input.jurisdiction !== null) throw new DeliveryConflict("内容主渠道保留全部国家，请使用单独的国别渠道");
  const requestHash = sha256(stableJson(input));
  return sql.begin(async (tx) => {
    await requireOwner(principal, tx);
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`${subject}:${actor}:${command}`}))`;
    const prior = await previousAuditedCommand(actor, action, subject, command, tx);
    if (prior) {
      const saved = prior.result as { requestHash?: string; result?: unknown };
      if (saved.requestHash !== requestHash) throw new DeliveryConflict("此请求编号已经用于其他修改");
      return NotifyTargetScope.parse(saved.result);
    }
    const [before] = await tx`SELECT key,jurisdiction,updated_at::text AS version,enabled,enabled_at AS "enabledAt"
      FROM notify_targets WHERE key=${key} AND purpose IN ('content','country_content') FOR UPDATE`;
    if (!before) return null;
    if (before.version !== input.version) throw new DeliveryConflict("通知目标已经变化，请刷新后重试");
    let after = before;
    if (before.jurisdiction !== input.jurisdiction) {
      const [updated] = await tx`
      UPDATE notify_targets SET jurisdiction=${input.jurisdiction},purpose=CASE WHEN ${input.jurisdiction}::text IS NULL THEN 'content' ELSE 'country_content' END,
      enabled_at=CASE WHEN enabled THEN pg_catalog.clock_timestamp() ELSE enabled_at END,updated_at=pg_catalog.clock_timestamp()
      WHERE key=${key} RETURNING key,jurisdiction,updated_at::text AS version,enabled,enabled_at AS "enabledAt"`;
      after = updated;
    }
    const result = NotifyTargetScope.parse({ ...after, enabledAt: after.enabledAt?.toISOString() ?? null });
    await audit(actor, action, subject, input.reason, before, { requestHash, result }, command, tx);
    return result;
  });
}
