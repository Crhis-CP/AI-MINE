import { beijingDate } from "@amp/contracts/time";
import { UsagePrice } from "@amp/contracts/http/private";
import type { z } from "zod";
import { dbOf, type Db } from "../db.ts";
const sql = dbOf("ai-gateway");
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
export type UsageQuote = { price_id: string; price_version: number; price: Price; reserved_micros: string; bounds: UsageBounds | null };
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
  const bounds = input.bounds ?? null;
  let reserved = price.per_request_micros === null ? 0n : BigInt(price.per_request_micros);
  if (bounds) {
    if (![bounds.input_tokens, bounds.output_tokens, bounds.images ?? 0].every((n) => Number.isSafeInteger(n) && n >= 0))
      return { quote: null, missing: "缺少可核输入输出上界" };
    if ((bounds.images ?? 0) > 0 && price.image_input_token_bound === null) return { quote: null, missing: "缺少供应商图像计费上界" };
    if (price.input_per_million_micros === null || price.output_per_million_micros === null) return { quote: null, missing: "缺少输入和输出人民币单价" };
    const inputTokens =
      BigInt(bounds.input_tokens) + BigInt(price.protocol_input_token_allowance) + BigInt(bounds.images ?? 0) * BigInt(price.image_input_token_bound ?? 0);
    reserved += ceilDivide(
      inputTokens * unitRate(price.input_per_million_micros) + BigInt(bounds.output_tokens) * unitRate(price.output_per_million_micros),
      MICRO * 100n,
    );
  } else if (price.max_request_micros === null && price.per_request_micros === null) return { quote: null, missing: "缺少单次最坏费用依据" };
  if (price.max_request_micros !== null && BigInt(price.max_request_micros) > reserved) reserved = BigInt(price.max_request_micros);
  return { quote: { price_id: id, price_version: row.version, price, reserved_micros: reserved.toString(), bounds }, missing: null };
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
  let amount = p.per_request_micros === null ? 0n : BigInt(p.per_request_micros);
  if (quote.bounds || (p.input_per_million_micros !== null && p.output_per_million_micros !== null)) {
    const input = usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.tokens ?? usage?.total_tokens,
      output = usage?.completion_tokens ?? (quote.bounds?.output_tokens === 0 || p.output_per_million_micros === "0" ? 0 : undefined);
    if (
      ![input, output].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) ||
      p.input_per_million_micros === null ||
      p.output_per_million_micros === null
    )
      return null;
    amount += ceilDivide(
      BigInt(input as number) * unitRate(p.input_per_million_micros) + BigInt(output as number) * unitRate(p.output_per_million_micros),
      MICRO * 100n,
    );
  } else if (p.per_request_micros === null) return null;
  return { micros: amount, basis: "estimated" as const };
}
