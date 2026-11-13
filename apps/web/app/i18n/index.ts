// The reader interface in Chinese (the default addresses) or English (the same addresses under /en),
// from typed dictionaries (DEC-78). Content is not translated; only the interface is.
import { use, useCallback, useMemo } from "react";
import { useLocation, type Path, type To } from "react-router";
import { categoryFilterKeys, isCategoryFilterKey } from "@amp/contracts/taxonomy";
import { CATEGORY_LABELS } from "@amp/industry/taxonomy";
import { withSubject } from "@amp/industry/site";
import { en } from "./en.ts";
import type { Phrase } from "./phrases.ts";
import { dateFormatFor } from "../lib/format";
import { zh } from "./zh.ts";

type Widen<T> = T extends string ? string : T extends Record<string, unknown> ? { [K in keyof T]: Widen<T[K]> } : T;
export type Dict = Widen<typeof zh>;
export type Locale = "zh" | "en";

const DICTS: Record<Locale, Dict> = { zh, en };

/** The interface language of a path: /en and anything under it is English. */
export function localeOf(pathname: string): Locale {
  return pathname === "/en" || pathname.startsWith("/en/") ? "en" : "zh";
}

/** A path without its language prefix, for matching sections ("/en/all" → "/all", "/en" → "/"). */
export function basePath(pathname: string): string {
  if (localeOf(pathname) === "zh") return pathname;
  return pathname.slice(3) || "/";
}

/** Addresses that are not reader pages keep their one address in every language. */
const SHARED = /^\/(?:api|feed|admin|rss|og|media|v1|v3|mcp)(?:[/?#.]|$)|\.(?:xml|json|png|svg|ico|txt)(?:[?#]|$)/;

/** An internal address in the given language; external, relative and shared addresses pass through. */
export function localizedPath(to: string, locale: Locale): string {
  if (locale === "zh" || !to.startsWith("/") || to.startsWith("//") || SHARED.test(to) || localeOf(to.split(/[?#]/)[0]!) === "en") return to;
  return to === "/" ? "/en" : to.startsWith("/?") || to.startsWith("/#") ? `/en${to.slice(1)}` : `/en${to}`;
}

/** A router target (an address, or a path object with a pathname) in the given language. */
export function localizeTo<T extends To>(to: T, locale: Locale): T {
  if (typeof to === "string") return localizedPath(to, locale) as T;
  const path = to as Partial<Path>;
  return (path.pathname ? { ...path, pathname: localizedPath(path.pathname, locale) } : to) as T;
}

/** An internal address in the language of the page at `from` (in a loader: the request's URL), for redirects. */
export function localizedFrom(from: string, to: string): string {
  return localizedPath(to, localeOf(new URL(from, "http://page.local").pathname));
}

/** The same page in the other language. */
export function otherLanguagePath(pathname: string, search: string, locale: Locale): string {
  const base = basePath(pathname);
  return (locale === "en" ? base : localizedPath(base, "en")) + search;
}

export function useLocale(): Locale {
  return localeOf(useLocation().pathname);
}

/**
 * Internal addresses in the current page's language: under /en a reader stays in English wherever a link, a
 * form, a navigation or a share link takes them (i18n/navigation.tsx wraps the router's own for this).
 */
export function useLocalize(): <T extends To>(to: T) => T {
  const locale = useLocale();
  return useCallback(<T extends To>(to: T): T => localizeTo(to, locale), [locale]);
}

export function useT(): Dict {
  return DICTS[useLocale()];
}

/** Fills {name} placeholders in a dictionary string. */
export function fmt(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));
}

/** A news category's name in the interface language; a retired key (ADR-0031) names the classes it now covers. */
export function useCategoryLabel(): (key: string) => string {
  const locale = useLocale();
  const one = (key: string) => (locale === "en" ? en.categories[key] : undefined) ?? (CATEGORY_LABELS as Record<string, string>)[key] ?? key;
  return (key) =>
    isCategoryFilterKey(key)
      ? categoryFilterKeys(key)
          .map(one)
          .join(locale === "en" ? " / " : "、")
      : one(key);
}

/** Category keys by their Chinese names: the model tags an item with its category's name as well. */
const CATEGORY_BY_NAME = new Map(Object.entries(CATEGORY_LABELS as Record<string, string>).map(([key, label]) => [label, key]));

/** A tag as the interface shows it: in English a category's name reads as the English category (the filter keeps the tag). */
export function useTagLabel(): (tag: string) => string {
  const english = useLocale() === "en";
  return useCallback((tag: string) => (english ? en.categories[CATEGORY_BY_NAME.get(tag) ?? ""] : undefined) ?? tag, [english]);
}

export type { Phrase };

/**
 * The English phrase list (phrases.ts, about 80 KB) is only needed by the English interface, so Chinese pages do
 * not download it (TASK-0593). The server registers it at start (entry.server.tsx); in the browser an English page
 * fetches it on first use: hydration and a switch to English wait for it, Chinese pages never ask.
 */
let english: Readonly<Record<Phrase, string>> | null = null;
let englishLoading: Promise<void> | null = null;
export function registerEnglishPhrases(phrases: Readonly<Record<Phrase, string>>): void {
  english = phrases;
}
export function loadEnglishPhrases(): Promise<void> {
  englishLoading ??= import("./phrases.ts").then((module) => registerEnglishPhrases(module.PHRASES));
  return englishLoading;
}
function englishPhrases(): Readonly<Record<Phrase, string>> {
  // Route meta functions (lib/seo.ts) translate titles while <Meta> renders, without useTr: on an English page's
  // first render in the browser they wait for the phrases the same way useTr does.
  if (!english) use(loadEnglishPhrases());
  if (!english) throw new Error("English phrases are not loaded");
  return english;
}

/** A phrase in the given language, with {name} placeholders filled; `.subject` adds the industry word in Chinese. */
export type Tr = ((phrase: Phrase, values?: Record<string, string | number>) => string) & {
  subject: (noun: Phrase) => string;
  /** A run-time string (a module label, a table value): translated when the dictionary has it, else unchanged. */
  maybe: (text: string) => string;
};
export function trFor(locale: Locale): Tr {
  const tr = ((phrase: Phrase, values?: Record<string, string | number>) => {
    const text: string = locale === "en" ? englishPhrases()[phrase] : phrase;
    return values ? fmt(text, values) : text;
  }) as Tr;
  // “矿业日报”: Chinese puts the industry word before the noun; the English entry already reads as a name.
  tr.subject = (noun) => (locale === "en" ? englishPhrases()[noun] : withSubject(noun));
  tr.maybe = (text) => (locale === "en" ? ((englishPhrases() as Record<string, string>)[text] ?? text) : text);
  return tr;
}

/** The phrase translator for the current page (Chinese keys, English values). */
export function useTr(): Tr {
  const locale = useLocale();
  // Suspends (keeping the page on screen) until the English phrases have arrived; never on Chinese pages.
  if (locale === "en" && !english) use(loadEnglishPhrases());
  // One translator per language, so it can sit in effect dependencies without re-running them.
  return useMemo(() => trFor(locale), [locale]);
}

/** Date helpers in the interface language (lib/format). */
export function useDateFormat() {
  const english = useLocale() === "en";
  return useMemo(() => dateFormatFor(english), [english]);
}
