// The dateline reader and the demotion of dateline countries (pipeline/understand/dateline.ts). Pure: the stored
// answers and the public geography are not touched; validateGeography only shows what the corrected answer would give.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateGeography } from "../packages/backend/src/editorial/geography.ts";
import { datelineEnd, demoteDateline, readDateline } from "../packages/backend/src/pipeline/understand/dateline.ts";
import { DATELINE_OPENINGS } from "./fixtures/understand/datelines.ts";

test("datelines are found, with their separator, and told apart by who issued them", () => {
  for (const opening of DATELINE_OPENINGS) {
    const found = readDateline(opening.text);
    assert.equal(found ? opening.text.slice(0, found.end) : null, opening.dateline, opening.text);
    if (opening.dateline) assert.equal(found?.kind, opening.kind, opening.text);
    assert.equal(datelineEnd(opening.text), opening.dateline?.length ?? 0, opening.text);
  }
});

test("a dateline is only looked for at the very start, within its first 200 characters", () => {
  assert.equal(readDateline("Lundin Mining said. VANCOUVER, Canada, Nov. 18, 2026 -- more"), null);
  assert.equal(readDateline(`${"A".repeat(195)}, Nov. 18, 2026 -- text`), null);
  assert.equal(readDateline("  VANCOUVER, Canada, Nov. 18, 2026 -- Lundin")?.end, 38);
});

const article = (title: string, body: string) => ({ title, bodyText: body, excerpt: null, bodyStatus: "ok", xPost: null });
const segments = (a: ReturnType<typeof article>) => [
  { id: "title", text: a.title },
  { id: "body_head", text: a.bodyText },
];
type Row = { code: string; role: string; mention: string; segment: string; quote: string };
const answer = (assignments: Row[]) => ({ status: "identified" as const, primary: assignments[0]?.code ?? null, assignments, reason: "test" });
const located = (a: ReturnType<typeof article>, candidate: unknown) => {
  const result = validateGeography(candidate, a);
  return { primary: result.primary, codes: result.codes };
};

const JOSEMARIA = article(
  "Lundin Mining Announces Updated Mineral Resource at Josemaria",
  "VANCOUVER, Canada, Nov. 18, 2026 -- Lundin Mining Corporation today announced an updated mineral resource estimate for the Josemaria copper-gold project in San Juan Province, Argentina.",
);
const CANADA_IN_DATELINE: Row = { code: "CA", role: "event_location", mention: "Canada", segment: "body_head", quote: "VANCOUVER, Canada, Nov. 18, 2026" };
const ARGENTINA: Row = { code: "AR", role: "event_location", mention: "Argentina", segment: "body_head", quote: "San Juan Province, Argentina" };

test("a country taken only from a release's dateline becomes the issuer's location", () => {
  const before = answer([CANADA_IN_DATELINE, ARGENTINA]);
  assert.deepEqual(located(JOSEMARIA, before), { primary: "CA", codes: ["CA", "AR"] });
  const result = demoteDateline(before, segments(JOSEMARIA));
  assert.deepEqual(result.demoted, [{ code: "CA", quote: CANADA_IN_DATELINE.quote }]);
  assert.deepEqual(result.kept, []);
  assert.equal(result.dateline?.kind, "unmarked");
  assert.deepEqual(result.candidate.assignments[0], { ...CANADA_IN_DATELINE, role: "issuer_location" });
  assert.deepEqual(located(JOSEMARIA, result.candidate), { primary: "AR", codes: ["AR"] });
  // The answer passed in is not changed.
  assert.equal(before.assignments[0]!.role, "event_location");
});

test("a story quoted only from its dateline ends with no country rather than a wrong one", () => {
  const result = demoteDateline(answer([CANADA_IN_DATELINE]), segments(JOSEMARIA));
  assert.deepEqual(located(JOSEMARIA, result.candidate).codes, []);
});

test("the dateline country stays when the title names it", () => {
  const a = article("Canada's Lundin Mining updates Josemaria resource", JOSEMARIA.bodyText);
  const result = demoteDateline(answer([CANADA_IN_DATELINE, ARGENTINA]), segments(a));
  assert.deepEqual(result.demoted, []);
  assert.deepEqual(result.kept, [{ code: "CA", quote: CANADA_IN_DATELINE.quote, reason: "title_names_it" }]);
  const chinese = article("加拿大矿企更新阿根廷项目资源量", JOSEMARIA.bodyText);
  assert.equal(demoteDateline(answer([CANADA_IN_DATELINE]), segments(chinese)).kept[0]?.reason, "title_names_it");
});

test("the dateline country stays when the step also placed the news there outside the dateline", () => {
  const a = article(
    "Lundin Mining reports",
    "VANCOUVER, Canada, Nov. 18, 2026 -- Lundin Mining Corporation said its mill in Canada would restart after the strike.",
  );
  const elsewhere: Row = { code: "CA", role: "affected_location", mention: "Canada", segment: "body_head", quote: "its mill in Canada" };
  const result = demoteDateline(answer([CANADA_IN_DATELINE, elsewhere]), segments(a));
  assert.deepEqual(result.demoted, []);
  assert.deepEqual(result.kept, [{ code: "CA", quote: CANADA_IN_DATELINE.quote, reason: "named_elsewhere" }]);
  // A mention the step did not assign does not count: the "About the company" paragraph names the head office too.
  const about = article(
    JOSEMARIA.title,
    `${JOSEMARIA.bodyText} About Lundin Mining: Lundin Mining is a diversified Canadian base metals mining company based in Canada.`,
  );
  assert.deepEqual(demoteDateline(answer([CANADA_IN_DATELINE, ARGENTINA]), segments(about)).demoted, [{ code: "CA", quote: CANADA_IN_DATELINE.quote }]);
});

test("a news agency's dateline is kept: its reporter is usually where the news is", () => {
  const a = article("Codelco output falls", "SANTIAGO, Nov 18 (Reuters) - Chile's Codelco said output fell at its largest mines.");
  const chile: Row = { code: "CL", role: "event_location", mention: "SANTIAGO", segment: "body_head", quote: "SANTIAGO, Nov 18" };
  const result = demoteDateline(answer([chile]), segments(a));
  assert.equal(result.dateline?.kind, "news_agency");
  assert.deepEqual(result.demoted, []);
  assert.deepEqual(result.kept, [{ code: "CL", quote: chile.quote, reason: "news_agency" }]);
});

test("Chinese datelines are read the same way", () => {
  const a = article("紫金矿业旗下公司公布阿根廷项目进展", "【温哥华11月18日讯】紫金矿业旗下公司宣布，其位于阿根廷卡塔马卡省的锂项目投产。");
  const canada: Row = { code: "CA", role: "event_location", mention: "温哥华", segment: "body_head", quote: "【温哥华11月18日讯】" };
  const result = demoteDateline(answer([canada]), segments(a));
  assert.deepEqual(result.demoted, [{ code: "CA", quote: canada.quote }]);
  const xinhua = article("国家发改委：加强铜资源保障", "新华社北京11月18日电（记者 王明）国家发展改革委18日表示，将加强铜资源保障。");
  const china: Row = { code: "CN", role: "rule_scope", mention: "北京", segment: "body_head", quote: "新华社北京11月18日电" };
  assert.deepEqual(demoteDateline(answer([china]), segments(xinhua)).kept, [{ code: "CN", quote: china.quote, reason: "news_agency" }]);
});

test("only active assignments inside the dateline are touched", () => {
  const headquarters: Row = { ...CANADA_IN_DATELINE, role: "headquarters" };
  const later: Row = { code: "AR", role: "event_location", mention: "Argentina", segment: "body_head", quote: "San Juan Province, Argentina" };
  const title: Row = { code: "AR", role: "event_location", mention: "Josemaria", segment: "title", quote: "Josemaria" };
  const malformed = { code: "CA", role: "event_location" };
  const before = { ...answer([headquarters, later, title]), assignments: [headquarters, later, title, malformed] };
  const result = demoteDateline(before, segments(JOSEMARIA));
  assert.equal(result.candidate, before);
  assert.deepEqual(result.demoted, []);
  assert.deepEqual(result.kept, []);
});

test("an article without a dateline is left as it is", () => {
  const a = article("Lundin Mining updates Josemaria", "Lundin Mining Corporation today announced an updated resource in Canada.");
  const canada: Row = { code: "CA", role: "event_location", mention: "Canada", segment: "body_head", quote: "resource in Canada" };
  const before = answer([canada]);
  const result = demoteDateline(before, segments(a));
  assert.equal(result.candidate, before);
  assert.equal(result.dateline, null);
});
