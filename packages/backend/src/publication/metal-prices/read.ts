// Site-only price projection: registry presentation and stored decimal values, without acquisition or writes.
import { MetalPrices } from "@amp/contracts/http/public";
import { beijingDate } from "@amp/contracts/time";
import { dbOf } from "../../db.ts";
import { loadMetalPriceRegistry, parseMetalPriceRegistry, type MetalPriceItem } from "./registry.ts";

const sql = dbOf("publication");
type Item = MetalPriceItem;
interface Price {
  start: string;
  end: string;
  label: string;
  value: string;
  unit: string;
  currency: string;
  release: string;
  url: string;
  date: string | null;
  rate_unit: string | null;
  rate_currency: string | null;
  previous_start: string | null;
  previous_end: string | null;
  previous_label: string | null;
  previous_value: string | null;
  previous_unit: string | null;
  previous_currency: string | null;
  previous_rate_unit: string | null;
  previous_rate_currency: string | null;
  percent: string | null;
}

export async function loadMetalPrices(now = new Date(), input?: unknown): Promise<MetalPrices> {
  const registry = input === undefined ? loadMetalPriceRegistry() : parseMetalPriceRegistry(input);
  const sources = registry.sources.filter((source) => source.enabled);
  const frequencies = registry.frequencies.filter((f) => sources.some((source) => source.frequency === f.key));
  const items = registry.items.filter((item) => item.enabled && !item.rate && sources.some((s) => s.key === item.source));
  const ordered = registry.metals.flatMap((metal) =>
    items
      .filter((item) => item.metal === metal.key)
      .sort((a, b) => {
        const source = (item: Item) => sources.find((s) => s.key === item.source)!;
        return (
          frequencies.findIndex((f) => f.key === source(a).frequency) - frequencies.findIndex((f) => f.key === source(b).frequency) ||
          sources.indexOf(source(a)) - sources.indexOf(source(b))
        );
      }),
  );
  const selected = await sql.begin("read only isolation level repeatable read", async (tx) => {
    const out = new Map<string, Price>();
    for (const item of ordered) {
      const source = sources.find((s) => s.key === item.source)!;
      const convert = item.convert,
        frequency: string = source.frequency;
      const [row] = await tx<Price[]>`
        WITH versions AS (
          SELECT DISTINCT ON (series_key, period_start) series_key, currency, unit, period_start, period_end, period_label,
            value, release_label, release_url, released_on, first_fetched_at
          FROM publication.metal_prices WHERE series_key IN (${item.key}, ${convert?.rate ?? item.key})
          ORDER BY series_key, period_start DESC, first_fetched_at DESC, released_on DESC NULLS LAST, release_label DESC
        ), prices AS (
          SELECT p.*, r.unit AS rate_unit, r.currency AS rate_currency,
            CASE WHEN ${!!convert} THEN p.value * ${convert?.factor ?? "1"}::numeric / r.value ELSE p.value END AS displayed
          FROM versions p LEFT JOIN versions r ON r.series_key = ${convert?.rate ?? ""} AND r.period_start = p.period_start
          WHERE p.series_key = ${item.key} AND (NOT ${!!convert} OR r.value IS NOT NULL)
        ), current AS (SELECT * FROM prices ORDER BY period_start DESC LIMIT 1)
        SELECT c.period_start::text AS start, c.period_end::text AS end, c.period_label AS label, c.displayed::text AS value,
          c.unit, c.currency, c.release_label AS release, c.release_url AS url, c.released_on::text AS date, c.rate_unit, c.rate_currency,
          p.period_start::text AS previous_start, p.period_end::text AS previous_end, p.period_label AS previous_label,
          p.displayed::text AS previous_value, p.unit AS previous_unit, p.currency AS previous_currency,
          p.rate_unit AS previous_rate_unit, p.rate_currency AS previous_rate_currency,
          pg_catalog.round((c.displayed - p.displayed) / p.displayed * 100, 1)::text AS percent
        FROM current c LEFT JOIN LATERAL (
          SELECT * FROM prices p WHERE p.period_start < c.period_start AND
            (${frequency} = 'day' OR (${frequency} = 'week' AND p.period_start = c.period_start - 7)
              OR (${frequency} NOT IN ('day','week') AND p.period_end = c.period_start - 1))
          ORDER BY p.period_start DESC LIMIT 1
        ) p ON true`;
      if (!row) continue;
      const rate = convert ? registry.items.find((r) => r.key === convert.rate) : null;
      if (
        row.unit !== item.unit ||
        row.currency !== source.currency ||
        (convert && (!rate || row.rate_unit !== rate.unit || row.rate_currency !== source.currency))
      )
        throw new Error(`Price unit/currency mismatch: ${item.key}`);
      out.set(item.key, row);
    }
    return out;
  });
  const today = beijingDate(now),
    yearPrefix = `${today.slice(0, 4)}年`;
  const presentationSources = sources.map((source) => {
    const rows = items
      .filter((item) => item.source === source.key)
      .map((item) => selected.get(item.key))
      .filter((row): row is Price => !!row);
    rows.sort((a, b) => b.end.localeCompare(a.end));
    const newest = rows[0];
    const status = !newest ? "empty" : new Date(Date.parse(newest.end) + source.staleDays * 86400_000).toISOString().slice(0, 10) < today ? "stale" : "fresh";
    return {
      key: source.key,
      name: source.name,
      tag: frequencies.find((f) => f.key === source.frequency)!.tag,
      status,
      latest: newest ? { label: newest.label, release: { label: newest.release, url: newest.url, date: newest.date } } : null,
    };
  });
  const references = new Map<string, number>();
  const metals = registry.metals.flatMap((metal) => {
    const quotes = ordered
      .filter((item) => item.metal === metal.key)
      .map((item) => {
        const source = sources.find((s) => s.key === item.source)!,
          row = selected.get(item.key),
          convert = item.convert;
        if (item.footnote && !references.has(item.footnote)) references.set(item.footnote, references.size + 1);
        const compared =
          row?.previous_value &&
          row.previous_unit === row.unit &&
          row.previous_currency === row.currency &&
          (!convert || (row.previous_rate_unit === row.rate_unit && row.previous_rate_currency === row.rate_currency));
        return {
          key: item.key,
          source: item.source,
          title: item.quote!,
          spec: item.spec,
          footnote: item.footnote ? references.get(item.footnote)! : null,
          value: row?.value ?? null,
          unit: convert?.unit ?? item.unit,
          currency: convert?.currency ?? source.currency,
          decimals: source.decimals,
          period: row ? { start: row.start, end: row.end, label: row.label } : null,
          change: compared
            ? {
                percent: row!.percent!,
                previous: { value: row!.previous_value!, period: { start: row!.previous_start!, end: row!.previous_end!, label: row!.previous_label! } },
              }
            : null,
        };
      });
    return quotes.length ? [{ ...metal, quotes }] : [];
  });
  const short = (label: string) => (label.startsWith(yearPrefix) ? label.slice(yearPrefix.length) : label);
  const latest = frequencies.map((frequency) => {
    const groups = new Map<string, { label: string; end: string; stale: boolean; metals: string[] }>();
    for (const metal of metals)
      for (const quote of metal.quotes) {
        const source = presentationSources.find((s) => s.key === quote.source)!;
        if (source.tag !== frequency.tag || !quote.period) continue;
        const group = groups.get(quote.period.label) ?? { label: short(quote.period.label), end: quote.period.end, stale: false, metals: [] };
        if (quote.period.end > group.end) group.end = quote.period.end;
        group.stale ||= source.status === "stale";
        if (!group.metals.includes(metal.name)) group.metals.push(metal.name);
        groups.set(quote.period.label, group);
      }
    const [head, ...extras] = [...groups.values()].sort((a, b) => b.end.localeCompare(a.end));
    return { tag: frequency.tag, label: head?.label ?? null, stale: head?.stale ?? false, extras: extras.map(({ end: _end, ...rest }) => rest) };
  });
  const notes: MetalPrices["notes"] = [...references].map(([key, ref]) => {
    const note = registry.footnotes.find((n) => n.key === key)!;
    return { ref, text: note.text, link: note.link ?? null };
  });
  for (const note of registry.notes)
    if (!note.sources || note.sources.some((key) => sources.some((s) => s.key === key)))
      notes.push({
        ref: null,
        text: note.text.replaceAll("{tags}", frequencies.map((f) => f.tag).join("、")).replaceAll("{compare}", frequencies.map((f) => f.compare).join("，")),
        link: note.link ?? null,
      });
  return MetalPrices.parse({
    generatedAt: now.toISOString(),
    intro: registry.intro,
    sources: presentationSources,
    metals,
    latest,
    notes,
    officialLinks: registry.officialLinks,
  });
}
