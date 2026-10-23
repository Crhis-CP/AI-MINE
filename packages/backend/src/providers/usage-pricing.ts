import { beijingDate } from "@amp/contracts/time";
import { UsagePrice } from "@amp/contracts/http/private";
import type { z } from "zod";
import { sql, type Db } from "../db.ts";

import { sha256, stableJson } from "../lib/ids.ts";
export const MICRO = 1000000n;
export const ratioMicros = (value: string) => BigInt(value.split(".")[0]!) * MICRO + BigInt((value.split(".")[1] ?? "").padEnd(6, "0"));
export const amountMicros = (value: string): bigint | null => (/^\d+(?:\.\d{1,6})?$/.test(value) ? ratioMicros(value) : null);
/** Unit prices retain all eight CNY decimals; only final charge/reservation rounds up to a whole micro. */
export function rateMicros(value: string): string | null {
  if (!/^\d+(?:\.\d{1,8})?$/.test(value)) return null;
  const scaled = BigInt(value.split(".")[0]!) * 100000000n + BigInt((value.split(".")[1] ?? "").padEnd(8, "0"));
  return `${scaled / 100n}${
    scaled % 100n
      ? "." +
        String(scaled % 100n)
          .padStart(2, "0")
          .replace(/0+$/, "")
      : ""
  }`;
}
export const unitRate = (value: string) => BigInt(value.split(".")[0]!) * 100n + BigInt((value.split(".")[1] ?? "").padEnd(2, "0"));
export const rateYuan = (value: string) => {
  const n = unitRate(value);
  return `${n / 100000000n}.${String(n % 100000000n).padStart(8, "0")}`;
};
export const centsText = (micros: bigint) => `${micros / MICRO}.${String(micros % MICRO).padStart(6, "0")}`;
export const ceilDivide = (a: bigint, b: bigint) => (a + b - 1n) / b;
export type UsageBounds = { input_tokens: number; output_tokens: number; images?: number };
export type Price = z.infer<typeof UsagePrice>;
export const usagePriceId = (service: string, model: string, configurationHash: string | null) => sha256(stableJson([service, model, configurationHash]));
export type UsageQuote = {
  price_id: string | null;
  price_version: number;
  price: Price | null;
  reserved_micros: string;
  bounds: UsageBounds | null;
  quoted_at?: string;
  rate_window?: NonNullable<Price["rate_windows"]>[number] | null;
  pricing_issue?: string;
  settlement_issue?: string;
};
export async function priceQuote(
  db: Db = sql,
  input: {
    service: string;
    model?: string | null;
    configurationHash?: string | null;
    bounds?: UsageBounds;
    registeredPricing?: { input: string; output: string; basis: string };
  },
  now = new Date(),
): Promise<{ quote: UsageQuote | null; missing: string | null }> {
  const id = usagePriceId(input.service, input.model ?? "", input.configurationHash ?? null);
  const [row] = await db<{ version: number; price: unknown }[]>`SELECT version,price FROM ai.usage_prices WHERE id=${id}`;
  const parsed = UsagePrice.safeParse(row?.price);
  if (!row || !parsed.success) return { quote: null, missing: "未登记可核对的人民币价格" };
  const price = parsed.data,
    day = beijingDate(now);
  if (price.observed_on > day || price.valid_until < day) return { quote: null, missing: "人民币价格尚未生效或已经到期" };
  if (
    input.registeredPricing &&
    (price.input_per_million_micros === null ||
      rateMicros(input.registeredPricing.input) === null ||
      unitRate(rateMicros(input.registeredPricing.input)!) !== unitRate(price.input_per_million_micros) ||
      price.output_per_million_micros === null ||
      rateMicros(input.registeredPricing.output) === null ||
      unitRate(rateMicros(input.registeredPricing.output)!) !== unitRate(price.output_per_million_micros) ||
      input.registeredPricing.basis !== price.basis_url)
  )
    return { quote: null, missing: "登记价格已变化，需要重新确认计费依据和有效期" };
  return refreshUsageQuote({ price_id: id, price_version: row.version, price, reserved_micros: "0", bounds: input.bounds ?? null }, now);
}
/** Keep the accepted price version; only an unsubmitted request may select another explicit window. */
export function refreshUsageQuote(quote: UsageQuote, now: Date): { quote: UsageQuote | null; missing: string | null } {
  const price = quote.price,
    day = beijingDate(now);
  if (!price || price.observed_on > day || price.valid_until < day) return { quote: null, missing: "调用前价格依据缺失或已过期" };
  const window = price.rate_windows?.find((w) => Date.parse(w.starts_at) <= now.getTime() && now.getTime() < Date.parse(w.ends_at)) ?? null;
  const rates = window ?? price,
    bounds = quote.bounds;
  let reserved = price.per_request_micros === null ? 0n : BigInt(price.per_request_micros);
  if (bounds) {
    if (![bounds.input_tokens, bounds.output_tokens, bounds.images ?? 0].every((n) => Number.isSafeInteger(n) && n >= 0))
      return { quote: null, missing: "缺少可核输入输出上界" };
    if ((bounds.images ?? 0) > 0 && price.image_input_token_bound === null) return { quote: null, missing: "缺少供应商图像计费上界" };
    if (rates.input_per_million_micros === null || rates.output_per_million_micros === null) return { quote: null, missing: "缺少输入和输出人民币单价" };
    const inputTokens =
      BigInt(bounds.input_tokens) + BigInt(price.protocol_input_token_allowance) + BigInt(bounds.images ?? 0) * BigInt(price.image_input_token_bound ?? 0);
    const inputRate = unitRate(rates.input_per_million_micros),
      cachedRate = unitRate(rates.cache_hit_input_per_million_micros ?? "0");
    reserved += ceilDivide(
      inputTokens * (inputRate > cachedRate ? inputRate : cachedRate) + BigInt(bounds.output_tokens) * unitRate(rates.output_per_million_micros),
      MICRO * 100n,
    );
  } else if (price.max_request_micros === null && price.per_request_micros === null) return { quote: null, missing: "缺少单次最坏费用依据" };
  if (price.max_request_micros !== null && BigInt(price.max_request_micros) > reserved) reserved = BigInt(price.max_request_micros);
  return {
    quote: { ...quote, quoted_at: now.toISOString(), rate_window: window, pricing_issue: undefined, reserved_micros: reserved.toString() },
    missing: null,
  };
}
export function settleQuotedCost(
  quote: UsageQuote,
  usage: Record<string, unknown> | null,
  actual: { amount: number | string; currency: string; basis: string } | null,
) {
  if (actual?.basis === "actual") {
    const exact = actual.currency === "CNY" ? amountMicros(String(actual.amount)) : null;
    return exact === null ? null : { micros: exact, basis: "actual" as const };
  }
  const p = quote.price;
  if (!p || quote.pricing_issue) return null;
  if (p.cache_hit_input_per_million_micros != null || p.rate_windows?.length) {
    if (!quote.quoted_at || !Object.hasOwn(quote, "rate_window") || !Number.isFinite(Date.parse(quote.quoted_at))) return null;
    const frozen = refreshUsageQuote(quote, new Date(quote.quoted_at));
    if (!frozen.quote || stableJson(frozen.quote.rate_window) !== stableJson(quote.rate_window)) return null;
  }
  const rates = quote.rate_window ?? p;
  let amount = p.per_request_micros === null ? 0n : BigInt(p.per_request_micros);
  if (quote.bounds || (p.input_per_million_micros !== null && p.output_per_million_micros !== null)) {
    const cached = rates.cache_hit_input_per_million_micros;
    // Cache prices support the existing OpenAI-compatible usage dialect, not mixed protocol totals.
    if (
      cached != null &&
      ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].some((key) => Object.hasOwn(usage ?? {}, key))
    )
      return null;
    const input = cached != null ? usage?.prompt_tokens : (usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.tokens ?? usage?.total_tokens),
      output = usage?.completion_tokens ?? (quote.bounds?.output_tokens === 0 || rates.output_per_million_micros === "0" ? 0 : undefined);
    if (
      ![input, output].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) ||
      rates.input_per_million_micros === null ||
      rates.output_per_million_micros === null
    )
      return null;
    let inputCost = BigInt(input as number) * unitRate(rates.input_per_million_micros);
    if (cached != null) {
      const details = usage?.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
      const hits = [usage?.prompt_cache_hit_tokens, details?.cached_tokens].filter((v) => v !== undefined);
      const miss = usage?.prompt_cache_miss_tokens;
      if (!hits.length || ![...hits, miss].every((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0) || hits.some((v) => v !== hits[0]))
        return null;
      const hit = BigInt(hits[0] as number),
        missed = BigInt(miss as number);
      if (hit + missed !== BigInt(input as number)) return null;
      inputCost = missed * unitRate(rates.input_per_million_micros) + hit * unitRate(cached);
    }
    amount += ceilDivide(inputCost + BigInt(output as number) * unitRate(rates.output_per_million_micros), MICRO * 100n);
  } else if (p.per_request_micros === null) return null;
  return { micros: amount, basis: "estimated" as const };
}
