import { config } from "../config.ts";
import { isEmptyOrLinkOnly, usableSourceText } from "./text.ts";
import { sha256 } from "./ids.ts";

/** The summarize fallback threshold; since 2026-11-08 also the least material an article (not a post) is judged on. */
export const LEGACY_SUMMARY_MIN_CHARS = 20;
/**
 * An article's material as the writer reads it (the body when it has a letter or digit, else the excerpt, trimmed) is
 * shorter than the writer needs: it waits for material and no paid step is bought (Owner 2026-11-08, TASK-0598).
 */
export const articleMaterialTooShort = (bodyText: string | null | undefined, excerpt: string | null | undefined) =>
  usableSourceText(bodyText, excerpt).trim().length < LEGACY_SUMMARY_MIN_CHARS;
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
