import { DOMParser } from "linkedom";
import { one, sql, type Tx } from "../db.ts";
import { newsLinkBodies } from "./items.ts";

/**
 * The one reading of "a report links a URL" (TASK-0567): an explicit <a href> that is an absolute http(s) URL,
 * compared without its fragment. The projection below, the policy page's related reports and the report page's
 * related policies all use these two functions, so the stored links and every lookup match the same way.
 */
export function explicitLinks(html: string) {
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
export function canonicalLink(value: string) {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

/**
 * Lookup keys for a canonical link: every lower-case spelling a stored official URL may use for it — with or without
 * the default port, with or without a trailing slash, percent-encoded or not. Stored official URLs are not normalised
 * (any spelling the source used); the policy index is lower(url without fragment), so these keys find the candidates
 * and the exact canonicalLink comparison still decides (Codex review #355).
 */
export function looseUrlKeys(link: string) {
  const spellings = new Set([link]);
  try {
    spellings.add(decodeURI(link));
  } catch {
    // A malformed escape keeps only the encoded spelling.
  }
  const keys = new Set<string>();
  for (const spelling of spellings) {
    const port = spelling.replace(/^(https?):\/\/([^/]+)/i, (_whole, scheme: string, host: string) =>
      /:\d+$/.test(host) ? `${scheme}://${host}` : `${scheme}://${host}:${scheme.toLowerCase() === "https" ? 443 : 80}`,
    );
    for (const value of [spelling, port]) {
      const lower = value.toLowerCase();
      keys.add(lower);
      keys.add(lower.endsWith("/") ? lower.replace(/\/+$/, "") : `${lower}/`);
    }
  }
  return [...keys];
}

/**
 * Keeps publication.news_links current for one article, read under the caller's lock on the article row. A row whose
 * links were read at this revision is current: any later change of the body clears it (database trigger), so the
 * body is only parsed again after a new revision or a body change.
 */
export async function projectNewsLinks(tx: Tx, article: { id: string; revision: number; body_html: string | null }) {
  const [row] = await tx<{ article_revision: number | null }[]>`SELECT article_revision FROM publication.news_links WHERE article_id=${article.id}`;
  if (row?.article_revision === article.revision) return;
  const urls = [...(article.body_html ? explicitLinks(article.body_html) : [])].sort();
  await tx`INSERT INTO publication.news_links(article_id,article_revision,urls) VALUES(${article.id},${article.revision},${urls}::text[])
    ON CONFLICT(article_id) DO UPDATE SET article_revision=EXCLUDED.article_revision,urls=EXCLUDED.urls,updated_at=now()`;
}

/**
 * Bounded maintenance: reads the links of articles whose row is still unread (existing articles after the migration,
 * or a body changed since). Readers check those articles' bodies directly meanwhile, so this changes no answer;
 * no model call, no re-scoring. Each batch holds a share lock on its article rows only while it reads them.
 */
export async function repairNewsLinks(batch = 100, budgetMs = 20_000) {
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 500) throw new Error("Invalid news link repair bound");
  const started = Date.now();
  let read = 0;
  while (Date.now() - started < budgetMs) {
    const ids = (await sql<{ article_id: string }[]>`SELECT article_id FROM publication.news_links WHERE urls IS NULL ORDER BY article_id LIMIT ${batch}`).map(
      (row) => row.article_id,
    );
    if (!ids.length) break;
    await sql.begin(async (tx) => {
      for (const article of await newsLinkBodies(ids, tx)) await projectNewsLinks(tx, article);
    });
    read += ids.length;
    if (ids.length < batch) break;
  }
  const { pending } = one(await sql<{ pending: number }[]>`SELECT count(*)::int AS pending FROM publication.news_links WHERE urls IS NULL`);
  return { read, pending };
}
