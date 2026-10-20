import { arrangeDaily } from "./arrangement.ts";
import { dailyEdition, periodEntries } from "./edition.ts";
import { dailyDraft, periodContent } from "./draft.ts";
import { reportCandidateRows } from "@amp/backend/publication/groups";
export { newsReportWithdrawalSnapshot } from "./references.ts";
// Daily, weekly and monthly reports. Windows are Beijing calendar based and written into the report;
// missed schedule points are caught up; regeneration creates a revision. The editors' prompts are in
// the industry pack (industry/prompts/report-*.md), the sections follow its categories.
import { EDITION_TIMES } from "@amp/industry/site";
import { modelFor } from "../editorial/models.ts";
import { addDays, beijingDate, beijingTime, isoWeekLabel, isoWeekRange } from "@amp/contracts/time";
import { sql } from "../db.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import { assertRuntimeControl, requireRuntimeRunning, runtimeControlSnapshot, type RuntimeControlSnapshot } from "../operations/lane-controls.ts";
export { composePolicyReports } from "../publication/policy-report-job.ts";

import { writePeriod } from "./period-writing.ts";
import { firstScheduledDaily, preserveReportCalendar, requestReportDependents } from "./revision-state.ts";
import { periodWindow } from "./periods.ts";
export { REPORT_VERSION, PeriodSchema, periodPrompt, writePeriod } from "./period-writing.ts";

export interface ReportEntry {
  itemId: string;
  publicationRevision?: number;
  factId: string | null;
  storyPublicId: string | null;
  title: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  sourceId: string;
  firstParty: boolean;
  role: string;
  score: number | null;
  publishedAt: string;
}

export interface Candidate extends ReportEntry {
  category: string | null;
  factKey: string;
  related?: ReportEntry[];
}

function roleOf(kind: string, firstParty: boolean): string {
  if (firstParty) return "官方";
  if (kind === "mp_account") return "公众号";
  return "媒体";
}

export async function candidates(start: Date, end: Date): Promise<Candidate[]> {
  const rows = await reportCandidateRows(start, end);
  // The publication owner supplies one representative per fact for this report window.
  const byFact = new Map<string, Candidate>();
  for (const r of rows) {
    const key = r.fact_public_id ?? `a:${r.id}`;
    const c: Candidate = {
      itemId: r.id,
      publicationRevision: r.revision,
      factId: r.fact_public_id,
      storyPublicId: r.story_public_id,
      title: r.title,
      summary: r.summary ?? "",
      sourceName: r.source_name,
      sourceUrl: r.url,
      sourceId: r.source_id,
      firstParty: r.first_party,
      role: roleOf(r.source_kind, r.first_party),
      score: r.score === null ? null : Number(r.score),
      publishedAt: r.at.toISOString(),
      category: r.category,
      factKey: key,
    };
    byFact.set(key, c);
  }
  return [...byFact.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

async function saveReport(
  kind: "daily" | "weekly" | "monthly",
  key: string,
  start: Date,
  end: Date,
  content: Record<string, unknown>,
  _reason: string,
  model: string | null,
  control: { publication: RuntimeControlSnapshot; processing?: RuntimeControlSnapshot },
) {
  await sql.begin(async (tx) => {
    await assertRuntimeControl(tx, control.publication);
    if (control.processing) await assertRuntimeControl(tx, control.processing);
    await tx`SELECT pg_advisory_xact_lock(hashtext('report_candidates'))`;
    const [existing] = await tx<{ id: number; revision: number; content: unknown; generated_at: Date }[]>`
      SELECT id, revision, content, generated_at FROM reports WHERE kind = ${kind} AND key = ${key} FOR UPDATE`;
    // Scheduled retries preserve an existing issue. Corrections use their own writer.
    if (existing) return;
    await preserveReportCalendar(tx);
    const inserted = await tx`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, first_published_at, model, origin)
      VALUES (${kind},${key},${start},${end},${tx.json(content as never)},now(),now(),${model},${model ? "model" : "rule"}) ON CONFLICT (kind,key) DO NOTHING`;
    await preserveReportCalendar(tx);
    if (inserted.count && kind === "daily") await requestReportDependents(key, [], tx);
  });
}

async function publishedEntries(kind: string, key: string): Promise<number> {
  const [row] = await sql<
    { content: { sections?: Array<{ items?: unknown[] }>; themes?: Array<{ storyRefs?: unknown[] }>; flashes?: unknown[] } }[]
  >`SELECT content FROM reports WHERE kind = ${kind} AND key = ${key}`;
  if (!row) return 0;
  const content = row.content;
  const sections = (content.sections ?? []).reduce((n: number, section: { items?: unknown[] }) => n + (section.items?.length ?? 0), 0);
  const themes = (content.themes ?? []).reduce((n: number, theme: { storyRefs?: unknown[] }) => n + (theme.storyRefs?.length ?? 0), 0);
  return sections + themes + (content.flashes?.length ?? 0);
}

/** Daily D covers [D-1 08:00, D 08:00). A judged window without selections gets a quiet issue; unjudged windows wait. */
export async function composeDaily(date: string, reason = "scheduled"): Promise<{ key: string; entries: number }> {
  const publication = await requireRuntimeRunning("news", ["publication"]);
  const [existing] = await sql`SELECT 1 FROM reports WHERE kind='daily' AND key=${date}`;
  if (existing) return { key: date, entries: await publishedEntries("daily", date) };
  const end = editionTime(date);
  const start = new Date(end.getTime() - 86400000);
  const prepared = await dailyDraft(date, start, end);
  if (prepared.waiting) return { key: date, entries: 0 };
  await saveReport("daily", date, start, end, prepared.content, reason, null, { publication });
  return { key: date, entries: prepared.entries };
}

/** Published dailies prove period coverage independently of the next catch-up's transient run status. */
async function periodEvidence(startDate: string, endDateInclusive: string) {
  const period = await periodEntries(startDate, endDateInclusive);
  if (period.entries.length) return { ...period, state: "entries" as const };
  const [first] = await sql<{ key: string | null }[]>`SELECT min(key) AS key FROM reports WHERE kind='daily'`;
  if (!period.issues && first?.key && endDateInclusive < first.key) return { ...period, state: "before_first_daily" as const };
  const firstDate = first?.key && first.key > startDate ? first.key : startDate;
  const expected = (Date.parse(endDateInclusive) - Date.parse(firstDate)) / 86400000 + 1;
  // Missing dailies and entries that have lost public eligibility are not a completed quiet period.
  const quiet = !period.hasEntries && period.issues > 0 && period.issues === expected;
  return { ...period, state: quiet ? ("quiet" as const) : ("incomplete" as const) };
}

async function composePeriod(kind: "weekly" | "monthly", key: string, startDate: string, endDateInclusive: string, reason: string) {
  const publication = await requireRuntimeRunning("news", ["publication"]),
    processing = await runtimeControlSnapshot("news", ["processing"]);
  const kept = await publishedEntries(kind, key);
  if (kept > 0) return { key, entries: kept };
  const { from: start, until: end } = periodWindow(kind, key);
  const period = await periodEvidence(startDate, endDateInclusive),
    top = period.entries.slice(0, kind === "weekly" ? 20 : 30);
  if (!top.length) {
    if (["scheduled", "catch-up"].includes(reason) && period.state === "quiet") return { key, entries: 0 };
    throw new Error(`${kind} ${key}: no daily entries in the period`);
  }
  const model = await modelFor("report");
  let written: Awaited<ReturnType<typeof writePeriod>> | null = null;
  try {
    written = await writePeriod(kind, key, startDate, endDateInclusive, top, model);
  } catch (error) {
    if (shutdownSignal.signal.aborted) throw error;
    // Failed prose never changes the already determined contents of an issue.
    console.warn(JSON.stringify({ level: "warn", msg: "report overview unavailable", kind, key, error: error instanceof Error ? error.name : "Error" }));
  }
  const content = periodContent(kind, key, startDate, endDateInclusive, period, top, written);
  await saveReport(kind, key, start, end, content, reason, written?.model ?? null, { publication, ...(written ? { processing } : {}) });
  if (written) await completeReceipt(sql, written.receiptId);
  return { key, entries: top.length };
}

export async function composeWeekly(label: string, reason = "scheduled") {
  const range = isoWeekRange(label);
  if (!range) throw new Error(`bad week label ${label}`);
  return composePeriod("weekly", label, range.start, range.end, reason);
}

export async function composeMonthly(label: string, reason = "scheduled") {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (!m) throw new Error(`bad month label ${label}`);
  const start = `${label}-01`;
  const next = Number(m[2]) === 12 ? `${Number(m[1]) + 1}-01-01` : `${m[1]}-${String(Number(m[2]) + 1).padStart(2, "0")}-01`;
  return composePeriod("monthly", label, start, addDays(next, -1), reason);
}

/** Current daily entries and unresolved nominations; zero qualified alone does not prove a quiet day. */
export async function dailyReportQualification(date: string) {
  const end = editionTime(date);
  const start = new Date(end.getTime() - 86400000);
  const candidates = await dailyEdition(date, start, end);
  const edition = arrangeDaily(candidates.entries);
  return { qualified: edition.main.length + edition.flashes.length, pendingSelections: candidates.stats.pendingSelections };
}

async function periodQualification(startDate: string, endDateInclusive: string) {
  const period = await periodEvidence(startDate, endDateInclusive);
  return { qualified: period.entries.length, state: period.state };
}

/** Read the same durable daily coverage used by period composition, without writing an issue or starting a job. */
export async function periodReportQualification(kind: "weekly" | "monthly", key: string) {
  if (kind === "weekly") {
    const range = isoWeekRange(key);
    if (!range) throw new Error(`bad week label ${key}`);
    return periodQualification(range.start, range.end);
  }
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) throw new Error(`bad month label ${key}`);
  const start = `${key}-01`;
  const next = Number(match[2]) === 12 ? `${Number(match[1]) + 1}-01-01` : `${match[1]}-${String(Number(match[2]) + 1).padStart(2, "0")}-01`;
  return periodQualification(start, addDays(next, -1));
}

/** How many current entries the composer would use; zero alone does not prove a completed quiet period. */
export async function qualifiedReportEntries(kind: "daily" | "weekly" | "monthly", key: string): Promise<number> {
  if (kind === "daily") return (await dailyReportQualification(key)).qualified;
  return (await periodReportQualification(kind, key)).qualified;
}

export const editionTime = (date: string) => new Date(`${date}T${EDITION_TIMES.daily}:00+08:00`);
export function dueDaily(now = new Date()) {
  const today = beijingDate(now);
  return beijingTime(now) >= EDITION_TIMES.daily ? today : addDays(today, -1);
}
export function dueWeekly(now = new Date()) {
  const today = beijingDate(now),
    weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  return isoWeekLabel(addDays(today, -weekday - (weekday > 0 || beijingTime(now) >= EDITION_TIMES.weekly ? 7 : 14)));
}
export function dueMonthly(now = new Date()) {
  const [year, month, day] = beijingDate(now).split("-").map(Number) as [number, number, number];
  const index = year * 12 + month - 1 - (day > 1 || beijingTime(now) >= EDITION_TIMES.monthly ? 1 : 2);
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}
const nextMonth = (key: string) => {
  const [year, month] = key.split("-").map(Number) as [number, number];
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
};

/** Half-hour recovery prioritizes current editions, then older gaps within the shared write limit. */
export async function catchUpReports(now = new Date(), limit = 8): Promise<{ generated: string[] }> {
  const generated: string[] = [],
    failed: string[] = [];
  const kinds = [
    { kind: "daily", due: dueDaily(now), next: (key: string) => addDays(key, 1), end: (key: string) => key, compose: composeDaily },
    {
      kind: "weekly",
      due: dueWeekly(now),
      next: (key: string) => isoWeekLabel(addDays(isoWeekRange(key)!.start, 7)),
      end: (key: string) => isoWeekRange(key)!.end,
      compose: composeWeekly,
    },
    { kind: "monthly", due: dueMonthly(now), next: nextMonth, end: (key: string) => addDays(`${nextMonth(key)}-01`, -1), compose: composeMonthly },
  ];
  editions: for (const current of [true, false]) {
    for (const item of kinds) {
      const have = new Set((await sql<{ key: string }[]>`SELECT key FROM reports WHERE kind=${item.kind}`).map((row) => row.key));
      const firstDaily = await firstScheduledDaily();
      const floor = firstDaily && (item.kind === "daily" ? firstDaily : item.kind === "weekly" ? isoWeekLabel(firstDaily) : firstDaily.slice(0, 7));
      const earliest = [...have].sort()[0] ?? item.due;
      const first = current ? item.due : floor && floor > earliest ? floor : earliest;
      const daily = { key: firstDaily };
      for (let key = first; key <= item.due; key = item.next(key)) {
        if (!current && key === item.due) break;
        if (have.has(key)) continue;
        if (item.kind !== "daily" && (!daily?.key || item.end(key) < daily.key)) continue;
        if (shutdownSignal.signal.aborted || generated.length >= limit) break editions;
        try {
          await item.compose(key, "catch-up");
          if ((await sql`SELECT 1 FROM reports WHERE kind=${item.kind} AND key=${key}`).length) generated.push(`${item.kind}:${key}`);
        } catch (error) {
          if (shutdownSignal.signal.aborted) break editions;
          failed.push(`${item.kind}:${key}`);
          console.warn(
            JSON.stringify({ level: "error", msg: "report issue failed", kind: item.kind, key, error: error instanceof Error ? error.name : "Error" }),
          );
        }
      }
    }
  }
  if (failed.length) throw new Error(`reports: ${failed.join(", ")} failed; ${generated.join(", ")} written`);
  return { generated };
}

export {
  ensureReportCorrectionQueue,
  correctNewsReport,
  registerReportCorrectionJobs,
  enqueuePendingReportCorrections,
  invalidateReportCorrections,
  REPORT_CORRECTION_QUEUE,
} from "./corrections.ts";
export { managedReports, requestManagedReport } from "./management.ts";
