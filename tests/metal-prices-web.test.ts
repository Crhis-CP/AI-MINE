// The /metals cards' presentation helpers: which quote leads a card and how its period and change read. Pure, no
// database or network; the payload is synthetic and parsed through the public contract.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MetalPrices } from "@amp/contracts/http/public";
import { changeText, headlineIndex, isBehind, licenceNotes, priceText, shortLabel } from "../modules/metals/web/quotes.ts";

const period = (end: string, label: string) => ({ start: end, end, label });
function prices(overrides: { dayStale?: boolean; dayValue?: string | null } = {}) {
  const { dayStale = false, dayValue = "9812.5" } = overrides;
  const quote = (key: string, source: string, value: string | null, p: ReturnType<typeof period>) => ({
    key,
    source,
    title: `合成 ${key}`,
    spec: null,
    footnote: null,
    value,
    unit: "美元/吨",
    currency: "USD" as const,
    decimals: null,
    period: value ? p : null,
    change: null,
  });
  return MetalPrices.parse({
    generatedAt: "2026-10-04T02:00:00Z",
    intro: "合成",
    latest: [
      { tag: "日", label: "10月2日", stale: dayStale, extras: [] },
      { tag: "周", label: "9月26日", stale: false, extras: [] },
      { tag: "月", label: "9月", stale: false, extras: [] },
    ],
    sources: [
      {
        key: "month",
        name: "合成月源",
        tag: "月",
        status: "fresh",
        latest: { label: "2026年9月", release: { label: "r", url: "https://source.invalid/m", date: null } },
      },
      {
        key: "week",
        name: "合成周源",
        tag: "周",
        status: "fresh",
        latest: { label: "2026年9月26日", release: { label: "r", url: "https://source.invalid/w", date: null } },
      },
      {
        key: "day",
        name: "合成日源",
        tag: "日",
        status: dayValue ? (dayStale ? "stale" : "fresh") : "empty",
        latest: dayValue ? { label: "2026年10月2日", release: { label: "r", url: "https://source.invalid/d", date: null } } : null,
      },
    ],
    metals: [
      {
        key: "copper",
        name: "铜",
        quotes: [
          quote("m", "month", "9245.18", period("2026-09-30", "2026年9月")),
          quote("w", "week", "78350", period("2026-09-26", "2026年9月26日")),
          quote("d", "day", dayValue, period("2026-10-02", "2026年10月2日")),
        ],
      },
      { key: "none", name: "无", quotes: [quote("x", "week", null, period("2026-09-26", "2026年9月26日"))] },
    ],
    notes: [{ ref: null, text: "合成月源数据按 {link} 许可使用。", link: { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" } }],
    officialLinks: [],
  });
}

test("the most frequent current quote with a price leads, whatever the API order", () => {
  const data = prices();
  assert.equal(data.metals[0]!.quotes[headlineIndex(data, data.metals[0]!)]!.key, "d");
  // Earlier data gives way to a current weekly quote; a missing daily price to the next frequency.
  const stale = prices({ dayStale: true });
  assert.equal(isBehind(stale, stale.metals[0]!, stale.metals[0]!.quotes[2]!), true);
  assert.equal(stale.metals[0]!.quotes[headlineIndex(stale, stale.metals[0]!)]!.key, "w");
  const missing = prices({ dayValue: null });
  assert.equal(missing.metals[0]!.quotes[headlineIndex(missing, missing.metals[0]!)]!.key, "w");
  // A metal without any price still has a card, led by its first quote (shown as 暂缺).
  assert.equal(headlineIndex(missing, missing.metals[1]!), 0);
});

test("periods, prices, changes and licences read as published", () => {
  const data = prices();
  assert.equal(shortLabel(data, "2026年10月2日"), "10月2日");
  assert.equal(shortLabel(data, "2025年12月下旬"), "2025年12月下旬");
  assert.equal(priceText("108770.0", null), "108,770.0");
  assert.equal(priceText("64.599999999999994", 2), "64.60");
  assert.deepEqual(changeText("1.0"), { text: "+1.0%", direction: "up" });
  assert.deepEqual(changeText("-1.6"), { text: "−1.6%", direction: "down" });
  assert.deepEqual(changeText("0.0"), { text: "0.0%", direction: "flat" });
  assert.deepEqual(
    licenceNotes(data.notes, data.sources[0]!).map((note) => note.link?.name),
    ["CC BY 4.0"],
  );
  assert.deepEqual(licenceNotes(data.notes, data.sources[1]!), []);
});
