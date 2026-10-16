/** Existing processing-state reads used by the public policy projection during module migration. */
export { POLICY_MODEL_BINDING_VERSION } from "./model-evidence.ts";
export { currentPolicyHeads } from "./public-state.ts";
export { readPolicyFulltextRun, type FulltextRun } from "./fulltext-store.ts";
export { readPolicyMetadataObservation } from "./metadata.ts";
export type { Candidate, RelatedPolicy } from "./interpretation-schema.ts";
export { explicitPolicyReference } from "./references.ts";
export { relatedNewsForPolicy } from "../publication/news-policy-links.ts";
export { currentNewsJurisdictionCounts } from "../publication/news-geography.ts";
