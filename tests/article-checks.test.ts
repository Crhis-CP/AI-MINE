// The per-article check (pipeline/understand/checks.ts) on one synthetic release: the companies found, what the name
// rule would rewrite, the figures held against the original and the dateline with the country taken only from it.
// Pure: the code seed stands in for the library, nothing is read or written.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalyzeInputArticle } from "../packages/backend/src/editorial/input.ts";
import { buildIndex } from "../packages/backend/src/pipeline/entities/link.ts";
import { seedRows } from "../packages/backend/src/pipeline/entities/seed.ts";
import { ARTICLE_CHECK_RECIPE, CHECK_TEXT_LIMIT, checkArticle, type JudgedArticle } from "../packages/backend/src/pipeline/understand/checks.ts";

const seed = seedRows();
const index = buildIndex(seed.entities, seed.statements);

const DATELINE = "VANCOUVER, Canada, Nov. 18, 2026 /PRNewswire/ -- ";
const BODY = `${DATELINE}Teck Resources Limited (NYSE: TECK) and South32 said today they will invest US$2.5 billion in a copper project in San Juan Province, Argentina. Glencore competes with Teck in the region.`;

const article = (over: Partial<AnalyzeInputArticle> = {}): AnalyzeInputArticle => ({
  id: "check-1",
  revision: 1,
  title: "Teck and South32 to invest US$2.5 billion in Argentine copper project",
  url: "https://www.prnewswire.com/news-releases/check-1.html",
  author: null,
  publishedAt: new Date("2026-11-18T13:00:00Z"),
  bodyText: BODY,
  excerpt: null,
  bodyStatus: "ok",
  media: [],
  source: { name: "PR Newswire", kind: "rss", tier: "T2", firstParty: false, ownerEntityId: null },
  translationZh: null,
  ...over,
});

const geography = {
  bodyBudget: 22000,
  state: "identified",
  primary: null,
  codes: ["CA", "AR"],
  assignments: [
    { code: "CA", role: "event_location", mention: "Canada", segment: "body_head", quote: "VANCOUVER, Canada" },
    { code: "AR", role: "event_location", mention: "Argentina", segment: "body_head", quote: "San Juan Province, Argentina" },
  ],
};

const judged = (over: Partial<JudgedArticle> = {}): JudgedArticle => ({
  subjects: [],
  titleZh: "泰克资源与南32将投资25亿美元开发阿根廷铜矿",
  summaryZh: "泰克资源（Teck Resources）和南32表示，将在阿根廷投资2.5亿美元开发铜矿项目，产量将增长12%。",
  reasonZh: null,
  writer: "understand",
  occurredAt: "2026-11-18",
  geography,
  ...over,
});

test("the record names the versions of all four checks", () => {
  assert.equal(ARTICLE_CHECK_RECIPE, "entity-linker-v1/entity-names-v1/figures-v1/dateline-v1");
});

test("one release: companies, name rewrites, figures and the dateline country", () => {
  const check = checkArticle(index, article(), "en", judged());
  assert.deepEqual(
    check.links.map((l) => [l.entityId, l.method, l.role, l.segment]),
    [
      ["teck", "text", "mention", "title"],
      ["south32", "text", "mention", "title"],
      ["glencore", "text", "mention", "body"],
    ],
  );
  // The writer's first 泰克资源 gets its bracket; the summary already wrote it, so only 南32 changes there.
  assert.deepEqual(check.names, [
    { kind: "rewrite", field: "title", entityId: "teck", from: "泰克资源", to: "泰克资源（Teck Resources）" },
    { kind: "rewrite", field: "title", entityId: "south32", from: "南32", to: "南32（South32）" },
    { kind: "rewrite", field: "summary", entityId: "south32", from: "南32", to: "南32（South32）" },
  ]);
  // 25亿美元 is the source's 2.5 billion; 2.5亿美元 is that figure at the wrong scale; 12% is nowhere in the source.
  // The 32 of 南32 and South32 is a name, not a figure.
  assert.equal(check.verdict, "hard");
  assert.deepEqual(
    check.figures.map((f) => `${f.field} ${f.token} ${f.problem} ${f.class}`),
    ["summary 2.5亿美元 scale_mismatch hard", "summary 12% absent soft"],
  );
  assert.deepEqual(check.geography, [
    { kind: "dateline", dateline: "release_wire", marker: "PRNewswire", end: DATELINE.length },
    { kind: "demoted", code: "CA" },
  ]);
});

test("the model's subjects make a company the subject; a post's own text is never put through the name rule", () => {
  const named = checkArticle(
    index,
    article({ title: "Glencore reports output", bodyText: "Glencore said output rose." }),
    "en",
    judged({ subjects: ["glencore"] }),
  );
  assert.deepEqual(
    named.links.map((l) => [l.entityId, l.role]),
    [["glencore", "subject"]],
  );
  const verbatim = checkArticle(index, article(), "en", judged({ writer: "verbatim" }));
  assert.deepEqual(verbatim.names, []);
  assert.equal(verbatim.links.length, 3, "the links do not depend on who wrote the copy");
});

test("a body cut at the length limit counts as incomplete, so its figure findings stay soft", () => {
  const long = `${BODY} ${"Further detail. ".repeat(Math.ceil(CHECK_TEXT_LIMIT / 16))}`;
  assert.ok(long.length > CHECK_TEXT_LIMIT);
  const check = checkArticle(index, article({ bodyText: long }), "en", judged());
  assert.equal(check.verdict, "soft");
  assert.deepEqual(
    check.figures.map((f) => `${f.token} ${f.class}`),
    ["2.5亿美元 soft", "12% soft"],
  );
  const unconfirmed = checkArticle(index, article({ bodyStatus: "unconfirmed" }), "en", judged());
  assert.equal(unconfirmed.verdict, "soft", "a body that was not read whole caps the findings too");
});

test("a stored geography that cannot be read demotes nothing; the dateline is still recorded", () => {
  for (const value of [null, "garbage", { assignments: "none" }, { bodyBudget: 5, assignments: [] }]) {
    const check = checkArticle(index, article(), "en", judged({ geography: value }));
    assert.deepEqual(check.geography, [{ kind: "dateline", dateline: "release_wire", marker: "PRNewswire", end: DATELINE.length }]);
  }
  const plain = checkArticle(index, article({ bodyText: "Teck Resources said output rose." }), "en", judged({ geography: null }));
  assert.deepEqual(plain.geography, []);
});

test("a post is read as the structure step reads it: its own text and the quoted post", () => {
  const post = article({
    title: "Post",
    bodyText: null,
    xPost: { authorName: "Example", handle: "example", text: "Glencore says cobalt output rose 5%.", media: [], quoted: null } as never,
  });
  const check = checkArticle(index, post, "en", judged({ titleZh: "嘉能可钴产量增长5%", summaryZh: "嘉能可称钴产量增长5%。", geography: null }));
  assert.deepEqual(
    check.links.map((l) => l.entityId),
    ["glencore"],
  );
  assert.equal(check.verdict, "ok");
});
