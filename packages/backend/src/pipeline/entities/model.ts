// The entity library's rows and results, shaped like the tables of schema `entities` (one field per column,
// camelCase, timestamps left out) so the store can hand rows straight to the pure functions. Companies were kept
// in four lists apart (tag vocabulary, name glossary, scoring names, prompt names); the library is the one place
// that says which spellings name which company and what its one Chinese name is.

export type EntityKind = "company" | "organization" | "asset";
export type EntityOrigin = "taxonomy" | "glossary" | "seed" | "admin";
export type RowStatus = "active" | "retired";

export interface EntityRow {
  id: string;
  kind: EntityKind;
  /** The one Chinese name readers see; null when none is established, and the original is then left as written. */
  nameZh: string | null;
  nameOriginal: string;
  /** Whether the first mention carries the original in brackets: false for Chinese companies. */
  showOriginal: boolean;
  origin: EntityOrigin;
  status: RowStatus;
  /** Set when a person merged this entity into another: its spellings then name the winner. */
  mergedInto: string | null;
}

export type StatementProperty = "alias" | "ticker" | "domain" | "source_owner" | "headquarters";

/**
 * How far an alias may be trusted in running text.
 * - text: links on its own.
 * - anchored: links only when the same article names the entity some other way (a `text` alias, a qualified
 *   ticker, the publisher, the model's subjects), because the spelling is also a place or a common word (Vale,
 *   Antofagasta, Kinross) or a two-character Chinese word.
 * - lookup: never matched in running text; only answers "which company is this spelling".
 */
export type AliasScope = "text" | "anchored" | "lookup";

export interface StatementRow {
  entityId: string;
  property: StatementProperty;
  /** As written: an alias spelling, `EXCHANGE:SYMBOL` for a ticker, a host name for a domain. */
  value: string;
  /** For aliases only; null for the other properties. */
  scope: AliasScope | null;
  lang: string | null;
  caseSensitive: boolean;
  origin: EntityOrigin | "history";
  status: RowStatus;
}

export type LinkRole = "subject" | "mention" | "publisher";
export type LinkMethod = "text" | "model_subject" | "publisher_domain" | "source_owner" | "manual";
export type LinkSegment = "title" | "body" | "source" | "model";

/** One entity found in one article. A text link counts every hit; its alias and position are the first one's. */
export interface EntityLink {
  entityId: string;
  role: LinkRole;
  method: LinkMethod;
  /** The spelling as the article wrote it (or the domain / owner id for a publisher link). */
  alias: string;
  segment: LinkSegment;
  /** Character offset of the first hit inside its segment; null for publisher links. */
  position: number | null;
  hits: number;
}
