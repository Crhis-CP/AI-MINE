// Whether a published comparison equals this period minus the previous one. A missing previous period is blank on
// purpose and is not an alert: the next official release has not arrived, and a Saturday has no new daily fixing.
import { addDays } from "@amp/contracts/time";

const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function parts(value: string): { signed: bigint; scale: number } {
  if (!DECIMAL.test(value)) throw new Error("not a decimal");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const digits = BigInt(`${whole}${fraction}`);
  return { signed: negative ? -digits : digits, scale: fraction.length };
}

/**
 * `(current − previous) / previous × 100`, rounded half away from zero to one decimal, as PostgreSQL `numeric` round does.
 * Exact zero is `0.0`, never `-0.0`.
 */
export function percentVersusPrevious(current: string, previous: string): string {
  const left = parts(current);
  const right = parts(previous);
  const scale = Math.max(left.scale, right.scale);
  const currentScaled = left.signed * 10n ** BigInt(scale - left.scale);
  const previousScaled = right.signed * 10n ** BigInt(scale - right.scale);
  if (previousScaled <= 0n) throw new Error("previous price is not positive");
  const diff = currentScaled - previousScaled;
  const negative = diff < 0n;
  const magnitude = (negative ? -diff : diff) * 1000n;
  const quotient = magnitude / previousScaled;
  const remainder = magnitude % previousScaled;
  const rounded = remainder * 2n >= previousScaled ? quotient + 1n : quotient;
  if (rounded === 0n) return "0.0";
  return `${negative ? "-" : ""}${quotientDigits(rounded)}`;
}

function quotientDigits(rounded: bigint): string {
  const whole = rounded / 10n;
  const tenth = rounded % 10n;
  return `${whole.toString()}.${tenth.toString()}`;
}

function spoken(percent: string): string {
  if (percent === "0.0") return "持平 0.0%";
  if (percent.startsWith("-")) return `跌 ${percent.slice(1)}%`;
  return `涨 ${percent}%`;
}

export interface ComparedQuote {
  metal: string;
  title: string;
  /** Page frequency tag: 日, 周, 旬 or 月. */
  tag: string;
  value: string | null;
  period: { start: string; end: string } | null;
  change: {
    percent: string;
    previous: { value: string; period: { start: string; end: string } };
  } | null;
}

/** What is wrong with one row, or null when the blank or the figure is the comparison this source actually uses. */
export function metalChangeIssue(quote: ComparedQuote): string | null {
  if (quote.value === null) return null;
  if (!quote.change) return null;
  if (!quote.period) return "没有本期，却写出了涨跌";
  const previousValue = quote.change.previous.value;
  if (!previousValue) return "没有上一期，却写出了涨跌";
  let expected: string;
  try {
    expected = percentVersusPrevious(quote.value, previousValue);
  } catch {
    return "前后两期的价格没法相减";
  }
  if (expected !== quote.change.percent) {
    const reversed = expected !== "0.0" && quote.change.percent !== "0.0" && expected.startsWith("-") !== quote.change.percent.startsWith("-");
    const page = spoken(quote.change.percent);
    const should = spoken(expected);
    return reversed ? `涨跌方向反了：页面是${page}，本期减上一期应是${should}` : `涨跌和本期减上一期不一致：页面是${page}，应是${should}`;
  }
  return periodIssue(quote.tag, quote.period, quote.change.previous.period);
}

function singleDay(period: { start: string; end: string }): boolean {
  return period.start === period.end;
}

function periodIssue(tag: string, current: { start: string; end: string }, previous: { start: string; end: string }): string | null {
  if (tag === "日") {
    if (!singleDay(current) || !singleDay(previous) || previous.start >= current.start) return "日价应比上一个定价日";
    return null;
  }
  if (tag === "周") {
    if (!singleDay(current) || !singleDay(previous) || previous.start !== addDays(current.start, -7)) return "周价应比正好早 7 天的那一期";
    return null;
  }
  if (tag === "旬" || tag === "月") {
    if (previous.end !== addDays(current.start, -1)) return tag === "月" ? "月价应比紧挨着的上个月" : "旬价应比紧挨着的上一旬";
    return null;
  }
  return null;
}

export function metalPriceChangeIssues(prices: {
  sources: readonly { key: string; tag: string }[];
  metals: readonly {
    name: string;
    quotes: readonly {
      title: string;
      source: string;
      value: string | null;
      period: { start: string; end: string } | null;
      change: ComparedQuote["change"];
    }[];
  }[];
}): string[] {
  const tags = new Map(prices.sources.map((source) => [source.key, source.tag]));
  const issues: string[] = [];
  for (const metal of prices.metals)
    for (const quote of metal.quotes) {
      const issue = metalChangeIssue({ ...quote, metal: metal.name, tag: tags.get(quote.source) ?? "" });
      if (issue) issues.push(`${metal.name}的${quote.title}：${issue}`);
    }
  return issues;
}
