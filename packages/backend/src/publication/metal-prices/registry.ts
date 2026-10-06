// Metal price registry (TASK-0044): the free official sources and the series taken from them, kept as a data file
// in the industry pack (industry/metal-prices.json) as the upstream leaderboard kept its source registry. The whole
// file is checked on reading; a bad file throws instead of quietly dropping an entry.
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "../../config.ts";

/** Hard rule 3: the only hosts a fetch address or release link may use; each source lists its own from these. */
export const METAL_PRICE_HOSTS = ["www.stats.gov.cn", "www.worldbank.org", "thedocs.worldbank.org", "www.imf.org"] as const;

const SOURCE_KEYS = ["nbs", "worldbank", "imf"] as const;
export type MetalPriceSourceKey = (typeof SOURCE_KEYS)[number];
/** Series key prefix and period type of each source: the same pairs publication.metal_prices checks. */
const SERIES_PREFIX: Record<MetalPriceSourceKey, string> = { nbs: "nbs", worldbank: "wb", imf: "imf" };
const PERIOD_TYPE: Record<MetalPriceSourceKey, "ten_day" | "month"> = { nbs: "ten_day", worldbank: "month", imf: "month" };

const text = z.string().regex(/\S/, "must not be blank");
const texts = z.array(text).min(1);
const https = z.url({ protocol: /^https$/ });
/** Absent means enabled: a source or series is stopped by writing false. */
const enabled = z.boolean().default(true);
/** Written on a source, these are the defaults of its items. */
const itemDefaults = { benchmark: text.optional(), deliveryBasis: text.optional(), unit: text.optional(), sourceUnit: text.optional() };

const Source = z.strictObject({
  key: z.enum(SOURCE_KEYS),
  name: text,
  section: z.enum(["domestic", "international"]),
  frequency: z.enum(["ten_day", "month"]),
  currency: z.enum(["CNY", "USD"]),
  delay: text,
  staleDays: z.int().positive(),
  hosts: z.array(z.enum(METAL_PRICE_HOSTS)).min(1),
  officialUrl: https,
  terms: z.strictObject({ name: text, url: https }),
  attribution: texts,
  license: texts,
  /** Absent: values are shown as published. */
  decimals: z.int().min(0).max(6).optional(),
  /** Replaces the default LME sentence of the page while this source has data (TASK-0045). */
  lmeNote: text.optional(),
  enabled,
  ...itemDefaults,
});

const Item = z.strictObject({
  key: z.string().regex(/^(nbs|wb|imf)\.[a-z0-9_]+$/),
  source: z.enum(SOURCE_KEYS),
  /** The product name as the source writes it, matched exactly after normalizeSourceName. */
  sourceName: text,
  name: text,
  grade: text.optional(),
  /** Words the source's own description of the series must still contain (the World Bank's benchmark notes). */
  descriptionIncludes: texts.optional(),
  enabled,
  ...itemDefaults,
});

/** How a product name read from a source is compared with the registered one: NFKC, then no whitespace. */
export function normalizeSourceName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/gu, "");
}

const Registry = z
  .strictObject({ sources: z.array(Source).min(1), items: z.array(Item).min(1) })
  .superRefine(({ sources, items }, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    for (const [i, source] of sources.entries()) {
      if (sources.findIndex((other) => other.key === source.key) !== i) issue(["sources", i, "key"], `duplicate source ${source.key}`);
      if (source.frequency !== PERIOD_TYPE[source.key]) issue(["sources", i, "frequency"], `${source.key} publishes ${PERIOD_TYPE[source.key]} prices`);
      if (new Set(source.hosts).size !== source.hosts.length) issue(["sources", i, "hosts"], "duplicate host");
      if (source.enabled && !items.some((item) => item.source === source.key && item.enabled)) issue(["sources", i, "enabled"], "no enabled item");
    }
    for (const [i, item] of items.entries()) {
      const source = sources.find((candidate) => candidate.key === item.source);
      if (items.findIndex((other) => other.key === item.key) !== i) issue(["items", i, "key"], `duplicate item ${item.key}`);
      if (!source) {
        issue(["items", i, "source"], `unknown source ${item.source}`);
        continue;
      }
      if (!item.key.startsWith(`${SERIES_PREFIX[item.source]}.`)) issue(["items", i, "key"], `${item.key} does not start with ${SERIES_PREFIX[item.source]}.`);
      const name = normalizeSourceName(item.sourceName);
      if (items.findIndex((other) => other.source === item.source && normalizeSourceName(other.sourceName) === name) !== i)
        issue(["items", i, "sourceName"], `duplicate source name ${item.sourceName}`);
      for (const field of ["benchmark", "unit", "sourceUnit"] as const)
        if (!(item[field] ?? source[field])) issue(["items", i, field], `no ${field} on the item or its source`);
    }
  })
  // Fill the source defaults into its items; absent optional values become null.
  .transform(({ sources, items }) => ({
    sources: sources.map(({ benchmark, deliveryBasis, unit, sourceUnit, decimals, lmeNote, ...source }) => ({
      ...source,
      decimals: decimals ?? null,
      lmeNote: lmeNote ?? null,
    })),
    items: items.map((item) => {
      const source = sources.find((candidate) => candidate.key === item.source)!;
      return {
        ...item,
        grade: item.grade ?? null,
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
