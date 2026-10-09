import data from "./data.json" with { type: "json" };

// Pure data: safe for a page or importer to read without loading the backend or files.
export const JURISDICTIONS = Object.freeze(data.jurisdictions.map((row) => Object.freeze(row)));
export type Jurisdiction = (typeof JURISDICTIONS)[number];
export const COUNTRIES = Object.freeze(JURISDICTIONS.filter((row) => row.kind === "country"));
export const ORGANIZATIONS = Object.freeze(JURISDICTIONS.filter((row) => row.kind === "organization"));
export const NEWS_COUNTRIES = Object.freeze(COUNTRIES.filter((row) => row.news_scope));
export const POLICY_JURISDICTIONS = Object.freeze(JURISDICTIONS.filter((row) => row.policy_scope));
export const CHINA_SUBDIVISIONS = Object.freeze(JURISDICTIONS.filter((row) => row.kind === "subdivision" && row.parent === "CN"));
export const COUNTRY_COUNT_IS_CAP = data.country_count_is_cap;
export const TIER_DEFINITIONS = Object.freeze(data.tier_definitions);
export const SCOPE_FLAGS = Object.freeze(data.scope_flags);

/** A country filter includes evidence assigned to its descendants, without inventing membership. */
export function jurisdictionDescendants(code: string): string[] {
  if (!JURISDICTIONS.some((j) => j.id === code)) return [];
  const codes = new Set([code]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const row of JURISDICTIONS)
      if (row.parent && codes.has(row.parent) && !codes.has(row.id)) {
        codes.add(row.id);
        changed = true;
      }
  }
  return [...codes];
}

export function validNewsJurisdiction(value: string) {
  return value === "unknown" || value === "none" || JURISDICTIONS.some((j) => j.id === value);
}
