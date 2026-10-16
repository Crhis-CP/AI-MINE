import { dbOf, type Db } from "../db.ts";
import { publicParticipationBindings } from "../publication/groups.ts";
import { publicParticipationSources } from "../sources/participants.ts";
import { publicMaterialVersions } from "../content/grouping.ts";
import type { reportEventEvidence } from "./report-context.ts";
import { sha256, stableJson } from "../lib/ids.ts";
const sql = dbOf("events");
export type QualifiedSignal = {
  story_id: number;
  article_id: string;
  participant_key: string;
  source_id: string;
  kind: "editorial" | "signal";
  observed_at: Date;
  qualified_fact_id: number | null;
  material_revision: number;
  source_date_version: string;
  publication_revision: number | null;
  source_since: Date;
  source_behind?: boolean;
};
export function participationHash(rows: Array<Pick<QualifiedSignal, "article_id" | "participant_key" | "kind" | "observed_at">>) {
  return sha256(
    stableJson(
      rows.map((row) => [row.article_id, row.participant_key, row.kind, row.observed_at.toISOString()]).sort((a, b) => String(a).localeCompare(String(b))),
    ),
  );
}
/** Store bounded proof fields alongside the existing observations; no model text or operator reasons. */
export async function projectParticipation(db: Db, storyIds: number[], rows: Awaited<ReturnType<typeof reportEventEvidence>>["signals"], at: Date) {
  if (!storyIds.length) return;
  const unique = new Map(rows.map((row) => [`${row.story_id}:${row.article_id}`, row]));
  const values = [...unique.values()];
  await db`UPDATE story_signals SET qualified_at=NULL WHERE story_id=ANY(${storyIds}::bigint[]) AND qualified_at IS NOT NULL
    AND (story_id::text || ':' || article_id) <> ALL(${[...unique.keys()]}::text[])`;
  for (let i = 0; i < values.length; i += 500) {
    const batch = values.slice(i, i + 500).map((row) => ({
      story_id: row.story_id,
      article_id: row.article_id,
      participant_key: row.participant_key,
      kind: row.kind,
      fact_id: row.fact_id,
      material_revision: row.material_revision,
      source_date_version: row.source_date_version,
      publication_revision: row.publication_revision,
      source_since: row.source_since.toISOString(),
    }));
    await db`UPDATE story_signals ss SET qualified_at=${at},participant_key=proof.participant_key,kind=proof.kind,qualified_fact_id=proof.fact_id,
      material_revision=proof.material_revision,source_date_version=proof.source_date_version,publication_revision=proof.publication_revision,source_since=proof.source_since
      FROM pg_catalog.jsonb_to_recordset(${db.json(batch)}) AS proof(story_id bigint,article_id text,participant_key text,kind text,fact_id bigint,material_revision integer,source_date_version bigint,publication_revision integer,source_since timestamptz)
      WHERE ss.story_id=proof.story_id AND ss.article_id=proof.article_id AND (ss.qualified_at IS NULL OR
        (ss.participant_key,ss.kind,ss.qualified_fact_id,ss.material_revision,ss.source_date_version,ss.publication_revision,ss.source_since)
        IS DISTINCT FROM (proof.participant_key,proof.kind,proof.fact_id,proof.material_revision,proof.source_date_version,proof.publication_revision,proof.source_since))`;
  }
}
/** Current public checks refine the worker proof; a reader never calls private grouping or a model. */
export async function publicParticipation(storyIds: number[], at: Date, from?: Date): Promise<QualifiedSignal[]> {
  if (!storyIds.length) return [];
  const rows = await sql<
    QualifiedSignal[]
  >`SELECT story_id,article_id,participant_key,source_id,kind,observed_at,qualified_fact_id,material_revision,source_date_version::text,publication_revision,source_since
    FROM story_signals WHERE story_id=ANY(${storyIds}::bigint[]) AND qualified_at IS NOT NULL AND observed_at<=${at}
      ${from ? sql`AND observed_at>${from}` : sql``}`;
  const ids = [...new Set(rows.map((row) => row.article_id))];
  const [bindings, sources, materials] = await Promise.all([
    publicParticipationBindings(ids),
    publicParticipationSources([...new Set(rows.map((row) => row.source_id))]),
    publicMaterialVersions(ids),
  ]);
  const byId = new Map(bindings.map((row) => [row.id, row])),
    bySource = new Map(sources.map((row) => [row.id, row])),
    byMaterial = new Map(materials.map((row) => [row.id, row]));
  return rows.flatMap((row) => {
    const source = bySource.get(row.source_id),
      publication = byId.get(row.article_id),
      material = byMaterial.get(row.article_id);
    if (source?.lane !== "news" || source.participation_mode !== (row.kind === "editorial" ? "editorial" : "hot_signal") || publication?.operator_withdrawn)
      return [];
    if (material?.revision !== row.material_revision || material.source_date_version !== row.source_date_version) return [];
    if (
      row.kind === "editorial" &&
      !(
        publication?.visibility === "public" &&
        publication.eligible &&
        publication.revision === row.publication_revision &&
        publication.source_id === row.source_id &&
        publication.fact_id === row.qualified_fact_id &&
        publication.story_id === row.story_id &&
        (!publication.selected || (!!publication.visible_after && publication.visible_after <= at))
      )
    )
      return [];
    const source_behind =
      source.enabled &&
      ["rss", "web_list", "json_list"].includes(source.kind) &&
      (!source.last_ok_at || source.last_ok_at.getTime() < at.getTime() - Math.max(source.interval_minutes * 3, 90) * 60000);
    return [{ ...row, source_behind }];
  });
}
/** Use one participant cohort across the entire plot, excluding sources added after its observation window began. */
export function comparableHeatSeries(hours: Date[], signals: QualifiedSignal[]) {
  if (!hours.length) return [];
  const since = hours[0]!.getTime() - 48 * 3600000;
  const late = new Set(signals.filter((row) => row.source_since.getTime() > since).map((row) => row.participant_key));
  const times = new Map<string, number[]>();
  for (const row of signals)
    if (!late.has(row.participant_key)) times.set(row.participant_key, [...(times.get(row.participant_key) ?? []), row.observed_at.getTime()]);
  const points = hours.map((hour) => {
    let heat = 0,
      participants = 0;
    for (const list of times.values()) {
      const valid = list.filter((time) => time <= hour.getTime() && time > hour.getTime() - 48 * 3600000);
      if (!valid.length) continue;
      heat += 0.5 ** ((hour.getTime() - Math.max(...valid)) / 3600000 / 24);
      participants++;
    }
    return { hour, heat: Math.round(heat * 100) / 10, participants };
  });
  return points.some((point) => point.heat > 0) ? points : [];
}
export async function publicHeatSeriesMany(storyIds: number[], now = new Date(), days = 7) {
  if (!storyIds.length) return new Map<number, ReturnType<typeof comparableHeatSeries>>();
  const rows = await sql<
    { story_id: number; hour: Date }[]
  >`SELECT story_id,hour FROM story_heat_hourly WHERE story_id=ANY(${storyIds}::bigint[]) AND complete AND hour>${new Date(now.getTime() - days * 86400000)} AND hour<=${now} ORDER BY hour`;
  const from = rows[0]?.hour;
  const signals = from ? await publicParticipation(storyIds, now, new Date(from.getTime() - 48 * 3600000)) : [];
  return new Map(
    storyIds.map((id) => [
      id,
      comparableHeatSeries(
        rows.filter((row) => row.story_id === id).map((row) => row.hour),
        signals.filter((row) => row.story_id === id),
      ),
    ]),
  );
}
export async function publicHeatSeries(storyId: number, now = new Date(), days = 7) {
  return (await publicHeatSeriesMany([storyId], now, days)).get(storyId) ?? [];
}
