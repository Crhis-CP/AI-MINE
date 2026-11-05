// The reader interface in Chinese (the default addresses) or English (the same addresses under /en),
// from typed dictionaries (DEC-78). Content is not translated; only the interface is.
import { useMemo } from "react";
import { useLocation } from "react-router";
import { CATEGORY_LABELS } from "@amp/industry/taxonomy";
import { withSubject } from "@amp/industry/site";
import { en } from "./en.ts";
import { PHRASES, type Phrase } from "./phrases.ts";
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

/** The same page in the other language. */
export function otherLanguagePath(pathname: string, search: string, locale: Locale): string {
  const base = basePath(pathname);
  return (locale === "en" ? base : localizedPath(base, "en")) + search;
}

export function useLocale(): Locale {
  return localeOf(useLocation().pathname);
}

export function useT(): Dict {
  return DICTS[useLocale()];
}

/** Fills {name} placeholders in a dictionary string. */
export function fmt(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));
}

export function dictFor(locale: Locale): Dict {
  return DICTS[locale];
}

/** A news category's name in the interface language. */
export function useCategoryLabel(): (key: string) => string {
  const locale = useLocale();
  return (key) => (locale === "en" ? en.categories[key] : undefined) ?? (CATEGORY_LABELS as Record<string, string>)[key] ?? key;
}

export type { Phrase };
/** A phrase in the given language, with {name} placeholders filled; `.subject` adds the industry word in Chinese. */
export type Tr = ((phrase: Phrase, values?: Record<string, string | number>) => string) & {
  subject: (noun: Phrase) => string;
  /** A run-time string (a module label, a table value): translated when the dictionary has it, else unchanged. */
  maybe: (text: string) => string;
};
export function trFor(locale: Locale): Tr {
  const tr = ((phrase: Phrase, values?: Record<string, string | number>) => {
    const text: string = locale === "en" ? PHRASES[phrase] : phrase;
    return values ? fmt(text, values) : text;
  }) as Tr;
  // “矿业日报”: Chinese puts the industry word before the noun; the English entry already reads as a name.
  tr.subject = (noun) => (locale === "en" ? PHRASES[noun] : withSubject(noun));
  tr.maybe = (text) => (locale === "en" ? ((PHRASES as Record<string, string>)[text] ?? text) : text);
  return tr;
}

/** The phrase translator for the current page (Chinese keys, English values). */
export function useTr(): Tr {
  const locale = useLocale();
  // One translator per language, so it can sit in effect dependencies without re-running them.
  return useMemo(() => trFor(locale), [locale]);
}

/** Date helpers in the interface language (lib/format). */
export function useDateFormat() {
  const english = useLocale() === "en";
  return useMemo(() => dateFormatFor(english), [english]);
}
