import { extractPolicyOriginal } from "./extraction.ts";
import type { ExtractionProfile } from "../core/extraction-parse.ts";
import { readPolicyOriginal } from "../core/originals.ts";
import { provisionSourceText, readStructure, storePolicyStructure, type PolicyStructure } from "../core/provision-store.ts";

/** Archive → structure for the current head of one expression. Reuses the cached extraction; never calls a model. */
export async function structurePolicyRevision(expressionId: string, profile: ExtractionProfile): Promise<PolicyStructure | null> {
  const snapshot = await readPolicyOriginal(expressionId);
  if (!snapshot) return null;
  const existing = await readStructure(snapshot.revisionId);
  if (existing) return existing;
  const main = snapshot.manifest.resources[0];
  if (!main || !snapshot.resources[0]?.body) return storePolicyStructure(snapshot.revisionId, "", ["正文原件未存档"], snapshot.language);
  const extraction = await extractPolicyOriginal(expressionId, profile);
  if (extraction.revisionId !== snapshot.revisionId) return null;
  const source = provisionSourceText(extraction, main.url);
  return storePolicyStructure(snapshot.revisionId, source.text, source.gaps, snapshot.language);
}
