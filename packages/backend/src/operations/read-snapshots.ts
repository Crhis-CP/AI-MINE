import type { z } from "zod";
import { type OpsDataset, OpsRows, OpsReadInput, OPS_COVERAGE, OPS_EXCLUSIONS } from "@amp/contracts/ops-mcp";
import { dbOf, operationsReadDatabase, type Db } from "../db.ts";
import type { AdminPrincipal } from "../admin/auth.ts";
import { withOwnerOperationalRead } from "../admin/operational-snapshot.ts";
const sql = dbOf("ops");
type Dataset = z.infer<typeof OpsDataset>;
export class OperationsReadUnavailable extends Error {
  readonly statusCode = 503;
  constructor() {
    super("只读运维数据暂不可用");
  }
}
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
/** Worker-only publication into a strictly typed, secret-free projection. */
export async function storeOperationalSnapshot(dataset: Dataset, rows: unknown, sampledAt = new Date()) {
  const checked = OpsRows[dataset].parse(wire(rows));
  await sql`INSERT INTO ops.operational_snapshots(dataset,sampled_at,payload,last_error_at) VALUES(${dataset},${sampledAt},${sql.json(checked as never)},NULL) ON CONFLICT(dataset) DO UPDATE SET sampled_at=EXCLUDED.sampled_at,payload=EXCLUDED.payload,last_error_at=NULL`;
}
export async function recordOperationalSnapshotFailure(dataset: Dataset) {
  await sql`INSERT INTO ops.operational_snapshots(dataset,last_error_at) VALUES(${dataset},now()) ON CONFLICT(dataset) DO UPDATE SET last_error_at=now()`;
}
/** No worker/queue/model port is imported by this reader. The observer login can only SELECT the projection. */
export async function readOperationalSnapshot(principal: AdminPrincipal, input: unknown, options: { db?: Db; now?: Date } = {}) {
  const request = OpsReadInput.parse(input),
    now = options.now ?? new Date();
  return withOwnerOperationalRead(principal, request, async () => {
    let row: { sampled_at: Date | null; payload: unknown; last_error_at: Date | null } | undefined;
    try {
      const reader = options.db ?? operationsReadDatabase();
      // The concrete observer connection is always a pool; test transaction injection is deliberately unsupported.
      if (!("begin" in reader)) throw new OperationsReadUnavailable();
      row = await reader.begin("read only", async (db) => {
        await db`SET LOCAL statement_timeout='2s'`;
        await db`SET LOCAL lock_timeout='250ms'`;
        const [snapshot] = await db<
          { sampled_at: Date | null; payload: unknown; last_error_at: Date | null }[]
        >`SELECT sampled_at,payload,last_error_at FROM ops.operational_snapshots WHERE dataset=${request.dataset}`;
        return snapshot;
      });
    } catch {
      throw new OperationsReadUnavailable();
    }
    const all = row?.payload === null || row?.payload === undefined ? [] : OpsRows[request.dataset].parse(row.payload);
    const maxRows = ["audit", "evaluations"].includes(request.dataset) ? 100 : 500,
      total = Math.min(all.length, maxRows);
    const items = all.slice(request.offset, Math.min(request.offset + request.limit, maxRows));
    const sampled = row?.sampled_at?.toISOString() ?? null;
    const stale = !!sampled && (now.getTime() - Date.parse(sampled) > 5 * 60_000 || (!!row?.last_error_at && row.last_error_at >= row.sampled_at!));
    const result = {
      dataset: request.dataset,
      sampled_at: sampled,
      read_at: now.toISOString(),
      state: !sampled ? "missing" : stale ? "stale" : "sampled",
      last_collection_failed_at: row?.last_error_at?.toISOString() ?? null,
      coverage: OPS_COVERAGE[request.dataset],
      excludes: [...OPS_EXCLUSIONS],
      items,
      next_offset: request.offset + items.length < total ? request.offset + items.length : null,
      truncated: all.length > maxRows,
    };
    return result;
  });
}
