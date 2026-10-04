import { z } from "zod";

/** ADR-0022 preparation only; the active CATEGORY_KEYS and HTTP registries have not switched. */
export const MINING_CATEGORY_KEYS = [
  "policy_regulation",
  "company_project",
  "commodity_market",
  "capital_ma",
  "supply_trade_controls",
  "esg_community_labor",
  "safety_incident",
  "technology_processing",
  "exploration_resource",
] as const;
export const MiningCategoryKeySchema = z.enum(MINING_CATEGORY_KEYS);
export const MiningCategorySchema = MiningCategoryKeySchema.nullable();
export type MiningCategoryKey = z.infer<typeof MiningCategoryKeySchema>;

export function isMiningCategoryKey(value: unknown): value is MiningCategoryKey {
  return typeof value === "string" && (MINING_CATEGORY_KEYS as readonly string[]).includes(value);
}

/** Public projection compatibility; do not rewrite the original analysis, overrides or ledger. */
export function normalizeMiningCategory(value: unknown): MiningCategoryKey | null {
  return isMiningCategoryKey(value) ? value : null;
}
