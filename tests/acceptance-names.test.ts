// The entity library (packages/backend/src/pipeline/entities) against the name cases (tests/acceptance/names.ts)
// and the company and name cases of the news line (tests/acceptance/news.ts). The library is not wired into the
// pipeline yet, so readers do not see these results; the live code's own outcome stays in news-baseline.json.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bilingualNames } from "../packages/backend/src/editorial/bilingual-names.ts";
import { buildIndex, linkText } from "../packages/backend/src/pipeline/entities/link.ts";
import { companyName, renderNames } from "../packages/backend/src/pipeline/entities/names.ts";
import { seedRows } from "../packages/backend/src/pipeline/entities/seed.ts";
import { runCases } from "./acceptance/case.ts";
import { NAME_CASES } from "./acceptance/names.ts";
import { NEWS_CASES, type NewsEffects } from "./acceptance/news.ts";
import { CURRENT_NEWS } from "./acceptance/news-current.ts";

const seed = seedRows();
const index = buildIndex(seed.entities, seed.statements);

/** The news abilities the library provides; places, freshness and the lead stay with today's code. */
const LIBRARY_NEWS: NewsEffects = {
  ...CURRENT_NEWS,
  aboutCompany(company, text, language) {
    const entity = [...index.entities.values()].find((e) => e.nameZh === company);
    if (!entity) throw new Error(`no library entity named ${company}`);
    return linkText(index, { title: text, body: "", language: language ?? null }).some((link) => link.entityId === entity.id && link.role === "subject");
  },
  rewriteNames: (text) => renderNames(index, text).text,
  companyName: (spelling) => companyName(index, spelling),
};

/** The news cases about companies and names; each is met by the library. */
const LIBRARY_MEETS = [
  "company-named-in-headline",
  "company-common-word",
  "company-place-name",
  "company-passing-mention",
  "name-first-mention-bracketed",
  "name-place-is-not-a-company",
  "name-one-per-company",
];

test("the library gives one Chinese name to a company written two ways in one title", () => {
  const today = runCases(NAME_CASES, { rewriteNames: bilingualNames });
  const results = runCases(NAME_CASES, LIBRARY_NEWS);
  for (const c of NAME_CASES) {
    const problem = results.get(c.id);
    console.log(`${problem === null ? "met  " : "UNMET"} ${c.id}: ${c.says}${problem === null ? "" : ` — ${problem}`} (today: ${today.get(c.id) ?? "met"})`);
  }
  assert.deepEqual(
    [...results].filter(([, problem]) => problem !== null),
    [],
  );
});

test("the library meets the news line's company and name cases", () => {
  const results = runCases(NEWS_CASES, LIBRARY_NEWS);
  for (const id of LIBRARY_MEETS) assert.equal(results.get(id), null, id);
});

test("every name case says what the reader wants in Chinese", () => {
  for (const c of NAME_CASES) assert.ok(c.says.length >= 8 && /[一-鿿]/.test(c.says), c.id);
});
