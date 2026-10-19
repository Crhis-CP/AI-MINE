// A published change must equal this period minus the previous one. A missing previous period stays blank:
// that is waiting for the next official release, not a rise or a fall, and it does not alert.
import assert from "node:assert/strict";
import { test } from "node:test";
import { metalChangeIssue, metalPriceChangeIssues, percentVersusPrevious, type ComparedQuote } from "../modules/metals/backend/change.ts";

const row = (change: Partial<ComparedQuote> & Pick<ComparedQuote, "tag" | "value" | "period">): ComparedQuote => ({
  metal: "金",
  title: "报价",
  change: null,
  ...change,
});

test("percent versus the previous period rounds half away from zero to one decimal", () => {
  assert.equal(percentVersusPrevious("100.05", "100.00"), "0.1");
  assert.equal(percentVersusPrevious("99.95", "100.00"), "-0.1");
  assert.equal(percentVersusPrevious("99.96", "100"), "0.0");
  assert.equal(percentVersusPrevious("12", "10"), "20.0");
  assert.equal(percentVersusPrevious("79", "80"), "-1.3");
  assert.equal(percentVersusPrevious("4124.5457766396246149", "4095.3962864890367642"), "0.7");
  assert.equal(percentVersusPrevious("58.8514848149927919", "60.0860095878469584"), "-2.1");
  assert.equal(percentVersusPrevious("4319", "4411"), "-2.1");
  assert.equal(percentVersusPrevious("111256", "111975"), "-0.6");
});

test("a daily price compares with the previous trading day, including across a weekend", () => {
  assert.equal(
    metalChangeIssue(
      row({
        tag: "日",
        value: "4124.5457766396246149",
        period: { start: "2026-10-09", end: "2026-10-09" },
        change: {
          percent: "0.7",
          previous: { value: "4095.3962864890367642", period: { start: "2026-10-08", end: "2026-10-08" } },
        },
      }),
    ),
    null,
  );
  assert.equal(
    metalChangeIssue(
      row({
        tag: "日",
        value: "4190.0477",
        period: { start: "2026-10-05", end: "2026-10-05" },
        change: {
          percent: "0.9",
          previous: { value: "4151.6470", period: { start: "2026-10-02", end: "2026-10-02" } },
        },
      }),
    ),
    null,
    "Monday compares with the previous Friday; Saturday does not invent a fixing",
  );
});

test("weekly, ten-day and monthly prices may compare with an earlier effective period across a missing release", () => {
  assert.equal(
    metalChangeIssue(
      row({
        metal: "铜",
        title: "国内 · 铜 1#",
        tag: "周",
        value: "111256",
        period: { start: "2026-10-02", end: "2026-10-02" },
        change: { percent: "-0.6", previous: { value: "111975", period: { start: "2026-09-25", end: "2026-09-25" } } },
      }),
    ),
    null,
  );
  assert.equal(
    metalChangeIssue(
      row({
        tag: "月",
        value: "4319",
        period: { start: "2026-09-01", end: "2026-09-30" },
        change: { percent: "-2.1", previous: { value: "4411", period: { start: "2026-08-01", end: "2026-08-31" } } },
      }),
    ),
    null,
  );
  assert.equal(
    metalChangeIssue(
      row({
        tag: "周",
        value: "111256",
        period: { start: "2026-10-02", end: "2026-10-02" },
        change: { percent: "-0.6", previous: { value: "111975", period: { start: "2026-09-18", end: "2026-09-18" } } },
      }),
    ),
    null,
  );
  assert.equal(
    metalChangeIssue(
      row({
        tag: "月",
        value: "4319",
        period: { start: "2026-09-01", end: "2026-09-30" },
        change: { percent: "-2.1", previous: { value: "4411", period: { start: "2026-07-01", end: "2026-07-31" } } },
      }),
    ),
    null,
  );
  const current = { start: "2026-10-11", end: "2026-10-20" };
  const previous = { start: "2026-09-21", end: "2026-09-30" };
  const quote = row({ tag: "旬", value: "110", period: current, change: { percent: "10.0", previous: { value: "100", period: previous } } });
  assert.equal(metalChangeIssue(quote), null);
  for (const period of [current, { start: "2026-10-21", end: "2026-10-31" }, { start: "2026-10-01", end: "2026-10-11" }])
    assert.match(metalChangeIssue({ ...quote, change: { ...quote.change!, previous: { value: "100", period } } }) ?? "", /本期之前/);
});

test("a reversed direction fails, and a missing previous period does not invent a rise or fall", () => {
  assert.match(
    metalChangeIssue(
      row({
        tag: "日",
        value: "4124.5457766396246149",
        period: { start: "2026-10-09", end: "2026-10-09" },
        change: {
          percent: "-0.7",
          previous: { value: "4095.3962864890367642", period: { start: "2026-10-08", end: "2026-10-08" } },
        },
      }),
    ) ?? "",
    /方向反了/,
  );
  assert.match(
    metalChangeIssue(
      row({
        tag: "月",
        value: "110",
        period: { start: "2026-09-01", end: "2026-09-30" },
        change: { percent: "9.0", previous: { value: "100", period: { start: "2026-08-01", end: "2026-08-31" } } },
      }),
    ) ?? "",
    /不一致/,
  );
  const waiting = row({
    metal: "铜",
    title: "国内 · 电解铜 1#",
    tag: "旬",
    value: "111742.5",
    period: { start: "2026-09-21", end: "2026-09-30" },
    change: null,
  });
  assert.equal(metalChangeIssue(waiting), null);
  assert.deepEqual(
    metalPriceChangeIssues({
      sources: [{ key: "nbs", tag: "旬" }],
      metals: [{ name: waiting.metal, quotes: [{ title: waiting.title, source: "nbs", value: waiting.value, period: waiting.period, change: null }] }],
    }),
    [],
  );
  assert.equal(
    metalChangeIssue(
      row({
        tag: "旬",
        value: "111742.5",
        period: { start: "2026-09-21", end: "2026-09-30" },
        change: { percent: "2.7", previous: { value: "", period: { start: "2026-09-11", end: "2026-09-20" } } },
      }),
    ),
    "没有上一期，却写出了涨跌",
  );
});
