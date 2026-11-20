// The figure check (pipeline/understand/figures.ts) on synthetic source and copy pairs: every pair either comes out ok
// or flags exactly the figures it should, with the right problem and class. Pure: no database, no model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFigures, chineseNumber, readingsOf } from "../packages/backend/src/pipeline/understand/figures.ts";
import { FIGURE_PAIRS } from "./fixtures/understand/figures.ts";

for (const pair of FIGURE_PAIRS)
  test(`figures: ${pair.name}`, () => {
    const result = checkFigures(
      { titleZh: "", summaryZh: pair.copy, reasonZh: null, occurredAt: pair.occurredAt ?? null },
      {
        texts: [pair.source],
        language: pair.language ?? "en",
        sourceDate: pair.sourceDate === undefined ? "2026-11-18" : pair.sourceDate,
        complete: pair.complete ?? true,
        hasImage: pair.hasImage ?? false,
      },
      pair.mask,
    );
    assert.deepEqual(
      result.findings.map((f) => `${f.token} ${f.problem} ${f.class}`),
      pair.flags ?? [],
    );
    const expected = (pair.flags ?? []).some((f) => f.endsWith(" hard")) ? "hard" : pair.flags?.length ? "soft" : "ok";
    assert.equal(result.verdict, expected);
  });

test("a flag names the closest figure the source does have", () => {
  const scale = checkFigures(
    { titleZh: "力拓批准2.5亿美元扩建", summaryZh: "", reasonZh: null },
    { texts: ["Rio Tinto approves $2.5 billion expansion"], language: "en", sourceDate: "2026-11-18", complete: true, hasImage: false },
  );
  assert.deepEqual(scale.findings, [{ field: "title", token: "2.5亿美元", kind: "amount", problem: "scale_mismatch", class: "hard", nearest: "2.5 billion" }]);
  const date = checkFigures(
    { titleZh: "", summaryZh: "", reasonZh: "11月8日宣布" },
    { texts: ["announced on November 18, 2026"], language: "en", sourceDate: null, complete: true, hasImage: false },
  );
  assert.deepEqual(date.findings, [{ field: "reason", token: "11月8日", kind: "date", problem: "absent", class: "hard", nearest: "2026-11-18" }]);
});

test("the copy's title, summary and reason are all read; a figure in any of them must come from the source", () => {
  const result = checkFigures(
    { titleZh: "产量下降12%", summaryZh: "投资25亿美元", reasonZh: "2027年投产" },
    {
      texts: ["Output fell 12 percent.", "It will invest $2.5 billion and start production in 2028."],
      language: "en",
      sourceDate: "2026-11-18",
      complete: true,
      hasImage: false,
    },
  );
  assert.deepEqual(
    result.findings.map((f) => [f.field, f.token, f.class]),
    [["reason", "2027年", "hard"]],
  );
});

test("a source digit string is read every way it can be meant", () => {
  assert.deepEqual(readingsOf("1,234.5"), [1234.5]);
  assert.deepEqual(readingsOf("1.234,5"), [1234.5]);
  assert.deepEqual(readingsOf("1,234"), [1.234, 1234]);
  assert.deepEqual(readingsOf("2,5"), [2.5]);
  assert.deepEqual(readingsOf("1.234.567"), [1234567]);
});

test("Chinese numerals are read as numbers only when they are one", () => {
  assert.equal(chineseNumber("两千万"), 20_000_000);
  assert.equal(chineseNumber("一千二百"), 1200);
  assert.equal(chineseNumber("三亿五千万"), 350_000_000);
  assert.equal(chineseNumber("一万亿"), 1e12);
  assert.equal(chineseNumber("一千零五"), 1005);
  assert.equal(chineseNumber("十四五"), null);
  assert.equal(chineseNumber("万一"), null);
});

test("an ISO date in the source is not read as a fiscal range, and a year-month in the copy needs its year too", () => {
  const source = (text: string) => ({ texts: [text], language: "en", sourceDate: "2026-11-18", complete: true, hasImage: false });
  const copy = (summaryZh: string, occurredAt: string | null = null) => ({ titleZh: "", summaryZh, reasonZh: null, occurredAt });
  const iso = checkFigures(copy("公司于2011年投产"), source("The mine started production on 2026-11-18."));
  assert.notEqual(iso.verdict, "ok");
  const range = checkFigures(copy("2026财年产量"), source("Output guidance for fiscal 2025-26 is unchanged."));
  assert.equal(range.verdict, "ok");
  const yearMonth = checkFigures(copy("公司将于2030年12月投产"), source("The company will start production in December 2027."));
  assert.notEqual(yearMonth.verdict, "ok");
  const fact = checkFigures(copy("公司将于12月投产", "2030-12"), source("The company will start production in December 2027."));
  assert.notEqual(fact.verdict, "ok");
  const right = checkFigures(copy("公司将于2027年12月投产", "2027-12"), source("The company will start production in December 2027."));
  assert.equal(right.verdict, "ok");
});

test("a long Chinese source with thousands of figures is read in time proportional to its length", () => {
  const prose = "紫金矿业2025年第三季度铜产量增长12.5%，达到25.3万吨，营收约320亿元，同比增加18%。力拓发货8,450万吨，嘉能可钴产量3.5至4.0万吨。";
  const source = prose.repeat(Math.ceil(200_000 / prose.length)).slice(0, 200_000);
  const started = performance.now();
  const result = checkFigures(
    { titleZh: "紫金矿业铜产量增长12.5%", summaryZh: "营收约320亿元，发货8,450万吨。", reasonZh: null, occurredAt: null },
    { texts: [source], language: "zh", sourceDate: "2025-10-20", complete: true, hasImage: false },
  );
  assert.equal(result.verdict, "ok");
  // About 0.1 s on 4 vCPUs at 2.1 GHz; rebuilding the text after every figure once took about 4 s here.
  assert.ok(performance.now() - started < 1_500, `took ${Math.round(performance.now() - started)} ms`);
});
