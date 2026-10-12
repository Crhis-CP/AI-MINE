// 全部矿业动态 filters keep every public article whose title or summary names the country,
// mineral or company. 精选 filters stay inside 精选. Aliases match. Withdrawn stays hidden.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { loadPool } from "@amp/backend/publication/pool";
import { loadTimeline } from "@amp/backend/publication/timeline";
import { foldMention, mentionByFold, mentionByTag, textHits } from "../packages/backend/src/publication/mentions.ts";

const sql = dbOf("publication");
const SOURCE = `test-mentions-${tag()}`;
const NOW = new Date("2026-10-10T04:00:00.000Z");

after(async () => {
  await closeDb();
});

test("刚果金, 刚果（金） and DRC are one country, and 金 is not", () => {
  assert.equal(foldMention("刚果（金）"), foldMention("刚果金"));
  assert.equal(mentionByFold(foldMention("刚果金"))?.id, "CD");
  assert.equal(mentionByFold("drc")?.id, "CD");
  assert.equal(mentionByTag("刚果（金）")?.id, "CD");
  assert.equal(mentionByFold("zambia")?.id, "ZM");
  assert.equal(mentionByTag("钴")?.id, "钴");
  assert.equal(mentionByFold("cmoc")?.id, "cmoc");
  assert.equal(mentionByTag("黄金")?.id, "金");
  assert.notEqual(mentionByTag("刚果（金）")?.id, "金");
  const gold = mentionByTag("金")!;
  assert.equal(textHits("紫金矿业公布钴配额", gold.needles), false);
  assert.equal(textHits("刚果（金）矿业部发布消息", gold.needles), false);
  assert.equal(textHits("金矿项目开工", gold.needles), true);
  assert.equal(textHits("山东黄金产量上升", gold.needles), true);
  assert.equal(textHits("智利国家铜业下调产量", mentionByTag("铜")!.needles), true);
  const lead = mentionByTag("铅")!;
  assert.equal(textHits("the minister will lead the review", lead.needles), false);
  assert.equal(textHits("leading the committee", lead.needles), false);
  assert.equal(textHits("lead metal output rose", lead.needles), true);
  assert.equal(textHits("铅锭价格上涨", lead.needles), true);
  assert.equal(textHits("精炼铅出口增加", lead.needles), true);
});

async function item(name: string, opts: { search: string; tags?: string[]; selected?: boolean; visibility?: string; eligible?: boolean }) {
  const id = `${SOURCE}-${name}`;
  const at = new Date(NOW.getTime() - 86_400_000);
  const url = `https://example.invalid/${id}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, language, body_text, raw)
    VALUES (${id}, ${SOURCE}, ${id}, ${url}, ${name}, ${at}, ${at}, 'zh', 'body', '{}')`;
  await sql`INSERT INTO publications (article_id, title, summary, search_text, source_id, channel, url, discovered_at, timeline_at, sort_at,
      visibility, eligible, selected, visible_after, tags)
    VALUES (${id}, ${name}, ${opts.search}, ${opts.search.toLowerCase()}, ${SOURCE}, 'news', ${url}, ${at}, ${at}, ${at},
      ${opts.visibility ?? "public"}, ${opts.eligible ?? true}, ${opts.selected ?? false}, ${at}, ${opts.tags ?? []})`;
  return id;
}

const poolIds = async (query: { jurisdiction?: string; tag?: string; q?: string }) =>
  new Set(
    (
      await loadPool({
        channel: "all",
        category: null,
        tag: query.tag ?? null,
        jurisdiction: query.jurisdiction ?? null,
        q: query.q,
        now: NOW,
      })
    ).items.map((item) => item.id),
  );

test("country, mineral and company filters keep public articles and leave 精选, withdrawn and lookalikes alone", async () => {
  await sql`INSERT INTO sources (id, name, kind, config) VALUES (${SOURCE}, 'Mention fixture', 'rss', '{}')`;
  const listed = await item("listed-drc", { search: "刚果（金）矿业部 · 新闻 刚果（金）矿业周开幕" });
  const alias = await item("alias-drc", { search: "刚果金矿业部发布新的出口安排" });
  const featured = await item("featured-drc", { search: "Democratic Republic of the Congo updates cobalt rules", selected: true });
  const tagged = await item("tagged-drc", { search: "出口配额调整", tags: ["刚果（金）"] });
  const withdrawn = await item("withdrawn-drc", { search: "刚果（金）矿业部撤回稿", visibility: "withdrawn" });
  const hidden = await item("ineligible-drc", { search: "刚果（金）未公开稿", eligible: false });
  const zambia = await item("zambia", { search: "赞比亚政府规划矿业投资" });
  const inner = await item("inner-mongolia", { search: "内蒙古自治区出让矿业权" });
  const cobalt = await item("cobalt", { search: "钴价上涨，库存下降" });
  const featuredCobalt = await item("featured-cobalt", { search: "cobalt output recovered", selected: true });
  const gold = await item("gold", { search: "黄金价格走高" });
  const cmoc = await item("cmoc", { search: "洛阳钼业公布产量" });

  const congo = await poolIds({ jurisdiction: "CD" });
  for (const id of [listed, alias, featured, tagged]) assert.ok(congo.has(id), id);
  assert.equal(congo.has(withdrawn), false);
  assert.equal(congo.has(hidden), false);
  assert.equal(congo.has(gold), false);
  assert.equal((await poolIds({ tag: "金" })).has(listed), false);
  assert.equal((await poolIds({ tag: "金" })).has(gold), true);

  const featuredIds = new Set(
    (await loadTimeline({ channel: "all", category: null, tag: null, jurisdiction: "CD", now: NOW })).cards.map((card) => card.item.id),
  );
  assert.equal(featuredIds.has(featured), true);
  assert.equal(featuredIds.has(listed), false, "全部里的非精选不进精选筛选");
  assert.equal(featuredIds.has(withdrawn), false);

  assert.equal((await poolIds({ q: "刚果金" })).has(listed), true);
  assert.equal((await poolIds({ q: "刚果金矿业部" })).has(listed), true);
  assert.equal((await poolIds({ q: "DRC" })).has(alias), true);
  assert.equal((await poolIds({ q: "Zambia" })).has(zambia), true);
  assert.equal((await poolIds({ jurisdiction: "ZM" })).has(zambia), true);
  assert.equal((await poolIds({ jurisdiction: "MN" })).has(inner), false);
  assert.equal((await poolIds({ jurisdiction: "CN-NM" })).has(inner), true);
  assert.equal((await poolIds({ tag: "钴" })).has(cobalt), true);
  assert.equal((await poolIds({ q: "cobalt" })).has(cobalt), true);
  assert.equal((await poolIds({ tag: "洛阳钼业" })).has(cmoc), true);
  assert.equal((await poolIds({ q: "CMOC" })).has(cmoc), true);

  const cobaltFeatured = new Set((await loadTimeline({ channel: "all", category: null, tag: "钴", now: NOW })).cards.map((card) => card.item.id));
  assert.equal(cobaltFeatured.has(featuredCobalt), true);
  assert.equal(cobaltFeatured.has(cobalt), false);
});
