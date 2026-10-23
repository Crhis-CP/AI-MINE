import { HistoricalCandidateRequest, HistoricalBackgroundConfirmation, type HistoricalBackgroundReference } from "@amp/contracts/site";
import { newsMaterialBindings, newsRelationMaterials } from "@amp/backend/content/materials";
import { readGroupingEvidencePublications, replaceHistoricalBackgroundProjection } from "@amp/backend/publication/publish";
import { sql, type Db, type Tx } from "../db.ts";
import { lockNewsProcessingPermissions } from "../providers/news-fallback.ts";
import { stableJson } from "../lib/ids.ts";

async function currentBindings(ids: string[], db: Db) {
  const [materials, publications, held, members] = await Promise.all([
    newsMaterialBindings(ids, db),
    readGroupingEvidencePublications(ids, db),
    db<{ article_id: string }[]>`SELECT article_id FROM grouping_overrides WHERE article_id=ANY(${ids}::text[])
      UNION SELECT article_id FROM fact_articles WHERE article_id=ANY(${ids}::text[]) AND manual
      UNION SELECT article_id FROM regroup_pending WHERE article_id=ANY(${ids}::text[])`,
    db<
      { article_id: string; public_id: string; input_revision: number; version: number }[]
    >`SELECT fa.article_id,st.public_id::text,fa.input_revision,st.version
      FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id JOIN stories st ON st.id=f.story_id AND st.merged_into IS NULL
      WHERE fa.article_id=ANY(${ids}::text[]) AND fa.role IN ('primary','report') AND NOT fa.manual ORDER BY fa.article_id,fa.fact_id`,
  ]);
  return ids.map((id) => {
    const material = materials.find((r) => r.id === id),
      publication = publications.find((r) => r.article_id === id);
    return {
      id,
      binding:
        material && publication && !publication.withdrawn && !held.some((r) => r.article_id === id)
          ? HistoricalCandidateRequest.shape.query.parse({
              articleId: id,
              materialRevision: material.revision,
              publicationRevision: publication.revision,
              sourceDateVersion: material.source_date_version,
            })
          : null,
      memberships: members.filter((r) => r.article_id === id && r.input_revision === material?.revision),
    };
  });
}
export class HistoricalBackgroundSuperseded extends Error {}
export async function historicalSnapshot(ids: string[], db: Db = sql) {
  const read = async (tx: Tx) => {
    await lockNewsProcessingPermissions(ids, tx);
    const [bindings, originals] = await Promise.all([currentBindings(ids, tx), newsRelationMaterials(ids, tx)]);
    return bindings.map((row) => {
      const original = originals.find((r) => r.id === row.id);
      if (!row.binding || !original) throw new HistoricalBackgroundSuperseded("历史背景材料、公开状态或人工归属已变化");
      return { binding: row.binding, memberships: row.memberships, original };
    });
  };
  return db === sql ? sql.begin(read) : read(db as Tx);
}
async function currentReferences(input: { lane: "news"; storyPublicId: string }, db: Db) {
  if (input.lane !== "news") throw new Error("Historical background is news-only");
  const rows = await db<
    { id: string; proof: unknown }[]
  >`SELECT id,proof FROM events.story_background_proofs WHERE active AND story_public_id=${input.storyPublicId} ORDER BY created_at DESC,id LIMIT 30`;
  const proofs = rows.map((row) => ({ id: row.id, proof: HistoricalBackgroundConfirmation.parse(row.proof) }));
  const current = await currentBindings([...new Set(proofs.flatMap(({ proof }) => [proof.query.articleId, proof.candidate.articleId]))], db);
  const stale: string[] = [],
    references: HistoricalBackgroundReference[] = [];
  for (const { id, proof } of proofs) {
    const query = current.find((r) => r.id === proof.query.articleId),
      candidate = current.find((r) => r.id === proof.candidate.articleId);
    if (
      stableJson(query?.binding) !== stableJson(proof.query) ||
      stableJson(candidate?.binding) !== stableJson(proof.candidate) ||
      !query?.memberships.some((m) => m.public_id === input.storyPublicId)
    ) {
      stale.push(id);
      continue;
    }
    references.push({ ...input, query: proof.query, candidate: proof.candidate, relation: proof.relation });
  }
  return { references, stale };
}
export async function readHistoricalBackgroundReferences(input: { lane: "news"; storyPublicId: string }, db: Db = sql) {
  return (await currentReferences(input, db)).references;
}
/** Stale proofs remain private history, but cannot obstruct a new valid projection. */
export async function projectHistoricalBackgrounds(storyPublicId: string, db: Db) {
  const { references, stale } = await currentReferences({ lane: "news", storyPublicId }, db);
  if (stale.length) await db`UPDATE events.story_background_proofs SET active=false WHERE id=ANY(${stale}::text[])`;
  await replaceHistoricalBackgroundProjection({ lane: "news", storyPublicId, references }, db);
}
/** Human actions revoke either side before their editorial transaction returns. */
export async function invalidateHistoricalBackgrounds(articleIds: string[], db: Db, storyPublicIds: string[] = []) {
  const rows = await db<{ story_public_id: string }[]>`UPDATE events.story_background_proofs SET active=false WHERE active
    AND (query_id=ANY(${articleIds}::text[]) OR candidate_id=ANY(${articleIds}::text[]) OR story_public_id=ANY(${storyPublicIds}::uuid[])) RETURNING story_public_id`;
  for (const id of new Set([...storyPublicIds, ...rows.map((row) => row.story_public_id)])) await projectHistoricalBackgrounds(id, db);
  return rows.length;
}
