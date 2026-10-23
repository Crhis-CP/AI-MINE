import { z } from "zod";
import { StoryBackgroundReport } from "./http/public.ts";
import { SourceDateTask } from "./time-assertion.ts";

/** Worker-side declarations only; parsing grants neither publication nor model-processing permission. */
export const HistoricalMaterialBinding = z.strictObject({
  articleId: z.string().min(1),
  materialRevision: z.number().int().positive(),
  publicationRevision: z.number().int().positive(),
  sourceDateVersion: SourceDateTask.shape.expectedSourceDateVersion,
});
export const HistoricalAnchor = z
  .strictObject({
    kind: z.enum(["project", "mine", "document"]),
    text: z.string().trim().min(2).max(160),
    quote: z.string().trim().min(12).max(600),
  })
  .refine((value) => value.quote.includes(value.text), "Anchor must occur verbatim in its quote");
export type HistoricalAnchorExtractor = (text: string) => z.infer<typeof HistoricalAnchor>[];
export const HistoricalCandidateRequest = z.strictObject({
  lane: z.literal("news"),
  query: HistoricalMaterialBinding,
  anchors: z.array(HistoricalAnchor).min(1).max(3),
  limit: z.number().int().min(1).max(10),
});
export const HistoricalBackgroundCandidate = z
  .strictObject({
    binding: HistoricalMaterialBinding,
    item: StoryBackgroundReport,
    anchors: z.array(HistoricalAnchor).min(1).max(3),
  })
  .refine((value) => value.binding.articleId === value.item.id, "Candidate display and material must identify the same article");
export const HistoricalBackgroundConfirmation = z
  .strictObject({
    lane: z.literal("news"),
    query: HistoricalMaterialBinding,
    candidate: HistoricalMaterialBinding,
    relation: z.enum(["SAME_OCCURRENCE", "SAME_STORY"]),
    queryAnchor: HistoricalAnchor,
    candidateAnchor: HistoricalAnchor,
    receiptId: z.number().int().positive(),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine((value) => value.query.articleId !== value.candidate.articleId, "An article cannot be its own background")
  .refine((value) => value.queryAnchor.kind === value.candidateAnchor.kind, "Both anchors must describe the same kind of object");
export type HistoricalCandidateRequest = z.infer<typeof HistoricalCandidateRequest>;
export type HistoricalBackgroundCandidate = z.infer<typeof HistoricalBackgroundCandidate>;
export type HistoricalBackgroundConfirmation = z.infer<typeof HistoricalBackgroundConfirmation>;
/** Safe worker-to-publication projection; source quotes and paid-request proofs stay private. */
export const HistoricalBackgroundReference = z.strictObject({
  lane: z.literal("news"),
  storyPublicId: z.uuid(),
  query: HistoricalMaterialBinding,
  candidate: HistoricalMaterialBinding,
  relation: z.enum(["SAME_OCCURRENCE", "SAME_STORY"]),
});
export const HistoricalBackgroundProjection = z
  .strictObject({ lane: z.literal("news"), storyPublicId: z.uuid(), references: z.array(HistoricalBackgroundReference) })
  .refine((value) => value.references.every((ref) => ref.storyPublicId === value.storyPublicId), "Every reference must belong to the projected story");
export type HistoricalBackgroundReference = z.infer<typeof HistoricalBackgroundReference>;
/** Future readHistoricalBackgroundCandidates export from @amp/backend/publication/publish; no implementation in this contract PR. */
export type HistoricalBackgroundReader = (input: HistoricalCandidateRequest) => Promise<HistoricalBackgroundCandidate[]>;
/** Worker-only reader from @amp/backend/events/group; public readers use the publication projection. */
export type HistoricalBackgroundReferencesReader = (input: { lane: "news"; storyPublicId: string }) => Promise<HistoricalBackgroundReference[]>;
/** Future replaceHistoricalBackgroundProjection in publication/publish; reuse the caller's transaction. */
export type HistoricalBackgroundProjector<Transaction> = (input: z.infer<typeof HistoricalBackgroundProjection>, transaction: Transaction) => Promise<void>;
