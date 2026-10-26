import { z } from "zod";

const id = z.string().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const recipe = z.string().min(1).max(512);

/** Private worker binding. Parsing does not establish current material, permission or human-control state. */
export const ReportMaterialBinding = z.strictObject({
  articleId: id,
  sourceId: id,
  materialRevision: z.int().positive(),
  contentHash: hash,
  sourceDateVersion: z.int().nonnegative(),
  permissionVersion: z.int().positive(),
  manualStateHash: hash,
});
export type ReportMaterialBinding = z.infer<typeof ReportMaterialBinding>;

/** Completed model answers only: transport waiting/unknown is not a fabricated model decision. */
export const ReportIdentityDecision = z
  .strictObject({
    lane: z.literal("news"),
    article: ReportMaterialBinding,
    anchor: ReportMaterialBinding,
    recipe,
    inputFingerprint: hash,
    relation: z.enum(["same_report", "new_development", "different", "insufficient"]),
    evidence: z.strictObject({ articleQuote: z.string().trim().min(1).max(600), anchorQuote: z.string().trim().min(1).max(600) }).nullable(),
    reason: z.string().trim().min(1).max(1000),
    receiptId: z.int().positive(),
    attemptId: z.string().regex(/^[1-9]\d*$/, "Expected a positive decimal attempt identity"),
  })
  .refine((value) => value.article.articleId !== value.anchor.articleId, "A report cannot compare with itself")
  .refine((value) => value.relation !== "same_report" || value.evidence !== null, "A positive identity needs evidence from both reports");
export type ReportIdentityDecision = z.infer<typeof ReportIdentityDecision>;

/** Projection requests reference private evidence; they do not carry quotes, receipts or model reasons. */
export const ReportGroupProjection = z
  .strictObject({
    lane: z.literal("news"),
    groupId: z.uuid(),
    article: ReportMaterialBinding,
    anchor: ReportMaterialBinding,
    recipe,
    inputFingerprint: hash,
  })
  .refine((value) => value.article.articleId !== value.anchor.articleId, "A joining report must differ from the identity anchor");
export type ReportGroupProjection = z.infer<typeof ReportGroupProjection>;
export const ReportGroupProjectionChange = z
  .strictObject({ articleId: id, projection: ReportGroupProjection.nullable() })
  .refine(
    (value) => value.projection === null || value.articleId === value.projection.article.articleId,
    "Projection and target must identify the same report",
  );
export type ReportGroupProjectionChange = z.infer<typeof ReportGroupProjectionChange>;

/** Recall metadata only; timelineAt is not a claimed source occurrence time or a processing permit. */
export interface ReportGroupCandidate {
  articleId: string;
  sourceId: string;
  materialRevision: number;
  title: string;
  summary: string | null;
  timelineAt: Date;
  groupId: string | null;
  anchorArticleId: string | null;
}
/** Current internal projection; its anchor may be a self row, unlike a model comparison. */
export interface ReportGroupMember {
  groupId: string;
  article: ReportMaterialBinding;
  anchor: ReportMaterialBinding;
  recipe: string;
}

/** Publication owner: bounded, eligible public candidates; selection never grants or removes identity evidence. */
export type ReportGroupCandidateReader<Transaction> = (
  input: { excludeArticleId: string; since: Date; limit: number },
  transaction: Transaction,
) => Promise<ReportGroupCandidate[]>;
/** Events owner: read the exact completed decision for both bindings; callers still recheck their current state. */
export type ReportGroupDecisionReader<Transaction> = (
  input: Omit<ReportGroupProjection, "groupId">,
  transaction: Transaction,
) => Promise<ReportIdentityDecision | null>;
/** Publication owner: current members for an identity anchor, not an HTTP disclosure of these private bindings. */
export type ReportGroupMembersReader<Transaction> = (groupId: string, transaction: Transaction) => Promise<ReportGroupMember[]>;
/** Publication owner: null removes only the derived membership; a positive projection requires a matching same_report decision. */
export type ReportGroupProjector<Transaction> = (input: ReportGroupProjectionChange, transaction: Transaction) => Promise<boolean>;
