import { z } from "zod";
import { PolicyCard, PolicyHistoryEntry, PolicyReport, PolicyReportCard } from "@amp/contracts/http/public";
import { addDays, beijingDate, beijingMidnight, isoWeekLabel, isoWeekRange, isValidDate } from "@amp/contracts/time";
import { sha256, stableJson } from "../lib/ids.ts";

export type PolicyReportKind = "weekly" | "monthly";
export type PolicyReportMemberLabel = "period_change" | "source_date_unknown" | "backfill" | "interpretation_update";
export interface PublicPolicyReportVersion {
  editionId: string;
  originalRevisionKey: string;
  policy: z.infer<typeof PolicyCard>;
  versions: z.infer<typeof PolicyHistoryEntry>[];
  releasedAt: string;
  discoveredAt: string | null;
  sourceLanguage: string;
  preferredSourceLanguage: string | null;
  attributions: z.infer<typeof PolicyReport>["attributions"];
}
export type PolicyReportCoverage = z.infer<typeof PolicyReport>["coverage"];
export type PolicyReportMember = { editionId: string; label: PolicyReportMemberLabel; availableByCutoff: boolean; position: number };
export interface PolicyReportDraft {
  kind: PolicyReportKind;
  periodKey: string;
  generatedAt: string;
  contentHash: string;
  card: Omit<z.infer<typeof PolicyReportCard>, "id" | "edition" | "correction_of">;
  coverage: PolicyReportCoverage;
  attributions: z.infer<typeof PolicyReport>["attributions"];
  members: PolicyReportMember[];
}

export function policyReportPeriod(kind: PolicyReportKind, key: string) {
  let start: string, end: string;
  if (kind === "weekly") {
    const range = isoWeekRange(key);
    if (!range) throw new Error("Invalid policy report week");
    start = range.start;
    end = addDays(range.end, 1);
  } else {
    if (!/^\d{4}-\d{2}$/.test(key) || !isValidDate(`${key}-01`)) throw new Error("Invalid policy report month");
    start = `${key}-01`;
    const next = new Date(`${start}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    end = next.toISOString().slice(0, 10);
  }
  return { startDay: start, endDay: end, start: beijingMidnight(start).toISOString(), end: beijingMidnight(end).toISOString() };
}
export function latestClosedPolicyPeriods(now: Date) {
  const today = beijingDate(now),
    dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const previousMonth = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  previousMonth.setUTCMonth(previousMonth.getUTCMonth() - 1);
  return { weekly: isoWeekLabel(addDays(today, -dow - 1)), monthly: previousMonth.toISOString().slice(0, 7) };
}
const epoch = (value: string | null) => (value === null || !Number.isFinite(Date.parse(value)) ? null : Date.parse(value));
const dayOf = (row: PublicPolicyReportVersion) => {
  const time = row.policy.sort_time ?? row.policy.published_time;
  if (time.condition_text || time.precision === "unknown" || !["published", "updated"].includes(time.meaning)) return null;
  return time.precision === "date" ? time.local_date : time.utc ? beijingDate(time.utc) : null;
};

/** Only current-eligible, immutable publication editions enter here; read-time eligibility must still be checked again. */
export function planPolicyReport(
  kind: PolicyReportKind,
  periodKey: string,
  editions: readonly PublicPolicyReportVersion[],
  coverage: PolicyReportCoverage,
  compiler: { name: string; url: string },
  now = new Date(),
): PolicyReportDraft {
  const period = policyReportPeriod(kind, periodKey),
    start = Date.parse(period.start),
    end = Date.parse(period.end);
  if (end > now.getTime()) throw new Error("Policy report period is still open");
  const byDocument = new Map<string, PublicPolicyReportVersion[]>();
  for (const row of editions) {
    const released = epoch(row.releasedAt);
    if (released === null || released > now.getTime() || !row.versions.length) continue;
    const group = byDocument.get(row.policy.id) ?? [];
    group.push(row);
    byDocument.set(row.policy.id, group);
  }
  const selected: { row: PublicPolicyReportVersion; label: PolicyReportMemberLabel }[] = [];
  let unclassified = 0;
  for (const rows of byDocument.values()) {
    rows.sort((a, b) => a.releasedAt.localeCompare(b.releasedAt) || a.editionId.localeCompare(b.editionId));
    const preferred = rows.find((r) => r.preferredSourceLanguage && rows.some((v) => v.sourceLanguage === r.preferredSourceLanguage))?.preferredSourceLanguage;
    const language = preferred ?? rows[0]!.sourceLanguage;
    const originals = new Map<string, PublicPolicyReportVersion>();
    for (const row of rows.filter((r) => r.sourceLanguage === language)) originals.set(row.originalRevisionKey, row);
    for (const row of originals.values()) {
      const discovered = epoch(row.discoveredAt),
        released = epoch(row.releasedAt)!,
        day = dayOf(row);
      let label: PolicyReportMemberLabel | null = null;
      if (discovered === null) {
        unclassified++;
        continue;
      }
      if (day !== null && day >= period.startDay && day < period.endDay && discovered < end) label = "period_change";
      else if (discovered >= start && discovered < end && day === null) label = "source_date_unknown";
      else if (discovered >= start && discovered < end && day !== null && day < period.startDay) label = "backfill";
      else if (discovered < start && released >= start && released < end && day !== null && day < period.startDay) label = "interpretation_update";
      if (label) selected.push({ row, label });
    }
  }
  selected.sort(
    (a, b) =>
      a.row.policy.id.localeCompare(b.row.policy.id) || a.row.releasedAt.localeCompare(b.row.releasedAt) || a.row.editionId.localeCompare(b.row.editionId),
  );
  const members = selected.map(({ row, label }, position) => ({
    editionId: row.editionId,
    label,
    availableByCutoff: Date.parse(row.releasedAt) < end,
    position,
  }));
  const attributions = [...new Map(selected.flatMap(({ row }) => row.attributions).map((a) => [stableJson(a), a])).values()];
  if (!attributions.length) attributions.push(compiler);
  const card = {
    type: `policy_${kind}` as "policy_weekly" | "policy_monthly",
    period_key: periodKey,
    title: `法规政策${kind === "weekly" ? "周" : "月"}报 · ${periodKey}`,
    summary: null,
    period_start: period.start,
    period_end: period.end,
    timezone: "Asia/Shanghai" as const,
    issued_at: now.toISOString(),
    item_count: new Set(selected.map(({ row }) => row.policy.id)).size,
    status: "compiled" as const,
    ai_label: "ai_generated" as const,
    coverage_note: `本报告引用当前仍可公开的固定文书版本；未取得完整检查回执不代表没有新法规。${unclassified ? `另有${unclassified}个版本缺少首次发现依据，未推测归期。` : ""}`,
  };
  const contentHash = sha256(
    stableJson({ kind, periodKey, members, coverage, attributions, unclassified, views: selected.map(({ row }) => [row.editionId, row.policy, row.versions]) }),
  );
  return { kind, periodKey, generatedAt: now.toISOString(), contentHash, card, coverage, attributions, members };
}
