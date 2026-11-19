// The rewritten reader's languages (DEC-78 bilingual base): every page answers at its Chinese address and under /en,
// and reads its language from the path. This replaces the phrase-keyed scheme of app/i18n, which stays with the old
// reader and the admin. Plan 3.1 grows the dictionary; the skeleton names only its own few lines.

export type Locale = "zh" | "en";

export function localeOf(pathname: string): Locale {
  return pathname === "/en" || pathname.startsWith("/en/") ? "en" : "zh";
}

/** A site path in the given language: "/all" stays "/all" in Chinese and becomes "/en/all" in English. */
export function localizedPath(to: string, locale: Locale): string {
  if (locale === "zh") return to;
  return to === "/" ? "/en" : `/en${to}`;
}

const WORDS = {
  zh: {
    skip: "跳到正文",
    picks: "精选",
    empty: "还没有精选内容。",
    notFound: "这里没有内容",
    notFoundBody: "你访问的页面不存在，或内容已不再公开。",
    unavailable: "暂时无法加载",
    unavailableBody: "服务暂时繁忙，请稍后再试。",
    home: "回到首页",
    license: "互联网新闻信息服务许可证：",
  },
  en: {
    skip: "Skip to content",
    picks: "Featured",
    empty: "Nothing has been featured yet.",
    notFound: "Nothing here",
    notFoundBody: "This page does not exist, or its content is no longer public.",
    unavailable: "Temporarily unavailable",
    unavailableBody: "The service is busy. Please try again shortly.",
    home: "Back to home",
    license: "Internet news information service licence: ",
  },
} as const satisfies Record<Locale, Record<string, string>>;

export type Words = (typeof WORDS)[Locale];

export function wordsFor(locale: Locale): Words {
  return WORDS[locale];
}
