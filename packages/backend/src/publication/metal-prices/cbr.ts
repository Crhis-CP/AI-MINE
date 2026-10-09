// Bank of Russia daily accounting prices: source RUB figures and same-effective-day USD rate, never converted here.
import { beijingDate } from "@amp/contracts/time";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { guardedFetch } from "../../lib/http-fetch.ts";
import { type MetalPriceRegistry, onSourceHost } from "./registry.ts";
import type { FetchedPeriod, Fetcher, PageGetter } from "./types.ts";

const xml = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false, isArray: (name) => ["Record", "Valute"].includes(name) });
const HOST = "https://www.cbr.ru";
const number = /^\d+(,\d+)?$/;
const offsetDay = (day: string, offset: number) => new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86400_000).toISOString().slice(0, 10);
const requested = (day: string) => day.split("-").reverse().join("/");
const label = (day: string) => {
  const [year, month, date] = day.split("-");
  return `${year}年${Number(month)}月${Number(date)}日`;
};
const metalUrl = (from: string, to: string) => `${HOST}/scripts/xml_metall.asp?date_req1=${requested(from)}&date_req2=${requested(to)}`;

/** XML dates are effective days; the fixing day is the previous calendar day, including across weekends. */
function effectiveDay(value: unknown): string {
  if (typeof value !== "string" || !/^\d{2}\.\d{2}\.[1-9]\d{3}$/.test(value)) throw new Error("俄罗斯银行 Date 不是 DD.MM.YYYY 日期");
  const day = value.split(".").reverse().join("-");
  if (!Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw new Error("俄罗斯银行 Date 不是真实日期");
  return day;
}
const rawText = (value: unknown) => (typeof value === "string" ? value : "");
type Metal = { "@_Date"?: unknown; "@_Code"?: string; Buy?: unknown; Sell?: unknown };
type Rate = { CharCode?: string; Nominal?: unknown; Value?: unknown };

export function cbrFetcher(registry: MetalPriceRegistry, get: PageGetter = guardedFetch): Fetcher {
  return {
    sourceKeys: ["cbr"],
    async fetch(newest, context) {
      const source = registry.sources.find((candidate) => candidate.key === "cbr");
      if (!source) throw new Error("登记里没有俄罗斯银行");
      const request = async (url: string, root: "Metall" | "ValCurs") => {
        if (!onSourceHost(source, url) || new URL(url).hostname !== "www.cbr.ru") throw new Error("俄罗斯银行地址不在登记的 https 主机上");
        const response = await get(url, { maxRedirects: 0 });
        if (response.url !== url) throw new Error("俄罗斯银行请求发生跳转");
        if (response.status !== 200) throw new Error(`俄罗斯银行返回 HTTP ${response.status}`);
        const text = response.text();
        if (XMLValidator.validate(text) !== true) throw new Error("俄罗斯银行回应不是有效 XML");
        const doc = xml.parse(text);
        if (!Object.hasOwn(doc, root)) throw new Error(`俄罗斯银行回应没有 ${root} 根元素`);
        return doc[root];
      };
      const today = beijingDate(context?.now ?? new Date());
      const from = offsetDay(today, -31);
      const metal = await request(metalUrl(from, today), "Metall");
      const days = new Map<string, Metal[]>();
      for (const row of (metal?.Record ?? []) as Metal[]) {
        const day = effectiveDay(row["@_Date"]);
        if (day < from || day > today) continue;
        days.set(day, [...(days.get(day) ?? []), row]);
      }
      if (!days.size) throw new Error("俄罗斯银行窗口里没有记录");
      const stored = await newest("cbr");
      const listed = [...days.keys()].sort();
      const selected = stored ? listed.filter((day) => offsetDay(day, -1) >= stored) : listed.slice(-2);
      const items = registry.items.filter((item) => item.source === "cbr" && item.enabled);
      const enabledMetals = new Map(items.filter((item) => !item.rate).map((item) => [item.sourceName, item.key]));
      const fetched: FetchedPeriod[] = [];
      for (const day of selected) {
        const fixing = offsetDay(day, -1);
        const one: FetchedPeriod = {
          source: "cbr",
          period: { start: fixing, end: fixing, label: `${label(fixing)}定价` },
          release: { label: `俄罗斯银行 ${label(day)}起适用`, url: metalUrl(day, day), releasedOn: null },
          rows: [],
          held: [],
        };
        for (const row of days.get(day)!) {
          const key = enabledMetals.get(row["@_Code"] ?? "");
          if (!key) continue;
          const buy = rawText(row.Buy),
            sell = rawText(row.Sell);
          if (buy !== sell) one.held.push(`${key} Buy 与 Sell 不同`);
          if (!number.test(buy) || !number.test(sell)) one.held.push(`${key} 数值不是原文的逗号小数`);
          one.rows.push({ key, unit: "卢布/克", value: buy.replace(",", ".") });
        }
        const currency = await request(`${HOST}/scripts/XML_daily.asp?date_req=${requested(day)}`, "ValCurs");
        if (effectiveDay(currency?.["@_Date"]) !== day) one.held.push("美元汇率文件日期与金属记录日不一致");
        const rates = ((currency?.Valute ?? []) as Rate[]).filter((rate) => rate.CharCode === "USD");
        if (rates.length > 1) one.held.push("美元汇率 USD 不止一项");
        const key = items.find((item) => item.rate && item.sourceName === "USD")?.key;
        for (const rate of rates) {
          if (rawText(rate.Nominal) !== "1") one.held.push("美元汇率 Nominal 不是 1");
          const value = rawText(rate.Value);
          if (!number.test(value)) one.held.push("美元汇率数值不是原文的逗号小数");
          if (key) one.rows.push({ key, unit: "卢布/美元", value: value.replace(",", ".") });
        }
        fetched.push(one);
      }
      return fetched;
    },
  };
}
