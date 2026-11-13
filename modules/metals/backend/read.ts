import { loadSiteInformation } from "@amp/backend/site/stats";
// Site-only price projection: registry presentation and stored decimal values, without acquisition or writes.
import { MetalPrices } from "@amp/contracts/http/public";
import { beijingDate } from "@amp/contracts/time";
import { sql } from "@amp/backend/db";
import { loadMetalPriceRegistry, parseMetalPriceRegistry, type MetalPriceItem } from "./registry.ts";

type Item = MetalPriceItem;

/**
 * The opening words of the footnote a quote gets while its newest value is held back alone (DEC-78补充 item 4); the page
 * shows them as a mark beside the period (web/quotes.ts HELD_MARK is the same text).
 */
export const HELD_MARK = "待下期确认";
const heldText = (label: string) =>
  `${HELD_MARK}：${label}公布的这一报价较上一期变动超出常规范围，暂不更新，这里仍是上一期已核对的数值；下一期公布后自动确认或更正。`;
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
/** A quote's price in another currency (TASK-0572), with the rate it was converted with. */
interface Converted {
  value: string;
  unit: string;
  currency: "CNY" | "USD";
  rate: { source: string; name: string; date: string; label: string };
}
/** How many periods of one quote the trend line may carry (a year of working days and some). */
const HISTORY_POINTS = 400;
type History = Array<{ period: { start: string; end: string; label: string }; value: string }>;
/** The newest stored day of a rate series: what a source that only gives rates is fresh or stale by. */
type RateDay = Pick<Price, "start" | "end" | "label" | "release" | "url" | "date">;

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
  // The rate series a conversion may use: enabled, of an enabled source (a stopped rate source just shows no conversion).
  const rates = registry.items.filter((item) => item.rate && item.enabled && sources.some((s) => s.key === item.source));
  const [selected, held, converted, rateDays, histories] = await sql.begin("read only isolation level repeatable read", async (tx) => {
    const out = new Map<string, Price>();
    const trends = new Map<string, History>();
    const conversions = new Map<string, Converted>();
    const days = new Map<string, RateDay>();
    // Values held back alone are not in the price table: the quote keeps its last value, marked as waiting.
    const holds = await tx<{ series_key: string; period_label: string }[]>`
      SELECT series_key, period_label FROM publication.metal_price_holds WHERE status = 'held'`;
    for (const item of ordered) {
      const source = sources.find((s) => s.key === item.source)!;
      const convert = item.convert;
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
          SELECT * FROM prices p WHERE p.period_start < c.period_start
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
      // Every stored period of the quote in the same unit and currency (the newest version of each), for the trend
      // line: read in the same snapshot as the price above, newest first, at most HISTORY_POINTS.
      const points = await tx<{ start: string; end: string; label: string; value: string }[]>`
        WITH versions AS (
          SELECT DISTINCT ON (series_key, period_start) series_key, currency, unit, period_start, period_end, period_label,
            value, first_fetched_at, released_on, release_label
          FROM publication.metal_prices WHERE series_key IN (${item.key}, ${convert?.rate ?? item.key})
          ORDER BY series_key, period_start DESC, first_fetched_at DESC, released_on DESC NULLS LAST, release_label DESC
        )
        SELECT p.period_start::text AS start, p.period_end::text AS end, p.period_label AS label,
          (CASE WHEN ${!!convert} THEN p.value * ${convert?.factor ?? "1"}::numeric / r.value ELSE p.value END)::text AS value
        FROM versions p LEFT JOIN versions r ON r.series_key = ${convert?.rate ?? ""} AND r.period_start = p.period_start
        WHERE p.series_key = ${item.key} AND p.unit = ${item.unit} AND p.currency = ${source.currency}
          AND (NOT ${!!convert} OR (r.value IS NOT NULL AND r.unit = ${row.rate_unit ?? ""} AND r.currency = ${row.rate_currency ?? ""}))
          AND p.period_start <= ${row.start}::date
        ORDER BY p.period_start DESC LIMIT ${HISTORY_POINTS}`;
      if (points.length >= 2)
        trends.set(
          item.key,
          points.reverse().map((point) => ({ period: { start: point.start, end: point.end, label: point.label }, value: point.value })),
        );
      // The rate of the quote's period end, or of the latest day before it within the window; never a later one.
      const secondary = item.secondary;
      const by = secondary ? rates.find((candidate) => candidate.key === secondary.rate) : undefined;
      if (!secondary || !by) continue;
      const [rated] = await tx<{ date: string; label: string; unit: string; currency: string; value: string }[]>`
        SELECT period_start::text AS date, period_label AS label, unit, currency,
          pg_catalog.round(${row.value}::numeric * ${secondary.factor}::numeric / value, ${secondary.decimals})::text AS value
        FROM publication.metal_prices
        WHERE series_key = ${by.key} AND period_start <= ${row.end}::date AND period_start >= ${row.end}::date - ${secondary.withinDays}::int
        ORDER BY period_start DESC, first_fetched_at DESC, released_on DESC NULLS LAST, release_label DESC
        LIMIT 1`;
      if (!rated) continue;
      if (rated.unit !== by.unit || rated.currency !== sources.find((s) => s.key === by.source)!.currency)
        throw new Error(`Rate unit/currency mismatch: ${by.key}`);
      // A price that rounds to nothing in the other currency is not shown as zero.
      if (/[1-9]/.test(rated.value))
        conversions.set(item.key, {
          value: rated.value,
          unit: secondary.unit,
          currency: secondary.currency,
          rate: { source: by.source, name: by.benchmark, date: rated.date, label: rated.label },
        });
    }
    // A source that only gives rates (the RMB central parity) is listed with its newest stored day.
    for (const rate of rates) {
      if (items.some((item) => item.source === rate.source) || days.has(rate.source)) continue;
      const [day] = await tx<RateDay[]>`
        SELECT period_start::text AS start, period_end::text AS end, period_label AS label, release_label AS release,
          release_url AS url, released_on::text AS date
        FROM publication.metal_prices WHERE series_key = ${rate.key}
        ORDER BY period_start DESC, first_fetched_at DESC, released_on DESC NULLS LAST, release_label DESC
        LIMIT 1`;
      if (day) days.set(rate.source, day);
    }
    return [out, new Map(holds.map((hold) => [hold.series_key, hold.period_label])), conversions, days, trends] as const;
  });
  const today = beijingDate(now),
    yearPrefix = `${today.slice(0, 4)}年`;
  const stalePeriod = (end: string, days: number) => new Date(Date.parse(end) + days * 86400_000).toISOString().slice(0, 10) < today;
  const releaseNotes: MetalPrices["notes"] = [];
  const presentationSources = sources.map((source) => {
    const day = rateDays.get(source.key);
    const rows: RateDay[] = items
      .filter((item) => item.source === source.key)
      .map((item) => selected.get(item.key))
      .filter((row): row is Price => !!row);
    if (day) rows.push(day);
    rows.sort((a, b) => b.end.localeCompare(a.end));
    const newest = rows[0];
    releaseNotes.push({
      ref: null,
      text: `${source.name}：${source.delay}。`,
      link: null,
    });
    const status = !newest ? "empty" : rows.some((row) => stalePeriod(row.end, source.staleDays)) ? "stale" : "fresh";
    return {
      key: source.key,
      name: source.name,
      tag: frequencies.find((f) => f.key === source.frequency)!.tag,
      status,
      latest: newest
        ? {
            label: newest.label,
            release: {
              label: source.key === "cochilco" ? newest.release.replace(/ [a-f0-9]{64}$/, "") : newest.release,
              url: newest.url,
              date: newest.date,
            },
          }
        : null,
    };
  });
  const references = new Map<string, number>();
  const heldNotes = new Map<string, { text: string; link: { name: string; url: string } | null }>();
  const metals = registry.metals.flatMap((metal) => {
    const quotes = ordered
      .filter((item) => item.metal === metal.key)
      .map((item) => {
        const source = sources.find((s) => s.key === item.source)!,
          row = selected.get(item.key),
          convert = item.convert;
        // A held quote (or one converted with a held rate) gets its own footnote, its registered one following the mark.
        const hold = held.get(item.key) ?? (convert ? held.get(convert.rate) : undefined);
        const footnote = hold === undefined ? item.footnote : `held:${item.key}`;
        if (hold !== undefined && footnote) {
          const own = registry.footnotes.find((note) => note.key === item.footnote);
          heldNotes.set(footnote, { text: own ? `${heldText(hold)}${own.text}` : heldText(hold), link: own?.link ?? null });
        }
        if (footnote && !references.has(footnote)) references.set(footnote, references.size + 1);
        const compared =
          row?.previous_value &&
          row.previous_end !== null &&
          row.previous_end < row.start &&
          row.previous_unit === row.unit &&
          row.previous_currency === row.currency &&
          (!convert || (row.previous_rate_unit === row.rate_unit && row.previous_rate_currency === row.rate_currency));
        return {
          key: item.key,
          source: item.source,
          title: item.quote!,
          spec: item.spec,
          footnote: footnote ? references.get(footnote)! : null,
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
          // Only quotes registered with a conversion whose rate is in use carry the field; null while no rate of the
          // window is stored. A stopped or unregistered rate source leaves the published price alone, as before.
          ...(item.secondary && rates.some((rate) => rate.key === item.secondary!.rate) ? { converted: converted.get(item.key) ?? null } : {}),
          ...(histories.has(item.key) ? { history: histories.get(item.key)! } : {}),
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
        group.stale ||= stalePeriod(quote.period.end, sources.find((registered) => registered.key === quote.source)!.staleDays);
        if (!group.metals.includes(metal.name)) group.metals.push(metal.name);
        groups.set(quote.period.label, group);
      }
    const [head, ...extras] = [...groups.values()].sort((a, b) => b.end.localeCompare(a.end));
    return { tag: frequency.tag, label: head?.label ?? null, stale: head?.stale ?? false, extras: extras.map(({ end: _end, ...rest }) => rest) };
  });
  const notes: MetalPrices["notes"] = [...references].map(([key, ref]) => {
    const note = heldNotes.get(key) ?? registry.footnotes.find((n) => n.key === key)!;
    return { ref, text: note.text, link: note.link ?? null };
  });
  for (const note of registry.notes)
    if (!note.sources || note.sources.some((key) => sources.some((s) => s.key === key)))
      notes.push({
        ref: null,
        text: note.text.replaceAll("{tags}", frequencies.map((f) => f.tag).join("、")).replaceAll("{compare}", frequencies.map((f) => f.compare).join("，")),
        link: note.link ?? null,
      });
  notes.push(...releaseNotes);
  return MetalPrices.parse({
    generatedAt: now.toISOString(),
    intro: registry.intro,
    sources: presentationSources,
    metals,
    latest,
    notes,
    officialLinks: input === undefined ? (await loadSiteInformation()).metalLinks : registry.officialLinks,
  });
}
