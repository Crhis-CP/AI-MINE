import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import {
  bands,
  hammingDistance,
  MAX_DISTANCE,
  NEAR_DUPLICATE_RECIPE,
  recordNearDuplicate,
  simhash,
  titleSimilarity,
} from "../packages/backend/src/editorial/near-duplicate.ts";
import { collect, render } from "../scripts/near-duplicate-report.ts";

after(closeDb);

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

test("the same wire story with different page chrome stays within the distance; a different story does not", () => {
  const a = simhash(`首页 > 新闻中心 > 行业动态\n${wire}\n责任编辑：张三 版权所有 某某网`);
  const b = simhash(`【来源：某财经网】${wire}（本文转载自公司公告，如有侵权请联系删除）`);
  const c = simhash(otherStory);
  assert.ok(hammingDistance(a, b) <= MAX_DISTANCE, `reprint distance ${hammingDistance(a, b)}`);
  assert.ok(hammingDistance(a, c) > MAX_DISTANCE * 3, `different story distance ${hammingDistance(a, c)}`);
  assert.equal(simhash(wire), simhash(` ${wire.replaceAll("，", ",")} `), "punctuation and spacing do not count");
});

test("bands split the 64 bits and two hashes within 6 bits always share one band", () => {
  const value = simhash(wire);
  for (const flips of [[0], [5, 21], [3, 19, 40], [0, 10, 19, 28, 37, 46], [9, 18, 27, 36, 45, 54]]) {
    let other = value;
    for (const bit of flips) other ^= 1n << BigInt(bit);
    assert.equal(hammingDistance(value, other), flips.length);
    const x = bands(value),
      y = bands(other);
    assert.ok(x.some((band, i) => band === y[i]));
  }
  assert.equal(bands(value).length, 7);
  assert.ok(bands(value).every((band, position) => band >= position * 1024 && band < position * 1024 + 1024));
});

test("title similarity uses character bigrams of the normalised title", () => {
  assert.equal(titleSimilarity("紫金矿业卡莫阿三期投产", "紫金矿业卡莫阿三期投产"), 1);
  assert.ok(titleSimilarity("紫金矿业卡莫阿铜矿三期选厂带料试车", "卡莫阿铜矿三期选厂完成带料试车") >= 0.5);
  assert.ok(titleSimilarity("紫金矿业卡莫阿三期投产", "智利特尼恩特铜矿减产") < 0.2);
});

test("record only: a later reprint from another source points at the earlier one; same source, short bodies and posts are not matched", async () => {
  const id = tag(),
    article = (n: string) => `nd-${id}-${n}`;
  const first = { id: article("a"), revision: 1, sourceId: `src-a-${id}`, title: "紫金矿业卡莫阿铜矿三期选厂带料试车", bodyText: wire, xPost: null };
  assert.equal(await recordNearDuplicate(first), null);
  const reprint = { ...first, id: article("b"), sourceId: `src-b-${id}`, title: "卡莫阿铜矿三期选厂完成带料试车", bodyText: `转载：${wire}责任编辑：李四` };
  const match = await recordNearDuplicate(reprint);
  assert.equal(match?.articleId, first.id);
  assert.ok(match!.distance <= MAX_DISTANCE);
  // The same revision is recorded once; repeating changes nothing.
  await recordNearDuplicate(reprint);
  const rows =
    await sql`SELECT article_id, match_article_id FROM enrichment.near_duplicates WHERE article_id = ANY(${[first.id, reprint.id]}) ORDER BY article_id`;
  assert.deepEqual(
    rows.map((r) => [r.article_id, r.match_article_id]),
    [
      [first.id, null],
      [reprint.id, first.id],
    ],
  );
  assert.equal(
    (await recordNearDuplicate({ ...reprint, id: article("c"), sourceId: first.sourceId }))?.articleId,
    reprint.id,
    "an earlier article of its own source is never the match",
  );
  assert.equal(await recordNearDuplicate({ ...reprint, id: article("d"), title: "智利铜矿减产" }), null, "unlike titles");
  assert.equal(await recordNearDuplicate({ ...reprint, id: article("e"), sourceId: `src-e-${id}`, bodyText: otherStory }), null, "another story");
  assert.equal(await recordNearDuplicate({ ...reprint, id: article("f"), bodyText: "短讯：铜矿投产。" }), null);
  assert.equal(await recordNearDuplicate({ ...reprint, id: article("g"), xPost: { text: wire } as never }), null);
  const recorded = await sql`SELECT article_id FROM enrichment.near_duplicates WHERE article_id IN (${article("f")}, ${article("g")})`;
  assert.equal(recorded.length, 0, "short bodies and posts are not fingerprinted");
  // Outside the window: no match.
  await sql`UPDATE enrichment.near_duplicates SET computed_at = now() - interval '15 days' WHERE article_id IN (${first.id}, ${reprint.id}, ${article("c")}, ${article("d")}, ${article("e")})`;
  assert.equal(await recordNearDuplicate({ ...reprint, id: article("h"), sourceId: `src-h-${id}` }), null);
});

test("many far articles sharing a band do not crowd out a true reprint (no row limit before the distance check)", async () => {
  const id = tag(),
    body = `${wire}批次${id}`,
    hash = simhash(body);
  // 600 articles (more than any limit) from other sources share the first band but are 20+ bits away; their ids sort before the reprint's.
  const far = Array.from({ length: 600 }, (_, i) => {
    let value = hash;
    for (let bit = 10; bit < 64; bit += 2) value ^= 1n << BigInt(bit);
    value ^= BigInt(i) << 40n;
    return { article_id: `a-far-${id}-${String(i).padStart(3, "0")}`, simhash: BigInt.asIntN(64, value) };
  });
  for (const row of far)
    await sql`INSERT INTO enrichment.near_duplicates (article_id, input_revision, source_id, simhash, bands, title_key, recipe)
      VALUES (${row.article_id}, 1, ${`src-far-${id}`}, ${row.simhash.toString()}, ${bands(row.simhash)}::integer[], '紫金矿业卡莫阿铜矿三期选厂带料试车', ${NEAR_DUPLICATE_RECIPE})`;
  const original = { id: `z-orig-${id}`, revision: 1, sourceId: `src-o-${id}`, title: "紫金矿业卡莫阿铜矿三期选厂带料试车", bodyText: body, xPost: null };
  await recordNearDuplicate(original);
  const match = await recordNearDuplicate({ ...original, id: `z-copy-${id}`, sourceId: `src-c-${id}`, bodyText: `转载：${body}` });
  assert.equal(match?.articleId, original.id);
});

test("the report counts matches, their events and the would-be saving read-only", async () => {
  const row = await collect(14);
  assert.ok(row.fingerprinted >= 1 && row.matched >= 0);
  assert.equal(row.matched, row.sameFact + row.sameStory + row.differentEvent + row.notGrouped);
  const text = render({ fingerprinted: 10, matched: 4, sameFact: 3, sameStory: 0, differentEvent: 1, notGrouped: 0 }, 14, 0.016);
  assert.match(text, /准确率（同一事实 ÷ 已能判断） \| 75\.0%/);
  assert.match(text, /约能省 \| 0\.06 元/);
});
