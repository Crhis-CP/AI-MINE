import { dbOf } from "../db.ts";
import { OpsDataset } from "@amp/contracts/ops-mcp";
import { sourcesOperationalSnapshot } from "../sources/operational-snapshot.ts";
import { processingOperationalSnapshot } from "../content/operational-snapshot.ts";
import { acquisitionOperationalSnapshot } from "../acquisition/operational-snapshot.ts";
import { usageOperationalSnapshot, evaluationsOperationalSnapshot, protectionOperationalSnapshot } from "../providers/operational-snapshot.ts";
import { publicationOperationalSnapshot } from "../publication/operational-snapshot.ts";
import { accountsOperationalSnapshot, auditOperationalSnapshot } from "../admin/operational-snapshot.ts";
import { feedbackOperationalSnapshot } from "../feedback/operational-snapshot.ts";
import { storeOperationalSnapshot, recordOperationalSnapshotFailure } from "./read-snapshots.ts";
import { queueOperationalSnapshot } from "../jobs/operational-snapshot.ts";
const sql = dbOf("ops");
const health = () =>
  sql.begin(async (db) => {
    await db`SET LOCAL statement_timeout='2s'`;
    const worker = await db<{ updated_at: Date }[]>`SELECT updated_at FROM settings WHERE key='heartbeat.worker'`;
    const api = await db<{ updated_at: Date }[]>`SELECT updated_at FROM settings WHERE key LIKE 'heartbeat.private-api:%' ORDER BY updated_at DESC LIMIT 1`;
    const backup = await db<{ updated_at: Date }[]>`SELECT updated_at FROM settings WHERE key='backup.last'`;
    return [
      { component: "worker", last_recorded_at: worker[0]?.updated_at ?? null },
      { component: "private-api", last_recorded_at: api[0]?.updated_at ?? null },
      { component: "backup_record", last_recorded_at: backup[0]?.updated_at ?? null },
    ];
  });
const runs = () =>
  sql.begin(async (db) => {
    await db`SET LOCAL statement_timeout='2s'`;
    return db`SELECT job,status,count(*)::int AS count,max(started_at) AS latest_at FROM job_runs WHERE started_at>=now()-interval '24 hours' GROUP BY job,status ORDER BY job,status LIMIT 501`;
  });
const readers = {
  runs,
  health,
  sources: sourcesOperationalSnapshot,
  processing: processingOperationalSnapshot,
  acquisition: acquisitionOperationalSnapshot,
  usage: usageOperationalSnapshot,
  protection: protectionOperationalSnapshot,
  publication: publicationOperationalSnapshot,
  audit: auditOperationalSnapshot,
  accounts: accountsOperationalSnapshot,
  feedback: feedbackOperationalSnapshot,
  evaluations: evaluationsOperationalSnapshot,
  queues: queueOperationalSnapshot,
};
/** Existing worker cron only; bounded, sequential queries do not create models, collection or public writes. */
export async function refreshOperationalSnapshots() {
  const result: { dataset: string; state: string }[] = [];
  for (const dataset of OpsDataset.options) {
    const sampledAt = new Date();
    try {
      await storeOperationalSnapshot(dataset, await readers[dataset](), sampledAt);
      result.push({ dataset, state: "sampled" });
    } catch {
      await recordOperationalSnapshotFailure(dataset);
      result.push({ dataset, state: "unavailable" });
    }
  }
  return result;
}
