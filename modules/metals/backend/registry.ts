// Metal price registry (TASK-0044): the free official sources and the series taken from them, kept as a data file
// in the industry pack (industry/metal-prices.json) as the upstream leaderboard kept its source registry. The whole
// file is checked on reading; a bad file throws instead of quietly dropping an entry.
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "@amp/backend/config";

/** Hard rule 3: the only hosts a fetch address or release link may use; each source lists its own from these. */
export const METAL_PRICE_HOSTS = [
  "www.stats.gov.cn",
  "www.worldbank.org",
  "thedocs.worldbank.org",
  "www.imf.org",
  "www.cbr.ru",
  "bank.gov.ua",
  "cif.mofcom.gov.cn",
  "www.cochilco.cl",
  "www.safe.gov.cn",
] as const;

const SOURCE_KEYS = ["nbs", "worldbank", "imf", "cbr", "mofcom", "cochilco", "safe"] as const;
export type MetalPriceSourceKey = (typeof SOURCE_KEYS)[number];
/** Series key prefix and period type of each source: the same pairs publication.metal_prices checks. */
const SERIES_PREFIX: Record<MetalPriceSourceKey, string> = {
  nbs: "nbs",
  worldbank: "wb",
  imf: "imf",
  cbr: "cbr",
  mofcom: "mofcom",
  cochilco: "cochilco",
  safe: "safe",
};
const PERIOD_TYPE: Record<MetalPriceSourceKey, "ten_day" | "month" | "day" | "week"> = {
  nbs: "ten_day",
  worldbank: "month",
  imf: "month",
  cbr: "day",
  mofcom: "week",
  cochilco: "day",
  safe: "day",
};

const text = z.string().regex(/\S/, "must not be blank");
const texts = z.array(text).min(1);
const https = z.url({ protocol: /^https$/ });
/** Absent means enabled: a source or series is stopped by writing false. */
const enabled = z.boolean().default(true);
/** A positive decimal written as text, so a factor is never a rounded JavaScript number. */
const factor = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/)
  .refine((value) => /[1-9]/.test(value), "must be positive");
/**
 * TASK-0572: the price is also shown converted into another currency, below the published one, which stays first and
 * unchanged. value × factor ÷ rate, rounded to `decimals`, with the rate series' value of the quote's period end or of
 * the latest day before it no more than `withinDays` earlier (a rate published later is never used; none in that
 * window, no conversion is shown). The rate is a `rate: true` series of any source quoted in the price's currency.
 */
const Secondary = z.strictObject({
  rate: text,
  factor,
  unit: text,
  currency: z.enum(["CNY", "USD"]),
  decimals: z.int().min(0).max(6),
  withinDays: z.int().min(0).max(31),
});
/** Written on a source, these are the defaults of its items. */
const itemDefaults = {
  benchmark: text.optional(),
  deliveryBasis: text.optional(),
  unit: text.optional(),
  sourceUnit: text.optional(),
  secondary: Secondary.optional(),
};

const Source = z.strictObject({
  key: z.enum(SOURCE_KEYS),
  name: text,
  section: z.enum(["domestic", "international"]),
  frequency: z.enum(["ten_day", "month", "day", "week"]),
  currency: z.enum(["CNY", "USD", "RUB"]),
  delay: text,
  staleDays: z.int().positive(),
  hosts: z.array(z.enum(METAL_PRICE_HOSTS)).min(1),
  officialUrl: https,
  terms: z.strictObject({ name: text, url: https }),
  attribution: texts,
  license: texts,
  /** Absent: values are shown as published. */
  decimals: z.int().min(0).max(6).optional(),
  enabled,
  ...itemDefaults,
});

const Item = z.strictObject({
  key: z.string().regex(/^(nbs|wb|imf|cbr|mofcom|cochilco|safe)\.[a-z0-9_]+$/),
  source: z.enum(SOURCE_KEYS),
  /** The product name as the source writes it, matched exactly after normalizeSourceName. */
  sourceName: text,
  sourceId: z.string().regex(/^\d+$/).optional(),
  name: text,
  grade: text.optional(),
  metal: text.optional(),
  quote: text.optional(),
  spec: text.optional(),
  footnote: text.optional(),
  /** Words the source's own description of the series must still contain (the World Bank's benchmark notes). */
  descriptionIncludes: texts.optional(),
  rate: z.boolean().default(false),
  convert: z
    .strictObject({
      rate: text,
      factor,
      unit: text,
      currency: z.enum(["CNY", "USD"]),
    })
    .optional(),
  enabled,
  ...itemDefaults,
});

/** How a product name read from a source is compared with the registered one: NFKC, then no whitespace. */
export function normalizeSourceName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/gu, "");
}

const Registry = z
  .strictObject({
    sources: z.array(Source).min(1),
    items: z.array(Item).min(1),
    metals: z.array(z.strictObject({ key: text, name: text })).min(1),
    intro: text,
    frequencies: z.array(z.strictObject({ key: Source.shape.frequency, tag: text, compare: text })).min(1),
    footnotes: z.array(z.strictObject({ key: text, text, link: z.strictObject({ name: text, url: https }).optional() })),
    notes: z.array(z.strictObject({ text, link: z.strictObject({ name: text, url: https }).optional(), sources: z.array(z.enum(SOURCE_KEYS)).optional() })),
    officialLinks: z.array(z.strictObject({ name: text, note: text, url: https })).min(1),
  })
  .superRefine(({ sources, items, metals, frequencies, footnotes, notes }, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    for (const [field, rows, key] of [
      ["metals", metals, "key"],
      ["frequencies", frequencies, "key"],
      ["frequencies", frequencies, "tag"],
      ["footnotes", footnotes, "key"],
    ] as const) {
      const seen = new Set<string>();
      for (const [i, row] of rows.entries()) {
        const value = key === "tag" && "tag" in row ? row.tag : row.key;
        if (seen.has(value)) issue([field, i, key], "duplicate key or tag");
        seen.add(value);
      }
    }
    for (const [field, rows, allowed] of [
      ["footnotes", footnotes, ["link"]],
      ["notes", notes, ["link", "tags", "compare"]],
    ] as const) {
      for (const [i, row] of rows.entries()) {
        const links = row.text.match(/\{link\}/g)?.length ?? 0;
        const remainder = row.text.replace(/\{(link|tags|compare)\}/g, (token, key: string) => ((allowed as readonly string[]).includes(key) ? "" : token));
        if (links !== (row.link ? 1 : 0) || /[{}]/.test(remainder)) issue([field, i, "text"], "invalid placeholder or link");
      }
    }
    // A converted price needs a rate series quoted in the price's own currency, and lands in another currency.
    // A registry narrowed to other sources (as tests do) may leave the rate's whole source out: that converts nothing.
    const checkSecondary = (secondary: z.infer<typeof Secondary>, currency: string, path: (string | number)[]) => {
      const rate = items.find((candidate) => candidate.key === secondary.rate);
      const rateSource = sources.find((candidate) => candidate.key === rate?.source);
      const named = SOURCE_KEYS.find((key) => secondary.rate.startsWith(`${SERIES_PREFIX[key]}.`));
      if (!rate && named !== undefined && !sources.some((candidate) => candidate.key === named)) return;
      if (!rate?.rate || rateSource?.currency !== currency) issue([...path, "rate"], "must reference a rate quoted in the price's currency");
      if (secondary.currency === currency) issue([...path, "currency"], "must differ from the price's currency");
    };
    for (const [i, source] of sources.entries()) if (source.secondary) checkSecondary(source.secondary, source.currency, ["sources", i, "secondary"]);
    for (const [i, source] of sources.entries()) {
      if (sources.findIndex((other) => other.key === source.key) !== i) issue(["sources", i, "key"], `duplicate source ${source.key}`);
      if (source.frequency !== PERIOD_TYPE[source.key]) issue(["sources", i, "frequency"], `${source.key} publishes ${PERIOD_TYPE[source.key]} prices`);
      if (new Set(source.hosts).size !== source.hosts.length) issue(["sources", i, "hosts"], "duplicate host");
      if (source.enabled && !items.some((item) => item.source === source.key && item.enabled)) issue(["sources", i, "enabled"], "no enabled item");
      if (source.enabled && !frequencies.some((frequency) => frequency.key === source.frequency))
        issue(["sources", i, "frequency"], "frequency is not registered");
    }
    for (const [i, item] of items.entries()) {
      const source = sources.find((candidate) => candidate.key === item.source);
      if ((item.source === "mofcom") !== (item.sourceId !== undefined)) issue(["items", i, "sourceId"], "sourceId is required only for mofcom");
      if (item.enabled && !item.rate && !item.metal) issue(["items", i, "metal"], "enabled item needs a metal");
      if (item.enabled && !item.rate && !item.quote) issue(["items", i, "quote"], "enabled item needs a quote");
      if (item.metal && !metals.some((metal) => metal.key === item.metal)) issue(["items", i, "metal"], "unknown metal");
      if (item.footnote && !footnotes.some((footnote) => footnote.key === item.footnote)) issue(["items", i, "footnote"], "unknown footnote");
      if (items.findIndex((other) => other.key === item.key) !== i) issue(["items", i, "key"], `duplicate item ${item.key}`);
      if (!source) {
        issue(["items", i, "source"], `unknown source ${item.source}`);
        continue;
      }
      if (item.rate)
        for (const field of ["metal", "quote", "spec", "footnote", "convert", "secondary"] as const)
          if (item[field] !== undefined) issue(["items", i, field], "a rate cannot carry quote presentation or conversion");
      if (item.secondary) checkSecondary(item.secondary, source.currency, ["items", i, "secondary"]);
      if (item.convert && (item.secondary ?? source.secondary)) issue(["items", i, "secondary"], "a converted quote cannot also carry a second conversion");
      if (item.convert) {
        const rate = items.find((candidate) => candidate.key === item.convert!.rate);
        if (!rate?.rate || rate.source !== item.source) issue(["items", i, "convert", "rate"], "must reference a rate on the same source");
        else if (item.enabled && !rate.enabled) issue(["items", i, "convert", "rate"], "enabled quote needs an enabled rate");
      }
      if (item.enabled && source.currency !== "CNY" && source.currency !== "USD" && !item.rate && !item.convert)
        issue(["items", i, "convert"], "this source currency requires conversion or a rate");
      if (!item.key.startsWith(`${SERIES_PREFIX[item.source]}.`)) issue(["items", i, "key"], `${item.key} does not start with ${SERIES_PREFIX[item.source]}.`);
      const name = normalizeSourceName(item.sourceName);
      if (items.findIndex((other) => other.source === item.source && normalizeSourceName(other.sourceName) === name) !== i)
        issue(["items", i, "sourceName"], `duplicate source name ${item.sourceName}`);
      for (const field of ["benchmark", "unit", "sourceUnit"] as const)
        if (!(item[field] ?? source[field])) issue(["items", i, field], `no ${field} on the item or its source`);
    }
  })
  // Fill the source defaults into its items; absent optional values become null.
  .transform(({ sources, items, ...presentation }) => ({
    ...presentation,
    sources: sources.map(({ benchmark, deliveryBasis, unit, sourceUnit, secondary, decimals, ...source }) => ({
      ...source,
      decimals: decimals ?? null,
    })),
    items: items.map((item) => {
      const source = sources.find((candidate) => candidate.key === item.source)!;
      return {
        ...item,
        grade: item.grade ?? null,
        convert: item.convert ?? null,
        // Rates are never displayed, so a source's default conversion does not reach them.
        secondary: item.rate ? null : (item.secondary ?? source.secondary ?? null),
        metal: item.metal ?? null,
        quote: item.quote ?? null,
        spec: item.spec ?? null,
        footnote: item.footnote ?? null,
        benchmark: (item.benchmark ?? source.benchmark)!,
        deliveryBasis: item.deliveryBasis ?? source.deliveryBasis ?? null,
        unit: (item.unit ?? source.unit)!,
        sourceUnit: (item.sourceUnit ?? source.sourceUnit)!,
        descriptionIncludes: item.descriptionIncludes ?? [],
      };
    }),
  }));
export type MetalPriceRegistry = z.output<typeof Registry>;
export type MetalPriceSource = MetalPriceRegistry["sources"][number];
export type MetalPriceItem = MetalPriceRegistry["items"][number];

/** Checks a whole registry (the file's, or data given by a test); a bad one throws naming every problem. */
export function parseMetalPriceRegistry(data: unknown): MetalPriceRegistry {
  const parsed = Registry.safeParse(data);
  if (!parsed.success)
    throw new Error(`metal price registry: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "file"}: ${issue.message}`).join("; ")}`);
  return parsed.data;
}

export function loadMetalPriceRegistry(file = path.join(REPO_ROOT, "industry/metal-prices.json")): MetalPriceRegistry {
  return parseMetalPriceRegistry(JSON.parse(readFileSync(file, "utf8")));
}

/** Hard rule 3 at fetch time (INV-33): an https address on one of the source's registered hosts, also after redirects. */
export function onSourceHost(source: Pick<MetalPriceSource, "hosts">, url: string): boolean {
  const parsed = URL.parse(url);
  return parsed?.protocol === "https:" && source.hosts.some((host) => host === parsed.host);
}
