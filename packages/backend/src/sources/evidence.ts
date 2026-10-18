import { sourceTargetFetchEvidence } from "../acquisition/target-evidence.ts";
import { sourceTargetMaterialEvidence } from "../content/target-evidence.ts";
import { sourceTargetPublicationEvidence } from "../publication/target-evidence.ts";
import { sourceTargetOriginalEvidence } from "../policy/target-evidence.ts";

/** Bounded operational evidence; each owning component reads its own records. */
export function readSourceTargetEvidence(ids: string[]) {
  if (ids.length > 5000) throw new Error("Source evidence exceeds the bounded operational query");
  return Promise.all([
    sourceTargetFetchEvidence(ids),
    sourceTargetMaterialEvidence(ids),
    sourceTargetPublicationEvidence(ids),
    sourceTargetOriginalEvidence(ids),
  ]);
}
