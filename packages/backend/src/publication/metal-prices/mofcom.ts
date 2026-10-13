// TASK-0082: three recorded weekly indices; preserve raw values and the source's single calendar date.
import { guardedFetch } from "../../lib/http-fetch.ts";
import { type MetalPriceRegistry, normalizeSourceName, onSourceHost } from "./registry.ts";
import type { FetchedPeriod, Fetcher, PageGetter } from "./types.ts";

export const MOFCOM_URL = "https://cif.mofcom.gov.cn/cif/getWeekLineChart2019.fhtml";
type Point = { DATADATE: string; DATA?: string | null; NAME?: string; UNIT?: string };
function points(text: string): { dates: Map<string, Point>; unit?: string } {
  const data = JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (key !== "DATA" || typeof value !== "number") return value;
    if (!context?.source) throw new Error("商务预报数值原文不可用");
    return context.source;
  });
  if (!data || !Array.isArray(data.datas) || !data.datas.length) throw new Error("商务预报回应没有日期价格点");
  if (data.unit !== undefined && typeof data.unit !== "string") throw new Error("商务预报单位字段无效");
  const dates = new Map<string, Point>();
  for (const point of data.datas) {
    const day = point?.DATADATE;
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day)
      throw new Error(`商务预报日期无效：${day}`);
    if (dates.has(day)) throw new Error(`商务预报日期重复：${day}`);
    if (["NAME", "UNIT"].some((key) => point[key] !== undefined && typeof point[key] !== "string") || (point.DATA != null && typeof point.DATA !== "string"))
      throw new Error("商务预报名称、单位或价格字段无效");
    dates.set(day, point);
  }
  return { dates, unit: data.unit };
}

export function mofcomFetcher(registry: MetalPriceRegistry, get: PageGetter = guardedFetch): Fetcher {
  return {
    sourceKeys: ["mofcom"],
    async fetch(newest) {
      const source = registry.sources.find((candidate) => candidate.key === "mofcom");
      if (!source || !onSourceHost(source, MOFCOM_URL)) throw new Error("商务预报请求不在登记的 HTTPS 主机上");
      const items = registry.items.filter((item) => item.source === "mofcom" && item.enabled);
      const replies: ReturnType<typeof points>[] = [];
      for (const item of items) {
        const response = await get(MOFCOM_URL, {
          method: "POST",
          body: new URLSearchParams({ indexId: item.sourceId!, startDate: "", endDate: "", flg: "2" }).toString(),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          maxRedirects: 0,
          maxBytes: 65536,
        });
        if (!onSourceHost(source, response.url)) throw new Error("商务预报跳到了登记之外的主机或非 HTTPS 地址");
        if (response.status !== 200) throw new Error(`商务预报返回 HTTP ${response.status}`);
        replies.push(points(response.text()));
      }
      const dates = [...new Set(replies.flatMap((reply) => [...reply.dates.keys()]))].sort();
      const since = await newest("mofcom");
      return (since ? dates.filter((day) => day >= since) : dates.slice(-2)).map((day) => {
        const [year, month, date] = day.split("-");
        const one: FetchedPeriod = {
          source: "mofcom",
          period: { start: day, end: day, label: `${year}年${Number(month)}月${Number(date)}日` },
          release: { label: `商务预报 ${day}`, url: source.officialUrl, releasedOn: null },
          rows: [],
          held: [],
        };
        for (const [i, item] of items.entries()) {
          const reply = replies[i],
            point = reply.dates.get(day);
          const value = point?.DATA?.trim().replaceAll(",", "") ?? "";
          const reason =
            !point || !value
              ? `商务预报这一周没有${item.name}的数`
              : point.NAME !== undefined && normalizeSourceName(point.NAME) !== normalizeSourceName(item.sourceName)
                ? `商务预报名称“${point.NAME}”与登记“${item.sourceName}”不符`
                : null;
          if (reason) {
            one.heldSeries ??= [];
            one.heldSeries.push({ key: item.key, reason });
          } else one.rows.push({ key: item.key, unit: point!.UNIT ?? reply.unit ?? item.sourceUnit, value });
        }
        return one;
      });
    },
  };
}
