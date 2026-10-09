// Article body extraction: readable text from the article page, or "unconfirmed" — never a wrong body.
// Jina Reader is the budgeted fallback for pages that only render in a browser.
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { dbOf } from "../db.ts";
import {
  crawlFetch as guardedFetch,
  crawlStep,
  withSourceCrawl,
  CrawlDeferred,
  CrawlBlocked,
  crawlFulltextAllowed,
  crawlExternal,
} from "../acquisition/crawl.ts";
import { readSourceDateContext } from "@amp/backend/admin/sources";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { jinaRead } from "../providers/jina.ts";
import { BudgetExceededError } from "../providers/receipts.ts";
import { sanitizeBody, trimTrailingChrome } from "./sanitize.ts";
import { contentHash, readCurrentBody } from "./materials.ts";

const sql = dbOf("content");

export interface ExtractedBody {
  html: string;
  text: string;
  images: Array<{ kind: "image"; url: string; width: number | null; height: number | null }>;
  via: "readability" | "jina";
}

const MIN_BODY_CHARS = 200;

export function readable(html: string, url: string): ExtractedBody | null {
  const { document } = parseHTML(html);
  try {
    const base = document.createElement("base");
    base.setAttribute("href", url);
    document.head?.appendChild(base);
  } catch {
    // no head
  }
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], {
    charThreshold: MIN_BODY_CHARS,
    keepClasses: false,
  }).parse();
  if (!article?.content) return null;
  const clean = trimTrailingChrome(sanitizeBody(article.content, url));
  const text = stripTags(clean);
  if (text.length < MIN_BODY_CHARS) return null;
  const images: ExtractedBody["images"] = [];
  for (const m of clean.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)) {
    const w = /\bwidth="(\d+)"/.exec(m[0]);
    const h = /\bheight="(\d+)"/.exec(m[0]);
    images.push({ kind: "image", url: m[1]!.replace(/&amp;/g, "&"), width: w ? Number(w[1]) : null, height: h ? Number(h[1]) : null });
    if (images.length >= 12) break;
  }
  return { html: clean, text, images, via: "readability" };
}

function markdownToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, '<img src="$2" alt="$1">')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  const blocks = md.split(/\n{2,}/);
  return blocks
    .map((b) => {
      const t = b.trim();
      if (!t) return "";
      if (/^```/.test(t)) return `<pre><code>${esc(t.replace(/^```\w*\n?|```$/g, ""))}</code></pre>`;
      const h = /^(#{1,4})\s+(.+)$/.exec(t);
      if (h) return `<h${Math.min(h[1]!.length + 1, 4)}>${inline(h[2]!)}</h${Math.min(h[1]!.length + 1, 4)}>`;
      if (/^[-*]\s/.test(t))
        return `<ul>${t
          .split("\n")
          .map((l) => `<li>${inline(l.replace(/^[-*]\s+/, ""))}</li>`)
          .join("")}</ul>`;
      if (/^>\s?/.test(t)) return `<blockquote><p>${inline(t.replace(/^>\s?/gm, ""))}</p></blockquote>`;
      return `<p>${inline(t).replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

export async function extractFromUrl(url: string, opts: { allowJina: boolean; subject: string }): Promise<ExtractedBody | null> {
  const direct = await crawlStep(`readability:${url}`, url, async () => {
    try {
      const res = await guardedFetch(url, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024, retryDropped: true });
      if (res.status === 200 && /html/.test(res.headers.get("content-type") ?? "")) return readable(res.text(), res.url);
    } catch (error) {
      if (error instanceof CrawlDeferred || error instanceof CrawlBlocked) throw error;
    }
    return null;
  });
  if (direct) return direct;
  if (!opts.allowJina) return null;
  try {
    const page = await crawlExternal(url, "body_fallback", () => jinaRead(url, { purpose: "body_fallback", subject: opts.subject }));
    const html = trimTrailingChrome(sanitizeBody(markdownToHtml(page.markdown), url));
    const text = stripTags(html);
    if (text.length < MIN_BODY_CHARS) return null;
    return { html, text, images: [], via: "jina" };
  } catch (error) {
    if (error instanceof BudgetExceededError) return null;
    throw error;
  }
}

/** Pages extraction can fetch: ordinary web pages (WeChat articles arrive whole or not at all; X pages are not fetched). */
export function pageFetchable(url: string, sourceKind: string): boolean {
  if (sourceKind === "mp_account") return false;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && !/(^|\.)(x\.com|twitter\.com|mp\.weixin\.qq\.com)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** Fetches and stores the body of one article. Unconfirmed bodies are recorded as such. */
async function extractArticleBody(articleId: string, allowJina = process.env.JINA_BODY_FALLBACK !== "false"): Promise<"ok" | "unconfirmed" | "skipped"> {
  const [a] = await sql<{ id: string; url: string; body_status: string; revision: number }[]>`
    SELECT id, url, body_status, revision FROM articles WHERE id = ${articleId}`;
  if (!a || a.body_status === "ok") return "skipped";
  if (!(await crawlFulltextAllowed(a.url))) {
    await sql`UPDATE articles SET body_status='none' WHERE id=${articleId} AND body_status='pending'`;
    return "skipped";
  }
  const got = await extractFromUrl(a.url, { allowJina, subject: `article:${a.id}` });
  if (!got) {
    await sql`UPDATE articles SET body_status = 'unconfirmed', updated_at = now() WHERE id = ${articleId} AND body_status <> 'ok'`;
    return "unconfirmed";
  }
  // The body is new content: a new revision, so an analysis of the body-less input counts as stale.
  await sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null }[]>`SELECT title, excerpt FROM articles WHERE id = ${articleId} FOR UPDATE`;
    if (!row) return;
    const hash = contentHash({ title: row.title, bodyText: got.text, excerpt: row.excerpt });
    const [r] = await tx<{ revision: number }[]>`
      UPDATE articles SET body_html = ${got.html}, body_text = ${got.text}, body_status = 'ok',
        media = CASE WHEN jsonb_array_length(media) = 0 THEN ${tx.json(got.images as never)}::jsonb ELSE media END,
        revision = revision + 1, content_hash = ${hash}, processing_state = 'new', updated_at = now()
      WHERE id = ${articleId} RETURNING revision`;
    await tx`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
             VALUES (${articleId}, ${r!.revision}, ${hash}, ${row.title}, ${got.text})`;
  });
  return "ok";
}

export { collapseWhitespace };

async function pacedExtractArticleBody(articleId: string, allowJina?: boolean, expectedSessionId?: string) {
  const material = await readCurrentBody(articleId),
    source = material ? await readSourceDateContext(material.source_id) : null;
  if (!source) return "skipped" as const;
  if (!source.enabled || !sourceCollectionEnabled(source.lane))
    throw new CrawlDeferred(new Date(Date.now() + 60_000), `body:${articleId}`, "collection_paused");
  return withSourceCrawl(source, `body:${articleId}:${material!.revision}`, () => extractArticleBody(articleId, allowJina), { expectedSessionId });
}
export { pacedExtractArticleBody as extractArticleBody };

import { sourceCollectionEnabled } from "../config.ts";
