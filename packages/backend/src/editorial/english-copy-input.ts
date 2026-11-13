// Which public news items get an English title and summary for the English interface, and the exact input each is
// written from (TASK-0595, Owner 2026-11-08: 英文文章肯定是要用英文标题和摘要). Pure: no database, network or clock.
//
// The input is the published Chinese title and summary (the analysis's reader copy, or a person's revision of it) and
// the original title, never the body: the scoring prompt is untouched and one short request covers the item. An
// English original keeps its own title; only the summary is written. Identical input has one hash, so it is written
// and paid for once; a changed Chinese copy has a new hash, and the old English copy stops being shown with it.
import { sha256, stableJson } from "../lib/ids.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { normalizeSourceLanguage } from "../sources/config-keys.ts";
import { promptVersion } from "./prompts.ts";

/** Recorded with each copy. A new prompt wording does not make existing copies stale (that would pay for all again). */
export const englishCopyRecipe = () => `english-copy-v1:${promptVersion("english-copy")}`;

/** The stored publication fields a copy depends on. */
export interface EnglishCopySource {
  title: string;
  summary: string | null;
  originalTitle: string | null;
  language: string | null;
  isOriginalPost: boolean;
  visibility: string;
  eligible: boolean;
}

export interface EnglishCopyInput {
  hash: string;
  /** The original is English and has its own title: that title is the English title, as it is. */
  keepTitle: boolean;
  /** With keepTitle, the English title. */
  sourceTitle: string | null;
  /** Exactly what the model reads. */
  message: { originalTitle?: string; titleZh: string; summaryZh: string; keepTitle?: true };
}

const HAN = /\p{Script=Han}/u;

/** An English-language original (en, en-US, …). */
export function isEnglishOriginal(language: string | null): boolean {
  return normalizeSourceLanguage(language)?.split("-")[0] === "en";
}

/**
 * The input for an item's English copy, or null when the item gets none: only public items in the reading pool with a
 * written summary. Original posts are left out (their card shows the post itself, projected at read time).
 */
export function englishCopyInput(row: EnglishCopySource): EnglishCopyInput | null {
  if (row.visibility !== "public" || !row.eligible || row.isOriginalPost) return null;
  const titleZh = collapseWhitespace(row.title ?? "");
  const summaryZh = collapseWhitespace(row.summary ?? "");
  if (!titleZh || !summaryZh) return null;
  const originalTitle = collapseWhitespace(row.originalTitle ?? "");
  const keepTitle = isEnglishOriginal(row.language) && !!originalTitle && !HAN.test(originalTitle);
  const message = {
    ...(originalTitle ? { originalTitle } : {}),
    titleZh,
    summaryZh,
    ...(keepTitle ? { keepTitle: true as const } : {}),
  };
  return { hash: sha256(stableJson({ v: 1, ...message })), keepTitle, sourceTitle: keepTitle ? originalTitle : null, message };
}
