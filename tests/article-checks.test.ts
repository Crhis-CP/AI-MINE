// The per-article check (pipeline/understand/checks.ts) on one synthetic release: the companies found, what the name
// rule would rewrite, the figures held against the original and the dateline with the country taken only from it; that
// it reads only what the judging steps were shown, stays fast on the largest bodies and lets other work run meanwhile.
// Pure: the code seed stands in for the library, nothing is read or written.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalyzeInputArticle } from "../packages/backend/src/editorial/input.ts";
import { buildIndex } from "../packages/backend/src/pipeline/entities/link.ts";
import { seedRows } from "../packages/backend/src/pipeline/entities/seed.ts";
import { ARTICLE_CHECK_RECIPE, CHECK_BODY_CHARS, checkArticle, type JudgedArticle } from "../packages/backend/src/pipeline/understand/checks.ts";

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

test("one release: companies, name rewrites, figures and the dateline country", async () => {
  const check = await checkArticle(index, article(), "en", judged());
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
    { kind: "demoted", code: "CA", quote: "VANCOUVER, Canada" },
  ]);
});

test("the model's subjects make a company the subject; a post's own text is never put through the name rule", async () => {
  const named = await checkArticle(
    index,
    article({ title: "Glencore reports output", bodyText: "Glencore said output rose." }),
    "en",
    judged({ subjects: ["glencore"] }),
  );
  assert.deepEqual(
    named.links.map((l) => [l.entityId, l.role]),
    [["glencore", "subject"]],
  );
  const verbatim = await checkArticle(index, article(), "en", judged({ writer: "verbatim" }));
  assert.deepEqual(verbatim.names, []);
  assert.equal(verbatim.links.length, 3, "the links do not depend on who wrote the copy");
});

test("only what the judging steps were shown is read: the head and the tail of a long body, not its middle", async () => {
  const filler = (n: number) => "Further detail on the project. ".repeat(Math.ceil(n / 31)).slice(0, n);
  const middle = "Codelco raised its output by 77%. ";
  const tail = "Newmont said gold output rose 31%.";
  const long = `${BODY} ${filler(CHECK_BODY_CHARS)} ${middle}${filler(CHECK_BODY_CHARS)} ${tail}`;
  const check = await checkArticle(
    index,
    article({ bodyText: long }),
    "en",
    judged({ summaryZh: "泰克资源（Teck Resources）表示，将投资25亿美元。智利国家铜业公司产量增长77%，纽蒙特黄金产量增长31%。" }),
  );
  assert.deepEqual(
    check.links.map((l) => l.entityId),
    ["teck", "south32", "glencore", "newmont"],
    "the tail is read, the middle is not",
  );
  assert.deepEqual(
    check.figures.map((f) => `${f.token} ${f.problem} ${f.class}`),
    ["77% absent soft"],
    "a figure only the unshown middle holds supports nothing",
  );
  const unconfirmed = await checkArticle(index, article({ bodyStatus: "unconfirmed" }), "en", judged());
  assert.equal(unconfirmed.verdict, "soft", "a body that was not extracted whole caps the findings");
});

test("one article of the largest kind is checked well within a second, with the other work let in between its steps", async () => {
  const dense =
    "紫金矿业2025年第三季度铜产量增长12.5%，达到25.3万吨，营收约320亿元，同比增加18%。力拓与必和必拓的铁矿石发货量为8,450万吨，嘉能可预计钴产量为3.5至4.0万吨。";
  for (const size of [200_000, 1_000_000]) {
    const body = dense.repeat(Math.ceil(size / dense.length)).slice(0, size);
    const started = performance.now();
    await checkArticle(
      index,
      article({ title: "紫金矿业三季度铜产量增长", bodyText: body }),
      "zh",
      judged({
        subjects: ["zijin"],
        titleZh: "紫金矿业三季度铜产量增长12.5%",
        summaryZh: "紫金矿业铜产量增长12.5%至25.3万吨，营收约320亿元。",
        geography: null,
      }),
    );
    // Measured at about 50 ms on 4 vCPUs at 2.1 GHz; the bound is generous so a slow machine passes and a cost that
    // grows with the body (seconds before the bound was set) does not.
    assert.ok(performance.now() - started < 1_000, `${size} characters took ${Math.round(performance.now() - started)} ms`);
  }
  const order: string[] = [];
  setImmediate(() => order.push("other work"));
  await checkArticle(index, article(), "en", judged()).then(() => order.push("check"));
  assert.deepEqual(order, ["other work", "check"], "the check gives the event loop back between its steps");
});

test("a stored geography that cannot be read demotes nothing; the dateline is still recorded", async () => {
  for (const value of [null, "garbage", { assignments: "none" }, { bodyBudget: 5, assignments: [] }]) {
    const check = await checkArticle(index, article(), "en", judged({ geography: value }));
    assert.deepEqual(check.geography, [{ kind: "dateline", dateline: "release_wire", marker: "PRNewswire", end: DATELINE.length }]);
  }
  const plain = await checkArticle(index, article({ bodyText: "Teck Resources said output rose." }), "en", judged({ geography: null }));
  assert.deepEqual(plain.geography, []);
});

test("a post is read as the structure step reads it: its own text and the quoted post", async () => {
  const post = article({
    title: "Post",
    bodyText: null,
    xPost: { authorName: "Example", handle: "example", text: "Glencore says cobalt output rose 5%.", media: [], quoted: null } as never,
  });
  const check = await checkArticle(index, post, "en", judged({ titleZh: "嘉能可钴产量增长5%", summaryZh: "嘉能可称钴产量增长5%。", geography: null }));
  assert.deepEqual(
    check.links.map((l) => l.entityId),
    ["glencore"],
  );
  assert.equal(check.verdict, "ok");
});

test("a stored translation never supports a figure; a feed summary does only where it stood in for an unusable body", async () => {
  const copy = judged({ titleZh: "力拓投资2.5亿美元", summaryZh: "力拓表示将投资2.5亿美元。", geography: null });
  const translated = { translationZh: "力拓表示将投资2.5亿美元。" };
  for (const over of [
    { bodyText: "Rio Tinto will invest $2.5 billion.", ...translated },
    { bodyText: null, excerpt: "Rio Tinto will invest $2.5 billion.", bodyStatus: "none", ...translated },
  ]) {
    const check = await checkArticle(index, article({ title: "Rio Tinto to invest", ...over }), "en", copy);
    assert.deepEqual(
      check.figures.map((f) => `${f.token} ${f.problem}`),
      ["2.5亿美元 scale_mismatch", "2.5亿美元 scale_mismatch"],
      "the judging steps are never shown the stored translation",
    );
  }
  const feed = await checkArticle(
    index,
    article({ title: "Rio Tinto to invest", bodyText: "……", excerpt: "力拓表示将投资2.5亿美元。", bodyStatus: "ok" }),
    "zh",
    copy,
  );
  assert.deepEqual(feed.figures, [], "an unusable body is replaced by the feed summary in what the steps read");
});
