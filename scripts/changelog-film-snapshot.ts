// Captures the figures of a changelog film once, as a fixed recording (TASK-0367, Owner 2026-11-21: the film is a
// snapshot of one moment, like a video; ordinary changes on the site do not change it, while a manual takedown still
// wins through the film's takedown list, films/<date>/redactions.json, rule 7). Read-only: four GETs
// to the site's public API, nothing written anywhere but the output file. Keeps only public fields the film draws:
// each home-page country's newest titles (Chinese and English as served) with source name and time, the published
// price points of the metals drawn, and the hot list's count. No item ids or links: the recording does not link items.
//   node scripts/changelog-film-snapshot.ts --out apps/web/app/features/changelog/films/<date>/snapshot.json
//   [--base https://aiminingpolicy.com] [--countries CN,AR] [--metals copper,gold] [--points 66]
// Then format it (npx biome format --write <file>) and commit it beside the film's scenes. docs/01-product/11-changelog-standard.md.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

interface PoolAnswer {
  items: Array<{ title: string; english?: { title?: string | null } | null; source: { name: string }; timelineAt: string }>;
}
interface PricePeriod {
  start: string;
  end: string;
  label: string;
}
interface PricesAnswer {
  sources: Array<{ key: string; name: string }>;
  notes: Array<{ ref: number | null; text: string }>;
  metals: Array<{
    key: string;
    name: string;
    quotes: Array<{
      source: string;
      title: string;
      unit: string;
      decimals: number | null;
      footnote: number | null;
      history?: Array<{ period: PricePeriod; value: string }>;
    }>;
  }>;
}
interface HotAnswer {
  computedAt: string | null;
  windowHours: number;
  entries: unknown[];
}

export interface SnapshotOptions {
  countries: readonly string[];
  metals: readonly string[];
  points: number;
}

/** A price held back for confirmation is not a published price the film may draw (metals module, HELD_MARK). */
const HELD_MARK = "待下期确认";

/** The film's figures from the four public answers, taken at `takenAt`. Pure: the tests feed it synthetic answers. */
export function filmSnapshot(answers: { pools: Record<string, PoolAnswer>; prices: PricesAnswer; hot: HotAnswer }, takenAt: string, options: SnapshotOptions) {
  const held = new Set(answers.prices.notes.filter((note) => note.ref !== null && note.text.startsWith(`${HELD_MARK}：`)).map((note) => note.ref));
  return {
    takenAt,
    countries: options.countries.map((code) => ({
      code,
      items: (answers.pools[code]?.items ?? []).slice(0, 5).map((item) => ({
        title: item.title,
        titleEn: item.english?.title ?? null,
        source: item.source.name,
        at: item.timelineAt,
      })),
    })),
    metals: options.metals.flatMap((key) => {
      const metal = answers.prices.metals.find((one) => one.key === key);
      // The quote with the longest record of published periods, unless its newest price is held back.
      const quote = metal?.quotes
        .filter((one) => (one.history?.length ?? 0) >= 2 && !(one.footnote !== null && held.has(one.footnote)))
        .sort((a, b) => (b.history?.length ?? 0) - (a.history?.length ?? 0))[0];
      if (!metal || !quote?.history) return [];
      return [
        {
          metal: metal.name,
          quote: quote.title,
          source: answers.prices.sources.find((source) => source.key === quote.source)?.name ?? quote.source,
          unit: quote.unit,
          decimals: quote.decimals,
          points: quote.history.slice(-options.points).map(({ period, value }) => ({ label: period.label, start: period.start, end: period.end, value })),
        },
      ];
    }),
    hot: { count: answers.hot.entries.length, windowHours: answers.hot.windowHours, computedAt: answers.hot.computedAt },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      base: { type: "string", default: "https://aiminingpolicy.com" },
      countries: { type: "string", default: "CN,AR" },
      metals: { type: "string", default: "copper,gold" },
      points: { type: "string", default: "66" },
    },
  });
  const options = { countries: values.countries.split(","), metals: values.metals.split(","), points: Number(values.points) };
  const get = async <T>(route: string): Promise<T> => {
    const response = await fetch(new URL(route, values.base), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${route}: ${response.status}`);
    return (await response.json()) as T;
  };
  const takenAt = new Date().toISOString();
  const [pools, prices, hot] = await Promise.all([
    Promise.all(
      options.countries.map(async (code) => [code, await get<PoolAnswer>(`/api/site/pool?jurisdiction=${code}&readingGroups=reports-v1&lean=1`)] as const),
    ),
    get<PricesAnswer>("/api/site/metal-prices"),
    get<HotAnswer>("/api/site/hot"),
  ]);
  const snapshot = filmSnapshot({ pools: Object.fromEntries(pools), prices, hot }, takenAt, options);
  const text = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (!values.out) return void process.stdout.write(text);
  mkdirSync(path.dirname(values.out), { recursive: true });
  writeFileSync(values.out, text);
  console.log(
    `${values.out}: taken ${takenAt}; ${snapshot.countries.map((c) => `${c.code} ${c.items.length}`).join(", ")}; ${snapshot.metals.map((m) => `${m.metal} ${m.points.length}`).join(", ")}; hot ${snapshot.hot.count}`,
  );
}

if (import.meta.main) await main();
