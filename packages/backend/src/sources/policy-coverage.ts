import { POLICY_SOURCES } from "@amp/industry/policy-sources";
import { POLICY_JURISDICTIONS } from "@amp/industry/jurisdictions";
import { PolicyJurisdiction } from "@amp/contracts/http/public";
import { dbOf } from "../db.ts";

const sql = dbOf("sources");
const directory = new Map(POLICY_SOURCES.map((source) => [`policy-${source.id.toLowerCase()}`, source]));

/** Fetch success does not certify a complete catalogue. Until that producer exists, its receipt counts stay explicitly missing. */
export async function policySourceCoverage(start: string, end: string) {
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) >= Date.parse(end))
    throw new Error("Invalid coverage period");
  const sources = await sql<{ id: string; name: string }[]>`SELECT id,name FROM sources WHERE lane='policy' AND created_at<${end}`;
  const failures = await sql<{ source_id: string; started_at: Date; finished_at: Date | null; category: string }[]>`
    SELECT f.source_id,f.started_at,f.finished_at,
      CASE WHEN f.error ~* 'timeout|timed out|超时' THEN '请求超时'
        WHEN f.error ~* 'HTTP [45][0-9][0-9]' THEN '来源返回错误'
        WHEN f.error ~* 'ECONN|EPIPE|SOCKET|fetch failed' THEN '网络请求失败'
        ELSE '来源检查失败' END AS category
    FROM fetch_runs f JOIN sources s ON s.id=f.source_id
    WHERE s.lane='policy' AND f.status='failed' AND f.started_at>=${start} AND f.started_at<${end}
    ORDER BY f.started_at,f.id`;
  const rows = POLICY_JURISDICTIONS.map((jurisdiction) => {
    const registered = sources.filter((source) => directory.get(source.id)?.jurisdiction === jurisdiction.id);
    const names = new Map(registered.map((source) => [source.id, source.name]));
    return {
      jurisdiction: PolicyJurisdiction.parse({
        code: jurisdiction.id,
        label: jurisdiction.name_zh,
        kind: jurisdiction.kind,
        ...(jurisdiction.parent ? { parent: jurisdiction.parent } : {}),
      }),
      registered_source_count: registered.length,
      complete_receipt_count: 0,
      incomplete_receipt_count: 0,
      missing_receipt_count: registered.length,
      available_count: 0,
      failures: failures
        .filter((failure) => names.has(failure.source_id))
        .map((failure) => ({
          category: `${names.get(failure.source_id)}：${failure.category}`,
          start: failure.started_at.toISOString(),
          end: failure.finished_at?.toISOString() ?? null,
        })),
    };
  });
  const known = new Set(POLICY_JURISDICTIONS.map((j) => j.id));
  return { rows, unassignedSourceCount: sources.filter((s) => !known.has(directory.get(s.id)?.jurisdiction ?? "")).length };
}
