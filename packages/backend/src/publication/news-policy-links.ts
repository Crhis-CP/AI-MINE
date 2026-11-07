import { canonicalLink, explicitLinks, looseUrlKeys } from "./news-link-index.ts";
import { readPublicNewsLinkCandidates, readPublicNewsLinking, readPublicNewsLinks, readPublicNewsLinksPending } from "./items.ts";
import { policyPublicRecordsByOriginalUrl } from "./policies.ts";

const RELATED_SHOWN = 20;

/** Explicit source links only; common countries, entities or words never establish a relationship. */
export async function relatedPoliciesForNews(articleId: string) {
  const row = await readPublicNewsLinks(articleId);
  if (!row) return [];
  const cited = new Set(row.urls ?? (row.body_html ? explicitLinks(row.body_html) : []));
  if (!cited.size) return [];
  // Only the documents whose official URL is cited are read, then compared exactly as before.
  return (await policyPublicRecordsByOriginalUrl([...cited].flatMap(looseUrlKeys)))
    .filter((p) => cited.has(canonicalLink(p.card.original_url)))
    .slice(0, RELATED_SHOWN)
    .map((p) => ({ id: p.card.id, title: p.card.title, jurisdiction: p.card.jurisdictions[0]?.label ?? null, documentNumber: p.card.instrument_number }));
}

/**
 * Public reports that link an official URL, found in publication.news_links (one index lookup) and checked against
 * the current public state on every view, so a withdrawn or hidden report disappears at once. Reports whose links
 * have not been read yet (existing reports until the backfill has reached them, or a body changed a moment ago) are
 * checked in their bodies directly, so the answer never waits for the backfill; once every row is read, no article
 * body is read here.
 */
export async function relatedNewsForPolicy(originalUrl: string) {
  const url = canonicalLink(originalUrl);
  // The unread list is read before the index, so a report the backfill reads in between is in the index answer and
  // never missed; one found on both sides is listed once (Codex review #355).
  const pending = await readPublicNewsLinksPending();
  const indexed = await readPublicNewsLinking(url, RELATED_SHOWN);
  const unread = pending.length ? (await readPublicNewsLinkCandidates(url, pending)).filter((row) => explicitLinks(row.body_html).has(url)) : [];
  return mergeRelated(indexed, unread);
}

/** Newest first, each report once, at most RELATED_SHOWN. */
export function mergeRelated(...lists: { id: string; title: string; timeline_at: Date }[][]) {
  const byId = new Map(lists.flat().map((row) => [row.id, row]));
  return [...byId.values()]
    .sort((a, b) => b.timeline_at.getTime() - a.timeline_at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, RELATED_SHOWN)
    .map(({ id, title }) => ({ id, title }));
}
