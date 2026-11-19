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
