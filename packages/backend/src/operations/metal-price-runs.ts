// Metal price runs (TASK-0071): the metals.prices records the schedule leaves in job_runs, read for the daily digest
// (alerts.ts) and TASK-0076's check script. A record is the refresh's return value as TASK-0069 shaped it, one entry per
// source key; later cards only add fields, read here when present (TASK-0046's note and heldSeries). Read-only, and from
// job_runs alone: no publication code, price table or registry.
import { dbOf } from "../db.ts";

const sql = dbOf("ops");

/** One period of a source's entry. */
export interface MetalPricePeriodRecord {
  period: string;
  version: string;
  inserted: number;
  touched: number;
  changed: { key: string; before: string; after: string }[];
  /** Why it was held back whole ("等 <所属期>" while it waits for a held earlier one); null when stored. */
  held: string | null;
  notes: string[];
  /** Series held back alone, with their reasons (TASK-0046). */
  heldSeries?: { key: string; reason: string }[];
}

/** One source's entry of a run: ok is no error and nothing held back ("no new version" and a note are successes). */
export interface MetalPriceSourceRecord {
  ok: boolean;
  at: string;
  error: string | null;
  inserted: number;
  touched: number;
  periods: MetalPricePeriodRecord[];
  /** "这次一期都没有返回" when the fetcher returned no period (TASK-0046). */
  note?: string;
}

export interface MetalPriceSourceRuns {
  firstSeenAt: Date;
  lastOkAt: Date | null;
  /** Its entry in the latest run that has it; one that returned no period and did not fail stands for the latest earlier one that did. */
  latest: MetalPriceSourceRecord;
  /** By label (all a record keeps), the periods its latest entry that returned periods held back, less those waiting ("等 …"). */
  held: string[];
}

export interface MetalPriceRuns {
  /** The latest run, whatever its status: a failed one has an error and no record. */
  latest: { at: Date; status: string; error: string | null; record: Record<string, MetalPriceSourceRecord> | null } | null;
  lastOkRunAt: Date | null;
  /** The sources of the latest ok run: the refresh leaves a source stopped in the registry out of its record. */
  sources: Record<string, MetalPriceSourceRuns>;
}

/** The metals.prices runs of the 30 days up to `now` (job_runs keeps no more), by when they started. */
export async function readMetalPriceRuns(now: Date): Promise<MetalPriceRuns> {
  const runs = await sql<{ started_at: Date; status: string; error: string | null; detail: Record<string, MetalPriceSourceRecord> | null }[]>`
    SELECT started_at, status, error, detail FROM job_runs
    WHERE job = 'metals.prices' AND started_at > ${new Date(now.getTime() - 30 * 86400_000)} AND started_at <= ${now}
    ORDER BY started_at, id`;
  const last = runs.at(-1);
  const lastOk = runs.findLast((run) => run.status === "ok");
  const sources: Record<string, MetalPriceSourceRuns> = {};
  for (const key of Object.keys(lastOk?.detail ?? {})) {
    const entries = runs.flatMap((run) => (run.detail?.[key] ? [{ at: run.started_at, entry: run.detail[key] }] : []));
    let latest = entries[0].entry;
    let lastOkAt: Date | null = null;
    let returned: MetalPriceSourceRecord | undefined;
    for (const { at, entry } of entries) {
      if (entry.periods.length) returned = entry;
      // A run that returned no period (TASK-0046's note: the same World Bank version is not downloaded again within 7 days,
      // TASK-0068) keeps the outcome of the latest earlier one that did, so the runs after a hold do not cover it up.
      latest = entry.ok && !entry.periods.length && returned ? returned : entry;
      if (latest.ok) lastOkAt = at;
    }
    const held = returned?.periods.filter((period) => period.held !== null && !period.held.startsWith("等 ")).map((period) => period.period) ?? [];
    sources[key] = { firstSeenAt: entries[0].at, lastOkAt, latest, held };
  }
  return {
    latest: last ? { at: last.started_at, status: last.status, error: last.error, record: last.detail } : null,
    lastOkRunAt: lastOk?.started_at ?? null,
    sources,
  };
}
