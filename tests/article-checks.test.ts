// The per-article check (pipeline/understand/checks.ts) on one synthetic release: the companies found, what the name
// rule would rewrite, the figures held against the original and the dateline with the country taken only from it; that
// it reads only what the judging steps were shown, cut where the shared material cuts the body, stays fast on the
// largest bodies and lets other work run meanwhile.
// Pure: the code seed stands in for the library, nothing is read or written.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sharedBody, sharedMaterial } from "../packages/backend/src/editorial/analysis-layout.ts";
import { geographyMaterial } from "../packages/backend/src/editorial/geography.ts";
import type { AnalyzeInputArticle } from "../packages/backend/src/editorial/input.ts";
import { UNDERSTAND_BODY_CHARS } from "../packages/backend/src/editorial/writing.ts";
import { buildIndex } from "../packages/backend/src/pipeline/entities/link.ts";
import { seedRows } from "../packages/backend/src/pipeline/entities/seed.ts";
import { ARTICLE_CHECK_RECIPE, bodyAsShown, checkArticle, type JudgedArticle } from "../packages/backend/src/pipeline/understand/checks.ts";

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
  const long = `${BODY} ${filler(UNDERSTAND_BODY_CHARS)} ${middle}${filler(UNDERSTAND_BODY_CHARS)} ${tail}`;
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

const repeatTo = (unit: string, n: number) =>
  Array.from(unit.repeat(Math.ceil(n / Array.from(unit).length)))
    .slice(0, n)
    .join("");
const ZH_FILLER = "矿山的生产安排保持稳定，项目建设按计划推进。";
const EN_FILLER = "Further detail on the project. ";

test("a long Chinese body is read where the material cuts it: a figure at character 18,500 counts, one in its last 2,000 characters the model never saw does not", async () => {
  const seen = "公司计划投资123亿元扩建冶炼厂。";
  const unseen = "其余矿区产量增长47%。";
  // 30,000 characters. body_tail is at most 4,000 UTF-8 bytes, 1,333 Chinese characters, so the material shows the
  // first 18,667 characters and the last 1,333: the first figure is in what it shows, the second is not.
  const body = `${repeatTo(ZH_FILLER, 18_500)}${seen}${repeatTo(ZH_FILLER, 30_000 - 18_500 - seen.length - 1_800)}${unseen}${repeatTo(ZH_FILLER, 1_800 - unseen.length)}`;
  const long = article({ title: "紫金矿业扩建冶炼厂", bodyText: body });
  const sent = sharedMaterial(long).text;
  assert.ok(sent.includes(seen) && !sent.includes(unseen), "what the model was sent");
  const check = await checkArticle(
    index,
    long,
    "zh",
    judged({ titleZh: "紫金矿业将投资123亿元扩建冶炼厂", summaryZh: "公司计划投资123亿元扩建冶炼厂，其余矿区产量增长47%。", geography: null }),
  );
  assert.deepEqual(
    check.figures.map((f) => `${f.field} ${f.token} ${f.problem}`),
    ["summary 47% absent"],
  );
});

test("an English body and one with a Chinese tail are read where the material cuts them", async () => {
  const copy = judged({ titleZh: "铜矿产量增长", summaryZh: "铜矿产量增长61%，发货量增长39%。", geography: null });
  // Plain English: the first 18,000 characters and the last 2,000.
  const english = `${repeatTo(EN_FILLER, 18_100)}Output rose 61%. ${repeatTo(EN_FILLER, 30_000 - 18_100 - 17 - 1_900)}Shipments rose 39%. ${repeatTo(EN_FILLER, 1_900 - 20)}`;
  // A Chinese tail is cut shorter by its bytes, so more of the start is shown: the first 18,667 and the last 1,333.
  const tail = `${repeatTo(ZH_FILLER, 200)}发货量增长39%。${repeatTo(ZH_FILLER, 2_000 - 200 - 9)}`;
  const mixed = `${repeatTo(EN_FILLER, 18_300)}Output rose 61%. ${repeatTo(EN_FILLER, 28_000 - 18_300 - 17)}${tail}`;
  for (const [body, findings] of [
    [english, ["summary 61% absent"]],
    [mixed, ["summary 39% absent"]],
  ] as const) {
    const long = article({ title: "Copper mine output", bodyText: body });
    const check = await checkArticle(index, long, "en", copy);
    assert.deepEqual(
      check.figures.map((f) => `${f.field} ${f.token} ${f.problem}`),
      findings,
    );
    const sent = sharedMaterial(long).text;
    assert.equal(sent.includes("Output rose 61%"), findings[0] !== "summary 61% absent", "the check agrees with what the model was sent");
    assert.equal(sent.includes("39%"), findings[0] !== "summary 39% absent");
  }
});

test("the body is cut exactly as the material cuts the whole of it, from a bounded part of a long one", () => {
  const kinds = {
    zh: `${ZH_FILLER}投资123亿元。`,
    en: "Copper output rose 12% to 123,000 tonnes. ",
    mixed: "Zijin 紫金矿业 reported 25.3万吨 copper; Rio Tinto shipped 84.5 Mt. ",
    astral: "𠀀铜😀 output 12% 𪚥。",
  };
  for (const [kind, unit] of Object.entries(kinds))
    for (const size of [6_001, 18_667, 20_001, 24_001, 48_001, 200_000, 1_000_000]) {
      const whole = article({ bodyText: repeatTo(unit, size) });
      const cut = sharedBody(whole);
      const shown = bodyAsShown(whole, whole.title);
      assert.equal(shown.text, `${cut.head}${cut.continuation}${cut.omitted ? "\n" : ""}${cut.tail}`, `${kind} ${size}`);
      assert.ok(shown.material.bodyText.length <= 2 * (UNDERSTAND_BODY_CHARS + 4_000), `${kind} ${size}: only a bounded part is handed to the cut`);
      // The dateline check cuts its segments from the same part, at any budget a stored geography carries.
      for (const budget of [22000, 4096]) assert.deepEqual(geographyMaterial(shown.material, budget).segments, geographyMaterial(whole, budget).segments);
    }
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
