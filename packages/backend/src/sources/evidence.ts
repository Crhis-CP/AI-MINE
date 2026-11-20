import { sourceTargetFetchEvidence } from "../acquisition/target-evidence.ts";
import { sourceTargetMaterialEvidence } from "../content/target-evidence.ts";
import { sourceTargetPublicationEvidence } from "../publication/target-evidence.ts";
import { serverModules, type SourceOriginalEvidence } from "../modules.ts";

/** Originals archived by installed modules (the policy line); empty when no module declares the hook. */
async function moduleOriginalEvidence(ids: string[]): Promise<SourceOriginalEvidence[]> {
  const reads = serverModules().flatMap((module) => (module.sourceEvidence ? [module.sourceEvidence(ids)] : []));
  return (await Promise.all(reads)).flat();
}

/** Bounded operational evidence; each owning component reads its own records. */
export function readSourceTargetEvidence(ids: string[]) {
  if (ids.length > 5000) throw new Error("Source evidence exceeds the bounded operational query");
  return Promise.all([sourceTargetFetchEvidence(ids), sourceTargetMaterialEvidence(ids), sourceTargetPublicationEvidence(ids), moduleOriginalEvidence(ids)]);
}
