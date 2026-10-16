import { requireRuntimeRunning, assertRuntimeControl } from "../operations/lane-controls.ts";
import { projectParticipation, participationHash } from "./participation-read.ts";
import { reportEventEvidence, currentFactMembers } from "./report-context.ts";
import { reportFactEvidence } from "../publication/groups.ts";
import { pickRepresentative } from "../publication/representative.ts";
// Hot ranking: attention over the last 48 hours from independent participants.
// Each participant counts once per window (repeat collection does not add heat), decays with a
// 24-hour half-life, and the source time (not collection time) places evidence in the window.
import { dbOf } from "../db.ts";
import { tierRank, type HotEntry } from "./hot-read.ts";

const sql = dbOf("events");

export const HOT_RULE_VERSION = "heat-v2-current-48h-halflife24h";
const WINDOW_HOURS = 48;
const HALF_LIFE_HOURS = 24;
const MIN_PARTICIPANTS = 2;

interface HeatRow {
  story_id: number;
  public_id: string;
  title: string;
  first_report_at: Date | null;
  latest_at: Date | null;
  participants: number;
  heat: number;
  heat_prev: number;
  /** The same two over the participants whose sources were caught up (the comparable group). */
  heat_obs: number;
  heat_prev_obs: number;
  /** Participants with a source whose collection was behind: their newest evidence may be missing. */
  behind_participants: number;
  uncomparable: number;
  recent6h: number;
  editorial_participants: number;
  signal_participants: number;
}

interface SourceClock {
  id: string;
  lastOk: number | null;
  graceMs: number;
}

/** Scheduled sources and their last successful fetch (screenshot-reported and pushed sources cannot visibly fall behind). */
export async function sourceClocks(): Promise<SourceClock[]> {
  const rows = await sql<{ id: string; last_ok_at: Date | null; interval_minutes: number }[]>`
    SELECT id, last_ok_at, interval_minutes FROM sources WHERE enabled AND lane = 'news' AND kind IN ('rss', 'web_list', 'json_list')`;
  return rows.map((r) => ({ id: r.id, lastOk: r.last_ok_at?.getTime() ?? null, graceMs: Math.max(r.interval_minutes * 3, 90) * 60_000 }));
}

/**
 * Sources whose evidence up to `at` may be incomplete. Looking at the present (`grace`), a source is
 * behind after three intervals (at least 90 minutes) without a successful fetch; for an hour already
 * past, it has caught up once any fetch succeeded after that hour (evidence carries the source's time).
 */
export function behindSources(clocks: SourceClock[], at: number, grace: boolean): string[] {
  return clocks.filter((c) => c.lastOk === null || c.lastOk < at - (grace ? c.graceMs : 0)).map((c) => c.id);
}

type HeatEvidence = Awaited<ReturnType<typeof reportEventEvidence>>["signals"];
async function currentHeatEvidence(at: Date, storyIds?: number[], includeHistory = false): Promise<HeatEvidence> {
  const from = new Date(at.getTime() - 54 * 3600000);
  const ids =
    storyIds ??
    (await sql<{ story_id: number }[]>`SELECT DISTINCT story_id FROM story_signals WHERE observed_at>${from} AND observed_at<=${at}`).map(
      (row) => row.story_id,
    );
  return (await reportEventEvidence(ids, [], new Date(at.getTime() + 1), includeHistory ? undefined : from)).signals;
}

/** Compare two complete 48-hour windows using currently valid independent participants. */
async function heatRows(at: Date, behind: string[] = [], storyIds?: number[], supplied?: HeatEvidence): Promise<HeatRow[]> {
  const evidence = supplied ?? (await currentHeatEvidence(at, storyIds));
  if (!evidence.length) return [];
  const input = evidence.map((row) => ({
    story_id: row.story_id,
    participant_key: row.participant_key,
    source_id: row.source_id,
    kind: row.kind,
    observed_at: row.observed_at.toISOString(),
    source_since: row.source_since.toISOString(),
  }));
  const prev = new Date(at.getTime() - 6 * 3600000);
  const nowFrom = new Date(at.getTime() - WINDOW_HOURS * 3600000),
    prevFrom = new Date(prev.getTime() - WINDOW_HOURS * 3600000);
  const decayNow = sql`power(0.5, extract(epoch FROM (${at}::timestamptz - last_at)) / 3600.0 / ${HALF_LIFE_HOURS})`;
  const decayPrev = sql`power(0.5, extract(epoch FROM (${prev}::timestamptz - last_prev)) / 3600.0 / ${HALF_LIFE_HOURS})`;
  const comparable = sql`NOT behind AND NOT late`;
  return sql<HeatRow[]>`
    WITH obs AS (
      SELECT story_id, participant_key,
        max(observed_at) FILTER(WHERE observed_at>${nowFrom}) AS last_at,
        min(observed_at) FILTER(WHERE observed_at>${nowFrom}) AS first_at,
        coalesce(bool_or(kind='editorial') FILTER(WHERE observed_at>${nowFrom}),false) AS editorial,
        max(observed_at) FILTER(WHERE observed_at<=${prev}) AS last_prev,
        bool_or(source_id=ANY(${behind}::text[])) AS behind,
        bool_or(source_since>${prevFrom}) AS late
      FROM pg_catalog.jsonb_to_recordset(${sql.json(input)}) AS cs(story_id bigint,participant_key text,source_id text,kind text,observed_at timestamptz,source_since timestamptz)
      WHERE observed_at>${prevFrom} AND observed_at<=${at}
      GROUP BY story_id,participant_key
    ), agg AS (
      SELECT story_id,
        count(*) FILTER(WHERE last_at IS NOT NULL) AS participants,
        coalesce(sum(${decayNow}) FILTER(WHERE last_at IS NOT NULL),0) AS heat,
        coalesce(sum(${decayPrev}) FILTER(WHERE last_prev IS NOT NULL),0) AS heat_prev,
        coalesce(sum(${decayNow}) FILTER(WHERE last_at IS NOT NULL AND ${comparable}),0) AS heat_obs,
        coalesce(sum(${decayPrev}) FILTER(WHERE last_prev IS NOT NULL AND ${comparable}),0) AS heat_prev_obs,
        count(*) FILTER(WHERE last_at IS NOT NULL AND behind) AS behind_participants,
        count(*) FILTER(WHERE behind OR late) AS uncomparable,
        count(*) FILTER(WHERE first_at>${prev}) AS recent6h,
        count(*) FILTER(WHERE last_at IS NOT NULL AND editorial) AS editorial_participants,
        count(*) FILTER(WHERE last_at IS NOT NULL AND NOT editorial) AS signal_participants
      FROM obs GROUP BY story_id HAVING count(*) FILTER(WHERE last_at IS NOT NULL)>0
    ) SELECT a.story_id,st.public_id::text AS public_id,st.title,st.first_report_at,st.latest_at,
      a.participants,a.heat,a.heat_prev,a.heat_obs,a.heat_prev_obs,a.behind_participants,a.uncomparable,a.recent6h,a.editorial_participants,a.signal_participants
      FROM agg a JOIN stories st ON st.id=a.story_id WHERE st.merged_into IS NULL`;
}

export function heatIndex(heat: number): number {
  return Math.round(heat * 100) / 10; // one decimal on the 10× scale shown to readers
}

export async function computeHotRanking(at = new Date()): Promise<{ id: number; entries: number }> {
  const control = await requireRuntimeRunning("news", ["publication"]);
  const observedStories = (
    await sql<
      { story_id: number }[]
    >`SELECT DISTINCT story_id FROM story_signals WHERE observed_at>${new Date(at.getTime() - 54 * 3600000)} AND observed_at<=${at}`
  ).map((row) => row.story_id);
  const qualified = await currentHeatEvidence(at, observedStories, true);
  const evidence = [...new Map(qualified.map((row) => [`${row.story_id}:${row.article_id}`, row])).values()];
  const behind = behindSources(await sourceClocks(), at.getTime(), true);
  const allRows = await heatRows(at, behind, undefined, evidence);
  const rows = allRows.filter((r) => Number(r.participants) >= MIN_PARTICIPANTS && Number(r.editorial_participants) >= 1);
  rows.sort((a, b) => Number(b.heat) - Number(a.heat) || (b.latest_at?.getTime() ?? 0) - (a.latest_at?.getTime() ?? 0));

  const entries: HotEntry[] = [];
  for (const r of rows) {
    if (entries.length >= 10) break;
    const facts = (await sql<{ id: number }[]>`SELECT id FROM facts WHERE story_id=${r.story_id}`).map((row) => row.id);
    const members = await currentFactMembers(facts),
      qualified = new Set(members.map((row) => `${row.fact_id}:${row.article_id}`));
    const reports = (await reportFactEvidence(facts, new Date(at.getTime() + 1))).filter((row) => qualified.has(`${row.fact_id}:${row.id}`));
    if (!reports.length) continue;
    const byFact = new Map<number, typeof reports>();
    for (const report of reports) byFact.set(report.fact_id!, [...(byFact.get(report.fact_id!) ?? []), report]);
    const sourceCount = (list: typeof reports) => new Set(list.map((report) => report.source_id)).size;
    const firstSeen = (list: typeof reports) => Math.min(...list.map((report) => report.timeline_at.getTime()));
    const leading = [...byFact.values()].sort((a, b) => sourceCount(b) - sourceCount(a) || firstSeen(a) - firstSeen(b) || a[0]!.fact_id! - b[0]!.fact_id!)[0]!;
    const selected = leading.filter((report) => report.selected),
      rep = pickRepresentative(selected.length ? selected : leading);
    const participantsByKey = new Map<string, { name: string; kind: "editorial" | "signal"; tier: string; at: Date }>();
    for (const signal of evidence
      .filter((signal) => Number(signal.story_id) === Number(r.story_id) && signal.observed_at.getTime() > at.getTime() - WINDOW_HOURS * 3600000)
      .sort((a, b) => Number(b.kind === "editorial") - Number(a.kind === "editorial") || b.observed_at.getTime() - a.observed_at.getTime())) {
      if (!participantsByKey.has(signal.participant_key))
        participantsByKey.set(signal.participant_key, { name: signal.source_name, kind: signal.kind, tier: signal.source_tier, at: signal.observed_at });
    }
    const participants = [...participantsByKey.values()];
    // The reporting sources of the window, latest first (signal participants are counted separately).
    const reporting = participants.filter((p) => p.kind === "editorial").sort((x, y) => y.at.getTime() - x.at.getTime());
    const heat = heatIndex(Number(r.heat));
    // The change against six hours before compares only participants whose sources were observed
    // throughout; with none of the earlier ones observed there is no comparison.
    const prevAll = heatIndex(Number(r.heat_prev));
    const [cur, prev] = Number(r.uncomparable) > 0 ? [heatIndex(Number(r.heat_obs)), heatIndex(Number(r.heat_prev_obs))] : [heat, prevAll];
    const pct = prev > 0 ? (cur - prev) / prev : null;
    const firstAt = r.first_report_at ?? reports[0]!.timeline_at;
    const isNew = at.getTime() - firstAt.getTime() < 6 * 3600 * 1000;
    const surge = Number(r.recent6h) >= 3 && Number(r.recent6h) / Number(r.participants) >= 0.5;
    const badges: HotEntry["badges"] = [];
    if (surge) badges.push("surge");
    if (isNew) badges.push("new");
    if (!surge && pct !== null && pct > 0.15) badges.push("rising");
    const sourceNames = [...new Set(reporting.map((x) => x.name))].slice(0, 8);
    entries.push({
      rank: entries.length + 1,
      storyId: r.story_id,
      storyPublicId: r.public_id,
      title: rep.title,
      heat,
      trend: prevAll <= 0 ? "new" : pct === null ? "unknown" : pct > 0.1 ? "up" : pct < -0.1 ? "down" : "flat",
      trendPct: pct === null ? null : Math.round(pct * 1000) / 10,
      badges,
      evidenceHash: participationHash(
        evidence.filter((signal) => signal.story_id === r.story_id && signal.observed_at.getTime() > at.getTime() - 48 * 3600000),
      ),
      participantCount: Number(r.participants),
      sourceCount: Number(r.editorial_participants),
      signalCount: Number(r.signal_participants),
      reportCount: reports.length,
      sourceNames,
      latestAt: (r.latest_at ?? at).toISOString(),
      firstReportAt: firstAt.toISOString(),
      representativeItemId: rep.id,
      representativeUrl: rep.url,
      representativeSource: rep.source_name,
      // 精选组 first by tier, the most recently active first within a tier (ordered before the cap).
      participants: participants
        .sort(
          (x, y) => Number(y.kind === "editorial") - Number(x.kind === "editorial") || tierRank(x.tier) - tierRank(y.tier) || y.at.getTime() - x.at.getTime(),
        )
        .slice(0, 40)
        .map(({ name, kind, tier }) => ({ name, kind, tier })),
    });
  }
  const row = await sql.begin(async (tx) => {
    await assertRuntimeControl(tx, control);
    await projectParticipation(tx, observedStories, evidence, at);
    const [saved] = await tx<{ id: number }[]>`INSERT INTO hot_rankings(computed_at,rule_version,entries,evidence,published)
      VALUES(${at},${HOT_RULE_VERSION},${tx.json(entries as never)},${tx.json({ windowHours: WINDOW_HOURS, halfLifeHours: HALF_LIFE_HOURS, minParticipants: MIN_PARTICIPANTS, candidates: rows.length })},true) RETURNING id`;
    return saved!;
  });
  // Keep a bounded history of rankings.
  await sql`DELETE FROM hot_rankings WHERE computed_at < now() - interval '30 days'`;
  return { id: row!.id, entries: entries.length };
}

/**
 * Hourly heat snapshot for active stories (event page trend). An hour taken while a participant's
 * source was behind is marked incomplete (the charts leave it out) and recomputed once the sources
 * have fetched past it: values are deterministic from the signals, which carry the source's time.
 */
export async function snapshotHeat(at = new Date()): Promise<{ stories: number; repaired: number }> {
  const hour = new Date(Math.floor(at.getTime() / 3600000) * 3600000);
  const historyStories = (
    await sql<
      { story_id: number }[]
    >`SELECT DISTINCT story_id FROM story_signals WHERE observed_at>${new Date(at.getTime() - 9 * 86400000)} AND observed_at<=${at}`
  ).map((row) => row.story_id);
  for (let i = 0; i < historyStories.length; i += 50) {
    const ids = historyStories.slice(i, i + 50),
      evidence = await currentHeatEvidence(at, ids, true);
    await sql.begin((tx) => projectParticipation(tx, ids, evidence, at));
  }
  const clocks = await sourceClocks();
  const rows = await heatRows(hour, behindSources(clocks, hour.getTime(), true));
  for (const r of rows) {
    await sql`
      INSERT INTO story_heat_hourly (story_id, hour, heat, participants, cohort, complete)
      VALUES (${r.story_id}, ${hour}, ${heatIndex(Number(r.heat))}, ${Number(r.participants)}, ${Number(r.editorial_participants)}, ${Number(r.behind_participants) === 0})
      ON CONFLICT (story_id, hour) DO UPDATE SET heat = EXCLUDED.heat, participants = EXCLUDED.participants, cohort = EXCLUDED.cohort, complete = EXCLUDED.complete`;
  }
  let repaired = 0;
  const stale = await sql<{ hour: Date; stories: number[] }[]>`
    SELECT hour, array_agg(story_id) AS stories FROM story_heat_hourly
    WHERE NOT complete AND hour < ${hour} AND hour > ${new Date(hour.getTime() - WINDOW_HOURS * 3600000)} GROUP BY hour ORDER BY hour`;
  for (const s of stale) {
    const wanted = new Set(s.stories.map(Number));
    for (const r of await heatRows(s.hour, behindSources(clocks, s.hour.getTime(), false), s.stories.map(Number))) {
      if (!wanted.has(Number(r.story_id)) || Number(r.behind_participants) > 0) continue;
      await sql`UPDATE story_heat_hourly SET heat = ${heatIndex(Number(r.heat))}, participants = ${Number(r.participants)}, cohort = ${Number(r.editorial_participants)}, complete = true
                WHERE story_id = ${r.story_id} AND hour = ${s.hour}`;
      repaired += 1;
    }
  }
  return { stories: rows.length, repaired };
}

/** Recomputes hourly snapshots for a story over its history (after imports or regrouping). */
export async function backfillStoryHeat(storyId: number, hours = 7 * 24): Promise<number> {
  const [s] = await sql<
    { first: Date | null; last: Date | null }[]
  >`SELECT min(observed_at) AS first, max(observed_at) AS last FROM story_signals WHERE story_id = ${storyId}`;
  if (!s?.first) return 0;
  const end = Math.floor(Math.min(Date.now(), (s.last?.getTime() ?? Date.now()) + WINDOW_HOURS * 3600000) / 3600000) * 3600000;
  const start = Math.max(Math.floor(s.first.getTime() / 3600000) * 3600000, end - hours * 3600000);
  const clocks = await sourceClocks();
  let n = 0;
  for (let t = start; t <= end; t += 3600000) {
    const rows = (await heatRows(new Date(t), behindSources(clocks, t, false), [storyId])).filter((r) => Number(r.story_id) === storyId);
    for (const r of rows) {
      await sql`INSERT INTO story_heat_hourly (story_id, hour, heat, participants, cohort, complete)
                VALUES (${storyId}, ${new Date(t)}, ${heatIndex(Number(r.heat))}, ${Number(r.participants)}, ${Number(r.editorial_participants)}, ${Number(r.behind_participants) === 0})
                ON CONFLICT (story_id, hour) DO UPDATE SET heat = EXCLUDED.heat, participants = EXCLUDED.participants, cohort=EXCLUDED.cohort, complete = EXCLUDED.complete`;
      n += 1;
    }
  }
  return n;
}
