import { policySourceCoverage } from "@amp/backend/admin/sources";
import { config } from "../config.ts";
import { SITE } from "@amp/industry/site";
import {
  latestClosedPolicyPeriods,
  policyReportPeriod,
  planPolicyReport,
  type PublicPolicyReportVersion,
  type PolicyReportKind,
} from "./policy-report-plan.ts";
import { policyReportsToRecheck, savePolicyReport } from "./policy-report-store.ts";
import { sha256, stableJson } from "../lib/ids.ts";

/** Hourly worker reconciliation only: no reader-triggered writes and no model invocation. */
export async function reconcilePolicyReportPeriods(readVersions: () => Promise<PublicPolicyReportVersion[]>, now = new Date()) {
  const periods = await policyReportsToRecheck(),
    latest = latestClosedPolicyPeriods(now);
  for (const kind of ["weekly", "monthly"] as const)
    if (!periods.some((p) => p.kind === kind && p.period_key === latest[kind])) periods.unshift({ kind, period_key: latest[kind] });
  const ready = periods.filter((p) => Date.parse(policyReportPeriod(p.kind, p.period_key).end) + 8 * 3600_000 <= now.getTime());
  if (!ready.length) return [];
  const editions = await readVersions(),
    results: { kind: PolicyReportKind; periodKey: string; id: string; revision: number; created: boolean }[] = [];
  for (const { kind, period_key } of ready) {
    const period = policyReportPeriod(kind, period_key),
      coverage = await policySourceCoverage(period.start, period.end);
    const draft = planPolicyReport(kind, period_key, editions, coverage.rows, { name: SITE.name, url: config.siteUrl }, now);
    const selected = new Set(draft.members.map((member) => member.editionId));
    for (const row of draft.coverage)
      row.available_count = new Set(
        editions
          .filter(
            (edition) =>
              selected.has(edition.editionId) &&
              edition.policy.jurisdictions.some((j) => j.code === row.jurisdiction.code || j.parent === row.jurisdiction.code),
          )
          .map((edition) => edition.policy.id),
      ).size;
    if (coverage.unassignedSourceCount) draft.card.coverage_note += `另有${coverage.unassignedSourceCount}个已登记来源尚未归入既定法域，未猜测归属。`;
    draft.contentHash = sha256(stableJson([draft.contentHash, draft.coverage, coverage.unassignedSourceCount]));
    results.push({ kind, periodKey: period_key, ...(await savePolicyReport(draft)) });
  }
  return results;
}
