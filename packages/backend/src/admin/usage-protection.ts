import { pricingModelChoices } from "./models.ts";
import { registeredModelId, connectionRow, modelConfigurationHash, modelRegistryLock } from "../providers/model-registry.ts";
import { rateMicros, unitRate } from "../providers/usage-pricing.ts";
import { UsageConfigChange, UsagePriceChange, UsagePriceRecord, UsageBreakerRecovery } from "@amp/contracts/http/private";
import { dbOf, type Db } from "../db.ts";
import { audit, actorOf, requireOwner, currentCapability, type AdminPrincipal } from "./auth.ts";
import { usageLock, usageConfiguration, usageEvent, usageBreakerRecord, readUsageProtection } from "../providers/usage-protection.ts";
import { usagePriceId } from "../providers/usage-pricing.ts";
const sql = dbOf("ai-gateway");
export type UsageOwnerGuard = (principal: AdminPrincipal, db: Db) => Promise<void>;
const deny: UsageOwnerGuard = requireOwner;
const conflict = () => {
  throw Object.assign(new Error("用量配置或熔断状态已变化，请刷新后操作"), { code: "conflict" });
};
/** HTTP composition root still requires the existing authenticated administrator session for reading. */
export async function usageProtectionOverview(principal: AdminPrincipal) {
  const can_manage = await currentCapability(principal, "owner");
  return { ...(await readUsageProtection()), can_manage, pricing_models: can_manage ? await pricingModelChoices() : [] };
}
export async function changeUsageProtection(input: unknown, principal: AdminPrincipal, guard = deny) {
  const v = UsageConfigChange.parse(input);
  return sql.begin(async (db) => {
    await guard(principal, db);
    await usageLock(db);
    const before = await usageConfiguration(db);
    if ((before?.version ?? 0) !== v.expected_version) conflict();
    const version = v.expected_version + 1;
    await db`INSERT INTO ai.usage_control_versions(version,config,actor,reason) VALUES(${version},${db.json(v.config)},${actorOf(principal)},${v.reason})`;
    const after = (await usageConfiguration(db))!;
    await audit(actorOf(principal), "usage.config.change", String(version), v.reason, before, after, undefined, db);
    await usageEvent(db, `usage-config:${version}`, "configuration_changed", { before, after });
    return after;
  });
}
export async function changeUsagePrice(input: unknown, principal: AdminPrincipal, guard = deny) {
  const v = UsagePriceChange.parse(input),
    id = usagePriceId(v.price.service, v.price.model, v.price.configuration_hash);
  return sql.begin(async (db) => {
    await guard(principal, db);
    await usageLock(db);
    const connectionId = registeredModelId(v.price.service);
    if (connectionId) {
      await modelRegistryLock(db);
      const row = await connectionRow(connectionId, db);
      if (
        v.price.model !== row.config.model ||
        v.price.configuration_hash !== modelConfigurationHash(row.config) ||
        v.price.input_per_million_micros === null ||
        unitRate(v.price.input_per_million_micros) !== unitRate(rateMicros(row.config.input_cny_per_million)!) ||
        v.price.output_per_million_micros === null ||
        unitRate(v.price.output_per_million_micros) !== unitRate(rateMicros(row.config.output_cny_per_million)!) ||
        v.price.basis_url !== row.config.billing_basis
      )
        throw Object.assign(new Error("登记模型的金额、依据或配置已变化，请刷新后确认当前版本。"), { code: "conflict" });
    }
    const [before] = await db<{ version: number; price: unknown }[]>`SELECT version,price FROM ai.usage_prices WHERE id=${id}`;
    if ((before?.version ?? 0) !== v.expected_version) conflict();
    const [after] = await db<
      { id: string; version: number; price: unknown; updated_at: Date }[]
    >`INSERT INTO ai.usage_prices(id,version,price) VALUES(${id},${v.expected_version + 1},${db.json(v.price)}) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,price=EXCLUDED.price,updated_at=now() RETURNING id,version,price,updated_at`;
    const record = UsagePriceRecord.parse({ ...after!, updated_at: after!.updated_at.toISOString() });
    await audit(actorOf(principal), "usage.price.change", id, v.reason, before ?? null, record, undefined, db);
    await usageEvent(db, `usage-price:${id}:${record.version}`, "configuration_changed", { price: record, reason: v.reason });
    return record;
  });
}
export async function recoverUsageBreaker(id: string, input: unknown, principal: AdminPrincipal, guard = deny) {
  const v = UsageBreakerRecovery.parse(input);
  return sql.begin(async (db) => {
    await guard(principal, db);
    await usageLock(db);
    const before = await usageBreakerRecord(db, id);
    if (before.revision !== v.expected_revision || before.state !== "open") conflict();
    await db`UPDATE ai.usage_breakers SET state='recovered',revision=revision+1,recovered_at=now(),recovered_by=${actorOf(principal)},recovery_reason=${v.reason} WHERE id=${id} AND revision=${v.expected_revision}`;
    const after = await usageBreakerRecord(db, id);
    await audit(actorOf(principal), "usage.breaker.recover", id, v.reason, before, after, undefined, db);
    await usageEvent(db, `${id}:recovered`, "recovered", after, after.scope.lane, after.scope.capability);
    return after;
  });
}
