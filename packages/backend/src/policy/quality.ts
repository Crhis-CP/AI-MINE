import { z } from "zod";
import { dbOf, type Db } from "../db.ts";
import { newShortId } from "../lib/ids.ts";
import { recordPolicyQualityWindow } from "@amp/backend/publication/policies-publish";
const sql = dbOf("policy");
const Release = z
  .strictObject({
    sourceIds: z.array(z.string().min(1)).min(1),
    languages: z.array(z.string().min(1)).min(1),
    fulltextRecipe: z.string().min(1),
    interpretationRecipe: z.string().min(1),
    models: z.array(z.string().min(1)).min(1),
    reviewedBy: z.literal("owner"),
    reviewEvidence: z.string().min(1),
    evaluationHash: z.string().regex(/^[a-f0-9]{64}$/),
    reviewedAt: z.iso.datetime(),
    validUntil: z.iso.datetime(),
  })
  .refine((r) => Date.parse(r.validUntil) > Date.parse(r.reviewedAt));
/** Protected setup-role port, no HTTP route or automatic installation. Requires actual Owner review evidence. */
export async function installPolicyQualityRelease(input: unknown) {
  const r = Release.parse(input),
    id = `pqr_${newShortId()}`;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO policy.quality_releases(id,source_ids,languages,fulltext_recipe,interpretation_recipe,models,reviewed_by,review_evidence,evaluation_hash,reviewed_at,valid_until)
   VALUES(${id},${r.sourceIds},${r.languages},${r.fulltextRecipe},${r.interpretationRecipe},${r.models},${r.reviewedBy},${r.reviewEvidence},${r.evaluationHash},${r.reviewedAt},${r.validUntil})`;
    await recordPolicyQualityWindow(id, r.validUntil, false, tx);
  });
  return id;
}
export async function revokePolicyQualityRelease(id: string) {
  await sql.begin(async (tx) => {
    const [r] = await tx`UPDATE policy.quality_releases SET revoked=true WHERE id=${id} RETURNING valid_until`;
    if (r) await recordPolicyQualityWindow(id, new Date(r.valid_until).toISOString(), true, tx);
  });
}
export async function matchingPolicyQuality(
  input: { sourceId: string; language: string; fulltextRecipe: string; interpretationRecipe: string; models: string[] },
  db: Db = sql,
) {
  if (!input.models.length) return null;
  const [r] = await db<{ id: string; valid_until: Date }[]>`SELECT id,valid_until FROM policy.quality_releases
   WHERE NOT revoked AND reviewed_by='owner' AND valid_until>now() AND reviewed_at<=now()
   AND ${input.sourceId}=ANY(source_ids) AND ${input.language}=ANY(languages)
   AND fulltext_recipe=${input.fulltextRecipe} AND interpretation_recipe=${input.interpretationRecipe}
   AND models @> ${input.models}::text[] ORDER BY valid_until DESC,id LIMIT 1 FOR SHARE`;
  return r ?? null;
}
