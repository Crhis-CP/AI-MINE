// The config keys each kind of source implements. Anything else is refused: a key a collector does not
// know would otherwise fall back silently to the generic parse (menus and sentence fragments as
// articles, dates never found).
import type { SourceRow } from "./types.ts";
import { z } from "zod";
import { SourceDateParseInput } from "@amp/contracts/time-assertion";
import { sha256, stableJson } from "../lib/ids.ts";

const languageNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
/** Declared BCP47 only; absent, unidentified or unsupported tags never become a language guess. */
export function normalizeSourceLanguage(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const locale = new Intl.Locale(value.trim()),
      language = locale.language;
    if (!language || ["und", "mul", "mis", "zxx"].includes(language) || !languageNames.of(language)) return null;
    return locale.baseName;
  } catch {
    return null;
  }
}

// Rules applied in collect.ts to every kind read through collectSource.
const COLLECTED = [
  "sourceDate",
  "_amp",
  "language",
  "allowUrlPrefixes",
  "denyUrlPrefixes",
  "ingestNoiseFilter",
  "itemUrlPrefixRewrite",
  "sortByPublishedAt",
  "detail",
  "fetchPublicContent",
];

const KEYS: Record<SourceRow["kind"], string[]> = {
  rss: [...COLLECTED, "feedUrl", "publishedAtField", "summaryIsBody", "preserveUrlFragment", "allowCategories", "denyCategories"],
  web_list: [
    ...COLLECTED,
    "url",
    "baseUrl",
    "parseMode",
    "cacheToleranceSeconds",
    "linksStartLine",
    "preserveUrlFragment",
    "itemSelector",
    "linkSelector",
    "titleSelector",
    "publishedAtSelector",
    "publishedAtRegex",
    "publishedAtUtcOffset",
  ],
  json_list: [
    ...COLLECTED,
    "url",
    "mode",
    "method",
    "headers",
    "bodyJson",
    "jsonKey",
    "windowVar",
    "itemsPath",
    "itemsObjectValues",
    "titlePaths",
    "summaryPaths",
    "summaryIsBody",
    "authorPaths",
    "publishedAtPath",
    "publishedAtUnit",
    "externalIdPath",
    "urlTemplate",
    "urlTemplateFallback",
    "rawDropKeys",
    "requireBoolean",
    "minNumeric",
  ],
  mp_account: ["wxid", "ghid", "nickname", "sourceDate"],
  external: ["sourceDate"],
};

// Objects with fixed keys (headers and bodyJson are request data, free-form).
const NESTED: Record<string, string[]> = {
  _amp: ["initialBackfillLimit", "initialBackfillMonths"],
  ingestNoiseFilter: ["dropMarkers", "dropMarkersTitleOnly", "keepIfMatches"],
  itemUrlPrefixRewrite: ["from", "to"],
  requireBoolean: ["path", "equals"],
  minNumeric: ["path", "min"],
  detail: [
    "sourceDate",
    "maxFetches",
    "publishedAtSelector",
    "publishedAtRegex",
    "publishedAtUtcOffset",
    "publishedAtAuthoritative",
    "upgradeDatePrecision",
    "titleSelector",
    "titleRegex",
    "titleAuthoritative",
    "summarySelector",
  ],
};

const VALUES: Record<string, string[]> = {
  publishedAtField: ["pubDate", "published", "dc:date"],
  parseMode: ["html", "markdown"],
};

const DATE_PROFILE = z.strictObject({
  format: SourceDateParseInput.shape.format.default("unknown"),
  formatPattern: SourceDateParseInput.shape.formatPattern.default(null),
  language: SourceDateParseInput.shape.language.default(null),
  timezone: SourceDateParseInput.shape.timezone.default(null),
  timezoneEvidence: SourceDateParseInput.shape.timezoneEvidence.default(null),
  meaning: SourceDateParseInput.shape.meaning.default("published"),
  publicationBasis: SourceDateParseInput.shape.publicationBasis.default("source_published"),
  basis: SourceDateParseInput.shape.basis.nullable().default(null),
});
/** A profile is only a parsing declaration; timezoneEvidence does not come from a country default. */
export function sourceDateProfile(config: Record<string, unknown>, detail = false) {
  const base = DATE_PROFILE.parse(config.sourceDate ?? {});
  const page = config.detail as Record<string, unknown> | undefined;
  return detail && page?.sourceDate ? DATE_PROFILE.parse({ ...base, ...z.record(z.string(), z.unknown()).parse(page.sourceDate) }) : base;
}

/** Excludes names, health/cursors, polling, limits and other edits that cannot change date attribution. */
export function sourceDateConfigHash(kind: SourceRow["kind"], config: Record<string, unknown>): string {
  const keys =
    kind === "rss"
      ? ["feedUrl", "publishedAtField", "preserveUrlFragment", "itemUrlPrefixRewrite"]
      : kind === "web_list"
        ? [
            "url",
            "baseUrl",
            "parseMode",
            "itemSelector",
            "linkSelector",
            "publishedAtSelector",
            "publishedAtRegex",
            "preserveUrlFragment",
            "itemUrlPrefixRewrite",
          ]
        : kind === "json_list"
          ? [
              "url",
              "method",
              "headers",
              "bodyJson",
              "mode",
              "jsonKey",
              "windowVar",
              "itemsPath",
              "itemsObjectValues",
              "urlTemplate",
              "urlTemplateFallback",
              "publishedAtPath",
              "publishedAtUnit",
              "itemUrlPrefixRewrite",
            ]
          : kind === "mp_account"
            ? ["ghid", "wxid"]
            : [];
  const page = (config.detail ?? {}) as Record<string, unknown>;
  return sha256(
    stableJson({
      recipe: "source-date/1",
      kind,
      profile: sourceDateProfile(config),
      detailProfile: sourceDateProfile(config, true),
      selectors: Object.fromEntries(keys.filter((key) => config[key] !== undefined).map((key) => [key, config[key]])),
      detail: Object.fromEntries(
        ["publishedAtSelector", "publishedAtRegex", "publishedAtAuthoritative", "upgradeDatePrecision"]
          .filter((key) => page[key] !== undefined)
          .map((key) => [key, page[key]]),
      ),
    }),
  );
}

/** The config entries a source of this kind would ignore or cannot run, e.g. ["parseMode=site_cards", "detail.titleFoo"]. */
export function unsupportedConfig(kind: SourceRow["kind"], config: Record<string, unknown>): string[] {
  const allowed = new Set(KEYS[kind] ?? []);
  const out: string[] = [];
  for (const [key, value] of Object.entries(config ?? {})) {
    if (!allowed.has(key)) out.push(key);
    else if (VALUES[key] && !VALUES[key]!.includes(String(value))) out.push(`${key}=${String(value)}`);
    else if (NESTED[key] && value && typeof value === "object") {
      for (const sub of Object.keys(value)) if (!NESTED[key]!.includes(sub)) out.push(`${key}.${sub}`);
    }
  }
  return out;
}

export class UnsupportedConfig extends Error {
  readonly statusCode = 400;
}

/** Refuses a config with entries its kind does not implement (admin create, edit and preview). */
export function assertSupportedConfig(kind: SourceRow["kind"], config: Record<string, unknown>): void {
  const bad = unsupportedConfig(kind, config);
  if (bad.length) throw new UnsupportedConfig(`不支持的配置项：${bad.join("、")}`);
  sourceDateProfile(config);
  sourceDateProfile(config, true);
}
