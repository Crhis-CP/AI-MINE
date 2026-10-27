import { originalPostAdmissionCondition } from "./items.ts";
import {
  HistoricalCandidateRequest,
  HistoricalBackgroundProjection,
  type HistoricalBackgroundReader,
  type HistoricalBackgroundProjector,
  type HistoricalAnchorExtractor,
} from "@amp/contracts/site";
import { StoryBackgroundReport, type StoryBackground } from "@amp/contracts/http/public";
import type { z } from "zod";
import { foldMention, mentionByFold } from "./mentions.ts";
import { publicMaterialVersions } from "../content/grouping.ts";
import { newsRelationMaterials } from "@amp/backend/content/materials";
import { publicProcessingAllowed, evaluateSourcePolicy, lockCurrentSourcePolicies } from "@amp/backend/admin/sources";
import { sql, type Db, type Tx } from "../db.ts";
import { fetchItemsByIds, publicTimeMetadata, type ItemRow } from "./items.ts";

const HistoricalMaterialBinding = HistoricalCandidateRequest.shape.query;
const HistoricalAnchor = HistoricalCandidateRequest.shape.anchors.element;
type Binding = z.infer<typeof HistoricalMaterialBinding>;
type Anchor = z.infer<typeof HistoricalAnchor>;
type Reference = z.infer<typeof HistoricalBackgroundProjection>["references"][number];
const fold = (text: string) => text.normalize("NFKC").toLowerCase().trim();
const name = "([\\p{Lu}\\p{N}][\\p{L}\\p{N}'’.-]*(?:[ \\t]+(?:(?:del|de|la|of)[ \\t]+)?[\\p{Lu}\\p{N}][\\p{L}\\p{N}'’.-]*){0,4})";
const patterns: Array<[Anchor["kind"], RegExp]> = [
  ["project", new RegExp(`(?<![\\p{L}\\p{N}])(?:[Pp]roject|[Pp]royecto|[Pp]rojet)\\s+[“"‘']?${name}`, "gu")],
  ["project", new RegExp(`(?<![\\p{L}\\p{N}])${name}(?:\\s+(?:[Pp]roject|[Pp]royecto)\\b|\\s*项目)`, "gu")],
  ["mine", new RegExp(`(?<![\\p{L}\\p{N}])(?:[Mm]ine|[Mm]ina|[Yy]acimiento)\\s+[“"‘']?${name}`, "gu")],
  ["mine", new RegExp(`(?<![\\p{L}\\p{N}])${name}(?:\\s+(?:[Mm]ine|[Mm]ina)\\b|\\s*(?:矿山|矿区))`, "gu")],
  ["document", /(?<![\p{L}\p{N}])(?:[Rr]esoluci[oó]n(?: General)?|[Dd]ecreto|[Ll]ey|[Rr]esolution|[Dd]ecree|[Ll]aw)\s+(?:[Nn][º°o.]?\s*)?(\d[\d./-]{1,30})/gu],
];
/** A typed phrase in the original is evidence; merely assigning a kind to a company name is not. */
export const extractHistoricalAnchors: HistoricalAnchorExtractor = (original) => {
  const result: Anchor[] = [];
  for (const [kind, pattern] of patterns)
    for (const match of original.matchAll(pattern)) {
      const quote = original.slice(Math.max(0, match.index - 80), match.index + match[0].length + 80).trim();
      const alias = kind !== "document" ? /^\s*[(（]([A-Z][A-Z0-9.-]{1,15})[)）]/.exec(original.slice(match.index + match[0].length))?.[1] : undefined;
      for (const text of [match[1]!.replace(/^The\s+/, ""), ...(alias ? [alias] : [])]) {
        if (/^(The|El|La)$/i.test(text) || mentionByFold(foldMention(text)) || /\b(?:Inc|Corp|Corporation|Ltd|PLC|Company)\b/i.test(text)) continue;
        const parsed = HistoricalAnchor.safeParse({ kind, text, quote });
        if (parsed.success && !result.some((a) => a.kind === kind && a.text === text)) result.push(parsed.data);
        if (result.length === 3) return result;
      }
    }
  return result;
};
const resource = (row: ItemRow) => ({ url: row.url, document_type: null, attachment: false });
async function current(ids: string[], db: Db) {
  const rows = await fetchItemsByIds(ids, db),
    versions = await publicMaterialVersions(ids, db);
  const held = new Set(
    (await db<{ article_id: string }[]>`SELECT article_id FROM publications WHERE article_id=ANY(${ids}::text[]) AND operator_withdrawn`).map(
      (r) => r.article_id,
    ),
  );
  const result = new Map<string, { row: ItemRow; binding: Binding }>();
  for (const m of versions) {
    const row = rows.get(m.id),
      version = (row?.source_policy as { permission_version?: number } | undefined)?.permission_version;
    if (
      row?.channel !== "news" ||
      row.visibility !== "public" ||
      !row.eligible ||
      row.source_mode !== "editorial" ||
      held.has(m.id) ||
      (row.selected && (!row.visible_after || row.visible_after.getTime() > Date.now()))
    )
      continue;
    if (!version || !(await publicProcessingAllowed(row.source_id, resource(row), Date.now(), db))) continue;
    if (
      (
        await evaluateSourcePolicy(
          { source_id: row.source_id, expected_permission_version: version, lane: "news", capability: "public_summary", resource: resource(row) },
          Date.now(),
          db,
        )
      ).decision !== "allow"
    )
      continue;
    if (typeof m.source_date_version !== "string" || !/^(0|[1-9]\d*)$/.test(m.source_date_version)) continue;
    const binding = HistoricalMaterialBinding.safeParse({
      articleId: m.id,
      materialRevision: m.revision,
      publicationRevision: row.revision,
      sourceDateVersion: Number(m.source_date_version),
    });
    if (binding.success && String(binding.data.sourceDateVersion) === m.source_date_version) result.set(m.id, { row, binding: binding.data });
  }
  return result;
}
const matches = (a: Binding, b: Binding | undefined) =>
  !!b &&
  a.articleId === b.articleId &&
  a.materialRevision === b.materialRevision &&
  a.publicationRevision === b.publicationRevision &&
  a.sourceDateVersion === b.sourceDateVersion;
async function originals(heads: Awaited<ReturnType<typeof current>>, db: Tx) {
  if (!heads.size) return [];
  const policies = new Map(
    [...heads.values()].map(({ row }) => [
      row.source_id,
      { sourceId: row.source_id, permissionVersion: (row.source_policy as { permission_version: number }).permission_version },
    ]),
  );
  await lockCurrentSourcePolicies(db, [...policies.values()]);
  return newsRelationMaterials([...heads.keys()], db);
}
function display(row: ItemRow, dates: Awaited<ReturnType<typeof publicTimeMetadata>>) {
  const date = dates.get(row.id)?.sourceTime;
  const sourceTime = date?.meaning === "published" ? date : null;
  return StoryBackgroundReport.parse({
    id: row.id,
    title: row.title,
    summary: row.summary,
    source: { name: row.source_name },
    selected: row.selected,
    publishedAt: sourceTime?.utc ?? null,
    sourceTime,
    originalUrl: row.url,
  });
}

export const readHistoricalBackgroundCandidates: HistoricalBackgroundReader = async (input) => {
  const request = HistoricalCandidateRequest.parse(input);
  return sql.begin("read only", async (db) => {
    const queryHead = await current([request.query.articleId], db),
      head = queryHead.get(request.query.articleId);
    if (!head || !matches(request.query, head.binding)) return [];
    const [original] = await originals(queryHead, db);
    if (!original || original.revision !== head.binding.materialRevision || original.source_date_version !== head.binding.sourceDateVersion) return [];
    const anchors = request.anchors.filter(
      (a) => original.original_text.includes(a.quote) && extractHistoricalAnchors(a.quote).some((v) => v.kind === a.kind && v.text === a.text),
    );
    if (anchors.length !== request.anchors.length) return [];
    const likes = anchors.map((a) => `%${a.text.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
    // shortcut: body search covers the existing permitted 12,000-character index; use full-text indexing only if this misses useful candidates.
    const ids = (
      await db<{ article_id: string }[]>`SELECT ps.article_id FROM pool_search ps JOIN publications p ON p.article_id=ps.article_id
      WHERE p.article_id<>${request.query.articleId} AND p.channel='news' AND p.visibility='public' AND ${originalPostAdmissionCondition()} AND p.eligible AND NOT p.operator_withdrawn
        AND (ps.direct LIKE ANY(${likes}::text[]) OR ps.body LIKE ANY(${likes}::text[]))
      ORDER BY (ps.direct LIKE ANY(${likes}::text[])) DESC,p.timeline_at DESC,p.article_id LIMIT ${request.limit * 3}`
    ).map((r) => r.article_id);
    const heads = await current(ids, db),
      materials = await originals(heads, db),
      dates = await publicTimeMetadata([...heads.keys()], db);
    const candidates = [];
    for (const m of materials) {
      const h = heads.get(m.id)!;
      if (m.revision !== h.binding.materialRevision || m.source_date_version !== h.binding.sourceDateVersion) continue;
      const found = extractHistoricalAnchors(m.original_text).filter((a) => anchors.some((q) => q.kind === a.kind && fold(q.text) === fold(a.text)));
      if (found.length) candidates.push({ binding: h.binding, item: display(h.row, dates), anchors: found });
    }
    const latest = await current([request.query.articleId, ...candidates.map((c) => c.binding.articleId)], db);
    if (!matches(request.query, latest.get(request.query.articleId)?.binding)) return [];
    return candidates.filter((c) => matches(c.binding, latest.get(c.binding.articleId)?.binding)).slice(0, request.limit);
  });
};

export const replaceHistoricalBackgroundProjection: HistoricalBackgroundProjector<Db> = async (input, db) => {
  const value = HistoricalBackgroundProjection.parse(input);
  await db`SELECT pg_advisory_xact_lock(hashtext(${`historical-background:${value.storyPublicId}`}))`;
  const heads = await current([...new Set(value.references.flatMap((r) => [r.query.articleId, r.candidate.articleId]))], db);
  const unique = new Map<string, Reference>();
  for (const ref of value.references) {
    const query = heads.get(ref.query.articleId);
    if (!matches(ref.query, query?.binding) || !matches(ref.candidate, heads.get(ref.candidate.articleId)?.binding)) continue;
    if (query!.row.story_public_id !== value.storyPublicId) throw new Error("Historical background query belongs to another story");
    const key = `${ref.query.articleId}:${ref.candidate.articleId}`;
    if (unique.has(key) && unique.get(key)!.relation !== ref.relation) throw new Error("Conflicting historical relations");
    unique.set(key, ref);
  }
  await db`DELETE FROM publication.story_background_refs WHERE lane='news' AND story_public_id=${value.storyPublicId}`;
  for (const r of unique.values())
    await db`INSERT INTO publication.story_background_refs(lane,story_public_id,query_article_id,query_material_revision,query_publication_revision,query_source_date_version,candidate_article_id,candidate_material_revision,candidate_publication_revision,candidate_source_date_version,relation)
    VALUES('news',${value.storyPublicId},${r.query.articleId},${r.query.materialRevision},${r.query.publicationRevision},${r.query.sourceDateVersion},${r.candidate.articleId},${r.candidate.materialRevision},${r.candidate.publicationRevision},${r.candidate.sourceDateVersion},${r.relation})`;
};

export async function readHistoricalBackground(storyPublicId: string, db: Db = sql): Promise<z.infer<typeof StoryBackground>[]> {
  if (db === sql) return sql.begin("isolation level repeatable read read only", (tx) => readHistoricalBackground(storyPublicId, tx));
  // shortcut: check 30 safe references and show 10 items; add pagination if longer stories need broader coverage.
  const refs = await db<
    {
      query_article_id: string;
      query_material_revision: number;
      query_publication_revision: number;
      query_source_date_version: number;
      candidate_article_id: string;
      candidate_material_revision: number;
      candidate_publication_revision: number;
      candidate_source_date_version: number;
      relation: Reference["relation"];
    }[]
  >`SELECT query_article_id,query_material_revision,query_publication_revision,query_source_date_version,candidate_article_id,candidate_material_revision,candidate_publication_revision,candidate_source_date_version,relation FROM publication.story_background_refs WHERE lane='news' AND story_public_id=${storyPublicId} ORDER BY query_article_id,candidate_article_id LIMIT 30`;
  const heads = await current([...new Set(refs.flatMap((r) => [r.query_article_id, r.candidate_article_id]))], db),
    result = new Map<string, z.infer<typeof StoryBackground>>(),
    dates = await publicTimeMetadata([...heads.keys()], db);
  for (const r of refs) {
    const q = heads.get(r.query_article_id),
      c = heads.get(r.candidate_article_id);
    if (!q || !c || q.row.story_public_id !== storyPublicId || result.get(c.row.id)?.relation === "SAME_OCCURRENCE") continue;
    if (
      !matches(
        {
          articleId: r.query_article_id,
          materialRevision: r.query_material_revision,
          publicationRevision: r.query_publication_revision,
          sourceDateVersion: r.query_source_date_version,
        },
        q.binding,
      ) ||
      !matches(
        {
          articleId: r.candidate_article_id,
          materialRevision: r.candidate_material_revision,
          publicationRevision: r.candidate_publication_revision,
          sourceDateVersion: r.candidate_source_date_version,
        },
        c.binding,
      )
    )
      continue;
    result.set(c.row.id, { relation: r.relation, item: display(c.row, dates) });
  }
  return [...result.values()]
    .sort((a, b) => (b.item.sourceTime?.local_date ?? "").localeCompare(a.item.sourceTime?.local_date ?? "") || a.item.id.localeCompare(b.item.id))
    .slice(0, 10);
}
