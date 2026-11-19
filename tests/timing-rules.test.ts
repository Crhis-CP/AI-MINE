// When a fact happened, by rules alone (packages/backend/src/pipeline/events/timing-rules.ts): a structure-step date
// counts as checked only when the report writes that day, and not as a period end.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dateInText, factTiming, type MemberClaim, memberClaim, parseClaim, writtenDays } from "../packages/backend/src/pipeline/events/timing-rules.ts";

const REPORTED = new Date("2026-11-19T02:00:00Z"); // Beijing 19 November

test("a claim is a calendar day; anything else is no claim", () => {
  assert.equal(parseClaim("2026-11-18"), "2026-11-18");
  assert.equal(parseClaim(" 2026-11-18T10:00:00Z "), "2026-11-18", "a time the model added is ignored");
  for (const bad of ["2026-11", "2026-13-01", "2026-02-30", "18/11/2026", "", null, undefined, 20261118]) assert.equal(parseClaim(bad), null, String(bad));
});

test("the day is found in every notation the sources use", () => {
  const written = [
    "The board met on 2026-11-18.",
    "董事会于2026年11月18日批准该项目。",
    "董事会１１月１８日批准该项目。",
    "公司11月18号发布公告。",
    "VANCOUVER, Canada, Nov. 18, 2026 -- the company announced",
    "The deal closed November 18th.",
    "The deal closed on 18 November 2026.",
    "The ministry acted on the 18th of November.",
    "El ministerio aprobó el proyecto el 18 de noviembre de 2026.",
    "A licença foi concedida em 18 de novembro.",
    "Le ministère a signé le 18 novembre 2026.",
    "Signed 2026/11/18 in Lima.",
  ];
  for (const text of written) assert.ok(dateInText(text, "2026-11-18", REPORTED), text);
  assert.equal(dateInText("The board met on 2026-11-17.", "2026-11-18", REPORTED), false);
  assert.equal(dateInText("Revenue rose 18% in November.", "2026-11-18", REPORTED), false, "a percentage is not a day");
  assert.equal(dateInText("Output was 2026 tonnes, up 11.18 per cent.", "2026-11-18", REPORTED), false);
});

test("a day written without a year takes the report's year, or the year before when it would lie after the report", () => {
  assert.deepEqual(writtenDays("Production stopped on Nov 3.", "2026-11-19"), ["2026-11-03"]);
  assert.deepEqual(writtenDays("Production stopped on December 28.", "2027-01-04"), ["2026-12-28"]);
  assert.deepEqual(writtenDays("2025年12月28日停产", "2027-01-04"), ["2025-12-28"], "a stated year is kept");
});

test("a period end or cut-off written in the text is not the day anything happened", () => {
  for (const text of [
    "Results for the quarter ended September 30, 2026 showed higher copper sales.",
    "Reserves as at 30 September 2026 rose 4%.",
    "截至2026年9月30日，公司铜产量同比增长。",
    "Resultados del trimestre terminado el 30 de septiembre de 2026.",
  ])
    assert.equal(dateInText(text, "2026-09-30", REPORTED), false, text);
  assert.ok(
    dateInText("Results for the quarter ended September 30. The mine flooded on September 30, 2026.", "2026-09-30", REPORTED),
    "stated again as an occurrence",
  );
});

test("a member's claim is checked against its own text; a day after the report is dropped as a schedule", () => {
  const claim = (value: unknown, text: string) => memberClaim({ articleId: "a", revision: 2, claim: value, text, reportedAt: REPORTED });
  assert.deepEqual(claim("2026-11-18", "Workers struck on November 18."), { articleId: "a", revision: 2, on: "2026-11-18", verified: true, at: REPORTED });
  assert.deepEqual(claim("2026-10-20", "Codelco cuts its output guidance."), { articleId: "a", revision: 2, on: "2026-10-20", verified: false, at: REPORTED });
  assert.equal(claim("2026-11-25", "The auction will be held on November 25.").on, null, "a scheduled day is not an occurrence");
  assert.equal(claim("2026-11-19", "Signed today, November 19.").verified, true, "the report's own day is allowed");
  assert.equal(claim(null, "Signed on November 18.").on, null);
});

const member = (articleId: string, at: string, on: string | null, verified = false): MemberClaim => ({
  articleId,
  revision: 1,
  on,
  verified,
  at: new Date(at),
});

test("a fact's day: the earliest checked claim, else a day two members agree on, else the founder's own claim", () => {
  assert.equal(factTiming([]), null, "a fact without members has no timing");
  const founder = member("b", "2026-11-18T01:00:00Z", "2026-11-10");
  assert.deepEqual(factTiming([founder, member("c", "2026-11-18T05:00:00Z", null)]), {
    occurredOn: "2026-11-10",
    occurredBasis: "claimed",
    firstReportedAt: founder.at,
    firstArticleId: "b",
    lastReportedAt: new Date("2026-11-18T05:00:00Z"),
    members: 2,
  });
  const agreed = factTiming([founder, member("c", "2026-11-18T05:00:00Z", "2026-11-12"), member("d", "2026-11-18T06:00:00Z", "2026-11-12")])!;
  assert.deepEqual([agreed.occurredOn, agreed.occurredBasis], ["2026-11-12", "agreed"]);
  const verified = factTiming([founder, member("c", "2026-11-18T05:00:00Z", "2026-11-14", true), member("d", "2026-11-18T06:00:00Z", "2026-11-13", true)])!;
  assert.deepEqual([verified.occurredOn, verified.occurredBasis], ["2026-11-13", "verified"], "the earliest checked day");
  assert.deepEqual(factTiming([member("c", "2026-11-18T05:00:00Z", null)])!.occurredBasis, "none");
});

test("the founder is the earliest report, ties by article id, whatever order members are read in", () => {
  const a = member("a", "2026-11-18T01:00:00Z", "2026-11-11"),
    b = member("b", "2026-11-18T01:00:00Z", "2026-11-12");
  assert.equal(factTiming([b, a])!.firstArticleId, "a");
  assert.equal(factTiming([b, a])!.occurredOn, "2026-11-11");
  assert.deepEqual(factTiming([a, b]), factTiming([b, a]));
});

test("the day moves when a better report joins and when its report leaves", () => {
  const founder = member("a", "2026-11-18T01:00:00Z", "2026-11-17");
  assert.equal(factTiming([founder])!.occurredBasis, "claimed");
  const better = member("b", "2026-11-18T03:00:00Z", "2026-11-16", true);
  assert.deepEqual([factTiming([founder, better])!.occurredOn, factTiming([founder, better])!.occurredBasis], ["2026-11-16", "verified"]);
  assert.deepEqual([factTiming([better])!.firstArticleId, factTiming([better])!.members], ["b", 1], "the founder left");
});
