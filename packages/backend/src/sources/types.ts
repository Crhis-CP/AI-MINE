import type { RuntimeControlSnapshot } from "../operations/lane-controls.ts";
import type { MaterialInput } from "../content/materials.ts";

export interface SourceRow {
  collectionControl?: RuntimeControlSnapshot;
  collectionSignal?: AbortSignal;
  collectionReadKey?: string;
  id: string;
  name: string;
  kind: "rss" | "web_list" | "json_list" | "mp_account" | "external";
  config: Record<string, any>;
  tier: string;
  participation_mode: "editorial" | "hot_signal" | "isolated";
  /** Business line (ADR-0016): policy material is stored but never enters the news stages. */
  lane: "news" | "policy";
  first_party: boolean;
  interval_minutes: number;
  enabled: boolean;
  archived_at?: Date | null;
  cursor: Record<string, any> | null;
  fail_count: number;
}

/**
 * What a fetcher found on a listing, before identity and timeline rules are applied. Whether the
 * article page is then fetched for a body is decided per source (jobs/content.ts route).
 */
export type Candidate = Omit<MaterialInput, "sourceId" | "via"> & {
  categories?: string[];
};

/**
 * Conditional-request validators of one listing response. Saved in the source cursor only after a stored run, so a
 * 304 never hides a list that was not yet stored; a config change or a redirect to another address starts plain.
 */
export interface ListingValidator {
  configHash: string;
  responseUrl: string;
  etag: string | null;
  lastModified: string | null;
}
export type ConditionalListing = { candidates: Candidate[]; validator: ListingValidator; notModified: boolean };
export function conditionalListingHeaders(previous: ListingValidator | null): Record<string, string> {
  return {
    ...(previous?.etag ? { "if-none-match": previous.etag } : {}),
    ...(previous?.lastModified ? { "if-modified-since": previous.lastModified } : {}),
  };
}
type ListingResponse = { status: number; url: string; headers: Headers };
export function listingValidator(configHash: string, res: ListingResponse, previous: ListingValidator | null): ListingValidator {
  return {
    configHash,
    responseUrl: res.url,
    etag: res.headers.get("etag") ?? (res.status === 304 ? (previous?.etag ?? null) : null),
    lastModified: res.headers.get("last-modified") ?? (res.status === 304 ? (previous?.lastModified ?? null) : null),
  };
}
export const listingNotModified = (res: ListingResponse, previous: ListingValidator | null) =>
  res.status === 304 && !!previous && !!(previous.etag || previous.lastModified) && res.url === previous.responseUrl;

export class FetchError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}
