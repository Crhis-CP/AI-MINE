import { confirmedGroupingMaterials } from "../content/grouping.ts";
import { reportEventEvidence } from "../events/report-context.ts";
import { addDays } from "@amp/contracts/time";
import {
  reportSelectedFacts,
  reportCurrentIdentities,
  reportFactEvidence,
  reportPublicInputs,
  reportWindowEvidence,
  type ReportInputRow,
} from "../publication/groups.ts";
import { pickRepresentative } from "../publication/representative.ts";
import { dbOf } from "../db.ts";
import { relatedReport, reportImportance, type EditionEntry } from "./arrangement.ts";
import { storedReportEntries, type StoredReportContent } from "./references.ts";
import type { Candidate, ReportEntry } from "./compose.ts";
const sql = dbOf("reports");
const factKey = (row: ReportInputRow) => row.fact_public_id ?? `a:${row.id}`;
function groupBy<T>(rows: T[], key: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return groups;
}
export function reportEntry(row: ReportInputRow): ReportEntry {
  return {
    itemId: row.id,
    publicationRevision: row.revision,
    factId: row.fact_public_id,
    storyPublicId: row.story_public_id,
    title: row.title,
    summary: row.summary ?? "",
    sourceName: row.source_name,
    sourceUrl: row.url,
    sourceId: row.source_id,
    firstParty: row.first_party,
    role: row.representative_priority < 3 ? "官方" : row.source_kind === "mp_account" ? "公众号" : "媒体",
    score: row.score,
    publishedAt: row.timeline_at.toISOString(),
  };
}

/** Saved facts plus their current identities prevent a later regrouping from repeating yesterday's news. */
export async function dailyMemory(date: string) {
  const issues = await sql<{ key: string; content: StoredReportContent }[]>`
    SELECT key,content FROM reports WHERE kind='daily' AND key<${date} AND key>=${addDays(date, -7)} ORDER BY key DESC`;
  const keys = new Set<string>(),
    cited = new Map<string, { key: string; title: string }>();
  for (const issue of issues)
    for (const entry of storedReportEntries(issue.content)) {
      if (entry.factId) keys.add(entry.factId);
      if (!entry.itemId) continue;
      keys.add(`a:${entry.itemId}`);
      if (!cited.has(entry.itemId)) cited.set(entry.itemId, { key: issue.key, title: entry.title ?? "" });
    }
  const stories = new Map<number, { key: string; title: string }>();
  for (const row of await reportCurrentIdentities([...cited.keys()])) {
    if (row.fact_public_id) keys.add(row.fact_public_id);
    const previous = cited.get(row.id)!;
    if (row.story_id !== null && (!stories.has(row.story_id) || stories.get(row.story_id)!.key < previous.key)) stories.set(row.story_id, previous);
  }
  return { keys, stories };
}

/** One entry per event; the most-covered new fact leads and its other developments remain related reading. */
export async function dailyEdition(date: string, start: Date, end: Date) {
  const [memory, rows] = await Promise.all([dailyMemory(date), reportWindowEvidence(start, end)]);
  const nominations = rows.filter((row) => row.selected || row.selection_candidate);
  const confirmed = new Set((await confirmedGroupingMaterials(nominations.map((row) => row.id))).map((row) => row.id));
  const pendingSelections = nominations.filter((row) => !confirmed.has(row.id) && row.timeline_at >= start).length;
  const selected = rows.filter(
    (row) =>
      row.selected &&
      confirmed.has(row.id) &&
      row.visible_after !== null &&
      Math.max(row.timeline_at.getTime(), row.visible_after.getTime()) >= start.getTime() &&
      Math.max(row.timeline_at.getTime(), row.visible_after.getTime()) < end.getTime(),
  );
  const evidence = await reportFactEvidence([...new Set(rows.flatMap((row) => (row.fact_id === null ? [] : [row.fact_id])))], end);
  const context = await reportEventEvidence(
    [...new Set(rows.flatMap((row) => (row.story_id === null ? [] : [row.story_id])))],
    rows.map((row) => row.id),
    end,
  );
  const selectedFacts = new Set(selected.map(factKey));
  const anySelected = await reportSelectedFacts([...new Set(evidence.flatMap((row) => (row.fact_id === null ? [] : [row.fact_id])))]);
  const activeFacts = new Set(rows.filter((row) => row.timeline_at >= start).map(factKey));
  const missed = [
    ...groupBy(
      evidence.filter((row) => context.signals.some((signal) => signal.article_id === row.id && signal.fact_id === row.fact_id)),
      factKey,
    ),
  ].filter(([key, members]) => {
    if (
      !activeFacts.has(key) ||
      selectedFacts.has(key) ||
      members.some((row) => row.selected || (row.fact_id !== null && anySelected.has(row.fact_id))) ||
      !members.some((row) => row.representative_priority < 3)
    )
      return false;
    const signals = context.signals.filter((signal) => signal.fact_id === members[0]!.fact_id);
    return (
      new Set(signals.map((signal) => signal.participant_key)).size >= 3 &&
      Math.min(...signals.map((signal) => signal.observed_at.getTime())) >= start.getTime() - 86400000
    );
  });
  const raw = [
    ...[...groupBy(selected, factKey)].map(([key, members]) => ({ key, rows: members, selected: true })),
    ...missed.map(([key, members]) => ({ key, rows: members, selected: false })),
  ];
  const kept = raw.filter((fact) => !memory.keys.has(fact.key) && !fact.rows.some((row) => memory.keys.has(`a:${row.id}`)));
  const facts = kept.map((fact) => ({
    ...fact,
    sourceIds: new Set([...fact.rows, ...evidence.filter((row) => row.fact_id === fact.rows[0]!.fact_id)].map((row) => row.source_id)),
    at: Math.min(...fact.rows.map((row) => row.timeline_at.getTime())),
  }));
  const events = [...groupBy(facts, (fact) => (fact.rows[0]!.story_id === null ? `f:${fact.key}` : `s:${fact.rows[0]!.story_id}`)).values()];
  const entries = events.map((facts): EditionEntry => {
    const ordered = [...facts].sort((a, b) => b.sourceIds.size - a.sourceIds.size || a.at - b.at || a.key.localeCompare(b.key));
    const reps = ordered.map((fact) => pickRepresentative(fact.rows)),
      rep = reps[0]!;
    const sourceIds = new Set(facts.flatMap((fact) => [...fact.sourceIds]));
    const previous = rep.story_id === null ? null : (memory.stories.get(rep.story_id) ?? null);
    return {
      entry: {
        ...reportEntry(rep),
        sources: sourceIds.size,
        ...(facts.every((fact) => !fact.selected) ? { fillIn: true as const } : {}),
        ...(reps.length > 1 ? { related: reps.slice(1).map((row) => relatedReport(reportEntry(row))) } : {}),
        ...(previous ? { followUp: previous.key } : {}),
      },
      category: rep.category,
      storyId: rep.story_id,
      sourceIds,
      mentions: new Set(
        rep.story_id === null
          ? context.mentions
              .filter((mention) => facts.some((fact) => fact.rows.some((row) => row.id === mention.article_id)))
              .map((mention) => mention.story_id)
          : [],
      ),
      authority: rep.representative_priority,
      previous,
      commentary: false,
      importance: reportImportance({
        score: Math.max(...facts.flatMap((fact) => fact.rows.map((row) => row.score ?? 0))),
        participants:
          rep.story_id === null
            ? sourceIds.size
            : new Set(
                context.signals.filter((signal) => signal.story_id === rep.story_id && signal.observed_at >= start).map((signal) => signal.participant_key),
              ).size || sourceIds.size,
        official: reps.some((row) => row.representative_priority < 3),
        followUp: !!previous,
      }),
    };
  });
  return {
    entries,
    stats: {
      selectedReports: selected.length,
      pendingSelections,
      facts: raw.length,
      repeatsSuppressed: raw.length - kept.length,
      events: entries.length,
      fillIns: kept.filter((fact) => !fact.selected).length,
    },
  };
}

/** Period reports use only main entries actually carried by dailies, in their current public wording. */
export async function periodEntries(start: string, end: string): Promise<{ entries: Candidate[]; issues: number }> {
  const issues = await sql<
    { key: string; content: StoredReportContent }[]
  >`SELECT key,content FROM reports WHERE kind='daily' AND key>=${start} AND key<=${end} ORDER BY key`;
  const carried = issues.flatMap((issue) =>
    (issue.content.sections ?? []).flatMap((section) =>
      section.items.map((entry) => ({
        id: entry.itemId,
        key: issue.key,
        sources: typeof entry.sources === "number" ? entry.sources : 1,
        lead: issue.content.leadItemId === entry.itemId,
        highlight: Array.isArray(issue.content.highlights) && issue.content.highlights.includes(entry.itemId),
      })),
    ),
  );
  const current = new Map((await reportPublicInputs([...new Set(carried.map((entry) => entry.id))])).map((row) => [row.id, row]));
  const events = groupBy(
    carried.filter((entry) => current.has(entry.id)),
    (entry) => {
      const row = current.get(entry.id)!;
      return row.story_id === null ? `a:${row.id}` : `s:${row.story_id}`;
    },
  );
  const ranked = [...events.values()].map((entries) => {
    const best = [...entries].sort(
      (a, b) =>
        b.sources - a.sources ||
        a.key.localeCompare(b.key) ||
        current.get(a.id)!.representative_priority - current.get(b.id)!.representative_priority ||
        a.id.localeCompare(b.id),
    )[0]!;
    const row = current.get(best.id)!;
    const rank =
      Math.max(...entries.map((entry) => current.get(entry.id)!.score ?? 0)) +
      5 * Math.log2(1 + Math.max(...entries.map((entry) => entry.sources))) +
      (entries.some((entry) => entry.lead) ? 6 : 0) +
      (entries.some((entry) => entry.highlight) ? 3 : 0) +
      4 * (new Set(entries.map((entry) => entry.key)).size - 1);
    return { candidate: { ...reportEntry(row), category: row.category, factKey: factKey(row) }, rank };
  });
  ranked.sort((a, b) => b.rank - a.rank || a.candidate.itemId.localeCompare(b.candidate.itemId));
  return { entries: ranked.map((entry) => entry.candidate), issues: issues.length };
}
