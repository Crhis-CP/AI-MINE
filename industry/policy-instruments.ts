import data from "./policy-instruments.json" with { type: "json" };

// TASK-0576 (Owner 2026-11-07): the one vocabulary of the policy line's instrument gate. Pure data, like ./policy-sources;
// the deterministic classifier lives in modules/policy/backend/domain/instrument-gate.ts. No model reads this file.

export type PolicyInstrumentLanguage = "es" | "zh" | "en";
export type PolicyInstrumentNature = "law" | "regulation" | "amendment" | "notice";
export interface PolicyInstrumentKind {
  kind: string;
  nature: PolicyInstrumentNature;
  language: PolicyInstrumentLanguage;
  pattern: string;
  /** Only a recognised instrument with a document number of this shape (Chinese normative notices need a 文号). */
  requires_number?: string;
}
type PerLanguage<T> = Partial<Record<PolicyInstrumentLanguage, T>>;
export interface PolicyInstrumentVocabulary {
  version: string;
  kinds: PolicyInstrumentKind[];
  not_final: PerLanguage<string[]>;
  not_normative: PerLanguage<string[]>;
  personnel: PerLanguage<string[]>;
  individual_act: PerLanguage<string[]>;
  amendment: PerLanguage<string>;
  repeal: PerLanguage<string>;
  mining_issuers: string[];
  mining_terms: PerLanguage<string[]>;
  strong_mining_terms: PerLanguage<string[]>;
  mining_noise: PerLanguage<string[]>;
}

export const POLICY_INSTRUMENTS: PolicyInstrumentVocabulary = Object.freeze(data as unknown as PolicyInstrumentVocabulary);
