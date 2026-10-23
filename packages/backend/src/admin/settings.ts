// Operator settings: notification targets (switching a group on records enabled_at so older content is
// never back-filled) and per-service request budgets (the circuit breaker paid calls check before sending).
import { sql } from "../db.ts";
import { audit, requireOwner, type AdminPrincipal } from "./auth.ts";
export { monthlyUsageReports } from "../operations/usage-monthly.ts";

export { listTargets, setTargetEnabled } from "@amp/backend/notify/deliver";
export { listTargetScopes, setTargetScope } from "../notify/scopes.ts";

export async function listBudgets() {
  return sql`
    SELECT b.service, b.per_minute, b.per_hour, b.per_day, b.note, b.updated_at,
           (SELECT count(*)::int FROM receipt_attempts a WHERE coalesce(a.quota_service,a.service) = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 day') AS used_day,
           (SELECT count(*)::int FROM receipt_attempts a WHERE coalesce(a.quota_service,a.service) = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 hour') AS used_hour
    FROM budgets b WHERE b.service NOT LIKE 'registered:%' OR b.per_minute=0 OR b.per_hour=0 OR b.per_day=0 ORDER BY b.service`;
}

export async function updateBudget(
  service: string,
  input: { perMinute: number; perHour: number; perDay: number; reason: string },
  actor: string,
  principal?: AdminPrincipal,
) {
  return sql.begin(async (tx) => {
    if (principal) await requireOwner(principal, tx);
    if (!input.reason?.trim()) throw new Error("reason is required");
    for (const v of [input.perMinute, input.perHour, input.perDay])
      if (!Number.isInteger(v) || v < 0) throw new Error("budgets are non-negative integers (0 stops the service)");
    const [before] = await tx`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = ${service}`;
    const [after] = await tx`
    INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES (${service}, ${input.perMinute}, ${input.perHour}, ${input.perDay}, ${input.reason})
    ON CONFLICT (service) DO UPDATE SET per_minute = EXCLUDED.per_minute, per_hour = EXCLUDED.per_hour, per_day = EXCLUDED.per_day, note = EXCLUDED.note, updated_at = now()
    RETURNING service, per_minute, per_hour, per_day`;
    await audit(actor, "budget.update", `budget:${service}`, input.reason, before ?? null, after, undefined, tx);
    return after;
  });
}

export { listLaneControls, changeOwnerLaneControls, LaneControlConflict } from "../operations/lane-controls.ts";

export { usageProtectionOverview, changeUsageProtection, changeUsagePrice, recoverUsageBreaker, type UsageOwnerGuard } from "./usage-protection.ts";
export { readManagedSiteInformation, saveSiteInformation } from "../publication/site-information.ts";
export { protectedSiteInformation } from "../site/protected-information.ts";
