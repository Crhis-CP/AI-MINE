// NBU observations are transient comparison inputs: no returned quote, raw rate, or response body enters storage/logs.
import { type MetalPriceRegistry, onSourceHost } from "./registry.ts";
import type { FetchedPeriod, PageGetter } from "./types.ts";

const CODES: Record<string, string> = { gold: "XAU", silver: "XAG", platinum: "XPT", palladium: "XPD" };
class ComparisonUnavailable extends Error {}
function unavailable(reason: string): never {
  throw new ComparisonUnavailable(reason);
}
/** Decimal fractions, including JSON numbers written with an exponent; comparison never rounds at the 5% boundary. */
function fraction(value: string | number): [bigint, bigint] {
  const [coefficient, power = "0"] = String(value).toLowerCase().split("e"),
    [whole, decimals = ""] = coefficient.split(".");
  const numerator = BigInt(whole + decimals),
    exponent = Number(power) - decimals.length;
  return exponent >= 0 ? [numerator * 10n ** BigInt(exponent), 1n] : [numerator, 10n ** BigInt(-exponent)];
}
const product = (...values: (string | number)[]) => values.map(fraction).reduce(([n, d], [nn, dd]) => [n * nn, d * dd], [1n, 1n]);

export async function compareCbrWithNbu(registry: MetalPriceRegistry, one: FetchedPeriod, get: PageGetter): Promise<void> {
  const source = registry.sources.find((s) => s.key === "cbr")!;
  const quotes = registry.items.filter((item) => item.source === "cbr" && item.enabled && item.convert);
  // Missing/invalid Russian rows will be held by the common check; they cannot form a comparison.
  if (
    quotes.some((item) =>
      [item.key, item.convert!.rate].some(
        (key) => one.rows.filter((row) => row.key === key).length !== 1 || !(Number(one.rows.find((row) => row.key === key)?.value) > 0),
      ),
    )
  )
    return;
  try {
    const url = `https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?date=${one.period.start.replaceAll("-", "")}&json`;
    if (!onSourceHost(source, url)) unavailable("比对主机没有登记");
    const response = await get(url, { maxRedirects: 0 });
    if (response.url !== url) unavailable("请求发生跳转");
    if (response.status !== 200) unavailable(`HTTP ${response.status}`);
    let data: unknown;
    try {
      data = JSON.parse(response.text());
    } catch {
      unavailable("回应不是 JSON");
    }
    if (!Array.isArray(data)) unavailable("回应不是列表");
    const rates = new Map<string, number>();
    for (const code of ["USD", ...Object.values(CODES)]) {
      const matched = data.filter((row) => row && typeof row === "object" && row.cc === code);
      if (matched.length !== 1) unavailable("比对品种缺失或重复");
      const row = matched[0];
      if (typeof row.rate !== "number" || !Number.isFinite(row.rate) || row.rate <= 0) unavailable("比对数不是正数");
      if (row.exchangedate !== one.period.start.split("-").reverse().join(".")) unavailable("比对日期不一致");
      rates.set(code, row.rate);
    }
    for (const item of quotes) {
      const raw = one.rows.find((row) => row.key === item.key)!.value,
        rate = one.rows.find((row) => row.key === item.convert!.rate)!.value;
      const [an, ad] = product(raw, item.convert!.factor, rates.get("USD")!),
        [bn, bd] = product(rate, rates.get(CODES[item.metal!]!)!);
      const left = an * bd,
        right = bn * ad,
        difference = left > right ? left - right : right - left;
      if (difference * 20n > right) {
        const percent = (difference * 10000n + right / 2n) / right;
        const display = percent === 500n ? ">5.00" : `${percent / 100n}.${String(percent % 100n).padStart(2, "0")}`;
        one.held.push(`${item.name}与乌克兰央行的同类价格差 ${display}%，超过 5%`);
      }
    }
  } catch (error) {
    // Never echo a transport/JSON error: it can contain the comparison provider's body or figures.
    one.notes = [...(one.notes ?? []), `乌克兰央行比对没做成：${error instanceof ComparisonUnavailable ? error.message : "取页或解析失败"}`];
  }
}
