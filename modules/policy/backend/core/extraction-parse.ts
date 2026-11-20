import { decodePolicyOriginal } from "./encoding.ts";
import type { SourceAnnotation } from "./annotations.ts";

export interface ExtractionProfile {
  bodySelector: string | null;
  attachmentSelector: string | null;
  /** A reviewed source-specific expression whose first group names a referenced attachment. */
  attachmentReferencePattern?: string;
  maxBytes: number;
  maxResources: number;
  maxPages: number;
  maxTextBytes: number;
}
export type OriginalNode = {
  id: string;
  ordinal: number;
  text: string;
  html?: string;
  page?: number;
  transform?: number[];
  visualLocations?: { page: number; bbox: number[]; imageHash: string }[];
  selector?: string;
  annotations?: SourceAnnotation[];
};
export type ResourceExtraction = {
  url: string;
  sha256: string | null;
  state: "extracted" | "incomplete" | "blocked_capacity";
  nodes: OriginalNode[];
  gaps: string[];
};
export type PolicyExtraction = {
  revisionId: string;
  state: ResourceExtraction["state"];
  gaps: string[];
  resources: ResourceExtraction[];
  visualProof?: { runId: string; contentHash: string; recipe: string };
};
export function validateProfile(profile: ExtractionProfile) {
  for (const key of ["maxBytes", "maxResources", "maxPages", "maxTextBytes"] as const)
    if (!Number.isSafeInteger(profile[key]) || profile[key] <= 0) throw new Error(`Invalid policy extraction ${key}`);
  if (profile.attachmentReferencePattern) {
    if (!profile.bodySelector || !profile.attachmentSelector || profile.attachmentReferencePattern.length > 300)
      throw new Error("Attachment reference checks require bounded declared body and catalogue selectors");
    new RegExp(profile.attachmentReferencePattern, "giu");
  }
}
export function decodeOriginal(bytes: Uint8Array, mediaType: string | null) {
  return decodePolicyOriginal(bytes, mediaType).text;
}
