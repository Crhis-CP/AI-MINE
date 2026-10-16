// Topic pages follow 全部矿业动态: public eligible articles, by tag or by the name in the title/summary.
// Homepage 精选 filters stay 精选-only. A company topic takes the entity tag or the name in the title,
// not a display tag by itself.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { loadPool } from "@amp/backend/publication/pool";
import { listTopicSummaries, loadTopicPage, seedTopics, topicPageCounts } from "@amp/backend/publication/topics";

const SOURCE = `test-topics-${tag()}`;

after(async () => {
  await closeDb();
});

async function item(
  name: string,
  opts: { tags: string[]; eligible?: boolean; selected?: boolean; visibility?: string; visibleAfter?: Date; daysAgo?: number },
) {
  const id = `${SOURCE}-${name}`;
  const at = new Date(Date.now() - (opts.daysAgo ?? 1) * 86400_000);
  const url = `https://example.invalid/${id}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, language, body_text, raw)
    VALUES (${id}, ${SOURCE}, ${id}, ${url}, ${name}, ${at}, ${at}, 'zh', 'body', '{}')`;
  await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, sort_at,
      visibility, eligible, selected, visible_after, tags)
    VALUES (${id}, ${name}, ${SOURCE}, 'news', ${url}, ${at}, ${at}, ${at}, ${opts.visibility ?? "public"}, ${opts.eligible ?? true},
      ${opts.selected ?? false}, ${opts.visibleAfter ?? null}, ${opts.tags})`;
}

const counts = async () => new Map((await topicPageCounts()).map((c) => [c.slug, c]));
const titles = async (slug: string) => (await loadTopicPage(slug, 1))!.items.map((i) => i.title).sort();

test("before the first 精选, topics follow 全部矿业动态 like its topic filter", async () => {
  await sql`INSERT INTO sources (id, name, kind, config) VALUES (${SOURCE}, 'Topics fixture', 'rss', '{}')`;
  await item("plain", { tags: ["铜"] });
  await item("old", { tags: ["铜"], daysAgo: 40 });
  await item("withdrawn", { tags: ["铜"], visibility: "withdrawn" });
  await item("ineligible", { tags: ["铜"], eligible: false });
  await item("pending", { tags: ["铜"], selected: true, visibleAfter: new Date(Date.now() + 3600_000) });
  await item("about-zijin", { tags: ["紫金矿业", "entity:zijin"] });
  await item("mentions-zijin", { tags: ["紫金矿业"] });

  const before = await counts();
  const copper = before.get("copper")!;
  assert.equal(copper.basis, "all", "a 精选 not yet released does not count as the first one");
  assert.deepEqual([copper.total, copper.recent, copper.pages], [2, 1, 1], "plain and old count; only plain is recent");
  assert.equal(before.get("zijin")!.total, 1, "a company topic takes the item about the company, not the mention");
  assert.equal(before.get("lithium")!.total, 0);
  const pool = await loadPool({ channel: "all", category: null, tag: null, topicTags: ["铜"] } as never);
  assert.equal(pool.total, copper.total, "the same items as 全部矿业动态 with the topic filter");
  assert.deepEqual(await titles("copper"), ["old", "plain"]);
  assert.equal(await loadTopicPage("copper", 2), null, "no page past the last");
  assert.ok(
    (await listTopicSummaries()).every((t) => t.basis === "all"),
    "the pages are told to say 动态, not 精选",
  );
});

test("releasing a 精选 does not shrink a topic page down to 精选 only", async () => {
  await sql`UPDATE publications SET visible_after = ${new Date(Date.now() - 60_000)} WHERE article_id = ${`${SOURCE}-pending`}`;
  await seedTopics(); // drops the minute-long count cache
  const after = await counts();
  const copper = after.get("copper")!;
  assert.equal(copper.basis, "all");
  assert.deepEqual([copper.total, copper.recent, copper.pages], [3, 2, 1], "the public items stay; the released 精选 is added");
  assert.equal(after.get("zijin")!.total, 1, "the company item stays even though it is not 精选");
  assert.deepEqual(await titles("copper"), ["old", "pending", "plain"]);
  assert.ok((await listTopicSummaries()).every((t) => t.basis === "all"));
});
