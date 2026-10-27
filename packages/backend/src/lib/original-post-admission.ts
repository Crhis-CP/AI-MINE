import { config } from "../config.ts";
import { isEmptyOrLinkOnly } from "./text.ts";
import { sha256 } from "./ids.ts";

/** Existing summarize fallback threshold, not a new general material requirement. */
export const LEGACY_SUMMARY_MIN_CHARS = 20;
type Post = { text: string } | null | undefined;

export const originalPostInputBlocked = (post: Post) => !config.originalPostAdmissionEnabled && !!post && isEmptyOrLinkOnly(post.text);
export const verbatimAdmissionRequired = (copy: string) => isEmptyOrLinkOnly(copy) || copy.trim().length < LEGACY_SUMMARY_MIN_CHARS;
export function originalPostAdmissionRequired(post: Post, writer?: string | null, copy?: string | null): boolean {
  return !!post && (isEmptyOrLinkOnly(post.text) || (writer === "verbatim" && verbatimAdmissionRequired(copy ?? post.text)));
}
export function originalPostProjectionAllowed(row: { is_original_post?: boolean; original_post_admission_required?: boolean | null }): boolean {
  return !row.is_original_post || config.originalPostAdmissionEnabled || row.original_post_admission_required === false;
}
/** Existing opaque read/cursor identities must change when the allowed public set changes. */
export const originalPostReadVersion = (version: string) => (config.originalPostAdmissionEnabled ? sha256(JSON.stringify([version, true])) : version);
