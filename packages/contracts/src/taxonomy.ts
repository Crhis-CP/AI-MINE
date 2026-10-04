// Stable public identities for URLs, API, RSS and MCP. Display labels belong to industry.
// Changing a key or its order is a contract change, independent of the industry vocabulary.
export const CATEGORY_KEYS = ["ai-models", "ai-products", "industry", "paper", "tip", "opinion"] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];

/** The public API, RSS and MCP use the same categories as the website. */
export const PUBLIC_API_CATEGORY_KEYS = CATEGORY_KEYS;
export type PublicApiCategoryKey = CategoryKey;

export function toPublicApiCategory(category: string | null): PublicApiCategoryKey | null {
  return isCategoryKey(category) ? category : null;
}

export function isCategoryKey(value: unknown): value is CategoryKey {
  return typeof value === "string" && (CATEGORY_KEYS as readonly string[]).includes(value);
}

export const CHANNEL_KEYS = ["all", "news", "firstParty"] as const;
export type ChannelKey = (typeof CHANNEL_KEYS)[number];

export function isChannelKey(value: unknown): value is ChannelKey {
  return typeof value === "string" && (CHANNEL_KEYS as readonly string[]).includes(value);
}

/** Article ids. Also the local-data import validation pattern. */
export const ARTICLE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
