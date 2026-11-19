// The news line's acceptance cases on today's code (tests/acceptance/news.ts). The cases the live code meets are
// listed in tests/acceptance/news-baseline.json; that list only grows. A case that stops being met is a
// regression; a case that starts being met must be added to the list in the same change, so the gain is kept.
// The unmet cases are the work the rewrite has to do (DEC-79), printed below on every run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runCases } from "./acceptance/case.ts";
import { NEWS_CASES } from "./acceptance/news.ts";
import { CURRENT_NEWS } from "./acceptance/news-current.ts";

const baseline = JSON.parse(readFileSync(path.join(import.meta.dirname, "acceptance/news-baseline.json"), "utf8")) as { met: string[] };

test("the live news line meets exactly the acceptance cases its baseline lists", () => {
  const results = runCases(NEWS_CASES, CURRENT_NEWS);
  const says = new Map(NEWS_CASES.map((c) => [c.id, c.says]));
  for (const [id, problem] of results) console.log(`${problem === null ? "met  " : "UNMET"} ${id}: ${says.get(id)}${problem === null ? "" : ` — ${problem}`}`);
  const met = [...results].filter(([, problem]) => problem === null).map(([id]) => id);
  console.log(`${met.length} of ${results.size} news acceptance cases met`);
  assert.deepEqual(
    met.filter((id) => !baseline.met.includes(id)),
    [],
    "newly met cases: add them to tests/acceptance/news-baseline.json",
  );
  assert.deepEqual(
    baseline.met.filter((id) => !met.includes(id)),
    [],
    "cases the baseline lists are no longer met",
  );
});

test("every baseline entry names a case, and every case says what the reader wants", () => {
  const ids = new Set(NEWS_CASES.map((c) => c.id));
  assert.deepEqual(
    baseline.met.filter((id) => !ids.has(id)),
    [],
  );
  for (const c of NEWS_CASES) assert.ok(c.says.length >= 8 && /[一-鿿]/.test(c.says), c.id);
});
