import { addDays, beijingDate, isoWeekLabel } from "@amp/contracts/time";
import { latestClosedPolicyPeriods, policyReportPeriod, type PolicyReportKind, type PublicPolicyReportVersion } from "./policy-report-plan.ts";
type Period = { kind: PolicyReportKind; period_key: string };
/** A bounded batch of missing closed periods. The floor is this system's discovery/publication or prior report, never an old law's source date. */
export function missingPolicyReportPeriods(editions: readonly PublicPolicyReportVersion[], existing: readonly Period[], now: Date, limit = 24) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid policy catch-up batch");
  const dates = editions.flatMap((row) => {
    if (!row.versions.length || !Number.isFinite(Date.parse(row.releasedAt)) || Date.parse(row.releasedAt) > now.getTime()) return [];
    const at = row.discoveredAt ?? row.releasedAt;
    return Number.isFinite(Date.parse(at)) && Date.parse(at) <= now.getTime() ? [beijingDate(at)] : [];
  });
  const latest = latestClosedPolicyPeriods(now);
  const occupied = new Set(existing.map((row) => `${row.kind}:${row.period_key}`));
  const missing: Period[] = [];
  for (const kind of ["weekly", "monthly"] as const) {
    const starts = [...dates, ...existing.filter((p) => p.kind === kind).map((p) => policyReportPeriod(kind, p.period_key).startDay)];
    const first = starts.sort()[0];
    let key = first ? (kind === "weekly" ? isoWeekLabel(first) : first.slice(0, 7)) : latest[kind];
    while (key <= latest[kind]) {
      const period = policyReportPeriod(kind, key);
      if (Date.parse(period.end) + 8 * 3600_000 <= now.getTime() && !occupied.has(`${kind}:${key}`)) missing.push({ kind, period_key: key });
      key = kind === "weekly" ? isoWeekLabel(addDays(period.startDay, 7)) : period.endDay.slice(0, 7);
    }
  }
  return missing
    .sort((a, b) => policyReportPeriod(a.kind, a.period_key).end.localeCompare(policyReportPeriod(b.kind, b.period_key).end) || a.kind.localeCompare(b.kind))
    .slice(0, limit);
}
