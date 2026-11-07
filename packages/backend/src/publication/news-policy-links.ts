import { DOMParser } from "linkedom";
import { readPublicNewsLinkCandidates } from "./items.ts";
import { policyCurrentPublicRecords } from "./policies.ts";
function links(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html");
  return new Set(
    Array.from(document.querySelectorAll("a[href]"), (node: { getAttribute(name: string): string | null }) => {
      try {
        const url = new URL(node.getAttribute("href")!);
        url.hash = "";
        return /^https?:$/.test(url.protocol) ? url.href : "";
      } catch {
        return "";
      }
    }).filter(Boolean),
  );
}
const canonical = (value: string) => {
  const url = new URL(value);
  url.hash = "";
  return url.href;
};
/** Explicit source links only; common countries, entities or words never establish a relationship. */
export async function relatedPoliciesForNews(articleId: string) {
  const [row] = await readPublicNewsLinkCandidates(articleId, null);
  if (!row?.body_html) return [];
  const cited = links(row.body_html);
  return (await policyCurrentPublicRecords())
    .filter((p) => cited.has(canonical(p.card.original_url)))
    .slice(0, 20)
    .map((p) => ({ id: p.card.id, title: p.card.title, jurisdiction: p.card.jurisdictions[0]?.label ?? null, documentNumber: p.card.instrument_number }));
}
/**
 * Which public reports link an official URL means reading every public article body (no index covers them), which
 * took seconds on every policy page. The reports found are kept per URL for a few minutes; each page view checks them
 * again against the current public state, so a withdrawn or hidden report disappears at once, and a report that links
 * the document later appears with the next scan. Only the first view of a document in a process waits for a scan;
 * later scans run while the page is answered with the reports already found.
 */
const RELATED_FRESH_MS = 10 * 60_000,
  RELATED_KEPT = 1000;
const relatedScans = new Map<string, { at: number; ids: Promise<string[]> }>();
/** A scan of every public report for the URL, kept (newest last, at most RELATED_KEPT); a failed scan is forgotten. */
function scanRelated(url: string) {
  const entry = {
    at: Date.now(),
    ids: readPublicNewsLinkCandidates(null, url).then((rows) => rows.filter((row) => links(row.body_html).has(url)).map((row) => row.id)),
  };
  entry.ids.catch(() => relatedScans.get(url) === entry && relatedScans.delete(url));
  relatedScans.delete(url);
  relatedScans.set(url, entry);
  if (relatedScans.size > RELATED_KEPT) relatedScans.delete(relatedScans.keys().next().value!);
  return entry;
}
export async function relatedNewsForPolicy(originalUrl: string) {
  const url = canonical(originalUrl);
  const known = relatedScans.get(url);
  // The first view waits for its scan; an older scan answers now and is renewed in the background.
  if (known && Date.now() - known.at > RELATED_FRESH_MS) scanRelated(url);
  const ids = await (known ?? scanRelated(url)).ids;
  if (!ids.length) return [];
  // Checked again against the current public state: a withdrawal or a changed body counts at once.
  const rows = await readPublicNewsLinkCandidates(null, url, ids);
  return rows
    .filter((row) => links(row.body_html).has(url))
    .slice(0, 20)
    .map(({ id, title }) => ({ id, title }));
}
