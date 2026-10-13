import type { Policy, PolicyCard } from "@amp/contracts/http/public";
import { dbOf, type Db } from "../db.ts";
import { newShortId } from "../lib/ids.ts";
import { readPolicyFulltextRun, type FulltextRun } from "../policy/fulltext-store.ts";
import { readPolicyMetadataObservation } from "../policy/metadata.ts";
import type { Candidate, RelatedPolicy } from "../policy/interpretation-schema.ts";
import { explicitPolicyReference } from "../policy/references.ts";
import { policyCurrentPublicRecords, PolicyReadError } from "./policies.ts";
const sql = dbOf("publication");
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
type Edge = {
  source_edition_id: string;
  source_policy_id: string;
  target_edition_id: string;
  target_policy_id: string;
  target_original_key: string;
  relation: Candidate["relationships"][number]["relation"];
  target_citation: string;
  evidence_ids: string[];
};
async function graph() {
  const records = new Map((await policyCurrentPublicRecords()).map((r) => [r.card.id, r]));
  const stored = await sql<
    Edge[]
  >`SELECT source_edition_id,source_policy_id,target_edition_id,target_policy_id,target_original_key,relation,target_citation,evidence_ids FROM publication.policy_relations`;
  const edges = stored.filter((e) => {
    const source = records.get(e.source_policy_id),
      target = records.get(e.target_policy_id);
    return source?.card.interpretation_state === "complete" && source.editionId === e.source_edition_id && target?.originalKey === e.target_original_key;
  });
  const threads = await sql<
    { id: string; anchor_policy_id: string; created_at: Date }[]
  >`SELECT id,anchor_policy_id,created_at FROM publication.policy_threads ORDER BY created_at,id`;
  const neighbours = new Map<string, Set<string>>();
  for (const e of edges)
    for (const [a, b] of [
      [e.source_policy_id, e.target_policy_id],
      [e.target_policy_id, e.source_policy_id],
    ] as const) {
      const set = neighbours.get(a) ?? new Set<string>();
      set.add(b);
      neighbours.set(a, set);
    }
  const component = (id: string) => {
    const ids = new Set<string>();
    if (!neighbours.has(id)) return ids;
    const pending = [id];
    while (pending.length) {
      const p = pending.pop()!;
      if (ids.has(p)) continue;
      ids.add(p);
      for (const n of neighbours.get(p) ?? []) if (!ids.has(n)) pending.push(n);
    }
    return ids;
  };
  const thread = (id: string) => {
    const members = component(id);
    return threads.find((t) => members.has(t.anchor_policy_id))?.id ?? null;
  };
  return { records, stored, edges, threads, component, thread };
}
export async function decoratePolicyNavigation<T extends PolicyCard>(cards: T[]): Promise<T[]> {
  if (!cards.length) return cards;
  const current = await graph();
  for (const card of cards) card.thread_id = current.thread(card.id);
  return cards;
}
export async function decoratePolicyRelationships(detail: Policy, editionId: string) {
  const current = await graph(),
    record = current.records.get(detail.id);
  detail.thread_id = current.thread(detail.id);
  // An explicit historical edition does not borrow relationships from a newer original or interpretation.
  if (!record || record.editionId !== editionId || detail.interpretation_state !== "complete") {
    detail.thread_id = null;
    detail.relationships = [];
    return detail;
  }
  detail.relationships = detail.relationships.flatMap<Policy["relationships"][number]>((r) => {
    const matching = current.stored.filter((e) => e.source_policy_id === detail.id && e.relation === r.relation && e.target_citation === r.target_citation);
    const edge = current.edges.find((e) => e.source_edition_id === record.editionId && e.relation === r.relation && e.target_citation === r.target_citation);
    return edge ? [{ ...r, target_policy_id: edge.target_policy_id }] : matching.length ? [] : [{ ...r, target_policy_id: null }];
  });
  return detail;
}
export async function readPolicyThread(id: string) {
  const current = await graph(),
    anchor = current.threads.find((t) => t.id === id);
  if (!anchor || !current.records.has(anchor.anchor_policy_id)) throw new PolicyReadError(404, "policy_thread_not_found");
  const ids = current.component(anchor.anchor_policy_id);
  if (ids.size < 2) throw new PolicyReadError(404, "policy_thread_not_found");
  const policies = [...ids].map((p) => ({ ...current.records.get(p)!.card, thread_id: current.thread(p) }));
  policies.sort((a, b) => {
    const ad = a.sort_time?.local_date ?? a.published_time.local_date,
      bd = b.sort_time?.local_date ?? b.published_time.local_date;
    return ad && bd ? ad.localeCompare(bd) || a.id.localeCompare(b.id) : ad ? -1 : bd ? 1 : a.id.localeCompare(b.id);
  });
  const labels = { updates: "修订", corrects: "勘误", repeals: "废止", implements: "实施", related: "引用" };
  return {
    id,
    title: "政策脉络",
    summary: "仅按仍可核对的原文明示关系提供阅读导航；各文书的法律状态分别查看。",
    jurisdictions: [...new Map(policies.flatMap((p) => p.jurisdictions).map((j) => [j.code, j])).values()],
    policies,
    stages: policies.map((p) => ({
      stage_label: "文书记录",
      policy_id: p.id,
      event_id: null,
      time: p.sort_time ?? p.published_time,
      relation:
        [...new Set(current.edges.filter((e) => e.source_policy_id === p.id && ids.has(e.target_policy_id)).map((e) => labels[e.relation]))].join("、") ||
        "被原文明确引用",
    })),
  };
}
