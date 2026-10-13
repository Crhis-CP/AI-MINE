import data from "./policy-sources.json" with { type: "json" };

// TASK-0092: the Owner's list received 2026-10-08, with dated research and explicit holds for unresolved evidence.
// This is a directory, not source activation or a claim of complete coverage. Pure data, like ./jurisdictions.

/** Whether an entry can be collected now, and if not, what it waits for. */
export const POLICY_SOURCE_STATUSES = ["ready", "needs_reader", "needs_overseas", "blocked", "reference_only", "identity_pending"] as const;
export type PolicySourceStatus = (typeof POLICY_SOURCE_STATUSES)[number];
export const POLICY_SOURCE_TERMS = ["open", "reuse", "exempt", "restricted", "no_automation"] as const;
/** core: an independent publisher; supplement: fills a gap; reference: consolidated text only, not new documents; duplicate: same documents as another entry. */
export const POLICY_SOURCE_ROLES = ["core", "supplement", "reference", "duplicate"] as const;
export const POLICY_SOURCE_TYPES = ["official_gazette", "law_database", "mining_rules", "related_rules", "local_rules", "policy_documents"] as const;
/** The seven business themes (docs/01-product/10-policy-service.md §2.3). */
export const POLICY_THEMES = [
  "investment_company",
  "mineral_rights",
  "land_construction",
  "safety_environment",
  "labour_community",
  "tax_finance",
  "trade_transport",
] as const;

export interface PolicySource {
  id: string;
  jurisdiction: string;
  level: "national" | "subnational" | "supranational";
  subdivision: string | null;
  authority: { zh: string; original: string };
  name: { zh: string; original: string };
  type: (typeof POLICY_SOURCE_TYPES)[number];
  role: (typeof POLICY_SOURCE_ROLES)[number];
  duplicate_of: string | null;
  website: string;
  /** The URL in the Owner's list; `entry` is the one the checked config reads (they differ when the listed page was a search form, an index or a home page). */
  listed_url: string;
  entry: string;
  collect: { kind: "rss" | "web_list" | "json_list"; config: Record<string, unknown> } | null;
  status: PolicySourceStatus;
  terms: (typeof POLICY_SOURCE_TERMS)[number];
  /** An unresolved condition blocks activation even when historical list fetching succeeded. */
  hold: string | null;
  language: string | null;
  detail_format: string | null;
  themes: Array<(typeof POLICY_THEMES)[number]>;
  identity: { status: "verified" | "incomplete"; evidence: string | null };
  notes: string | null;
}

export const POLICY_SOURCES: readonly PolicySource[] = Object.freeze((data.sources as unknown as PolicySource[]).map((source) => Object.freeze(source)));
