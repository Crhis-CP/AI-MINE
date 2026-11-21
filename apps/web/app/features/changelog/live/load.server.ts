// Reads the real figures of the changelog showcases from the public site API (TASK-0367). Only existing public reads,
// all at once, each with a short deadline: a slow or failed read gives null and its block draws a still sketch, so the
// page is never held up and never shows an empty box. The page's own cache (s-maxage 300) bounds how often this runs.
import { schemas as publicSchemas, type MetalPrices } from "@amp/contracts/http/public";
import type { HotResponse } from "@amp/contracts/site";
import { apiGet } from "../../../lib/api.server";
import { HOME_COUNTRIES } from "../../region/home-country";
import type { LiveBlock, LiveCountry, LiveData, LiveHot, LiveMetal } from "./types";

/** How long one read may take before its block falls back to the sketch. */
export const LIVE_TIMEOUT_MS = 2500;
/** The metals whose trend lines are drawn, and how many of their latest published periods. */
export const LIVE_METALS = ["copper", "gold"] as const;
export const LIVE_POINTS = 66;
const HELD_MARK = "待下期确认";

type Read = <T>(path: string) => Promise<T>;

async function countries(read: Read): Promise<LiveCountry[] | null> {
  const lists = await Promise.all(
    HOME_COUNTRIES.map(async (code) => {
      const pool = publicSchemas.ReportGroupedPoolResponse.parse(await read(`/api/site/pool?jurisdiction=${code}&readingGroups=reports-v1&lean=1`));
      return {
        code,
        items: pool.items.slice(0, 5).map((item) => ({
          id: item.id,
          title: item.title,
          titleEn: item.english?.title ?? null,
          source: item.source.name,
          at: item.timelineAt,
        })),
      };
    }),
  );
  return lists.some((list) => list.items.length) ? lists : null;
}

/** Each metal's quote with the longest record of published periods, unless its newest price is held back for confirmation. */
export function pickMetals(prices: MetalPrices, keys: readonly string[] = LIVE_METALS, count = LIVE_POINTS): LiveMetal[] {
  const held = new Set(prices.notes.filter((note) => note.ref !== null && note.text.startsWith(`${HELD_MARK}：`)).map((note) => note.ref));
  const picked: LiveMetal[] = [];
  for (const key of keys) {
    const metal = prices.metals.find((one) => one.key === key);
    const quote = metal?.quotes
      .filter((one) => (one.history?.length ?? 0) >= 2 && !(one.footnote !== null && held.has(one.footnote)))
      .sort((a, b) => (b.history?.length ?? 0) - (a.history?.length ?? 0))[0];
    if (!metal || !quote?.history) continue;
    picked.push({
      key: quote.key,
      metal: metal.name,
      quote: quote.title,
      source: prices.sources.find((source) => source.key === quote.source)?.name ?? quote.source,
      unit: quote.unit,
      decimals: quote.decimals,
      points: quote.history.slice(-count).map((point) => ({ label: point.period.label, end: point.period.end, value: point.value })),
    });
  }
  return picked;
}

async function metals(read: Read): Promise<LiveMetal[] | null> {
  const picked = pickMetals(publicSchemas.MetalPrices.parse(await read("/api/site/metal-prices")));
  return picked.length ? picked : null;
}

async function hot(read: Read): Promise<LiveHot | null> {
  const list = await read<HotResponse>("/api/site/hot");
  if (!list || !Array.isArray(list.entries) || typeof list.windowHours !== "number") return null;
  return { count: list.entries.length, windowHours: list.windowHours, computedAt: list.computedAt ?? null };
}

const READERS: Record<LiveBlock, (read: Read) => Promise<LiveData[LiveBlock]>> = { countries, metals, hot };

/** The blocks asked for, read in parallel; anything else, or anything that failed, is null. */
export async function loadLive(blocks: ReadonlySet<LiveBlock>, signal: AbortSignal): Promise<LiveData> {
  const read: Read = (path) => apiGet(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(LIVE_TIMEOUT_MS)]) });
  const entries = await Promise.all(
    (Object.keys(READERS) as LiveBlock[]).map(async (block) => [block, blocks.has(block) ? await READERS[block](read).catch(() => null) : null] as const),
  );
  return Object.fromEntries(entries) as unknown as LiveData;
}
