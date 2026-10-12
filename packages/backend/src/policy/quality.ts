import { PolicyModelQualificationKey, POLICY_MODEL_BINDING_VERSION } from "./model-evidence.ts";
import { z } from "zod";
import { dbOf, type Db } from "../db.ts";
import { newShortId } from "../lib/ids.ts";
import { recordPolicyQualityWindow } from "../publication/policies-publish.ts";
const sql = dbOf("policy");
const Release = z
  .strictObject({
    sourceIds: z.array(z.string().min(1)).min(1),
    languages: z.array(z.string().min(1)).min(1),
    fulltextRecipe: z.string().min(1),
    interpretationRecipe: z.string().min(1),
    models: z.array(PolicyModelQualificationKey).min(1),
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
    await tx`SELECT pg_advisory_xact_lock(hashtext('policy-quality-control'))`;
    await tx`INSERT INTO policy.quality_releases(id,source_ids,languages,fulltext_recipe,interpretation_recipe,models,reviewed_by,review_evidence,evaluation_hash,reviewed_at,valid_until)
   VALUES(${id},${r.sourceIds},${r.languages},${r.fulltextRecipe},${r.interpretationRecipe},${r.models},${r.reviewedBy},${r.reviewEvidence},${r.evaluationHash},${r.reviewedAt},${r.validUntil})`;
    await recordPolicyQualityWindow(id, r.validUntil, false, tx, POLICY_MODEL_BINDING_VERSION);
  });
  return id;
}
export async function revokePolicyQualityRelease(id: string) {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('policy-quality-control'))`;
    const [r] = await tx`UPDATE policy.quality_releases SET revoked=true WHERE id=${id} RETURNING valid_until`;
    if (r) await recordPolicyQualityWindow(id, new Date(r.valid_until).toISOString(), true, tx);
  });
}
export async function matchingPolicyQuality(
  input: { sourceId: string; language: string; fulltextRecipe: string; interpretationRecipe: string; models: string[] },
  db: Db = sql,
) {
  if (!input.models.length || input.models.some((model) => !PolicyModelQualificationKey.safeParse(model).success)) return null;
  await db`SELECT pg_advisory_xact_lock_shared(hashtext('policy-quality-control'))`;
  const [r] = await db<{ id: string; valid_until: Date }[]>`SELECT id,valid_until FROM policy.quality_releases
   WHERE NOT revoked AND reviewed_by='owner' AND valid_until>now() AND reviewed_at<=now()
   AND ${input.sourceId}=ANY(source_ids) AND ${input.language}=ANY(languages)
   AND fulltext_recipe=${input.fulltextRecipe} AND interpretation_recipe=${input.interpretationRecipe}
   AND models @> ${input.models}::text[] ORDER BY valid_until DESC,id LIMIT 1`;
  return r ?? null;
}

/** Bounded operational reminder input. It never renews a qualification or changes source permissions. */
export async function expiringPolicyQualityReleases(now = new Date(), horizonDays = 7, limit = 100) {
  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 90 || !Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error("Invalid quality reminder bounds");
  return sql<{ id: string; source_ids: string[]; languages: string[]; fulltext_recipe: string; interpretation_recipe: string; valid_until: Date }[]>`
    SELECT q.id,q.source_ids,q.languages,q.fulltext_recipe,q.interpretation_recipe,q.valid_until FROM policy.quality_releases q
    WHERE NOT q.revoked AND q.reviewed_by='owner' AND q.reviewed_at<=${now} AND q.valid_until>${now}
      AND q.valid_until<=${new Date(now.getTime() + horizonDays * 86400_000)}
      AND NOT EXISTS (SELECT 1 FROM policy.quality_releases newer WHERE NOT newer.revoked AND newer.reviewed_by='owner'
        AND newer.reviewed_at<=${now} AND newer.valid_until>q.valid_until AND newer.fulltext_recipe=q.fulltext_recipe
        AND newer.interpretation_recipe=q.interpretation_recipe AND newer.source_ids @> q.source_ids
        AND newer.languages @> q.languages AND newer.models @> q.models)
    ORDER BY q.valid_until,q.id LIMIT ${limit}`;
}
