import { z } from "zod";

/**
 * ADR-0031 category identities (Owner 2026-11-05, DEC-78补充 item 2): the nine classes cut by actual article volume.
 * Keys whose meaning stays (or only widens without moving any old item out) are kept, so their history needs no work.
 */
export const MINING_CATEGORY_KEYS = [
  "policy_regulation",
  "operations_output",
  "project_development",
  "exploration_resource",
  "capital_ma",
  "commodity_market",
  "technology_processing",
  "safety_environment",
  "events_opinion",
] as const;
export const MiningCategoryKeySchema = z.enum(MINING_CATEGORY_KEYS);
export const MiningCategorySchema = MiningCategoryKeySchema.nullable();
export type MiningCategoryKey = z.infer<typeof MiningCategoryKeySchema>;

/** ADR-0022 keys retired by ADR-0031. Still accepted in URLs and public query parameters, never returned. */
export const LEGACY_MINING_CATEGORY_KEYS = ["company_project", "supply_trade_controls", "esg_community_labor", "safety_incident"] as const;
export type LegacyMiningCategoryKey = (typeof LEGACY_MINING_CATEGORY_KEYS)[number];

/**
 * What a retired key filters for. A single target is also the deterministic reclassification of its history;
 * 企业与项目 split into two classes, so as a filter it covers both and its items are reclassified by the model.
 */
export const LEGACY_MINING_CATEGORY_TARGETS: Readonly<Record<LegacyMiningCategoryKey, readonly MiningCategoryKey[]>> = {
  company_project: ["operations_output", "project_development"],
  supply_trade_controls: ["policy_regulation"],
  esg_community_labor: ["safety_environment"],
  safety_incident: ["safety_environment"],
};

export function isMiningCategoryKey(value: unknown): value is MiningCategoryKey {
  return typeof value === "string" && (MINING_CATEGORY_KEYS as readonly string[]).includes(value);
}

export function isLegacyMiningCategoryKey(value: unknown): value is LegacyMiningCategoryKey {
  return typeof value === "string" && (LEGACY_MINING_CATEGORY_KEYS as readonly string[]).includes(value);
}

/** The current key a stored value means without a model: itself, a retired key's single target, or null. */
export function mappedMiningCategory(value: unknown): MiningCategoryKey | null {
  if (isMiningCategoryKey(value)) return value;
  if (!isLegacyMiningCategoryKey(value)) return null;
  const targets = LEGACY_MINING_CATEGORY_TARGETS[value];
  return targets.length === 1 ? targets[0]! : null;
}

/** Public projection compatibility; do not rewrite the original analysis, overrides or ledger. */
export function normalizeMiningCategory(value: unknown): MiningCategoryKey | null {
  return mappedMiningCategory(value);
}
