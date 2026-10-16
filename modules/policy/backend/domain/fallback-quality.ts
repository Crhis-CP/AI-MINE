import { sql, type Db } from "@amp/backend/db";
import { promptVersion } from "@amp/backend/editorial/prompts";
import { sha256, stableJson } from "@amp/backend/lib/ids";
import { POLICY_MODEL_BINDING_VERSION } from "./model-evidence.ts";

export type PolicyFallbackContext = { language: string; fulltextRecipe: string; interpretationRecipe: string };
export const currentInterpretationRecipe = () =>
  sha256(
    stableJson(["policy-interpretation-1", ...["policy-group-check", "policy-group-merge", "policy-interpret", "policy-verify"].map((n) => promptVersion(n))]),
  );
export const currentInterpretationQualification = () => `${currentInterpretationRecipe()}/explicit-reference-2/${POLICY_MODEL_BINDING_VERSION}`;
/** Read the same existing Owner release. No fallback-specific quality bypass or automatic grant. */
export async function policyFallbackQuality(modelKey: string, context?: PolicyFallbackContext, sourceIds: readonly string[] = [], db: Db = sql) {
  const { policyVisionRecipe } = await import("./vision-runtime.ts");
  const currentText = `${promptVersion("policy-fulltext")}/candidate-v1`,
    currentVision = `${currentText}/vision:${policyVisionRecipe()}`;
  if (context && (context.interpretationRecipe !== currentInterpretationQualification() || ![currentText, currentVision].includes(context.fulltextRecipe)))
    return null;
  const rows = await db<
    { id: string; source_ids: string[]; languages: string[]; fulltext_recipe: string; interpretation_recipe: string }[]
  >`SELECT id,source_ids,languages,fulltext_recipe,interpretation_recipe FROM policy.quality_releases
 WHERE NOT revoked AND reviewed_by='owner' AND reviewed_at<=now() AND valid_until>now() AND ${modelKey}=ANY(models)
 AND interpretation_recipe=${currentInterpretationQualification()} ORDER BY valid_until DESC,id`;
  return (
    rows.find(
      (r) =>
        [currentText, currentVision].includes(r.fulltext_recipe) &&
        sourceIds.every((s) => r.source_ids.includes(s)) &&
        (!context || (r.fulltext_recipe === context.fulltextRecipe && r.languages.includes(context.language))),
    ) ?? null
  );
}
