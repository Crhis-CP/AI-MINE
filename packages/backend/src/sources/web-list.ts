// Web list pages: HTML with selectors, and Markdown through Jina Reader.
import * as cheerio from "cheerio";
import { guardedFetch } from "../lib/http-fetch.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { readable, type ExtractedBody } from "../content/extract.ts";
import { jinaRead } from "../providers/jina.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";
import { observeSourceDate, previewSourceDate, toDateCandidate } from "./date-extraction.ts";
import { getPath } from "./json-list.ts";
import type { SourceDateObservationInput } from "@amp/contracts/time-assertion";
import { identityKeyForUrl } from "../lib/url.ts";

const JINA_PREFIX = "https://r.jina.ai/";

/** A time followed by its zone: "10:00Z", "10:00:00+08:00", "10:00:00 +0000", "10:00:00 GMT". */
const EXPLICIT_ZONE = /\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)\b/i;

function atOffset(
  y: string | number,
  mo: string | number,
  d: string | number,
  h: string | number,
  mi: string | number,
  s: string | number,
  utcOffset: string,
): Date | null {
  const p = (n: string | number) => String(n).padStart(2, "0");
  const t = Date.parse(`${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(s)}${utcOffset}`);
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * A published date as a list page or article prints it. Date.parse is kept only where it reads the same
 * on every host: a time with its zone, and an ISO date alone (UTC midnight). Anything else it would read
 * in the server's local zone (UTC in Docker), so "2026-09-26 10:00" is read in the source's offset instead.
 */
export function parseLooseDate(value: string | null | undefined, utcOffset = "+08:00"): Date | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  if (EXPLICIT_ZONE.test(v) || /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const direct = Date.parse(v);
    if (Number.isFinite(direct) && /\d{4}/.test(v)) return new Date(direct);
  }
  // 2026-09-26 / 2026/09/26 / 2026-09-26T10:00 / 2026年9月26日 (+ optional time), interpreted in the given offset.
  const m = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:(?:T|\s*)(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(v);
  if (m) {
    const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
    return atOffset(y!, mo!, d!, h, mi, s, utcOffset);
  }
  // "Sep 26, 2026": Date.parse reads it in the host's zone, so take its fields and place them in the offset.
  const en = Date.parse(v.replace(/(\d)(st|nd|rd|th)/, "$1"));
  if (!Number.isFinite(en)) return null;
  const local = new Date(en);
  return atOffset(local.getFullYear(), local.getMonth() + 1, local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds(), utcOffset);
}

/** The calendar day of an instant in an offset such as "+08:00"; null for an offset it cannot read. */
function dayInOffset(at: Date, utcOffset: string): string | null {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(utcOffset);
  if (!m) return null;
  const minutes = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  return new Date(at.getTime() + minutes * 60_000).toISOString().slice(0, 10);
}

/**
 * The published time kept for a parsed source date, read as the upstream reads it (Owner 2026-10-05:
 * where the handoff's way differs from the upstream's, the upstream's): the instant when the source gives
 * one; otherwise the text as printed, by parseLooseDate in the source's offset. One difference: a date
 * alone is the start of that day in the source's offset whatever its spelling (the upstream reads an ISO
 * date alone as UTC midnight, Beijing 08:00), so pages can tell it from a real time and show the date
 * only (Owner 2026-10-05: 只显示日期).
 */
export function sourcePublishedAt(
  time: { raw: string; utc: string | null; local_date?: string | null; local_time?: string | null } | null | undefined,
  utcOffset = "+08:00",
): Date | null {
  if (!time) return null;
  if (time.utc) return new Date(time.utc);
  const day = time.local_date && /^\d{4}-\d{2}-\d{2}$/.test(time.local_date) ? time.local_date : null;
  // A time of day the date evidence could not place in a zone, so it kept the date alone: read in the
  // source's offset, as the upstream reads it, as long as it still falls on that day.
  if (/\d{1,2}:\d{2}/.test(time.raw)) {
    const read = parseLooseDate(time.raw, utcOffset);
    if (read && (!day || dayInOffset(read, utcOffset) === day)) return read;
  }
  if (day) {
    const start = Date.parse(`${day}T00:00:00${utcOffset}`);
    if (Number.isFinite(start)) return new Date(start);
  }
  return parseLooseDate(time.raw, utcOffset);
}

/** Only structured data identifying this article can contribute a publication date. */
function jsonLdDates($: cheerio.CheerioAPI, url: string, keepFragment = false): Array<{ raw: string; locator: string }> {
  const values: Array<{ raw: string; locator: string }> = [];
  const samePage = (value: unknown) => {
    if (typeof value !== "string") return false;
    try {
      const candidate = identityKeyForUrl(new URL(value, url).href, { keepFragment });
      return candidate !== null && candidate === identityKeyForUrl(url, { keepFragment });
    } catch {
      return false;
    }
  };
  const visit = (value: unknown, locator: string, depth = 0) => {
    if (depth > 6 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        visit(item, `${locator}[${i}]`, depth + 1);
      });
      return;
    }
    const row = value as Record<string, unknown>;
    const types = Array.isArray(row["@type"]) ? row["@type"] : [row["@type"]];
    const page = row.mainEntityOfPage;
    const identity = typeof page === "object" && page !== null ? (page as Record<string, unknown>)["@id"] : page;
    if (
      types.some((type) => typeof type === "string" && /(?:^|\/)(Article|NewsArticle|BlogPosting)$/.test(type)) &&
      [row.url, row["@id"], identity].some(samePage) &&
      typeof row.datePublished === "string"
    )
      values.push({ raw: row.datePublished, locator: `${locator}.datePublished` });
    visit(row["@graph"], `${locator}.@graph`, depth + 1);
  };
  $('script[type="application/ld+json"]').each((i, element) => {
    try {
      visit(JSON.parse($(element).text()), `script[type=application/ld+json][${i}]`);
    } catch {
      /* Broken JSON is not a date claim. */
    }
  });
  return values;
}

export function jsonLdPublished($: cheerio.CheerioAPI, _html: string, url?: string): string | null {
  return url ? (jsonLdDates($, url)[0]?.raw ?? null) : null;
}

function detailDate(text: string, url: string, source: SourceRow, $: cheerio.CheerioAPI | null, observedAt: string): SourceDateObservationInput {
  const d = source.config.detail ?? {},
    candidates: SourceDateObservationInput[] = [];
  const add = (raw: string, locator: string, standard = false) => {
    const item = observeSourceDate(source, url, raw, locator, { detail: true, observedAt, ...(standard ? { format: "unknown" } : {}) });
    if (standard) {
      item.meaning = "published";
      item.publicationBasis = "source_published";
      item.basis = `Source field: ${locator}`;
    }
    candidates.push(item);
  };
  if (d.publishedAtSelector) {
    const node = $?.(d.publishedAtSelector).first();
    add(node?.attr("datetime") ?? node?.attr("content") ?? node?.attr("title") ?? node?.text() ?? "", `selector:${d.publishedAtSelector}`);
  } else if (d.publishedAtRegex) add(new RegExp(d.publishedAtRegex).exec(text)?.[1] ?? "", `regex:${d.publishedAtRegex}`);
  if ($) {
    $('meta[property="article:published_time"], meta[name="pubdate"], meta[itemprop="datePublished"], time[itemprop="datePublished"]').each((i, el) => {
      const node = $(el),
        raw = node.attr("content") ?? node.attr("datetime") ?? node.text();
      const scope = node.closest("[itemscope]"),
        itemId = scope.attr("itemid");
      let bound = false;
      if (itemId) {
        try {
          const keepFragment = source.config.preserveUrlFragment === true;
          const identity = identityKeyForUrl(new URL(itemId, url).href, { keepFragment });
          bound = identity !== null && identity === identityKeyForUrl(url, { keepFragment });
        } catch {
          /* An invalid identity cannot describe this article. */
        }
      }
      const fragmentIdentity = source.config.preserveUrlFragment === true && !!new URL(url).hash;
      const pageMeta = node.is("meta") && node.parent().is("head") && (!itemId || bound) && (!fragmentIdentity || bound);
      const articleScope = bound && (scope.attr("itemtype") ?? "").split(/\s+/).some((type) => /(?:^|\/)(Article|NewsArticle|BlogPosting)$/.test(type));
      if (!pageMeta && !articleScope) return;
      if (raw.trim()) add(raw, `${pageMeta && !fragmentIdentity ? "head" : `itemscope:${itemId}`}/publication-metadata[${i}]`, true);
    });
    for (const item of jsonLdDates($, url, source.config.preserveUrlFragment === true)) add(item.raw, item.locator, true);
  }
  const primary = candidates.shift() ?? observeSourceDate(source, url, "", "page publication metadata absent", { detail: true, observedAt });
  if (candidates.length) primary.alternatives = candidates.map(toDateCandidate);
  return primary;
}

/** Prefix rules ignore the scheme: a Jina listing of an http:// address links its posts over http. */
const overHttps = (url: string) => url.replace(/^http:\/\//i, "https://");

export function allowed(url: string, source: SourceRow): boolean {
  const allow: string[] = (source.config.allowUrlPrefixes ?? []).map(overHttps);
  const deny: string[] = (source.config.denyUrlPrefixes ?? []).map(overHttps);
  const target = overHttps(url);
  if (deny.some((p) => target.startsWith(p))) return false;
  return allow.length === 0 || allow.some((p) => target.startsWith(p));
}

/** A link back to the listing page itself (skip links, in-page anchors such as #paper, #blog). */
function listingItself(url: string, listing: string): boolean {
  const bare = (x: URL) => `${x.host}${x.pathname.replace(/\/$/, "")}`;
  return bare(new URL(url)) === bare(new URL(listing));
}

/**
 * Navigation a listing links to but that is no post: the listing itself, year archives, and taxonomy,
 * author and pagination pages.
 */
function navigationLink(url: string, listing: string): boolean {
  if (listingItself(url, listing)) return true;
  const u = new URL(url);
  return /\/(label|labels|tag|tags|category|categories|author|authors|page)(\/|$)/i.test(u.pathname) || /\/(19|20)\d{2}(\/\d{1,2})?\/?$/.test(u.pathname);
}

/** Absolute http(s) URL; a link to the listing's own https site keeps https. */
function absolute(href: string | undefined, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const b = new URL(base);
    if (u.protocol === "http:" && b.protocol === "https:" && u.host === b.host) u.protocol = "https:";
    return u.toString();
  } catch {
    return null;
  }
}

async function fetchListingText(source: SourceRow): Promise<{ text: string; viaJina: boolean; base: string }> {
  const url = String(source.config.url ?? "");
  if (!url) throw new FetchError("url missing");
  if (url.startsWith(JINA_PREFIX)) {
    const target = url.slice(JINA_PREFIX.length);
    const page = await jinaRead(target, {
      purpose: "source_listing",
      subject: `source:${source.id}`,
      cacheToleranceSeconds: source.config.cacheToleranceSeconds,
      perRead: true,
    });
    return { text: page.markdown, viaJina: true, base: source.config.baseUrl ?? target };
  }
  const res = await guardedFetch(url, { headers: { accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8" }, timeoutMs: 25_000 });
  if (res.status !== 200) throw new FetchError(`HTTP ${res.status}`, res.status);
  const base = source.config.baseUrl ?? url;
  // Some listings are filled in by script from JSON that carries the list HTML (MOFCOM's page units
  // answer {"data":{"html":"<ul>…"}}): read that string, then parse it like any page.
  const path = source.config.htmlJsonPath;
  if (!path) return { text: res.text(), viaJina: false, base };
  let html: unknown;
  try {
    html = getPath(JSON.parse(res.text()), String(path));
  } catch {
    throw new FetchError("htmlJsonPath: the listing is not JSON");
  }
  if (typeof html !== "string") throw new FetchError(`htmlJsonPath: no string at ${path}`);
  return { text: html, viaJina: false, base };
}

export function fromMarkdown(md: string, base: string, source: SourceRow): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  const listing = String(source.config.url ?? base).replace(JINA_PREFIX, "");
  // Card links wrap an image and the text, [![alt](img) ##### Title …](url "Title"): images go first so the
  // link text is plain; a bare image link is then left without a title and skipped, as are nav-length labels.
  const text = md.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  // Listings whose teasers link other articles in their prose (Axios: "capping a [chaotic three weeks](…)")
  // take only links that begin their line, after heading, list, quote or emphasis marks and image links.
  const startsLine = (at: number) =>
    /^[\s>#*+_|-]*(?:\d+[.)]\s*)?[\s*_]*$/.test(text.slice(text.lastIndexOf("\n", at - 1) + 1, at).replace(/\[\]\([^)]*\)/g, ""));
  for (const m of text.matchAll(/\[([^\]]{6,1000})\]\((https?:\/\/[^)\s]+|\/[^)\s]*)(?:\s+"([^"]*)")?\)/g)) {
    const url = absolute(m[2], base);
    if (!url || seen.has(url) || !allowed(url, source) || navigationLink(url, listing)) continue;
    if (source.config.linksStartLine === true && !startsLine(m.index!)) continue;
    const label = collapseWhitespace(m[1]!.replace(/[*_`#]/g, ""));
    // A title attribute the card text already contains is the clean title, without dates and blurbs.
    const attr = collapseWhitespace(m[3] ?? "");
    const title = attr.length >= 6 && label.includes(attr) ? attr : label;
    if (title.length < 6) continue;
    seen.add(url);
    out.push({ url, title });
  }
  return out;
}

export function fromHtml(html: string, base: string, source: SourceRow): Candidate[] {
  const c = source.config;
  const $ = cheerio.load(html);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const listing = String(c.url ?? base).replace(JINA_PREFIX, "");
  // Sections of the listing page are posts only for sources that keep fragments as identity.
  const sectionsArePosts = c.preserveUrlFragment === true;
  const itemSel: string | undefined = c.itemSelector;
  const nodes = itemSel ? $(itemSel).toArray() : $("a[href]").toArray();
  for (const node of nodes) {
    const el = $(node);
    const linkEl = c.linkSelector ? (el.is(c.linkSelector) ? el : el.find(c.linkSelector).first()) : el.is("a") ? el : el.find("a[href]").first();
    const url = absolute(linkEl.attr("href"), base);
    if (!url || seen.has(url) || !allowed(url, source)) continue;
    if (!sectionsArePosts && listingItself(url, listing)) continue;
    const titleEl = c.titleSelector ? (el.is(c.titleSelector) ? el : el.find(c.titleSelector).first()) : linkEl;
    const title = collapseWhitespace(titleEl.text() || linkEl.attr("title") || "");
    if (!title) continue;
    let raw = "",
      locator = "listing publication field absent";
    if (c.publishedAtSelector) {
      const node = el.find(c.publishedAtSelector).first();
      raw = node.attr("datetime") ?? node.attr("title") ?? node.text();
      locator = `selector:${c.itemSelector ?? "a[href]"}/${c.publishedAtSelector}`;
    } else if (c.publishedAtRegex) {
      raw = new RegExp(c.publishedAtRegex).exec($.html(el))?.[1] ?? "";
      locator = `regex:${c.publishedAtRegex}`;
    }
    const sourceDateObservation = observeSourceDate(source, url, raw, locator);
    seen.add(url);
    const time = previewSourceDate(sourceDateObservation);
    out.push({ url, title, publishedAt: sourcePublishedAt(time, c.publishedAtUtcOffset), sourceDateObservation });
  }
  return out;
}

export async function fetchWebList(source: SourceRow): Promise<Candidate[]> {
  const { text, viaJina, base } = await fetchListingText(source);
  const mode = source.config.parseMode ?? (viaJina ? "markdown" : "html");
  const out = mode === "markdown" ? fromMarkdown(text, base, source) : fromHtml(text, base, source);
  if (out.length === 0) throw new FetchError(`no items matched (${mode})`);
  return out;
}

export interface DetailNeed {
  date: boolean;
  title: boolean;
  summary: boolean;
  /** Reuse HTML already needed for metadata; never fetch a page just for this hint. */
  body?: boolean;
}

/**
 * What a listing's detail pages add (config.detail): the date, title and summary its rules find. Each
 * rule reads the rendering it was written for. For a listing read through Jina, regexes match Jina's
 * text ("Published Time: …", "# Heading"), so that paid rendering is bought only when such a rule is
 * needed; selectors and page metadata read the page's own HTML.
 */
export async function fetchDetail(
  url: string,
  source: SourceRow,
  need: DetailNeed,
): Promise<{
  publishedAt: Date | null;
  sourceDateObservation?: SourceDateObservationInput;
  title: string | null;
  summary: string | null;
  body: ExtractedBody | null;
}> {
  const observedAt = new Date().toISOString();
  const d = source.config.detail ?? {};
  const jinaListing = String(source.config.url ?? "").startsWith(JINA_PREFIX);
  const dateInJina = need.date && jinaListing && !!d.publishedAtRegex;
  const titleInJina = need.title && jinaListing && !!d.titleRegex;
  const jina = dateInJina || titleInJina ? (await jinaRead(url, { purpose: "source_detail", subject: `source:${source.id}` })).raw : null;
  let html: string | null = null;
  let body: ExtractedBody | null = null;
  if ((need.date && !dateInJina) || (need.title && !titleInJina) || need.summary) {
    const res = await guardedFetch(url, { timeoutMs: 20_000 });
    if (res.status === 200) {
      html = res.text();
      if (need.body && /html/.test(res.headers.get("content-type") ?? "")) {
        try {
          body = readable(html, res.url);
        } catch {
          /* A failed extraction must not discard the detail metadata. */
        }
      }
    }
  }
  const $ = html === null ? null : cheerio.load(html);

  const dateText = dateInJina ? jina : html;
  const sourceDateObservation = need.date && dateText !== null ? detailDate(dateText, url, source, dateInJina ? null : $, observedAt) : undefined;

  let title: string | null = null;
  if (need.title) {
    const titleText = titleInJina ? jina : html;
    if (d.titleRegex && titleText !== null) title = collapseWhitespace(new RegExp(d.titleRegex, "m").exec(titleText)?.[1] ?? "") || null;
    else if (d.titleSelector && $) title = collapseWhitespace($(d.titleSelector).first().text()) || null;
  }

  let summary: string | null = null;
  if (need.summary && $) {
    const el = $(d.summarySelector).first();
    summary = collapseWhitespace(el.attr("content") ?? el.text()) || null;
  }
  const time = sourceDateObservation ? previewSourceDate(sourceDateObservation) : null;
  return { publishedAt: sourcePublishedAt(time, d.publishedAtUtcOffset), sourceDateObservation, title, summary, body };
}
