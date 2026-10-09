// World Bank Pink Sheet (TASK-0088): monthly workbook, raw numeric text, registered series only.
import { load } from "cheerio";
import { guardedFetch } from "../../lib/http-fetch.ts";
import { type MetalPriceRegistry, normalizeSourceName, onSourceHost } from "./registry.ts";
import type { FetchedPeriod, Fetcher, PageGetter, Period } from "./types.ts";
import { openWorkbook } from "./xlsx.ts";

export const WORLDBANK_LIST_URL = "https://www.worldbank.org/en/research/commodity-markets";
const LIMIT = 4 * 1024 * 1024;
const WEEK = 7 * 86400_000;
const tidy = (text: string) => text.replace(/\s+/gu, " ").trim();
const monthPeriod = (year: number, month: number): Period => {
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  return { start, end: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10), label: `${year}年${month}月` };
};
/** Only an explicit full date in the list cell; never the file's update line or the month in the version. */
function releaseDay(label: string): string | null {
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(label)?.[1];
  const full = /\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}),? (\d{4})\b/.exec(label);
  const date =
    iso ??
    (full
      ? `${full[3]}-${String("January February March April May June July August September October November December".split(" ").indexOf(full[1]) + 1).padStart(2, "0")}-${full[2].padStart(2, "0")}`
      : null);
  return date && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date ? date : null;
}

/** Pure workbook interpretation; tests change copies of the recorded cells, never the fixture file. */
export function worldbankPeriods(
  registry: MetalPriceRegistry,
  sheet: ReturnType<typeof openWorkbook>,
  release: FetchedPeriod["release"],
  newest: string | null,
): FetchedPeriod[] {
  const prices = sheet("Monthly Prices");
  const descriptions = [...sheet("Description").values()].map((row) => tidy(row.get("B") ?? ""));
  const months = [...prices.values()]
    .flatMap((row) => {
      const match = /^([1-9]\d{3})M(0[1-9]|1[0-2])$/.exec(row.get("A") ?? "");
      return match ? [{ row, period: monthPeriod(Number(match[1]), Number(match[2])) }] : [];
    })
    .sort((a, b) => a.period.start.localeCompare(b.period.start));
  const last = months.at(-1);
  if (!last) throw new Error("世界银行表里没有月份行");
  const previousDate = new Date(`${last.period.start}T00:00:00Z`);
  previousDate.setUTCMonth(previousDate.getUTCMonth() - 1);
  const previous = previousDate.toISOString().slice(0, 10);
  const selected = months.filter((one) => one.period.start === last.period.start || ((!newest || newest === previous) && one.period.start === previous));
  const items = registry.items.filter((item) => item.source === "worldbank" && item.enabled);
  return selected.map(({ row, period }) => {
    const one: FetchedPeriod = { source: "worldbank", period, release, rows: [], held: [], heldSeries: [] };
    for (const item of items) {
      const columns = [...(prices.get(5) ?? [])].filter(([, name]) => normalizeSourceName(name) === normalizeSourceName(item.sourceName));
      if (columns.length !== 1) {
        one.held.push(`${item.key} 应有一列，实际 ${columns.length} 列`);
        continue;
      }
      const column = columns[0][0];
      const unit = (prices.get(6)?.get(column) ?? "").trim();
      if (unit !== item.sourceUnit) one.held.push(`${item.key} 单位“${unit}”与登记“${item.sourceUnit}”不同`);
      const value = (row.get(column) ?? "").trim().replaceAll(",", "");
      if (value !== "…" && value !== ".." && !/^-?\d+(?:\.\d+)?$/.test(value)) one.held.push(`${item.key} 不是数值：“${value}”`);
      const reason = !descriptions.some((description) => item.descriptionIncludes.every((words) => description.includes(tidy(words))))
        ? "世界银行说明与登记的品种规格或基准不符"
        : value === "…" || value === ".."
          ? "世界银行这个月没有给这个品种的数"
          : null;
      if (reason) one.heldSeries!.push({ key: item.key, reason });
      else one.rows.push({ key: item.key, unit, value });
    }
    // Workbook column order, irrespective of the presentation order in the registry.
    const order = [...(prices.get(5)?.keys() ?? [])];
    const columnFor = (key: string) =>
      [...(prices.get(5) ?? [])].find(
        ([, name]) => normalizeSourceName(name) === normalizeSourceName(items.find((item) => item.key === key)!.sourceName),
      )?.[0] ?? "";
    one.rows.sort((a, b) => order.indexOf(columnFor(a.key)) - order.indexOf(columnFor(b.key)));
    if (!one.heldSeries!.length) delete one.heldSeries;
    return one;
  });
}

export function worldbankFetcher(registry: MetalPriceRegistry, get: PageGetter = guardedFetch): Fetcher {
  return {
    sourceKeys: ["worldbank"],
    async fetch(newest, context) {
      const source = registry.sources.find((candidate) => candidate.key === "worldbank");
      if (!source) throw new Error("登记里没有世界银行");
      const request = async (url: string, file = false) => {
        if (!onSourceHost(source, url)) throw new Error("世界银行地址不在登记的 https 主机上");
        // The shared transport does not apply source hosts to each redirect hop: refuse redirects altogether here.
        const response = await get(url, { maxRedirects: 0, ...(file ? { maxBytes: LIMIT } : {}) });
        if (!onSourceHost(source, response.url) || response.url !== url) throw new Error("世界银行请求发生跳转");
        if (response.status !== 200) throw new Error(`世界银行返回 HTTP ${response.status}`);
        return response;
      };
      const page = await request(WORLDBANK_LIST_URL);
      const $ = load(page.text());
      const links = Array.from($("a[href]")).filter((link) => /\/CMO-Historical-Data-Monthly\.xlsx$/i.test(new URL($(link).attr("href")!, page.url).pathname));
      if (links.length !== 1) throw new Error(`世界银行月度文件链接应有一个，实际 ${links.length} 个`);
      const cell = $(links[0]).closest("td").clone();
      cell.find("br").replaceWith(" ");
      const label = tidy(cell.text());
      if (!label) throw new Error("世界银行月度文件链接没有版本单元格");
      const url = new URL($(links[0]).attr("href")!, page.url).href;
      if (!onSourceHost(source, url)) throw new Error("世界银行文件链接不在登记的 https 主机上");
      const fetched = context && (await context.fetchedAt("worldbank", label));
      if (fetched && context!.now.getTime() >= fetched.getTime() && context!.now.getTime() - fetched.getTime() < WEEK) return [];
      const response = await request(url, true);
      if (!response.body) throw new Error("世界银行文件没有字节");
      if (response.body.length > LIMIT) throw new Error("世界银行文件超过 4 MiB");
      return worldbankPeriods(registry, openWorkbook(response.body), { label, url, releasedOn: releaseDay(label) }, await newest("worldbank"));
    },
  };
}
