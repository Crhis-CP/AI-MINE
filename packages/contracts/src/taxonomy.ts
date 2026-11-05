// Stable public identities for URLs, API, RSS and MCP. Display labels belong to industry.
// Changing a key or its order is a contract change, independent of the industry vocabulary.
import {
  LEGACY_MINING_CATEGORY_KEYS,
  LEGACY_MINING_CATEGORY_TARGETS,
  MINING_CATEGORY_KEYS,
  isLegacyMiningCategoryKey,
  mappedMiningCategory,
} from "./mining-taxonomy.ts";
export const CATEGORY_KEYS = MINING_CATEGORY_KEYS;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];

/** The public API, RSS and MCP use the same categories as the website. */
export const PUBLIC_API_CATEGORY_KEYS = CATEGORY_KEYS;
export type PublicApiCategoryKey = CategoryKey;

/**
 * What a category filter accepts (ADR-0031): the current keys and the retired ones, which old links, feeds and
 * agents still send. Responses only ever carry current keys.
 */
export const CATEGORY_FILTER_KEYS = [...CATEGORY_KEYS, ...LEGACY_MINING_CATEGORY_KEYS] as const;
export type CategoryFilterKey = (typeof CATEGORY_FILTER_KEYS)[number];

/** A stored or submitted value as a current public key: retired keys with a single successor map to it. */
export function toPublicApiCategory(category: string | null): PublicApiCategoryKey | null {
  return mappedMiningCategory(category);
}

export function isCategoryKey(value: unknown): value is CategoryKey {
  return typeof value === "string" && (CATEGORY_KEYS as readonly string[]).includes(value);
}

export function isCategoryFilterKey(value: unknown): value is CategoryFilterKey {
  return isCategoryKey(value) || isLegacyMiningCategoryKey(value);
}

/**
 * The filter a request means: a retired key with one successor becomes that key; company_project stays as it is
 * (it filters both of its successors). Unknown values return null for the caller to reject.
 */
export function canonicalCategoryFilter(value: unknown): CategoryFilterKey | null {
  if (!isCategoryFilterKey(value)) return null;
  return mappedMiningCategory(value) ?? value;
}

/** The current keys a filter selects. */
export function categoryFilterKeys(value: CategoryFilterKey): CategoryKey[] {
  return isLegacyMiningCategoryKey(value) ? [...LEGACY_MINING_CATEGORY_TARGETS[value]] : [value];
}

export const CHANNEL_KEYS = ["all", "news", "firstParty"] as const;
export type ChannelKey = (typeof CHANNEL_KEYS)[number];

export function isChannelKey(value: unknown): value is ChannelKey {
  return typeof value === "string" && (CHANNEL_KEYS as readonly string[]).includes(value);
}

/** Article ids. Also the local-data import validation pattern. */
export const ARTICLE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
