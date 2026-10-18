import { promptVersion } from "@amp/backend/editorial/prompts";
import { sha256, stableJson } from "@amp/backend/lib/ids";
import { EXTRACTION_RECIPE } from "./extraction.ts";
import { POLICY_PLAN_LIMITS } from "./processing-plan.ts";
import { policyVisionRecipe } from "./vision-runtime.ts";
/** The exact processing inputs watched by the bounded worker sweep; acquisition revisions stay immutable. */
export function currentPolicyProcessingRecipe() {
  return sha256(
    stableJson([
      EXTRACTION_RECIPE,
      POLICY_PLAN_LIMITS,
      "prose-fragments-1",
      "exclusion-verification-2",
      "publication-projection-2",
      policyVisionRecipe(),
      ...["policy-fulltext", "policy-group-check", "policy-group-merge", "policy-interpret", "policy-verify"].map((name) => [name, promptVersion(name)]),
    ]),
  );
}
