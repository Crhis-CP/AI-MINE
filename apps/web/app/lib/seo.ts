// Page metadata from one place: title template, canonical address, OG images, robots. The site's name
// and wording come from the industry pack (industry/site.ts); its address from SITE_URL.
import type { MetaDescriptor } from "react-router";
import { SITE } from "@amp/industry/site";
import { localeOf, localizedPath, trFor, type Locale } from "../i18n";
import { LOGO_PATH } from "./icons.ts";

/**
 * The site's address: SITE_URL while rendering on the server (what crawlers and share previews read),
 * the page's own origin in the browser.
 */
export function siteUrl(): string {
  if (typeof window !== "undefined") return window.location.origin;
  return (process.env.SITE_URL || SITE.defaultUrl).replace(/\/+$/, "");
}

export const HOME_TITLE = SITE.homeTitle;
export const SITE_DESCRIPTION = SITE.description;
/** The English interface's description in search results (TASK-0590). */
export const SITE_DESCRIPTION_EN =
  "AI-MINE follows global metal mining: companies and projects, markets and technology, laws and policies by country, and metal prices, with story timelines and daily, weekly and monthly reports.";

/**
 * The language of the page being rendered (TASK-0590, Owner 2026-11-08: readers worldwide should find the site in
 * search engines). In the browser, its address; on the server, the request's path, which the web server keeps for
 * the request it is rendering (apps/web/server.ts). Meta functions take no request, so they ask here.
 */
export function requestLocale(): Locale {
  if (typeof window !== "undefined") return localeOf(window.location.pathname);
  const path = (globalThis as { __ampRequestPath?: () => string | undefined }).__ampRequestPath?.();
  return path ? localeOf(path) : "zh";
}

/** A title in the page's language: each part translated when the phrase book has it (site name, page names). */
function localTitle(title: string, locale: Locale): string {
  if (locale === "zh") return title;
  const tr = trFor(locale);
  return title
    .split(" · ")
    .map((part) => {
      const whole = tr.maybe(part);
      if (whole !== part) return whole;
      // A named page with a date or number after it: “矿业日报 2026-11-06” → “Mining Daily 2026-11-06”.
      const named = /^(.+?) (\S+)$/.exec(part);
      return named ? `${tr.maybe(named[1]!)} ${named[2]}` : part;
    })
    .join(" · ");
}

export interface PageMetaInput {
  title?: string | null;
  /** Use `title` verbatim as the document title (no " · <site>" suffix). */
  rawTitle?: boolean;
  description?: string | null;
  path: string;
  image?: string | null;
  noindex?: boolean;
  nofollow?: boolean;
  type?: "website" | "article";
  jsonLd?: Record<string, unknown> | Array<Record<string, unknown>>;
}

/**
 * A list page's own address (canonical, og:url) from the filters it applied: tracking and unknown
 * parameters (`?from=timeline`, `utm_*`) never become part of it. The page caches keep one copy across
 * such parameters, so the address in that copy must not depend on them either.
 */
export function listPath(path: string, params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") sp.set(k, String(v));
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}

/** "Title · Site", with the name readers see in tabs and search results. */
export function titled(title: string): string {
  return `${title} · ${SITE.webName}`;
}

export function pageMeta(input: PageMetaInput): MetaDescriptor[] {
  const base = siteUrl();
  const locale = requestLocale();
  const english = locale === "en";
  const tr = trFor(locale);
  // Each language is its own page in search: the English page names itself (canonical) and both versions point
  // at each other (hreflang), with Chinese as the default for other languages.
  const zhUrl = `${base}${input.path}`;
  const enUrl = `${base}${localizedPath(input.path, "en")}`;
  const title = localTitle(input.title ? (input.rawTitle ? input.title : titled(input.title)) : HOME_TITLE, locale);
  const shortTitle = localTitle(input.title ?? HOME_TITLE, locale);
  const description = english ? (input.description ? tr.maybe(input.description) : SITE_DESCRIPTION_EN) : (input.description ?? SITE_DESCRIPTION);
  const url = english ? enUrl : zhUrl;
  const image = input.image ? (input.image.startsWith("http") ? input.image : `${base}${input.image}`) : `${base}/og/site.png`;
  const tags: MetaDescriptor[] = [
    { title },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: url },
    { property: "og:site_name", content: SITE.webName },
    { property: "og:type", content: input.type ?? "website" },
    { property: "og:title", content: shortTitle },
    { property: "og:description", content: description },
    { property: "og:url", content: url },
    { property: "og:image", content: image },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:locale", content: english ? "en_US" : SITE.locale.replace("-", "_") },
    { property: "og:locale:alternate", content: english ? SITE.locale.replace("-", "_") : "en_US" },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: shortTitle },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: image },
  ];
  if (input.noindex) tags.push({ name: "robots", content: input.nofollow ? "noindex, nofollow" : "noindex, follow" });
  else
    tags.push(
      { tagName: "link", rel: "alternate", hrefLang: SITE.locale, href: zhUrl },
      { tagName: "link", rel: "alternate", hrefLang: "en", href: enUrl },
      { tagName: "link", rel: "alternate", hrefLang: "x-default", href: zhUrl },
    );
  if (input.jsonLd) tags.push({ "script:ld+json": input.jsonLd });
  return tags;
}

export function organizationLd() {
  const base = siteUrl();
  const founder = SITE.organization.founder;
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE.webName,
    alternateName: SITE.organization.name,
    url: base,
    logo: `${base}${LOGO_PATH}`,
    ...(founder
      ? {
          founder: {
            "@type": "Person",
            name: founder.name,
            ...(founder.description ? { description: founder.description } : {}),
            ...(founder.url ? { sameAs: [founder.url] } : {}),
          },
        }
      : {}),
  };
}

/** The site's name for search results, on the home page (the Chinese name as its alternate): its url is the canonical home address. */
export function websiteLd() {
  return { "@context": "https://schema.org", "@type": "WebSite", name: SITE.webName, alternateName: SITE.name, url: `${siteUrl()}/` };
}

export function breadcrumbLd(items: Array<{ name: string; path: string }>) {
  const base = siteUrl();
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, item: `${base}${it.path}` })),
  };
}
