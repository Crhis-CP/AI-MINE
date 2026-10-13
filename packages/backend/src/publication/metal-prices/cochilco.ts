import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { load } from "cheerio";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { guardedFetch } from "../../lib/http-fetch.ts";
import { type MetalPriceRegistry, onSourceHost } from "./registry.ts";
import type { FetchedPeriod, Fetcher, PageGetter } from "./types.ts";

export const COCHILCO_URL = "https://www.cochilco.cl/web/la-rueda-diaria/";
const MONTHS = "enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre".split(" ");
const NUMBER = "((?:\\d{1,3}(?:\\.\\d{3})+|\\d+),\\d+)";
const decimal = (value: string) => value.replaceAll(".", "").replace(",", ".");
const tidy = (value: string) => value.replace(/\s+/gu, " ").trim();

/** One text-layer page; no OCR, chart reading or external PDF resources. */
export async function cochilcoLines(bytes: Buffer): Promise<string[]> {
  if (bytes.length > 4 * 1024 * 1024 || bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("Cochilco 文件不是限定大小的 PDF");
  const entry = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: Uint8Array.from(bytes),
    stopAtErrors: true,
    useWorkerFetch: false,
    disableAutoFetch: true,
    disableStream: true,
    enableXfa: false,
    verbosity: 0,
    standardFontDataUrl: fileURLToPath(new URL("../../standard_fonts/", entry)),
  });
  try {
    const document = await task.promise;
    if (document.numPages !== 1) throw new Error("Cochilco 日报不再是一页，需核对版式");
    const page = await document.getPage(1);
    const { items } = await page.getTextContent();
    if (items.length > 20_000) throw new Error("Cochilco 文字层超过限制");
    const rows = new Map<number, { x: number; text: string }[]>();
    for (const item of items)
      if ("str" in item && item.str.trim()) {
        const y = Math.round(item.transform[5]);
        rows.set(y, [...(rows.get(y) ?? []), { x: item.transform[4], text: item.str }]);
      }
    return [...rows]
      .sort(([a], [b]) => b - a)
      .map(([, cells]) =>
        tidy(
          cells
            .sort((a, b) => a.x - b.x)
            .map((cell) => cell.text)
            .join(" "),
        ),
      );
  } finally {
    await task.destroy();
  }
}

/** Read the USD/metric-ton cash tables, never the cents/lb, futures, charts or old lithium observation. */
export function cochilcoPeriod(registry: MetalPriceRegistry, day: string, url: string, lines: string[], hash: string): FetchedPeriod {
  const [year, month, date] = day.split("-").map(Number);
  const spanish = `${MONTHS[month - 1]} ${date}, ${year}`;
  if (!lines.some((line) => line.includes(`${date} de ${MONTHS[month - 1]} de ${year}`))) throw new Error("Cochilco 日报日期与列表不符");
  const section = (start: string, end: string) => {
    const first = lines.findIndex((line) => line === start);
    const last = lines.findIndex((line, index) => index > first && line.startsWith(end));
    if (first < 0 || last <= first) throw new Error(`Cochilco 缺少价格区块 ${start}`);
    return lines.slice(first + 1, last);
  };
  const copper = section("Cotizaciones en Bolsa de Metales de Londres (LME)", "Cotizaciones en Bolsa de Nueva York");
  const others = section("OTROS METALES Y LITIO", "Carbonato de Litio");
  if (![copper, others].every((rows) => rows.some((line) => line.startsWith(spanish)))) throw new Error("Cochilco 报价日期与日报日期不符");
  if (!others.includes("Cotizaciones en Bolsa de Metales de Londres Contado (LME)") || !others.some((line) => /US\$\/TM.*¢US\$\/lb/.test(line)))
    throw new Error("Cochilco 基础金属的市场或单位发生变化");
  const unit = copper.findIndex((line) => line === "US$/TM");
  if (unit < 0) throw new Error("Cochilco 铜价没有美元/吨区块");
  const cash = copper.slice(unit + 1).filter((line) => line.startsWith("Contado "));
  const one: FetchedPeriod = {
    source: "cochilco",
    period: { start: day, end: day, label: `${year}年${month}月${date}日` },
    release: { label: `Cochilco La Rueda ${day} ${hash}`, url, releasedOn: day },
    rows: [],
    held: [],
  };
  for (const item of registry.items.filter((item) => item.source === "cochilco" && item.enabled)) {
    const candidates = item.sourceName === "Cobre" ? cash : others.filter((line) => line.startsWith(`${item.sourceName} `));
    const pattern =
      item.sourceName === "Cobre"
        ? new RegExp(`^Contado ${NUMBER} [-+]?\\d+,\\d+(?: |$)`)
        : new RegExp(`^${item.sourceName} ${NUMBER} ${NUMBER} [-+]?\\d+,\\d+$`);
    const match = candidates.length === 1 ? pattern.exec(candidates[0]) : null;
    if (!match) one.held.push(`${item.key} 的美元/吨价格行缺失、重复或格式变化`);
    else one.rows.push({ key: item.key, value: decimal(match[1]), unit: "US$/TM" });
  }
  return one;
}

export function cochilcoFetcher(registry: MetalPriceRegistry, get: PageGetter = guardedFetch): Fetcher {
  return {
    sourceKeys: ["cochilco"],
    async fetch(newest) {
      const source = registry.sources.find((source) => source.key === "cochilco");
      if (!source) throw new Error("登记里没有 Cochilco");
      const request = async (url: string, maxBytes: number) => {
        if (!onSourceHost(source, url)) throw new Error("Cochilco 地址不在登记的 HTTPS 主机上");
        const response = await get(url, { maxRedirects: 0, maxBytes });
        if (response.status !== 200 || response.url !== url) throw new Error(`Cochilco 请求失败或跳转：${response.status}`);
        return response;
      };
      const list = await request(COCHILCO_URL, 2 * 1024 * 1024),
        $ = load(list.text());
      const found = new Map<string, string>();
      for (const link of $("a.wpfd-file-link[href]").toArray()) {
        const match = /^Rueda (\d{2})-(\d{2})-(\d{4})$/.exec(tidy($(link).attr("title") ?? $(link).text()));
        if (!match) continue;
        const day = `${match[3]}-${match[2]}-${match[1]}`,
          url = new URL($(link).attr("href")!, COCHILCO_URL).href;
        if (!Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw new Error("Cochilco 列表日期无效");
        if (!onSourceHost(source, url) || !new URL(url).pathname.endsWith(".pdf")) throw new Error("Cochilco 列表文件不在登记范围内");
        if (found.has(day) && found.get(day) !== url) throw new Error("Cochilco 同一天列出多个文件，不猜哪份为准");
        found.set(day, url);
      }
      if (!found.size) throw new Error("Cochilco 列表没有可识别的日报");
      const since = await newest("cochilco"),
        sorted = [...found].sort(([a], [b]) => a.localeCompare(b));
      const selected = since ? sorted.filter(([day]) => day >= since).slice(-32) : sorted.slice(-2);
      const result: FetchedPeriod[] = [];
      for (const [day, url] of selected) {
        try {
          const file = await request(url, 4 * 1024 * 1024);
          if (!file.body) throw new Error("Cochilco PDF 没有字节");
          result.push(cochilcoPeriod(registry, day, url, await cochilcoLines(file.body), createHash("sha256").update(file.body).digest("hex")));
        } catch (error) {
          // A broken daily observation must not prevent newer valid days from advancing the stored cursor.
          const [year, month, date] = day.split("-");
          result.push({
            source: "cochilco",
            period: { start: day, end: day, label: `${year}年${Number(month)}月${Number(date)}日` },
            release: { label: `Cochilco La Rueda ${day}（读取失败）`, url, releasedOn: day },
            rows: [],
            held: [`日报读取失败：${(error instanceof Error ? error.message : String(error)).slice(0, 500).toWellFormed()}`],
          });
        }
      }
      return result;
    },
  };
}
