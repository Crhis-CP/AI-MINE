// Topic counts follow 全部矿业动态 (PG-08): an eligible public item counts whether or not it is 精选; a
// withdrawn, ineligible or not yet released one does not; a company topic takes only items about the
// company (its subject tag), not mere mentions; the counts agree with the topic filter of 全部矿业动态.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { loadPool } from "@amp/backend/publication/pool";
import { loadTopicPage, topicPageCounts } from "@amp/backend/publication/topics";

const sql = dbOf("publication");
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

test("topic counts follow 全部矿业动态, not only 精选, and agree with its topic filter", async () => {
  await sql`INSERT INTO sources (id, name, kind, config) VALUES (${SOURCE}, 'Topics fixture', 'rss', '{}')`;
  await item("plain", { tags: ["铜"] });
  await item("selected", { tags: ["铜"], selected: true, visibleAfter: new Date(Date.now() - 60_000) });
  await item("old", { tags: ["铜"], daysAgo: 40 });
  await item("unreleased", { tags: ["铜"], selected: true, visibleAfter: new Date(Date.now() + 3600_000) });
  await item("withdrawn", { tags: ["铜"], visibility: "withdrawn" });
  await item("ineligible", { tags: ["铜"], eligible: false });
  await item("about-zijin", { tags: ["紫金矿业", "entity:zijin"] });
  await item("mentions-zijin", { tags: ["紫金矿业"] });

  const counts = new Map((await topicPageCounts()).map((c) => [c.slug, c]));
  const copper = counts.get("copper")!;
  assert.deepEqual([copper.total, copper.recent, copper.pages], [3, 2, 1], "plain, selected and old count; only the first two are recent");
  assert.equal(counts.get("zijin")!.total, 1, "a company topic takes the item about the company, not the mention");
  assert.equal(counts.get("lithium")!.total, 0);

  const pool = await loadPool({ channel: "all", category: null, tag: null, topicTags: ["铜"] } as never);
  assert.equal(pool.total, copper.total, "the same items as 全部矿业动态 with the topic filter");
  const page = await loadTopicPage("copper", 1);
  assert.deepEqual(page!.items.map((i) => i.title).sort(), ["old", "plain", "selected"]);
  assert.equal(await loadTopicPage("copper", 2), null, "no page past the last");
});
