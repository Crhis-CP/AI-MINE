// Tag normalization over the industry pack's vocabulary (industry/taxonomy.ts), which the topics
// (industry/topics.json) are built on.
import { CATEGORY_TAGS, ENTITY_TAGS, TAG_SYNONYMS, TOPIC_TAGS } from "@amp/industry/taxonomy";

export { CATEGORY_TAGS, ENTITIES, ENTITY_TAGS, ITEM_TYPES, TOPIC_TAGS } from "@amp/industry/taxonomy";

const ALLOWED_TAGS = new Set<string>([...CATEGORY_TAGS, ...TOPIC_TAGS, ...ENTITY_TAGS]);

/**
 * Known tags only, synonyms mapped, duplicates dropped, at most `max`; a known category goes first.
 * Missing classification remains absent, without an item-type or last-tag fallback.
 */
export function normalizeTags(v: unknown, opts: { max?: number } = {}): string[] {
  const max = opts.max ?? 6;
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,，]/g) : [];
  const tags: string[] = [];
  for (const x of raw) {
    const t = String(x ?? "")
      .trim()
      .replace(/^#/, "");
    const tag = TAG_SYNONYMS[t] ?? TAG_SYNONYMS[t.toLowerCase()] ?? t;
    if (tag && ALLOWED_TAGS.has(tag) && !tags.includes(tag)) tags.push(tag);
  }
  const isCategory = (t: string) => (CATEGORY_TAGS as readonly string[]).includes(t);
  const categoryIndex = tags.findIndex(isCategory);
  const category = categoryIndex >= 0 ? tags[categoryIndex]! : null;
  return [...(category ? [category] : []), ...tags.filter((t) => !isCategory(t))].slice(0, max);
}

/** The category guide the structure step reads: one line per category. */
export { MINING_CATEGORY_GUIDE as CATEGORY_GUIDE } from "@amp/industry/mining-taxonomy";
