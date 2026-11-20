import { readPolicyFulltextRun, type FulltextRun } from "./fulltext-store.ts";
import { readPolicyMetadataObservation } from "../core/metadata.ts";
import type { Candidate, RelatedPolicy } from "./interpretation-schema.ts";
import { explicitPolicyReference } from "./references.ts";
import type { Db } from "@amp/backend/db";
import { newShortId } from "@amp/backend/lib/ids";
import { policyCurrentPublicRecords } from "../read.ts";

type PublicRecord = Awaited<ReturnType<typeof policyCurrentPublicRecords>>[number];
type Target = PublicRecord & { citation: string; url: string; jurisdiction: string };
async function targets(run: FulltextRun) {
  const jurisdiction = run.snapshot.manifest.identity.jurisdiction,
    rows: Target[] = [];
  for (const row of await policyCurrentPublicRecords()) {
    if (row.expressionId === run.plan.context.expressionId || !row.card.instrument_number || !row.card.jurisdictions.some((j) => j.code === jurisdiction))
      continue;
    if (!run.plan.parts.some((p) => explicitPolicyReference(p, row.card.instrument_number!, row.card.original_url))) continue;
    const meta = await readPolicyMetadataObservation(row.expressionId);
    if (meta?.jurisdiction !== jurisdiction || meta.documentNumber !== row.card.instrument_number || meta.officialUrl !== row.card.original_url) continue;
    rows.push({ ...row, citation: meta.documentNumber, url: meta.officialUrl, jurisdiction });
  }
  // Even an apparently unique database number is not proof: an explicit official URI was required above.
  return rows
    .filter((row) => rows.filter((other) => other.citation === row.citation || other.url === row.url).length === 1)
    .sort((a, b) => a.card.id.localeCompare(b.card.id));
}
export async function policyRelationshipCandidates(fulltextRunId: string): Promise<RelatedPolicy[]> {
  const loaded = await readPolicyFulltextRun(fulltextRunId);
  if (!loaded) return [];
  return (await targets(loaded.run))
    .slice(0, 5)
    .map((t) => ({ id: t.card.id, citation: t.citation, url: t.url, jurisdiction: t.jurisdiction, qualified: true }));
}
type Link = { target: Target; relation: Candidate["relationships"][number] };
export async function preparePolicyRelationships(run: FulltextRun, candidate: Candidate): Promise<Link[]> {
  const possible = await targets(run),
    result: Link[] = [];
  for (const relation of candidate.relationships) {
    const evidence = candidate.evidence.filter((e) => relation.evidence_ids.includes(e.id));
    const matching = possible.filter(
      (t) =>
        relation.target_citation === t.citation &&
        (!relation.target_policy_id || relation.target_policy_id === t.card.id) &&
        evidence.some((e) => {
          const part = run.plan.parts.find((p) => p.partId === e.part_id);
          return !!part && explicitPolicyReference(part, t.citation, t.url, e.quote);
        }),
    );
    if (matching.length === 1 && new Set(result.map((r) => r.target.card.id)).size < 5) result.push({ target: matching[0]!, relation });
  }
  return result;
}
/** Called only by the trusted publisher after its current complete projection passed all qualification checks. */
export async function savePolicyRelationships(db: Db, sourceId: string, editionId: string, links: Link[], evidenceIds: Record<string, string>) {
  for (const { target, relation } of links) {
    if (target.card.id === sourceId) continue;
    await db`INSERT INTO publication.policy_relations(source_edition_id,source_policy_id,target_edition_id,target_policy_id,target_original_key,relation,target_citation,evidence_ids)
      VALUES(${editionId},${sourceId},${target.editionId},${target.card.id},${target.originalKey},${relation.relation},${relation.target_citation},${relation.evidence_ids.map((id) => evidenceIds[id]!)}) ON CONFLICT DO NOTHING`;
    for (const policyId of [sourceId, target.card.id])
      await db`INSERT INTO publication.policy_threads(id,anchor_policy_id) VALUES(${`plt_${newShortId(12)}`},${policyId}) ON CONFLICT(anchor_policy_id) DO NOTHING`;
  }
}
