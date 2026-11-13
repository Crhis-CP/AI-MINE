// Earlier days of the two daily official sources, for the trend chart (TASK-0632). The schedule only ever reads forward
// from the newest stored day; this fills days before it that are not stored, from the same official pages, and never
// touches a day already in the table. Nothing is estimated: a value goes in only as the source printed it, and only
// when it passes the checks below; anything else is left out and reported.
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { XMLValidator } from "fast-xml-parser";
import { guardedFetch } from "@amp/backend/lib/http-fetch";
import { HOST, type Metal, effectiveDay, label, metalUrl, number, offsetDay, rawText, requested, xml } from "./cbr.ts";
import { COCHILCO_URL, cochilcoLines, cochilcoListed } from "./cochilco.ts";
import { fetchCochilco } from "./relay.ts";
import { type MetalPriceItem, type MetalPriceRegistry, type MetalPriceSource, loadMetalPriceRegistry, onSourceHost } from "./registry.ts";
import { nextValues, storePeriod, storedStarts } from "./store.ts";
import type { FetchedPeriod, PageGetter } from "./types.ts";

/**
 * A back-filled daily value may differ from the nearest later day that has it by at most this ratio: the band the
 * schedule's own check uses for daily sources (check.ts). It catches a misread unit or column, not a market move.
 */
export const BACKFILL_BAND = [0.5, 2] as const;
/** US cents per pound to US dollars per tonne. */
const TONNE = 22.0462262;
/** The two prints of one price agree to the rounding of the cents figure. */
const agree = (tonne: number, cents: number) => Math.abs(tonne / (cents * TONNE) - 1) < 0.0006;

const MONTHS = "enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre".split(" ");
const NUMBER = "((?:\\d{1,3}(?:\\.\\d{3})+|\\d+),\\d+)";
const decimal = (value: string) => value.replaceAll(".", "").replace(",", ".");

/**
 * A daily report of any of its past layouts. The current reader (cochilcoPeriod) follows the page's sections, which
 * moved over the years; this one does not: a series is taken only where the report prints the same price twice, in
 * US$/tonne and in ¢/lb, and the two agree. That identity says both which number is the tonne price and that the line
 * was read whole. A series without such a pair that day (a holiday, a wrapped row) is left out.
 */
export function cochilcoHistoryPeriod(registry: MetalPriceRegistry, day: string, url: string, lines: string[], hash: string): FetchedPeriod {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  if (!lines.some((line) => line.includes(`${MONTHS[month - 1]} ${date}, ${year}`))) throw new Error("Cochilco 日报日期与列表不符");
  const one: FetchedPeriod = {
    source: "cochilco",
    period: { start: day, end: day, label: `${year}年${month}月${date}日` },
    release: { label: `Cochilco La Rueda ${day} ${hash}`, url, releasedOn: day },
    rows: [],
    held: [],
    notes: [],
  };
  const cash = lines.map((line) => new RegExp(`^Contado ${NUMBER}(?: |$)`).exec(line)?.[1]).filter((value): value is string => !!value);
  for (const item of registry.items.filter((item) => item.source === "cochilco" && item.enabled)) {
    const found =
      item.sourceName === "Cobre"
        ? cash.filter((tonne) => cash.some((cents) => agree(Number(decimal(tonne)), Number(decimal(cents)))))
        : lines
            .map((line) => new RegExp(`^${item.sourceName} ${NUMBER} ${NUMBER}(?: |$)`).exec(line))
            .filter((match): match is RegExpExecArray => !!match && agree(Number(decimal(match[1]!)), Number(decimal(match[2]!))))
            .map((match) => match[1]!);
    const values = [...new Set(found.map(decimal))];
    if (values.length === 1) one.rows.push({ key: item.key, value: values[0]!, unit: "US$/TM" });
    else one.notes!.push(`${item.key}：这一天没有能互相印证的美元/吨与美分/磅价格`);
  }
  return one;
}

type Request = (url: string, maxBytes: number) => Promise<{ text(): string; body?: Buffer }>;

/** Every Bank of Russia fixing between two effective days, from the two range files; a day without its USD rate is left out. */
export async function cbrHistory(registry: MetalPriceRegistry, from: string, through: string, request: Request): Promise<FetchedPeriod[]> {
  const read = async (url: string, root: "Metall" | "ValCurs") => {
    const text = (await request(url, 8 * 1024 * 1024)).text();
    if (XMLValidator.validate(text) !== true) throw new Error("俄罗斯银行回应不是有效 XML");
    const doc = xml.parse(text);
    if (!Object.hasOwn(doc, root)) throw new Error(`俄罗斯银行回应没有 ${root} 根元素`);
    return doc[root];
  };
  const metal = await read(metalUrl(from, through), "Metall");
  const dollars = await read(`${HOST}/scripts/XML_dynamic.asp?date_req1=${requested(from)}&date_req2=${requested(through)}&VAL_NM_RQ=R01235`, "ValCurs");
  const rate = new Map<string, { Nominal?: unknown; Value?: unknown }>();
  for (const row of [dollars?.Record ?? []].flat() as { "@_Date"?: unknown; Nominal?: unknown; Value?: unknown }[]) rate.set(effectiveDay(row["@_Date"]), row);
  const days = new Map<string, Metal[]>();
  for (const row of (metal?.Record ?? []) as Metal[]) {
    const day = effectiveDay(row["@_Date"]);
    if (day >= from && day <= through) days.set(day, [...(days.get(day) ?? []), row]);
  }
  const items = registry.items.filter((item) => item.source === "cbr" && item.enabled);
  const metals = new Map(items.filter((item) => !item.rate).map((item) => [item.sourceName, item.key]));
  const usd = items.find((item) => item.rate && item.sourceName === "USD")?.key;
  const out: FetchedPeriod[] = [];
  for (const day of [...days.keys()].sort()) {
    const fixing = offsetDay(day, -1);
    const one: FetchedPeriod = {
      source: "cbr",
      period: { start: fixing, end: fixing, label: `${label(fixing)}定价` },
      release: { label: `俄罗斯银行 ${label(day)}起适用`, url: metalUrl(day, day), releasedOn: null },
      rows: [],
      held: [],
      notes: [],
    };
    for (const row of days.get(day)!) {
      const key = metals.get(row["@_Code"] ?? "");
      if (!key) continue;
      const buy = rawText(row.Buy);
      if (buy !== rawText(row.Sell) || !number.test(buy)) one.notes!.push(`${key}：Buy 与 Sell 不同或不是原文的逗号小数`);
      else one.rows.push({ key, unit: "卢布/克", value: buy.replace(",", ".") });
    }
    const dollar = rate.get(day);
    const value = rawText(dollar?.Value);
    if (!usd) continue;
    if (!dollar || rawText(dollar.Nominal) !== "1" || !number.test(value)) one.held.push("这一天没有可用的美元汇率");
    else one.rows.push({ key: usd, unit: "卢布/美元", value: value.replace(",", ".") });
    out.push(one);
  }
  return out;
}

export interface BackfillDay {
  day: string;
  /** Series that went in (or would, in a dry run). */
  stored: string[];
  /** Series or the whole day left out, with the reason. */
  left: string[];
}
export interface BackfillReport {
  source: string;
  applied: boolean;
  from: string;
  /** Days the source offers in the range that are not stored. */
  missing: number;
  /** Days still to do after this run (the limit was reached). */
  remaining: number;
  days: BackfillDay[];
}

/**
 * Fills days before the newest stored one. `limit` bounds the days read in one run, newest missing days first, so the
 * chart grows backwards from today without a gap; run again to go further. Without `apply` nothing is written.
 */
export async function backfillMetalPrices(opts: {
  source: "cbr" | "cochilco";
  from: string;
  limit: number;
  apply?: boolean;
  now?: Date;
  registry?: MetalPriceRegistry;
  get?: PageGetter;
  /** Wait between two daily PDFs, so a long run stays a light visitor of the official site. */
  pauseMs?: number;
}): Promise<BackfillReport> {
  const registry = opts.registry ?? loadMetalPriceRegistry();
  const now = opts.now ?? new Date();
  const source = registry.sources.find((candidate) => candidate.key === opts.source && candidate.enabled) as MetalPriceSource | undefined;
  if (!source) throw new Error(`来源 ${opts.source} 不存在或未启用`);
  const items = registry.items.filter((item) => item.source === source.key && item.enabled);
  const have = await storedStarts(source.key);
  const newest = [...have].sort().at(-1) ?? null;
  if (!newest) throw new Error(`${source.key} 还没有任何一期入库：先让定时任务取到最新一期，再补更早的`);
  const get = opts.get ?? (source.key === "cochilco" ? fetchCochilco : guardedFetch);
  const request: Request = async (url, maxBytes) => {
    if (!onSourceHost(source, url)) throw new Error(`${url} 不在登记的 https 主机上`);
    const response = await get(url, { maxRedirects: 0, maxBytes, retryDropped: true });
    if (response.status !== 200 || response.url !== url) throw new Error(`请求失败或跳转：HTTP ${response.status}`);
    return response;
  };

  let candidates: { day: string; load: () => Promise<FetchedPeriod> }[];
  if (source.key === "cbr") {
    // Effective days: the fixing is the day before.
    const all = await cbrHistory(registry, offsetDay(opts.from, 1), newest, request);
    candidates = all.map((one) => ({ day: one.period.start, load: async () => one }));
  } else {
    const listed = cochilcoListed(source, (await request(COCHILCO_URL, 2 * 1024 * 1024)).text());
    candidates = [...listed].map(([day, url]) => ({
      day,
      load: async () => {
        await delay(opts.pauseMs ?? 1000);
        const file = await request(url, 4 * 1024 * 1024);
        if (!file.body) throw new Error("Cochilco PDF 没有字节");
        return cochilcoHistoryPeriod(registry, day, url, await cochilcoLines(file.body), createHash("sha256").update(file.body).digest("hex"));
      },
    }));
  }
  const missing = candidates.filter(({ day }) => day >= opts.from && day < newest && !have.has(day)).sort((a, b) => a.day.localeCompare(b.day));
  const chosen = missing.slice(-opts.limit);
  const report: BackfillReport = {
    source: source.key,
    applied: !!opts.apply,
    from: opts.from,
    missing: missing.length,
    remaining: missing.length - chosen.length,
    days: [],
  };
  const run = new Map<string, Map<string, string>>();
  // Newest first: each day is checked against the nearest later day that has the series, a chain that starts at a stored one.
  for (const { day, load } of chosen.reverse()) {
    const entry: BackfillDay = { day, stored: [], left: [] };
    report.days.push(entry);
    let fetched: FetchedPeriod;
    try {
      fetched = await load();
    } catch (error) {
      entry.left.push(`整天：${(error instanceof Error ? error.message : String(error)).slice(0, 300).toWellFormed()}`);
      continue;
    }
    entry.left.push(...(fetched.notes ?? []));
    if (fetched.held.length) {
      entry.left.push(`整天：${fetched.held.join("；")}`);
      continue;
    }
    const was = await nextValues(source.key, day, items);
    for (const [, values] of [...run].sort(([a], [b]) => b.localeCompare(a))) for (const [key, value] of values) was.set(key, value);
    const keep: MetalPriceItem[] = [];
    for (const item of items) {
      const rows = fetched.rows.filter((row) => row.key === item.key);
      if (!rows.length) continue;
      const { unit, value } = rows[0]!;
      const base = was.get(item.key);
      const ratio = base === undefined ? 1 : Number(value) / Number(base);
      if (rows.length !== 1) entry.left.push(`${item.key}：出现 ${rows.length} 次`);
      else if (unit !== item.sourceUnit) entry.left.push(`${item.key}：单位是“${unit}”，不是“${item.sourceUnit}”`);
      else if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) entry.left.push(`${item.key}：数值“${value}”不是正数`);
      else if (ratio < BACKFILL_BAND[0] || ratio > BACKFILL_BAND[1])
        entry.left.push(`${item.key}：${value} 是后一个有数的日子 ${base} 的 ${ratio.toFixed(2)} 倍，超出 ${BACKFILL_BAND.join("–")} 倍`);
      else keep.push(item);
    }
    if (!keep.length) continue;
    run.set(day, new Map(keep.map((item) => [item.key, fetched.rows.find((row) => row.key === item.key)!.value])));
    entry.stored = keep.map((item) => item.key);
    if (opts.apply) await storePeriod(source, keep, fetched, now);
  }
  report.days.reverse();
  return report;
}
