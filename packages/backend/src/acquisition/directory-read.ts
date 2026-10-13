import { dbOf } from "../db.ts";
import { directoryContract } from "../sources/directory-profile.ts";
import type { SourceRow } from "../sources/types.ts";
const sql = dbOf("acquisition");
/** Current acquisition membership, not legal validity or public withdrawal. */
export async function directoryMaterialState(source: Pick<SourceRow, "id" | "kind" | "config">, materialId: string) {
  const [head] = await sql<
    { scan_id: string; contract_hash: string }[]
  >`SELECT h.scan_id,s.contract_hash FROM acquisition.directory_heads h JOIN acquisition.directory_scans s ON s.id=h.scan_id WHERE h.source_id=${source.id}`;
  const managed = source.config.directoryProfile !== undefined || !!head;
  if (!managed) return { managed: false, current: true, pending: false, hash: null };
  const contract = directoryContract(source);
  const [active] = await sql`SELECT id FROM acquisition.directory_scans WHERE source_id=${source.id} AND state='running' LIMIT 1`;
  const [record] = head
    ? await sql<
        { metadata_hash: string }[]
      >`SELECT b.wake_hash AS metadata_hash FROM acquisition.directory_records r JOIN acquisition.directory_bindings b ON b.scan_id=r.scan_id AND b.record_id=r.record_id WHERE r.scan_id=${head.scan_id} AND r.role='current' AND b.material_id=${materialId} LIMIT 1`
    : [];
  return {
    managed: true,
    current: !!record,
    pending: !!active || !head || !contract || head.contract_hash !== contract.hash,
    hash: record?.metadata_hash ?? null,
  };
}
/** As-of evidence: an unfinished round never borrows its eventual completion into an earlier report. */
export async function directoryCoverageEvidence(sourceIds: string[], start: string, end: string) {
  const receipts = await sql<{ source_id: string; outcome: "complete" | "incomplete"; count: number }[]>`
    SELECT source_id,outcome,count(*)::int AS count FROM acquisition.directory_receipts WHERE source_id=ANY(${sourceIds}::text[]) AND recorded_at>=${start} AND recorded_at<${end} GROUP BY source_id,outcome`;
  const unfinished = await sql<{ source_id: string; count: number }[]>`
    SELECT source_id,count(*)::int AS count FROM acquisition.directory_scans WHERE source_id=ANY(${sourceIds}::text[])
      AND started_at<${end} AND (finished_at IS NULL OR finished_at>=${end}) GROUP BY source_id`;
  const failures = await sql<{ source_id: string; started_at: Date; finished_at: Date | null; category: string }[]>`
    SELECT source_id,started_at,finished_at,
      CASE WHEN error ~* 'timeout|timed out|超时' THEN '请求超时'
        WHEN error ~* 'HTTP [45][0-9][0-9]' THEN '来源返回错误'
        WHEN error ~* 'ECONN|EPIPE|SOCKET|fetch failed' THEN '网络请求失败'
        ELSE '来源检查失败' END AS category FROM fetch_runs
    WHERE source_id=ANY(${sourceIds}::text[]) AND status='failed' AND started_at>=${start} AND started_at<${end} ORDER BY started_at,id`;
  return { receipts: [...receipts, ...unfinished.map((row) => ({ ...row, outcome: "incomplete" as const }))], failures };
}
