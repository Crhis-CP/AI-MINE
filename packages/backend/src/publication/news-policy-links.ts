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
export async function relatedNewsForPolicy(originalUrl: string) {
  const url = canonical(originalUrl);
  const rows = await readPublicNewsLinkCandidates(null, url);
  return rows
    .filter((row) => links(row.body_html).has(url))
    .slice(0, 20)
    .map(({ id, title }) => ({ id, title }));
}
