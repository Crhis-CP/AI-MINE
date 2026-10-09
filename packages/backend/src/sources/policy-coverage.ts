import { POLICY_SOURCES } from "@amp/industry/policy-sources";
import { POLICY_JURISDICTIONS } from "@amp/industry/jurisdictions";
import { PolicyJurisdiction } from "@amp/contracts/http/public";
import { directoryCoverageEvidence } from "@amp/backend/sources/collect";
import { dbOf } from "../db.ts";

const sql = dbOf("sources");
const directory = new Map(POLICY_SOURCES.map((source) => [`policy-${source.id.toLowerCase()}`, source]));

/** Coverage comes from structural rounds, never a successful HTTP response alone. */
export async function policySourceCoverage(start: string, end: string) {
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) >= Date.parse(end))
    throw new Error("Invalid coverage period");
  const sources = await sql<{ id: string; name: string }[]>`SELECT id,name FROM sources WHERE lane='policy' AND created_at<${end}`;
  const { receipts, failures } = await directoryCoverageEvidence(
    sources.map((s) => s.id),
    start,
    end,
  );
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
      complete_receipt_count: receipts.filter((r) => names.has(r.source_id) && r.outcome === "complete").reduce((n, r) => n + r.count, 0),
      incomplete_receipt_count: receipts.filter((r) => names.has(r.source_id) && r.outcome === "incomplete").reduce((n, r) => n + r.count, 0),
      missing_receipt_count: registered.filter((s) => !receipts.some((r) => r.source_id === s.id)).length,
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
