import { dailyJudgedReportCount, reportCandidateRows } from "@amp/backend/publication/groups";
import { reportFallbackInput } from "./fallback-input.ts";
import { currentReportPublications, lockReportPublications } from "@amp/backend/publication/publish";
import { isReportWithdrawn } from "@amp/backend/publication/reports";
import { readCurrentSourcePolicy, lockCurrentSourcePolicies } from "@amp/backend/admin/sources";
import { storedReportEntries, type StoredReportContent } from "./references.ts";
export { newsReportWithdrawalSnapshot } from "./references.ts";
// Daily, weekly and monthly reports. Windows are Beijing calendar based and written into the report;
// missed schedule points are caught up; regeneration creates a revision. The editors' prompts are in
// the industry pack (industry/prompts/report-*.md), the sections follow its categories.
import { z } from "zod";
import { SITE } from "@amp/industry/site";
import { CATEGORIES } from "@amp/industry/taxonomy";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { modelFor } from "../editorial/models.ts";
import { addDays, beijingDate, beijingMidnight, isoWeekLabel, isoWeekRange } from "@amp/contracts/time";
import { dbOf } from "../db.ts";
import { chatJson } from "../providers/llm.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import { assertRuntimeControl, requireRuntimeRunning, runtimeControlSnapshot, type RuntimeControlSnapshot } from "../operations/lane-controls.ts";
export { composePolicyReports } from "../publication/policy-report-job.ts";

const sql = dbOf("reports");

export const REPORT_VERSION = promptVersion("report-daily-lead", "report-period");

const SECTION_OF = new Map<string, string>(CATEGORIES.map((c) => [c.key, c.section]));
const SECTION_ORDER = [...new Set(CATEGORIES.map((c) => c.section))];
/** Unknown categories remain unsectioned; country groupings require independent evidence. */
const reportSection = (category: string | null) => SECTION_OF.get(category ?? "") ?? null;

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
}

function roleOf(kind: string, firstParty: boolean): string {
  if (firstParty) return "官方";
  if (kind === "mp_account") return "公众号";
  return "媒体";
}

export async function candidates(start: Date, end: Date): Promise<Candidate[]> {
  const rows = await reportCandidateRows(start, end);
  // One entry per fact: first-party first, then score.
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
    const prev = byFact.get(key);
    if (!prev || Number(c.firstParty) - Number(prev.firstParty) > 0 || (c.firstParty === prev.firstParty && (c.score ?? 0) > (prev.score ?? 0)))
      byFact.set(key, c);
  }
  return [...byFact.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** Facts and items already covered by recent editions are not repeated. */
async function recentlyCovered(kind: "daily", before: string, days = 7): Promise<Set<string>> {
  const rows = await sql<{ content: StoredReportContent }[]>`
    SELECT content FROM reports WHERE kind = ${kind} AND key < ${before} AND key >= ${addDays(before, -days)}`;
  const out = new Set<string>();
  for (const r of rows) {
    for (const it of storedReportEntries(r.content)) {
      if (it.itemId) out.add(`a:${it.itemId}`);
      if (it.factId) out.add(it.factId);
    }
  }
  return out;
}

const LeadSchema = z.object({
  title: z.string().max(120),
  leadParagraph: z.string().max(600),
  highlights: z
    .array(z.union([z.number(), z.string()]))
    .max(6)
    .catch([]),
});

export async function writeLead(kind: string, key: string, entries: ReportEntry[], model: string) {
  if (entries.length === 0) return null;
  const list = entries
    .slice(0, 30)
    .map((e, i) => `${i + 1}. ${e.title}｜${e.summary.slice(0, 120)}`)
    .join("\n");
  const fallbackInput = await reportFallbackInput(entries);
  const system = promptText("report-daily-lead");
  const res = await chatJson({
    model,
    purpose: "report_lead",
    sourceIds: [...new Set(entries.map((e) => e.sourceId))],
    fallbackPermit: fallbackInput?.({ system, user: list }),
    subject: `report:${kind}:${key}`,
    promptVersion: REPORT_VERSION,
    system,
    user: list,
    schema: LeadSchema,
    temperature: 0.3,
    maxTokens: 800,
  });
  const highlights = res.data.highlights
    .map((h) => entries[Number(h) - 1])
    .filter((e): e is ReportEntry => !!e)
    .map((e) => e.itemId);
  return { lead: { title: res.data.title, leadParagraph: res.data.leadParagraph }, highlights, receiptId: res.receiptId, model: res.model };
}

async function saveReport(
  kind: "daily" | "weekly" | "monthly",
  key: string,
  start: Date,
  end: Date,
  content: Record<string, unknown>,
  reason: string,
  model: string | null,
  control: { publication: RuntimeControlSnapshot; processing?: RuntimeControlSnapshot },
) {
  await sql.begin(async (tx) => {
    await assertRuntimeControl(tx, control.publication);
    if (control.processing) await assertRuntimeControl(tx, control.processing);
    const [existing] = await tx<{ id: number; revision: number; content: unknown; generated_at: Date }[]>`
      SELECT id, revision, content, generated_at FROM reports WHERE kind = ${kind} AND key = ${key} FOR UPDATE`;
    // Scheduled daily retries preserve even a zero-entry issue. Corrections use their own writer.
    if (existing && kind === "daily") return;
    if (existing) {
      await tx`INSERT INTO report_revisions (report_id, revision, content, generated_at, reason)
               VALUES (${existing.id}, ${existing.revision}, ${tx.json(existing.content as never)}, ${existing.generated_at}, ${reason}) ON CONFLICT DO NOTHING`;
      await tx`UPDATE reports SET content = ${tx.json(content as never)}, window_start = ${start}, window_end = ${end}, generated_at = now(),
                 model = ${model}, revision = revision + 1, origin = 'model', updated_at = now() WHERE id = ${existing.id}`;
    } else {
      await tx`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, model, origin)
               VALUES (${kind}, ${key}, ${start}, ${end}, ${tx.json(content as never)}, now(), ${model}, 'model') ON CONFLICT (kind,key) DO NOTHING`;
    }
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

/** Complete only the saved first edition; retries never reselect members or overwrite a correction. */
async function completeDailyLead(date: string, publication: RuntimeControlSnapshot, processing: RuntimeControlSnapshot) {
  type Content = Record<string, unknown> & {
    sections?: Array<{ items: ReportEntry[] }>;
    generator?: Record<string, unknown>;
    correctionPending?: boolean;
    generationStatus?: string;
  };
  const [report] = await sql<{ revision: number; content: Content }[]>`SELECT revision,content FROM reports WHERE kind='daily' AND key=${date}`;
  if (!report || report.content.correctionPending || !["pending", "failed"].includes(report.content.generationStatus ?? "")) return;
  if (await isReportWithdrawn("news", "daily", date)) return;
  const entries: ReportEntry[] = (report.content.sections ?? [])
    .flatMap((section: { items: ReportEntry[] }) => section.items)
    .sort((a: ReportEntry, b: ReportEntry) => (b.score ?? 0) - (a.score ?? 0));
  if (!entries.length) return;
  const ids = entries.map((entry) => entry.itemId);
  const matches = (current: Awaited<ReturnType<typeof currentReportPublications>>) =>
    current.length === entries.length &&
    entries.every((entry) =>
      current.some(
        (row) =>
          row.itemId === entry.itemId &&
          row.title === entry.title &&
          row.summary === entry.summary &&
          row.sourceId === entry.sourceId &&
          row.sourceUrl === entry.sourceUrl,
      ),
    );
  try {
    if (!matches(await currentReportPublications(ids))) throw new Error("Report citations changed; correction required");
    const permissions = await Promise.all(
      [...new Set(entries.map((entry) => entry.sourceId))].sort().map(async (sourceId) => {
        const policy = await readCurrentSourcePolicy(sourceId);
        if (!policy) throw new Error("Report source permission missing");
        return { sourceId, permissionVersion: policy.permission_version };
      }),
    );
    const lead = await writeLead("daily", date, entries, await modelFor("report"));
    if (!lead) return;
    await sql.begin(async (tx) => {
      await assertRuntimeControl(tx, publication);
      await assertRuntimeControl(tx, processing);
      await lockCurrentSourcePolicies(tx, permissions);
      await tx`SELECT pg_advisory_xact_lock(hashtext('report_candidates'))`;
      await lockReportPublications(ids, tx);
      const current = await currentReportPublications(ids, tx);
      if (!matches(current)) return;
      // Grouping, tags and body-mode changes can advance publication revisions without changing
      // the model input. Bind the unchanged text to its current revision, preserving fixed members.
      const revisions = new Map(current.map((entry) => [entry.itemId, entry.publicationRevision]));
      const content = {
        ...report.content,
        generationStatus: "ready",
        sections: report.content.sections?.map((section) => ({
          ...section,
          items: section.items.map((entry) => ({ ...entry, publicationRevision: revisions.get(entry.itemId) })),
        })),
        lead: lead.lead,
        highlights: lead.highlights,
        generator: { ...report.content.generator, model: lead.model },
      };
      const updated = await tx`UPDATE reports SET content=${tx.json(content as never)},model=${lead.model},updated_at=now()
        WHERE kind='daily' AND key=${date} AND revision=${report.revision}
          AND content->>'generationStatus' IN ('pending','failed') AND coalesce(content->>'correctionPending','false')<>'true'`;
      if (updated.count) await completeReceipt(tx, lead.receiptId);
    });
  } catch (error) {
    // Failure metadata cannot override a concurrent publication hold or manual correction.
    await sql
      .begin(async (tx) => {
        await assertRuntimeControl(tx, publication);
        await tx`UPDATE reports SET content=jsonb_set(content,'{generationStatus}','"failed"'::jsonb),updated_at=now()
        WHERE kind='daily' AND key=${date} AND revision=${report.revision}
          AND content->>'generationStatus' IN ('pending','failed') AND coalesce(content->>'correctionPending','false')<>'true'`;
      })
      .catch(() => {});
    throw error;
  }
}

/** Daily D covers [D-1 08:00, D 08:00). A judged window without selections gets a quiet issue; unjudged windows wait. */
export async function composeDaily(date: string, reason = "scheduled"): Promise<{ key: string; entries: number }> {
  const publication = await requireRuntimeRunning("news", ["publication"]),
    processing = await runtimeControlSnapshot("news", ["processing"]);
  const [existing] = await sql`SELECT 1 FROM reports WHERE kind='daily' AND key=${date}`;
  if (existing) {
    await completeDailyLead(date, publication, processing);
    return { key: date, entries: await publishedEntries("daily", date) };
  }
  const end = new Date(beijingMidnight(date).getTime() + 8 * 3600 * 1000);
  const start = new Date(end.getTime() - 86400000);
  const covered = await recentlyCovered("daily", date);
  const all = await candidates(start, end);
  const fresh = all.filter((c) => !covered.has(c.factKey) && !covered.has(`a:${c.itemId}`));
  const perSection = new Map<string, Candidate[]>();
  const flashes: Array<{
    itemId: string;
    publicationRevision?: number;
    factId: string | null;
    title: string;
    sourceName: string;
    sourceUrl: string;
    publishedAt: string;
  }> = [];
  for (const c of fresh) {
    const label = reportSection(c.category);
    const list = label ? (perSection.get(label) ?? []) : [];
    if (label && list.length < 8) list.push(c);
    else if (flashes.length < 12)
      flashes.push({
        itemId: c.itemId,
        factId: c.factId,
        publicationRevision: c.publicationRevision,
        title: c.title,
        sourceName: c.sourceName,
        sourceUrl: c.sourceUrl,
        publishedAt: c.publishedAt,
      });
    if (label) perSection.set(label, list);
  }
  const sections = SECTION_ORDER.filter((l) => perSection.get(l)?.length).map((label) => ({
    label,
    items: perSection.get(label)!.map(({ category: _c, factKey: _f, ...entry }) => entry),
  }));
  const ordered = sections.flatMap((s) => s.items).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const quiet = ordered.length === 0 && flashes.length === 0;
  if (quiet && (await dailyJudgedReportCount(start, end)) === 0) return { key: date, entries: 0 };
  const content = {
    date,
    generationStatus: ordered.length ? "pending" : "summary",
    lead: quiet
      ? {
          title: "今日无大事发生",
          leadParagraph: "本期已完成评分的矿业资讯中，没有新增内容入选日报。",
        }
      : null,
    highlights: [],
    sections,
    flashes,
    metrics: {
      totalEvents: ordered.length,
      sourcesCount: new Set(ordered.map((e) => e.sourceId)).size,
      modelsReleased: perSection.get("模型发布/更新")?.length ?? 0,
      firstPartyEvents: ordered.filter((e) => e.firstParty).length,
    },
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    generator: { version: REPORT_VERSION, model: null, repeatsSuppressed: all.length - fresh.length },
  };
  await saveReport("daily", date, start, end, content, reason, null, { publication });
  await completeDailyLead(date, publication, processing);
  return { key: date, entries: await publishedEntries("daily", date) };
}

export const PeriodSchema = z.object({
  // A headline is asked for, but a missing or unusable one leaves the issue on its generic name.
  headline: z.string().max(60).catch(""),
  overview: z.string().max(1500),
  themes: z
    // A theme cites at most eight entries; a model that lists more keeps its first eight rather than failing the issue.
    .array(
      z.object({
        heading: z.string().max(60),
        summary: z.string().max(800),
        refs: z.array(z.union([z.number(), z.string()])).transform((refs) => refs.slice(0, 8)),
      }),
    )
    .min(1)
    .transform((themes) => themes.slice(0, 6)),
});

/** The editor's brief for a week or month: its top entries as a numbered list, each with its section. */
export function periodPrompt(kind: "weekly" | "monthly", startDate: string, endDateInclusive: string, top: Candidate[]) {
  const list = top.map((e, i) => `${i + 1}. [${reportSection(e.category) ?? ""}] ${e.title}｜${e.summary.slice(0, 140)}`).join("\n");
  return {
    system: promptText("report-period", { kindName: kind === "weekly" ? "周报" : "月报", overviewLength: kind === "weekly" ? "150–300" : "200–400" }),
    user: `本期：${startDate} 至 ${endDateInclusive}\n${list}`,
  };
}

async function composePeriod(kind: "weekly" | "monthly", key: string, startDate: string, endDateInclusive: string, reason: string) {
  const publication = await requireRuntimeRunning("news", ["publication"]),
    processing = await runtimeControlSnapshot("news", ["processing"]);
  const start = beijingMidnight(startDate);
  const end = beijingMidnight(addDays(endDateInclusive, 1));
  const all = await candidates(start, end);
  const top = all.slice(0, kind === "weekly" ? 40 : 60);
  const kept = await publishedEntries(kind, key);
  if (kept > 0) return { key, entries: kept };
  if (!top.length) return { key, entries: 0 };
  const dailyCount =
    (await sql<{ n: number }[]>`SELECT count(*) AS n FROM reports WHERE kind = 'daily' AND key >= ${startDate} AND key <= ${endDateInclusive}`)[0]?.n ?? 0;
  let themes: Array<{ heading: string; summary: string; storyRefs: ReportEntry[] }> = [];
  let headline = "";
  let overview = "";
  let receiptId: number | null = null;
  const model = await modelFor("report");
  let actualModel = model;
  if (top.length) {
    const prompt = periodPrompt(kind, startDate, endDateInclusive, top);
    const fallbackInput = await reportFallbackInput(top);
    const res = await chatJson({
      model,
      purpose: `report_${kind}`,
      subject: `report:${kind}:${key}`,
      promptVersion: REPORT_VERSION,
      ...prompt,
      sourceIds: [...new Set(top.map((e) => e.sourceId))],
      fallbackPermit: fallbackInput?.(prompt),
      schema: PeriodSchema,
      temperature: 0.3,
      maxTokens: 2500,
    });
    receiptId = res.receiptId;
    actualModel = res.model;
    headline = res.data.headline.trim();
    overview = res.data.overview;
    themes = res.data.themes.map((t) => ({
      heading: t.heading,
      summary: t.summary,
      storyRefs: t.refs
        .map((r) => top[Number(r) - 1])
        .filter((e): e is Candidate => !!e)
        .map(({ category: _c, factKey: _f, ...e }) => e),
    }));
  }
  const content = {
    kind,
    generationStatus: receiptId ? "ready" : "summary",
    title: kind === "weekly" ? `${SITE.name} 周报 · ${key}` : `${SITE.name} 月报 · ${key}`,
    ...(kind === "weekly" ? { isoLabel: key } : { monthLabel: key }),
    periodStart: startDate,
    periodEnd: endDateInclusive,
    ...(headline ? { headline } : {}),
    overview,
    themes,
    storyOrder: top.map((e) => e.itemId),
    metrics: { totalStories: themes.reduce((n, t) => n + t.storyRefs.length, 0), selectedCount: all.length, reportsCovered: Number(dailyCount) },
    generator: { version: REPORT_VERSION, model: actualModel },
  };
  await saveReport(kind, key, start, end, content, reason, actualModel, { publication, ...(receiptId ? { processing } : {}) });
  if (receiptId) await completeReceipt(sql, receiptId);
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

/** Entries a catch-up would put in daily D. Zero means the gap stays missing instead of becoming a blank issue. */
async function freshDailyCount(date: string): Promise<number> {
  const end = new Date(beijingMidnight(date).getTime() + 8 * 3600 * 1000);
  const start = new Date(end.getTime() - 86400000);
  const covered = await recentlyCovered("daily", date);
  const all = await candidates(start, end);
  return all.filter((c) => !covered.has(c.factKey) && !covered.has(`a:${c.itemId}`)).length;
}

async function periodEntryCount(startDate: string, endDateInclusive: string): Promise<number> {
  return (await candidates(beijingMidnight(startDate), beijingMidnight(addDays(endDateInclusive, 1)))).length;
}

/**
 * How many qualified new selections the composer would put in this issue.
 * Daily is the fresh items in [D-1 08:00, D 08:00). Weekly and monthly are the selections in that
 * calendar period. Zero may be a quiet daily; it is not a count of older selections.
 */
export async function qualifiedReportEntries(kind: "daily" | "weekly" | "monthly", key: string): Promise<number> {
  if (kind === "daily") return freshDailyCount(key);
  if (kind === "weekly") {
    const range = isoWeekRange(key);
    if (!range) throw new Error(`bad week label ${key}`);
    return periodEntryCount(range.start, range.end);
  }
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) throw new Error(`bad month label ${key}`);
  const start = `${key}-01`;
  const next = Number(match[2]) === 12 ? `${Number(match[1]) + 1}-01-01` : `${match[1]}-${String(Number(match[2]) + 1).padStart(2, "0")}-01`;
  return periodEntryCount(start, addDays(next, -1));
}

/**
 * Catch-up: generates any missing daily report for the last `days` days (never the future and never
 * before the first report in the database), the last complete week and the last complete month.
 * A judged daily without new selections still publishes its quiet issue; unjudged windows wait.
 */
export async function catchUpReports(now = new Date(), days = 7): Promise<{ generated: string[] }> {
  const generated: string[] = [];
  const failures: unknown[] = [];
  const today = beijingDate(now);
  const bjHour = Number(new Date(now.getTime() + 8 * 3600000).toISOString().slice(11, 13));
  const [first] = await sql<{ key: string | null }[]>`SELECT min(key) AS key FROM reports WHERE kind = 'daily'`;
  const latestDue = bjHour >= 8 ? today : addDays(today, -1);
  for (let i = days - 1; i >= 0; i--) {
    if (shutdownSignal.signal.aborted) return { generated }; // the next hourly run continues
    const d = addDays(latestDue, -i);
    if (first?.key && d < first.key) continue;
    const [exists] = await sql`SELECT content FROM reports WHERE kind = 'daily' AND key = ${d}`;
    try {
      if (exists && !exists.content.correctionPending && ["pending", "failed"].includes(exists.content.generationStatus)) {
        // The saved member snapshot survives failure; the gateway still blocks unknown bills.
        await composeDaily(d, "catch-up");
      } else if (!exists) {
        await composeDaily(d, "catch-up");
        if ((await sql`SELECT 1 FROM reports WHERE kind='daily' AND key=${d}`).length) generated.push(`daily:${d}`);
      }
    } catch (error) {
      // One unresolved synthesis must not prevent later deterministic editions from appearing.
      failures.push(error);
    }
  }
  // Recover only existing older snapshots, bounded and rotated so unresolved bills cannot starve others.
  const older = await sql<{ key: string }[]>`UPDATE reports SET updated_at=now() WHERE id IN (
    SELECT id FROM reports WHERE kind='daily' AND key < ${addDays(latestDue, 1 - days)}
      AND content->>'generationStatus' IN ('pending','failed') AND coalesce(content->>'correctionPending','false')<>'true'
    ORDER BY updated_at,id LIMIT 20 FOR UPDATE SKIP LOCKED) RETURNING key`;
  for (const issue of older) {
    if (shutdownSignal.signal.aborted) return { generated };
    try {
      await composeDaily(issue.key, "catch-up");
    } catch (error) {
      failures.push(error);
    }
  }
  // Last complete ISO week (Monday 10:00 onwards).
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const lastWeek = isoWeekLabel(addDays(today, -dow - 7));
  const weekDue = dow > 0 || bjHour >= 10;
  if (weekDue) {
    const [w] = await sql`SELECT 1 FROM reports WHERE kind = 'weekly' AND key = ${lastWeek}`;
    const range = isoWeekRange(lastWeek);
    if (!w && range && (await periodEntryCount(range.start, range.end)) > 0) {
      await composeWeekly(lastWeek, "catch-up");
      generated.push(`weekly:${lastWeek}`);
    }
  }
  // Last complete month (1st 10:30 onwards).
  const [y, mo, dd] = today.split("-").map(Number) as [number, number, number];
  const prevMonth = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
  const monthDue = dd > 1 || bjHour > 10 || (bjHour === 10 && Number(new Date(now.getTime() + 8 * 3600000).toISOString().slice(14, 16)) >= 30);
  if (monthDue) {
    const [m] = await sql`SELECT 1 FROM reports WHERE kind = 'monthly' AND key = ${prevMonth}`;
    const monthStart = `${prevMonth}-01`;
    const monthEnd = addDays(`${y}-${String(mo).padStart(2, "0")}-01`, -1);
    if (!m && (await periodEntryCount(monthStart, monthEnd)) > 0) {
      await composeMonthly(prevMonth, "catch-up");
      generated.push(`monthly:${prevMonth}`);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Daily report synthesis remains incomplete");
  return { generated };
}

export {
  ensureReportCorrectionQueue,
  correctNewsReport,
  enqueuePendingReportCorrections,
  invalidateReportCorrections,
  REPORT_CORRECTION_QUEUE,
} from "./corrections.ts";
