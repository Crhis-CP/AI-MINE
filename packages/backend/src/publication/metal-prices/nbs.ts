// National Bureau of Statistics (TASK-0057): ten-day prices of important means of production in circulation. The news
// list names each release and so its period; the release page carries the price table, found by its header and read by
// registered name. "本期价格" is not said to be a ten-day average, so nothing here calls it one: a value is its period's.
import { type CheerioAPI, load } from "cheerio";
import { guardedFetch } from "../../lib/http-fetch.ts";
import { type MetalPriceRegistry, normalizeSourceName, onSourceHost } from "./registry.ts";
import type { FetchedPeriod, Fetcher, PageGetter, Period, PriceRow } from "./types.ts";

export const NBS_LIST_URL = "https://www.stats.gov.cn/sj/zxfb/index.html";
const TITLE = /^(\d{4})年(\d{1,2})月([上中下])旬流通领域重要生产资料市场价格变动情况$/;
/** The price table's leading header cells, NFKC with no whitespace; the two after them (the changes) are not read. */
const HEADER = ["产品名称", "单位", "本期价格(元)"];

type Listed = Omit<FetchedPeriod, "rows" | "held">;

/** The period a release title names: 上旬 days 1–10, 中旬 11–20, 下旬 the 21st to the month's last day. */
export function tenDayPeriod(title: string): Period | null {
  const [, year, month, part] = TITLE.exec(title) ?? [];
  if (!year || !month || !part || Number(month) < 1 || Number(month) > 12) return null;
  const first = { 上: 1, 中: 11, 下: 21 }[part as "上" | "中" | "下"];
  const last = part === "下" ? new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate() : first + 9;
  const day = (d: number) => `${year}-${month.padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { start: day(first), end: day(last), label: `${year}年${Number(month)}月${part}旬` };
}

/**
 * The ten-day releases on the list, once each: an entry links its page three times (one per screen size, the smallest
 * with its text cut short), so a link counts by its full title and once per address. The date is the entry's own, not
 * read from the file name (the latest release is dated the 24th, its file named the 23rd).
 */
function listed($: CheerioAPI, base: string): Listed[] {
  const found = new Map<string, Listed>();
  for (const link of Array.from($("li a[href]"))) {
    const label = ($(link).attr("title") ?? $(link).text()).trim();
    const period = tenDayPeriod(label);
    if (!period) continue;
    const url = new URL($(link).attr("href")!, base).href;
    const date = $(link).closest("li").find("span").first().text().trim();
    if (!found.has(url)) found.set(url, { source: "nbs", period, release: { label, url, releasedOn: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null } });
  }
  return [...found.values()];
}

/** The release page writes its title from a script in <h1> (`var title1 = '…'`): one unlike the list's, or none, holds. */
function titleHeld($: CheerioAPI, label: string): string[] {
  const title = /\btitle1\s*=\s*'([^']*)'/.exec($("h1").text())?.[1]?.trim();
  if (title === undefined) return ["发布页读不到标题（<h1> 的脚本里没有 title1）"];
  return title === label ? [] : [`发布页标题“${title}”与列表页标题“${label}”不一致`];
}

/**
 * Every copy of the price table (the page repeats it for another screen size), read by registered name; a copy that
 * reads differently from the first holds the period back. No table headed as expected throws, saying what was there.
 */
function priceTable($: CheerioAPI, keys: Map<string, string>): Pick<FetchedPeriod, "rows" | "held"> {
  const tables = Array.from($("table"), (table) =>
    Array.from($(table).find("tr"), (row) => Array.from($(row).children("td, th"), (cell) => $(cell).text().trim())),
  );
  const copies = tables.filter(([header = []]) => HEADER.every((cell, i) => normalizeSourceName(header[i] ?? "") === cell));
  if (!copies.length) {
    const firsts = tables.map(([header = []]) => `“${header[0] ?? ""}”`).join("、");
    throw new Error(`发布页没有价格表：找到 ${tables.length} 张表${firsts && `，首格是${firsts}`}`);
  }
  const read = ([, ...body]: string[][]): PriceRow[] =>
    body.flatMap(([name = "", unit = "", value = ""]) => {
      const key = keys.get(normalizeSourceName(name));
      return key ? [{ key, unit, value: value.replaceAll(",", "") }] : [];
    });
  const [rows, ...others] = copies.map(read);
  const show = (row?: PriceRow) => (row ? `${row.key} ${row.unit} ${row.value}` : "没有这一行");
  const held = others.flatMap((copy, n) => {
    const i = [...Array(Math.max(rows.length, copy.length)).keys()].find((i) => show(rows[i]) !== show(copy[i]));
    return i === undefined ? [] : [`价格表第 ${n + 2} 份与第 1 份不同：第 1 份是“${show(rows[i])}”，第 ${n + 2} 份是“${show(copy[i])}”`];
  });
  return { rows, held };
}

export function nbsFetcher(registry: MetalPriceRegistry, get: PageGetter = guardedFetch): Fetcher {
  return {
    sourceKeys: ["nbs"],
    async fetch(newest) {
      const source = registry.sources.find((candidate) => candidate.key === "nbs");
      if (!source) throw new Error("登记里没有国家统计局");
      const enabled = registry.items.filter((item) => item.source === "nbs" && item.enabled);
      const keys = new Map(enabled.map((item) => [normalizeSourceName(item.sourceName), item.key]));
      // INV-33: an error status, an address or redirect off the registered https hosts, a list naming no period and a
      // release without its table (a redesign or a challenge page) fail the source; none of them reads as "nothing new".
      const page = async (url: string) => {
        if (!onSourceHost(source, url)) throw new Error(`${url} 不在国家统计局登记的主机上或不是 https`);
        const res = await get(url);
        if (!onSourceHost(source, res.url)) throw new Error(`${url} 跳到了 ${res.url}，不在登记的主机上或不是 https`);
        if (res.status !== 200) throw new Error(`${url} 返回 HTTP ${res.status}`);
        return { $: load(res.text()), url: res.url };
      };
      const list = await page(NBS_LIST_URL);
      const found = listed(list.$, list.url).toSorted((a, b) => a.period.start.localeCompare(b.period.start));
      if (!found.length) throw new Error("列表页没有认出任何一期（可能改版或是验证页）");
      // The stored newest period is read again, to catch a value changed in its version; nothing stored: the newest alone.
      const since = await newest("nbs");
      const fetched: FetchedPeriod[] = [];
      for (const one of since ? found.filter((later) => later.period.start >= since) : found.slice(-1)) {
        const { $ } = await page(one.release.url);
        const { rows, held } = priceTable($, keys);
        fetched.push({ ...one, rows, held: [...titleHeld($, one.release.label), ...held] });
      }
      return fetched;
    },
  };
}
