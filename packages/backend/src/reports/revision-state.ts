import { addDays } from "@amp/contracts/time";
import { sql, type Db } from "../db.ts";
import { ackReportChangeNotifications, reportChangeNotifications } from "@amp/backend/publication/groups";
import { ensureQueue } from "../jobs/queue.ts";
import { enqueueJob } from "../jobs/module-queues.ts";
import { dependentPeriods, periodWindow, periodDueAt, type ReportKind } from "./periods.ts";
import { dueDaily, dueMonthly, dueWeekly } from "./compose.ts";

export const RECONCILE_QUEUE = "reports.reconcile";
export const ensureReconciliationQueue = () => ensureQueue(RECONCILE_QUEUE, { policy: "exclusive", retryLimit: 0, expireInSeconds: 900 });
export function reportIsDue(kind: ReportKind, key: string, now = new Date()) {
  periodWindow(kind, key);
  return key <= (kind === "daily" ? dueDaily(now) : kind === "weekly" ? dueWeekly(now) : dueMonthly(now));
}
export async function requestReportRevision(kind: ReportKind, key: string, reason: string, evidence: string[], db: Db = sql) {
  const window = periodWindow(kind, key);
  // Future periods stay tracked until their normal edition time; new inputs cannot publish them early.
  await db`INSERT INTO reports.reconciliation_jobs(kind,key,period_start,period_end,reason_code,evidence,next_attempt_at)
    VALUES(${kind},${key},${window.from},${window.until},${reason},${db.json([...new Set(evidence)].slice(0, 200))},greatest(now(),${periodDueAt(kind, key)}))
    ON CONFLICT(kind,key) DO UPDATE SET generation=reports.reconciliation_jobs.generation+1,
      state='pending',period_start=EXCLUDED.period_start,period_end=EXCLUDED.period_end,reason_code=EXCLUDED.reason_code,evidence=EXCLUDED.evidence,
      requested_at=now(),next_attempt_at=greatest(now(),EXCLUDED.next_attempt_at),attempts=0`;
}
export async function requestReportDependents(day: string, evidence: string[], db: Db) {
  for (const period of dependentPeriods(day)) await requestReportRevision(period.kind, period.key, "daily_revision", evidence, db);
  // Seven-day memory may suppress or attach a fact in a following issue. Only already tracked issues need repair.
  const following = await db<{ key: string }[]>`SELECT key FROM reports WHERE kind='daily' AND key>${day} AND key<=${addDays(day, 7)} ORDER BY key`;
  for (const issue of following) await requestReportRevision("daily", issue.key, "earlier_daily_revision", evidence, db);
}
/** Acknowledge publication generations in the same transaction that records all affected work. */
export async function collectReportChanges(limit = 100) {
  const changes = await reportChangeNotifications(Math.min(200, Math.max(1, limit)));
  await sql.begin(async (tx) => {
    await ackReportChangeNotifications(changes, tx);
    const periods = new Map<string, Set<string>>();
    for (const change of changes)
      for (const day of change.periods) {
        if (!periods.has(day)) periods.set(day, new Set());
        periods.get(day)!.add(change.articleId);
      }
    for (const [day, ids] of [...periods].sort(([a], [b]) => a.localeCompare(b))) await requestReportRevision("daily", day, "source_change", [...ids], tx);
  });
  return changes.length;
}
/** Current issues get the first slots, but an oldest pending slot prevents historical starvation. */
export async function enqueueReportReconciliation(limit = 4) {
  await ensureReconciliationQueue();
  const rows = await sql<{ kind: ReportKind; key: string; generation: string }[]>`
    WITH due AS (
      SELECT j.kind,j.key,j.generation,j.requested_at,j.period_end FROM reports.reconciliation_jobs j
      WHERE j.state IN ('pending','retry','running') AND j.next_attempt_at<=now()
        AND (j.lease_until IS NULL OR j.lease_until<now())
        AND ((j.kind='daily' AND j.key<=${dueDaily()}) OR (j.kind='weekly' AND j.key<=${dueWeekly()}) OR (j.kind='monthly' AND j.key<=${dueMonthly()}))
        AND (j.kind='daily' OR NOT EXISTS(SELECT 1 FROM reports.reconciliation_jobs d
          WHERE d.kind='daily' AND (d.state IN ('pending','running') OR (d.state='retry' AND d.next_attempt_at<=now()))
            AND d.key>=pg_catalog.to_char(j.period_start AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')
            AND d.key<=pg_catalog.to_char(j.period_end AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')))
    ), oldest AS (SELECT * FROM due ORDER BY requested_at,kind,key LIMIT 1)
    SELECT * FROM (SELECT *,false AS oldest FROM due ORDER BY period_end DESC,kind LIMIT ${Math.max(1, Math.min(limit, 20)) - 1}) recent
    UNION ALL SELECT *,true AS oldest FROM oldest`;
  let queued = 0;
  for (const row of new Map(rows.map((row) => [`${row.kind}:${row.key}`, row])).values()) {
    if (!reportIsDue(row.kind, row.key)) continue;
    await sql.begin(async (tx) => {
      const changed = await tx`UPDATE reports.reconciliation_jobs SET state='pending',next_attempt_at=now()+interval '5 minutes'
        WHERE kind=${row.kind} AND key=${row.key} AND generation=${row.generation} AND next_attempt_at<=now()
        AND (lease_until IS NULL OR lease_until<now())`;
      if (!changed.count) return;
      const id = await enqueueJob(
        RECONCILE_QUEUE,
        { kind: row.kind, key: row.key, lane: "news" },
        { singletonKey: `${row.kind}:${row.key}:${row.generation}` },
        tx,
      );
      if (id) queued++;
    });
  }
  return queued;
}
export async function preserveReportCalendar(db: Db = sql) {
  await db`INSERT INTO reports.calendar(first_daily) SELECT min(key) FROM reports WHERE kind='daily' HAVING min(key) IS NOT NULL ON CONFLICT DO NOTHING`;
}
export async function firstScheduledDaily() {
  const [row] = await sql<{ key: string | null }[]>`SELECT coalesce(
    (SELECT first_daily FROM reports.calendar WHERE singleton),
    (SELECT min(key) FROM reports WHERE kind='daily')) AS key`;
  return row?.key ?? null;
}
