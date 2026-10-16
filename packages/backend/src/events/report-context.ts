import { confirmedGroupingMaterials } from "../content/grouping.ts";
import { sql } from "../db.ts";
import { participantIdentity, sourceParticipants } from "../sources/participants.ts";
import { newsMaterialBindings } from "../content/materials.ts";
import { reportPublicInputs, heldReportSignals } from "../publication/groups.ts";
import { reportSignalExclusions } from "../editorial/report-exclusions.ts";

/** Current graph evidence, qualified by the source, content, editorial and publication owners. */
export async function reportEventEvidence(storyIds: number[], articleIds: string[], end: Date, from?: Date) {
  if (!storyIds.length && !articleIds.length) return { signals: [], mentions: [] };
  const rows = await sql<
    {
      article_id: string;
      story_id: number;
      story_public_id: string;
      fact_id: number | null;
      fact_public_id: string | null;
      source_id: string;
      observed_at: Date;
      manual: boolean | null;
      input_revision: number | null;
    }[]
  >`
    SELECT ss.article_id,ss.story_id,st.public_id::text AS story_public_id,f.id AS fact_id,f.public_id AS fact_public_id,ss.source_id,ss.observed_at,fa.manual,fa.input_revision
    FROM story_signals ss LEFT JOIN fact_articles fa ON fa.article_id=ss.article_id AND fa.role<>'mention' LEFT JOIN facts f ON f.id=fa.fact_id AND f.story_id=ss.story_id
    JOIN stories st ON st.id=ss.story_id AND st.merged_into IS NULL
    WHERE (ss.story_id=ANY(${storyIds}::bigint[]) OR ss.article_id=ANY(${articleIds}::text[])) AND ss.observed_at<${end} ${from ? sql`AND ss.observed_at>${from}` : sql``}
      AND NOT EXISTS(SELECT 1 FROM grouping_overrides o WHERE o.article_id=ss.article_id AND o.mode='standalone')`;
  const ids = [...new Set(rows.map((row) => row.article_id))];
  const [sourceRows, materials, publications, excluded, held, confirmations] = await Promise.all([
    sourceParticipants([...new Set(rows.map((row) => row.source_id))]),
    newsMaterialBindings(ids),
    reportPublicInputs(ids),
    reportSignalExclusions(ids),
    heldReportSignals(rows),
    confirmedGroupingMaterials(ids),
  ]);
  const sources = new Map(sourceRows.map((row) => [row.id, row])),
    current = new Map(materials.map((row) => [row.id, row])),
    published = new Map(publications.map((row) => [row.id, row]));
  const confirmed = new Set(confirmations.map((row) => row.id));
  const signals = rows.flatMap((row) => {
    const source = sources.get(row.source_id),
      material = current.get(row.article_id),
      publication = published.get(row.article_id);
    if (
      source?.lane !== "news" ||
      source.participation_mode === "isolated" ||
      !material ||
      material.source_id !== row.source_id ||
      (!row.manual && (!confirmed.has(row.article_id) || (source.participation_mode === "editorial" && row.input_revision !== material.revision))) ||
      excluded.has(row.article_id) ||
      held.has(row.article_id)
    )
      return [];
    if (
      source.participation_mode === "editorial" &&
      (row.fact_id === null ||
        !publication ||
        publication.fact_id !== row.fact_id ||
        publication.timeline_at >= end ||
        (publication.selected && (!publication.visible_after || publication.visible_after >= end)))
    )
      return [];
    return [
      {
        ...row,
        kind: source.participation_mode === "editorial" ? ("editorial" as const) : ("signal" as const),
        participant_key: participantIdentity(source),
        source_name: source.name,
        source_tier: source.tier,
        source_since: source.created_at,
        publication_revision: publication?.revision ?? null,
        material_revision: material.revision,
        source_date_version: String(material.source_date_version),
      },
    ];
  });
  const named = articleIds.length
    ? await sql<{ article_id: string; story_id: number; manual: boolean; input_revision: number | null }[]>`
    SELECT DISTINCT fa.article_id,f.story_id,fa.manual,fa.input_revision FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id
    WHERE fa.article_id=ANY(${articleIds}::text[]) AND fa.role='mention' AND f.story_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM grouping_overrides o WHERE o.article_id=fa.article_id AND o.mode='standalone')`
    : [];
  const loose = new Map((await newsMaterialBindings([...new Set(named.map((row) => row.article_id))])).map((row) => [row.id, row]));
  const mentions = named.filter((row) => row.manual || row.input_revision === loose.get(row.article_id)?.revision);
  return { signals, mentions };
}

/** Current owned fact members for report/heat representatives; a mention never becomes its own report. */
export async function currentFactMembers(factIds: number[]) {
  if (!factIds.length) return [];
  const rows = await sql<{ article_id: string; fact_id: number; manual: boolean; input_revision: number | null }[]>`
    SELECT fa.article_id,fa.fact_id,fa.manual,fa.input_revision FROM fact_articles fa
    WHERE fa.fact_id=ANY(${factIds}::bigint[]) AND fa.role IN ('primary','report')
      AND NOT EXISTS(SELECT 1 FROM grouping_overrides o WHERE o.article_id=fa.article_id AND o.mode='standalone')`;
  const ids = [...new Set(rows.map((row) => row.article_id))];
  const [materials, confirmed] = await Promise.all([newsMaterialBindings(ids), confirmedGroupingMaterials(ids)]);
  const revisions = new Map(materials.map((row) => [row.id, row.revision])),
    ready = new Set(confirmed.map((row) => row.id));
  return rows.filter((row) => row.manual || (ready.has(row.article_id) && row.input_revision === revisions.get(row.article_id)));
}
