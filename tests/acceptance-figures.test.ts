// The per-article checks (packages/backend/src/pipeline/understand) against the number, date and dateline cases
// (tests/acceptance/figures.ts) and the news line's dateline case (tests/acceptance/news.ts). The checks are not wired
// into the pipeline yet, so readers do not see these results; the live code's own outcome stays in news-baseline.json.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateGeography } from "../packages/backend/src/editorial/geography.ts";
import { demoteDateline, readDateline } from "../packages/backend/src/pipeline/understand/dateline.ts";
import { checkFigures } from "../packages/backend/src/pipeline/understand/figures.ts";
import { runCases } from "./acceptance/case.ts";
import { FIGURE_CASES, type FigureEffects } from "./acceptance/figures.ts";
import { NEWS_CASES, type NewsEffects } from "./acceptance/news.ts";
import { CURRENT_NEWS } from "./acceptance/news-current.ts";

const CHECKS: FigureEffects = {
  unsupportedFigures: (copy, source) =>
    checkFigures(
      { titleZh: "", summaryZh: copy, reasonZh: null },
      { texts: [source.text], language: source.language, sourceDate: source.date, complete: true, hasImage: false },
    ).findings.map((f) => f.token),
  dateline(body) {
    const found = readDateline(body);
    return found && { text: body.slice(0, found.end), kind: found.kind };
  },
};

/** Today's places with the structure step's answer corrected for datelines before it is validated. */
const WITH_DATELINES: NewsEffects = {
  ...CURRENT_NEWS,
  locate(article, answer) {
    const material = { title: article.title, bodyText: article.body, excerpt: null, bodyStatus: "ok", xPost: null };
    const segments = [
      { id: "title", text: article.title },
      { id: "body_head", text: article.body },
    ];
    const result = validateGeography(demoteDateline(answer, segments).candidate, material);
    return { primary: result.primary, codes: result.codes };
  },
};

test("the per-article checks meet the number, date and dateline cases", () => {
  const today = runCases(FIGURE_CASES, {});
  const results = runCases(FIGURE_CASES, CHECKS);
  for (const c of FIGURE_CASES) {
    const problem = results.get(c.id);
    console.log(`${problem === null ? "met  " : "UNMET"} ${c.id}: ${c.says}${problem === null ? "" : ` — ${problem}`} (today: ${today.get(c.id) ?? "met"})`);
  }
  assert.deepEqual(
    [...results].filter(([, problem]) => problem !== null),
    [],
  );
});

test("with the dateline corrected, the Vancouver release is filed under Argentina and no met news case is lost", () => {
  const today = runCases(NEWS_CASES, CURRENT_NEWS);
  const results = runCases(NEWS_CASES, WITH_DATELINES);
  assert.notEqual(today.get("place-dateline-is-not-the-event"), null);
  assert.equal(results.get("place-dateline-is-not-the-event"), null);
  for (const [id, problem] of today) if (problem === null) assert.equal(results.get(id), null, id);
});

test("every figure case says what the reader wants in Chinese", () => {
  for (const c of FIGURE_CASES) assert.ok(c.says.length >= 8 && /[一-鿿]/.test(c.says), c.id);
});
