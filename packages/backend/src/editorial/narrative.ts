import * as cheerio from "cheerio";
import { collapseWhitespace } from "../lib/text.ts";

/** An embedded article-link card is navigation, not a fact about this article. Raw bodies remain unchanged. */
export function narrativeText(text: string | null, html: string | null, url: string): string | null {
  if (!html?.includes("<figure")) return text;
  const $ = cheerio.load(html, null, false);
  let removed = false;
  $("figure").each((_, node) => {
    const figure = $(node),
      quote = figure.children("blockquote");
    if (figure.children().length !== 1 || quote.length !== 1 || quote.attr("cite")) return;
    const link = quote.children("a[href]");
    if (quote.children().length !== 1 || link.length !== 1 || !link.text().trim() || collapseWhitespace(figure.text()) !== collapseWhitespace(link.text()))
      return;
    try {
      const target = new URL(link.attr("href")!, url);
      if (!["http:", "https:"].includes(target.protocol) || target.href === url) return;
    } catch {
      return;
    }
    figure.remove();
    removed = true;
  });
  if (!removed) return text;
  $("p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,td,th,br").append("\n");
  return collapseWhitespace($.root().text());
}
