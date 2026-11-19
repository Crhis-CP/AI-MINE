// The package 2 event rules (packages/backend/src/pipeline/events/rules.ts) on hand-built reports: each rule fires on
// its own evidence and nothing weaker, only "no candidate at all" founds a new event, and the call forecast counts
// what the live engine would still ask. The wire story is the one TASK-0661 measured its thresholds on.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FINGERPRINT_MAX_DISTANCE,
  FINGERPRINT_RECIPE,
  bodyFingerprint,
  hammingDistance,
  simhash,
  titleSimilarity,
} from "../packages/backend/src/pipeline/events/fingerprint.ts";
import { DATE_APART_DAYS, EVENT_RULESET, type EventCandidate, type EventQuery, decideEvent } from "../packages/backend/src/pipeline/events/rules.ts";

const wire = [
  "紫金矿业今日宣布，公司旗下位于刚果（金）的卡莫阿铜矿三期选厂已完成带料试车，设计年处理矿石能力提升至1900万吨。",
  "公司表示，三期达产后卡莫阿-卡库拉铜矿年产铜将超过60万吨，成为全球第四大铜矿。项目配套的直流冶炼厂预计明年二季度投产，",
  "届时阳极铜产能达到50万吨，可就地加工约一半的铜精矿，降低运输成本和出口关税。",
  "公告显示，三期工程总投资约为14亿美元，较可研估算节省约8%，主要得益于设备国产化和施工组织优化。",
  "刚果（金）矿业部长在试车仪式上表示，政府将继续支持外国投资者，并推动更多矿产在本地完成加工。",
  "分析人士认为，在全球铜精矿供应偏紧、冶炼加工费处于低位的背景下，卡莫阿项目扩产将为市场带来新增供应。",
  "据介绍，三期选厂采用大型半自磨加球磨工艺，配套建设了尾矿库扩容和回水系统，选矿回收率设计值为百分之八十六。",
  "项目建设期间累计雇用当地员工超过六千人，公司同步建设了职业培训中心、医院和道路，并向周边社区提供清洁饮用水。",
  "电力方面，项目与当地电力公司合作修复了英加二级水电站一台机组，新增约一百六十兆瓦供电，缓解了矿区用电紧张。",
  "公司计划在未来两年内启动四期工程可行性研究，目标将年产铜提升至八十万吨以上，并评估在矿区建设硫酸厂的可行性。",
  "今年前三季度，紫金矿业矿产铜产量约为八十万吨，同比增长约百分之六，其中卡莫阿项目权益产量贡献约四分之一。",
  "公司同时公布，旗下塞尔维亚佩吉铜金矿下部矿带开发进展顺利，预计明年产量继续增长，西藏巨龙铜矿二期工程也已开工。",
].join("");
const otherStory = [
  "智利国家铜业公司表示，受地质条件变化和设备检修影响，旗下特尼恩特铜矿今年产量预计下降约5%。",
  "公司正在推进新矿层开发项目，计划在三年内恢复产能，并将加大自动化设备投入以提高安全水平。",
  "智利矿业部表示，将与公司协商调整部分环境许可的审批时限，以保障项目按期推进。工会则呼吁公司增加一线人员配备。",
  "市场人士指出，智利作为全球最大产铜国，主要矿山产量波动会对铜价形成支撑，但短期影响有限。",
].join("");
// What a broken extraction keeps of a page: the site's own navigation and footer, the same on every page of the site.
const chromeOnly = `${"首页 新闻中心 行业动态 政策法规 企业风采 联系我们 版权所有 某某矿业网 备案信息 技术支持 ".repeat(6)}`;

const day = (iso: string) => new Date(`${iso}T09:00:00+08:00`);

function query(over: Partial<EventQuery> = {}): EventQuery {
  return {
    articleId: "q",
    sourceId: "src-b",
    title: "卡莫阿铜矿三期选厂完成带料试车",
    at: day("2026-11-18"),
    jurisdiction: "CD",
    fingerprint: bodyFingerprint(`【来源：某财经网】${wire}（本文转载自公司公告）`),
    occurredOn: null,
    editorial: true,
    relevance: "pass",
    scope: "single",
    frame: true,
    manual: false,
    historical: false,
    hasVector: true,
    readingBackground: false,
    ...over,
  };
}

function candidate(articleId: string, over: Partial<EventCandidate> = {}): EventCandidate {
  return {
    articleId,
    sourceId: "src-a",
    factId: 10,
    storyId: 100,
    title: "紫金矿业卡莫阿铜矿三期选厂带料试车",
    at: day("2026-11-18"),
    jurisdiction: "CD",
    fingerprint: null,
    occurredOn: null,
    cosine: 0.7,
    lexical: 0.4,
    sameUrl: false,
    sameHash: false,
    documentKey: false,
    selected: false,
    ...over,
  };
}

test("fingerprint: a reprint with page chrome stays within the distance, another story does not, short bodies have none", () => {
  const original = simhash(wire);
  for (const reprint of [
    `首页 > 新闻中心 > 行业动态\n${wire}\n责任编辑 版权所有 某某网`,
    `【来源：某财经网】${wire}（本文转载自公司公告，如有侵权请联系删除）`,
    `首页 > 新闻中心\n${wire}\n责任编辑 版权所有`,
  ])
    assert.ok(hammingDistance(simhash(reprint), original) <= FINGERPRINT_MAX_DISTANCE, `reprint distance ${hammingDistance(simhash(reprint), original)}`);
  // Two copies with different chrome on a text this short (about 570 characters) sit at the limit: the shadow
  // measurement, not this test, decides whether 6 bits holds.
  assert.ok(hammingDistance(original, simhash(otherStory)) > FINGERPRINT_MAX_DISTANCE * 3, "a different story is far away");
  assert.equal(simhash(wire), simhash(` ${wire.replaceAll("，", ",")} `), "punctuation and spacing do not count");
  assert.equal(bodyFingerprint("紫金矿业卡莫阿三期投产。"), null);
  assert.equal(bodyFingerprint(""), null);
  assert.ok(titleSimilarity("紫金矿业卡莫阿铜矿三期选厂带料试车", "卡莫阿铜矿三期选厂完成带料试车") >= 0.5);
  assert.ok(titleSimilarity("紫金矿业卡莫阿三期投产", "智利特尼恩特铜矿减产") < 0.2);
});

test("the ruleset names every threshold, so rows under other values are never pooled", () => {
  assert.ok(EVENT_RULESET.startsWith("event-rules-v1/"));
  assert.ok(EVENT_RULESET.includes(FINGERPRINT_RECIPE));
  assert.ok(EVENT_RULESET.includes(`apart${DATE_APART_DAYS}`));
  assert.ok(EVENT_RULESET.includes("fp6-title0.5"));
});

test("rule 0: manual, archive, not passed, too thin and roundups are not judged and carry no forecast", () => {
  const twin = [candidate("a", { sameUrl: true })];
  const cases: Array<[Partial<EventQuery>, string]> = [
    [{ manual: true, historical: true }, "manual"],
    [{ historical: true }, "historical"],
    [{ relevance: "block" }, "not_passed"],
    [{ editorial: false }, "not_passed"],
    [{ scope: "unknown", frame: false }, "not_passed"],
    [{ scope: "composite" }, "composite"],
  ];
  for (const [over, rule] of cases) {
    const d = decideEvent(query(over), twin);
    assert.deepEqual([d.verdict, d.rule, d.targetFactId, d.wouldCall], ["not_judged", rule, null, 0], rule);
  }
});

test("rule 1: the same address ties to the earliest twin's fact; the value question still costs a call unless the twin is selected", () => {
  const later = candidate("later", { sameUrl: true, factId: 21, storyId: 201, at: day("2026-11-18") });
  const first = candidate("first", { sameUrl: true, factId: 20, storyId: 200, at: day("2026-11-17"), cosine: 0.3 });
  const d = decideEvent(query(), [later, first, candidate("x", { cosine: 0.99 })]);
  assert.deepEqual([d.verdict, d.rule, d.targetFactId, d.targetStoryId, d.wouldCall], ["same_fact", "same_url", 20, 200, 0]);
  assert.equal(decideEvent(query({ readingBackground: true }), [first]).wouldCall, 1);
  assert.equal(decideEvent(query({ readingBackground: true }), [{ ...first, selected: true }]).wouldCall, 0);
});

test("rule 2: a hash twin re-collected under a new address from the same source is the same fact; a generic bodiless title is not enough", () => {
  const old = candidate("old", {
    sourceId: "src-b",
    title: query().title,
    sameHash: true,
    factId: 30,
    storyId: 300,
    at: day("2026-10-02"),
    cosine: null,
    lexical: 1,
  });
  const d = decideEvent(query(), [old]);
  assert.deepEqual([d.verdict, d.rule, d.targetFactId], ["same_fact", "content_hash", 30]);
  assert.equal(d.candidates[0]?.sameHash, true);
  const generic = decideEvent(query({ title: "公告", fingerprint: null }), [{ ...old, title: "公告" }]);
  assert.notEqual(generic.rule, "content_hash");
  assert.equal(generic.verdict, "undecided");
});

test("rule 3: a retitled reprint from another site is the same fact; chrome-only pages of one site and other countries are not", () => {
  const original = candidate("orig", { factId: 40, storyId: 400, fingerprint: bodyFingerprint(`首页 > 新闻中心\n${wire}\n责任编辑 版权所有`) });
  const d = decideEvent(query(), [original]);
  assert.deepEqual([d.verdict, d.rule, d.targetFactId], ["same_fact", "fingerprint", 40]);
  assert.ok((d.candidates[0]?.fingerprint ?? 99) <= FINGERPRINT_MAX_DISTANCE);

  // The same source: the title must be the same, because a failed extraction fingerprints like every other one.
  const page = (articleId: string, title: string) => candidate(articleId, { sourceId: "src-b", title, fingerprint: bodyFingerprint(chromeOnly) });
  const chromeQuery = query({ title: "某矿业公司第三季度生产经营情况公告", fingerprint: bodyFingerprint(chromeOnly) });
  assert.equal(decideEvent(chromeQuery, [page("p2", "某矿业公司第二季度生产经营情况公告")]).verdict, "undecided");
  const recollected = decideEvent(chromeQuery, [page("p3", "某矿业公司第三季度生产经营情况公告")]);
  assert.deepEqual([recollected.verdict, recollected.rule], ["same_fact", "fingerprint"]);

  assert.equal(decideEvent(query(), [{ ...original, jurisdiction: "CL" }]).rule, "similar_unsure", "a country conflict leaves it to the judge");
  assert.equal(decideEvent(query(), [{ ...original, fingerprint: bodyFingerprint(otherStory) }]).rule, "similar_unsure");
});

test("rule 4: certainDuplicate exactly as the live re-merge (0.92, same Beijing day, same title key)", () => {
  const twin = candidate("wire", { factId: 50, storyId: 500, title: "新华社：卡莫阿铜矿三期选厂完成带料试车！", cosine: 0.95 });
  const d = decideEvent(query({ fingerprint: null }), [candidate("weak", { cosine: 0.8 }), twin]);
  assert.deepEqual([d.verdict, d.rule, d.targetFactId, d.similarity], ["same_fact", "certain_duplicate", 50, 0.95]);
  assert.equal(decideEvent(query({ fingerprint: null }), [{ ...twin, at: day("2026-11-17") }]).verdict, "undecided", "another day");
  assert.equal(decideEvent(query({ fingerprint: null }), [{ ...twin, cosine: 0.9 }]).verdict, "undecided", "below 0.92");
});

test("rule 5: trusted occurrence days far apart rule out the same fact but leave the story to the relation step", () => {
  const q = query({ fingerprint: null, occurredOn: "2026-11-18" });
  const older = candidate("older", { occurredOn: "2026-10-20", cosine: 0.75 });
  const d = decideEvent(q, [older]);
  assert.deepEqual([d.verdict, d.rule, d.targetFactId, d.wouldCall], ["undecided", "date_apart", null, 1]);
  assert.equal(d.candidates[0]?.occurredGapDays, 29);
  // One candidate within the window keeps the same fact possible.
  const near = candidate("near", { occurredOn: "2026-11-15", cosine: 0.7 });
  assert.equal(decideEvent(q, [older, near]).rule, "similar_unsure");
  // Exactly the limit is not apart, and a candidate without a trusted day is not apart either.
  assert.equal(decideEvent(q, [{ ...older, occurredOn: `2026-11-${18 - DATE_APART_DAYS}` }]).rule, "similar_unsure");
  assert.equal(decideEvent(q, [{ ...older, occurredOn: null }]).rule, "similar_unsure");
  // Twin evidence outranks dates: the same text is the same fact whatever a model said about its day.
  assert.equal(decideEvent(q, [{ ...older, sameUrl: true }]).rule, "same_url");
});

test("rule 6: only no candidate at all, with a complete recall, founds a new event", () => {
  const d = decideEvent(query(), []);
  assert.deepEqual([d.verdict, d.rule, d.targetFactId, d.similarity, d.candidates, d.wouldCall], ["new_event", "no_candidate", null, null, [], 0]);
  assert.equal(decideEvent(query({ readingBackground: true }), []).wouldCall, 1, "the value question remains");
  const blind = decideEvent(query({ hasVector: false }), []);
  assert.deepEqual([blind.verdict, blind.rule, blind.wouldCall], ["undecided", "vector_missing", 1]);
  const unknownScope = decideEvent(query({ scope: "unknown" }), []);
  assert.deepEqual([unknownScope.verdict, unknownScope.rule, unknownScope.wouldCall], ["undecided", "no_candidate", 1]);
  // The report itself among its candidates is ignored.
  assert.equal(decideEvent(query(), [candidate("q", { sameUrl: true })]).verdict, "new_event");
});

test("rule 7: anything else is undecided; the forecast adds one review call per judged candidate under 0.85, capped at six", () => {
  const q = query({ fingerprint: null });
  const d = decideEvent(q, [candidate("a", { cosine: 0.9 }), candidate("b", { cosine: 0.7 }), candidate("c", { cosine: null, lexical: 0.3 })]);
  assert.deepEqual([d.verdict, d.rule, d.wouldCall, d.similarity], ["undecided", "similar_unsure", 3, 0.9]);
  assert.deepEqual(
    d.candidates.map((c) => c.articleId),
    ["a", "b", "c"],
    "recall order",
  );
  const many = Array.from({ length: 8 }, (_, i) => candidate(`m${i}`, { factId: 60 + i, cosine: 0.6 + i * 0.01 }));
  const capped = decideEvent(q, many);
  assert.equal(capped.candidates.length, 5);
  assert.equal(capped.wouldCall, 6);
  assert.equal(decideEvent(query({ fingerprint: null, hasVector: false }), many).rule, "vector_missing");
});

test("the record keeps at most five candidates and always the target", () => {
  const strong = Array.from({ length: 6 }, (_, i) => candidate(`s${i}`, { factId: 70 + i, cosine: 0.9 - i * 0.01 }));
  const copy = candidate("copy", { factId: 80, cosine: null, lexical: 0.2, fingerprint: bodyFingerprint(wire) });
  const d = decideEvent(query(), [...strong, copy]);
  assert.equal(d.rule, "fingerprint");
  assert.equal(d.candidates.length, 5);
  assert.ok(d.candidates.some((c) => c.factId === 80));
  // JSON-safe for the jsonb column: no bigint fingerprints, dates or functions.
  assert.deepEqual(JSON.parse(JSON.stringify(d.candidates)), d.candidates);
});
