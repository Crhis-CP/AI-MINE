import type { Candidate } from "./interpretation-schema.ts";
import { originalText } from "./interpretation-schema.ts";
import type { PolicyPart } from "./processing-plan.ts";
import type { Policy, PolicyReadingBlock } from "@amp/contracts/http/public";
import type { z } from "zod";

/** Rebind only to an actual paragraph of this revision; a repeated quote cannot repair an unknown locator. */
export function alignPolicyEvidence(candidate: Candidate, parts: PolicyPart[]) {
  const text = new Map(parts.map((part) => [part.partId, originalText(part)]));
  const linkedIds = new Set<string>();
  const evidence = candidate.evidence.map((e) => {
    if (e.quote.trim() && text.get(e.part_id)?.includes(e.quote)) {
      linkedIds.add(e.id);
      return e;
    }
    const matches = e.quote.trim() ? parts.filter((part) => text.get(part.partId)!.includes(e.quote)) : [];
    if (matches.length !== 1) return e;
    linkedIds.add(e.id);
    const { annotation_id: _annotation, ...quote } = e;
    return { ...quote, part_id: matches[0]!.partId };
  });
  const omitted: string[] = [];
  const keep = (path: string, refs: string[]) => {
    if (refs.length && refs.every((id) => linkedIds.has(id))) return true;
    omitted.push(path);
    return false;
  };
  const main_points = candidate.main_points.filter((point, i) => keep(`main_points.${i}`, point.evidence_ids));
  const impacts = candidate.impacts.filter((impact, i) => keep(`impacts.${i}`, impact.evidence_ids));
  return {
    candidate: { ...candidate, evidence, main_points, impacts },
    total: candidate.main_points.length + candidate.impacts.length,
    linked: main_points.length + impacts.length,
    omitted,
  };
}

/** Public reading facts only: unavailable permission is not proof that the source body was never acquired. */
export function auditPolicyLinkage(
  policy: Pick<Policy, "id" | "main_points" | "impacts" | "sections" | "reading">,
  blocks: z.infer<typeof PolicyReadingBlock>[],
) {
  const anchors = new Set(blocks.flatMap((block) => block.evidence_ids));
  const claims = [
    ...policy.main_points.map((point, i) => ({ path: `main_points.${i}`, ...point })),
    ...policy.impacts.map((impact, i) => ({ path: `impacts.${i}`, ...impact })),
  ];
  const unlinked = claims.filter((claim) => !claim.evidence_ids.length || claim.evidence_ids.some((id) => !anchors.has(id)));
  return {
    id: policy.id,
    total: claims.length,
    linked: claims.length - unlinked.length,
    ratio: claims.length ? (claims.length - unlinked.length) / claims.length : null,
    unlinked: unlinked.map((claim) => claim.path),
    empty: ["main_points", "impacts", "sections"].filter((key) => !policy[key as "main_points" | "impacts" | "sections"].length),
    public_reading_completeness: policy.reading?.completeness ?? "unknown",
    source_acquisition_kind: null,
    blocked_claims: null,
  };
}
