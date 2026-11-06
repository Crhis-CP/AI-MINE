// RMB central parity against the US dollar (TASK-0572), as the State Administration of Foreign Exchange republishes it
// from the China Foreign Exchange Trade System: the dollar column of its table, as written (元 per 100 US dollars), one
// day per period. It is a rate series only: never shown as a price, it converts the domestic 元/吨 quotes into 美元/吨.
// The parity is fixed at 9:15 Beijing time on each interbank trading day; weekends and public holidays have none.
import { load } from "cheerio";
import { guardedFetch } from "@amp/backend/lib/http-fetch";
import { type MetalPriceRegistry, normalizeSourceName, onSourceHost } from "./registry.ts";
import type { FetchedPeriod, Fetcher, PageGetter } from "./types.ts";

/** The query page the official parity page frames; asked without dates it lists the latest ten trading days. */
export const SAFE_PARITY_URL = "https://www.safe.gov.cn/AppStructured/hlw/RMBQuery.do";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER = /^\d+(?:\.\d+)?$/;
/** Per 100 dollars the parity has been between 600 and 900 元 for decades; below 100 the page has changed its basis. */
const PER_HUNDRED_FLOOR = 100;

const label = (day: string) => {
  const [year, month, date] = day.split("-");
  return `${year}年${Number(month)}月${Number(date)}日`;
};
const realDay = (day: string) => DAY.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;

/**
 * The listed days and their dollar cell, as written. The table is found by its id and read by header name; a row that
 * does not start with a date (the page leaves an empty template row in) is not a day. A table that cannot be read as
 * expected throws, naming what was there.
 */
export function safeParityDays(html: string, column: string): Map<string, string> {
  const $ = load(html);
  const table = $("table#InfoTable");
  if (table.length !== 1) throw new Error("国家外汇管理局中间价页没有唯一的 InfoTable 表格");
  const rows = Array.from(table.find("tr"), (row) => Array.from($(row).children("td, th"), (cell) => $(cell).text().replace(/\s+/g, " ").trim()));
  const header = rows.find((cells) => cells[0] === "日期");
  if (!header) throw new Error("国家外汇管理局中间价表没有“日期”表头");
  const at = header.flatMap((cell, i) => (normalizeSourceName(cell) === normalizeSourceName(column) ? [i] : []));
  if (at.length !== 1) throw new Error(`国家外汇管理局中间价表的“${column}”列有 ${at.length} 个`);
  const days = new Map<string, string>();
  for (const cells of rows) {
    const day = cells[0] ?? "";
    if (!DAY.test(day)) continue;
    if (!realDay(day)) throw new Error(`国家外汇管理局中间价表的日期无效：${day}`);
    if (days.has(day)) throw new Error(`国家外汇管理局中间价表的日期重复：${day}`);
    days.set(day, (cells[at[0]!] ?? "").replaceAll(",", ""));
  }
  if (!days.size) throw new Error("国家外汇管理局中间价表里没有日期行");
  return days;
}

export function safeFetcher(registry: MetalPriceRegistry, get: PageGetter = guardedFetch): Fetcher {
  return {
    sourceKeys: ["safe"],
    async fetch(newest) {
      const source = registry.sources.find((candidate) => candidate.key === "safe");
      if (!source || !onSourceHost(source, SAFE_PARITY_URL) || !onSourceHost(source, source.officialUrl))
        throw new Error("国家外汇管理局地址不在登记的 https 主机上");
      const items = registry.items.filter((item) => item.source === "safe" && item.enabled);
      if (items.length !== 1) throw new Error(`国家外汇管理局应只登记一项启用的汇率，现在是 ${items.length} 项`);
      const item = items[0]!;
      const response = await get(SAFE_PARITY_URL, { maxRedirects: 0, maxBytes: 1 << 20, retryDropped: true });
      if (response.url !== SAFE_PARITY_URL) throw new Error("国家外汇管理局请求发生跳转");
      if (response.status !== 200) throw new Error(`国家外汇管理局返回 HTTP ${response.status}`);
      const days = safeParityDays(response.text(), item.sourceName);
      const listed = [...days.keys()].sort();
      const since = await newest("safe");
      // The first run takes every listed day (about two weeks), so the domestic quotes already shown, whose periods
      // ended days before, have a parity to be converted with; later runs read the stored newest day again and on.
      return (since ? listed.filter((day) => day >= since) : listed).map((day) => {
        const value = days.get(day)!;
        const one: FetchedPeriod = {
          source: "safe",
          period: { start: day, end: day, label: label(day) },
          release: { label: `国家外汇管理局 人民币汇率中间价 ${day}`, url: source.officialUrl, releasedOn: day },
          rows: [],
          held: [],
        };
        if (!NUMBER.test(value)) one.held.push(`${day} 的${item.sourceName}中间价“${value}”不是数字`);
        else if (Number(value) < PER_HUNDRED_FLOOR) one.held.push(`${day} 的${item.sourceName}中间价 ${value} 不像每 100 美元的人民币数`);
        one.rows.push({ key: item.key, unit: item.sourceUnit, value });
        return one;
      });
    },
  };
}
