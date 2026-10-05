// Topic counts and pages take 精选 only, as the upstream's do: a public 精选 item counts and an item not
// selected or withdrawn does not; a company topic takes only items about the company (its subject tag),
// not mere mentions. Before the mining scoring standard is confirmed there is no 精选, so topics are empty.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
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

test("topic counts and pages take only 精选, as the upstream's do", async () => {
  await sql`INSERT INTO sources (id, name, kind, config) VALUES (${SOURCE}, 'Topics fixture', 'rss', '{}')`;
  const released = new Date(Date.now() - 60_000);
  await item("plain", { tags: ["铜"] });
  await item("selected", { tags: ["铜"], selected: true, visibleAfter: released });
  await item("old", { tags: ["铜"], selected: true, visibleAfter: released, daysAgo: 40 });
  await item("withdrawn", { tags: ["铜"], selected: true, visibleAfter: released, visibility: "withdrawn" });
  await item("about-zijin", { tags: ["紫金矿业", "entity:zijin"], selected: true, visibleAfter: released });
  await item("mentions-zijin", { tags: ["紫金矿业"], selected: true, visibleAfter: released });

  const counts = new Map((await topicPageCounts()).map((c) => [c.slug, c]));
  const copper = counts.get("copper")!;
  assert.deepEqual([copper.total, copper.recent, copper.pages], [2, 1, 1], "the two 精选 count, the recent one as recent; the plain item does not");
  assert.equal(counts.get("zijin")!.total, 1, "a company topic takes the item about the company, not the mention");
  assert.equal(counts.get("lithium")!.total, 0);

  const page = await loadTopicPage("copper", 1);
  assert.deepEqual(page!.items.map((i) => i.title).sort(), ["old", "selected"]);
  assert.equal(await loadTopicPage("copper", 2), null, "no page past the last");
});
