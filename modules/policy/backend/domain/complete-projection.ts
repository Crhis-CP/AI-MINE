import { POLICY_THEME_LABELS } from "../reader-copy.ts";
import { Policy } from "@amp/contracts/http/public";
import type { FulltextRun } from "./fulltext-store.ts";
import type { Candidate } from "./interpretation-schema.ts";
import { natureLabels, policyBackfill } from "../publication/policies-project.ts";

// The product's own theme names (docs/01-product/10-policy-service.md §2.3), shared with the read layer and the pages.
const themeLabels = POLICY_THEME_LABELS;
function refs(value: unknown, map: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => refs(v, map));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      k === "evidence_ids"
        ? (v as string[]).map((id) => {
            if (!map[id]) throw new Error("Unmapped policy evidence");
            return map[id];
          })
        : refs(v, map),
    ]),
  );
}
export function completePolicy(
  basic: Policy,
  candidate: Candidate,
  run: FulltextRun,
  evidenceIds: Record<string, string>,
  annotationIds: Record<string, string> = {},
  discoveredAt: string | null = null,
) {
  const c = refs(candidate, evidenceIds) as Candidate,
    force = { whole: "yes", partial: "partial", not_in_force: "no", unknown: "unknown" } as const;
  const result = {
    ...basic,
    title: c.title_zh.length <= 250 ? c.title_zh : basic.title,
    nature: { code: c.legal_state.nature.value, label: natureLabels[c.legal_state.nature.value] },
    themes: [...new Set(c.impacts.map((i) => i.theme))].map((code) => ({ code, label: themeLabels[code] })),
    legal_state: c.legal_state,
    legal_brief: { stage: c.legal_state.legislative_stage.value, in_force: force[c.legal_state.enforcement.value], repeal: c.legal_state.repeal.value },
    interpretation_state: "complete",
    summary: c.dynamic_zh.length <= 300 ? c.dynamic_zh : null,
    guide: c.dynamic_zh,
    main_points: c.main_points,
    impacts: c.impacts,
    relationships: c.relationships.map((r) => ({ ...r, target_policy_id: null })),
    gaps: c.gaps,
    evidence: candidate.evidence.map((e) => {
      const part = run.plan.parts.find((p) => p.partId === e.part_id)!;
      const annotation = e.annotation_id ? part.annotations?.find((a) => a.annotation_id === e.annotation_id) : null;
      return {
        ...(annotation
          ? {
              annotation_id: annotationIds[annotation.annotation_id],
              annotation_name: annotation.name,
              annotation_value: annotation.value,
              annotation_scope: annotation.scope,
            }
          : {}),
        evidence_id: evidenceIds[e.id],
        source: {
          source_id: run.snapshot.sourceId,
          publisher: basic.authority,
          title_original: basic.original_title,
          original_url: part.resourceUrl,
          insecure_transport: part.resourceUrl.startsWith("http:"),
          published_time: basic.published_time,
        },
        locator: annotation?.locator ?? part.nodePath,
        excerpt: e.quote,
        relation: "supports",
      };
    }),
    limitation: "AI辅助解读；原文、译文、条款依据与适用条件分别展示。",
  };
  const publication = c.legal_state.publication.time;
  if (publication?.meaning === "published" && publication.local_date && !publication.condition_text) {
    result.published_time = publication;
    result.sort_time = publication;
    result.sort_kind = "published";
  }
  const events = c.publication_events ?? [];
  if (events.length) result.dates = events.map((event) => event.time);
  else if (publication) result.dates = [{ ...publication, event_kind: "original_publication", occurrence: "occurred" }];
  const occurred = events.filter((event) => event.time.occurrence === "occurred" && event.time.local_date && !event.time.condition_text);
  const change = occurred
    .filter((event) => event.time.event_kind === "substantive_change")
    .sort((a, b) => b.time.local_date!.localeCompare(a.time.local_date!))[0];
  const firstPublication = occurred
    .filter((event) => event.time.event_kind === "original_publication" && event.time.meaning === "published")
    .sort((a, b) => a.time.local_date!.localeCompare(b.time.local_date!))[0];
  const withoutEvent = (event: NonNullable<Candidate["publication_events"]>[number]) => {
    const { event_kind: _kind, occurrence: _occurrence, ...time } = event.time;
    return time;
  };
  if (firstPublication) result.published_time = withoutEvent(firstPublication);
  if (change) {
    result.sort_time = withoutEvent(change);
    result.sort_kind = "substantive_change";
    result.change_kind = { code: "substantive_change", label: "实质变化" };
  } else if (firstPublication) {
    result.sort_time = withoutEvent(firstPublication);
    result.sort_kind = "published";
    result.change_kind = { code: "first_publication", label: "首次公布" };
  }
  if (discoveredAt) result.is_backfill = policyBackfill(result.sort_time, discoveredAt);
  return Policy.safeParse(result);
}
