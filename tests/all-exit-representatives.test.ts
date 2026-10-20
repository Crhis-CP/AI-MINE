import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { loadTimeline } from "@amp/backend/publication/timeline";
import { v1Items } from "@amp/backend/publication/v1";
import { itemFeed } from "@amp/backend/publication/feeds";
import { randomUUID } from "node:crypto";

after(closeDb);
test("unfiltered all exits choose one identical representative per fact and retain a separate new development", async () => {
  const now = new Date("2026-10-20T10:00:00Z");
  const [story] = await sql`INSERT INTO stories(public_id,title) VALUES(${randomUUID()},'合成铜矿发展线') RETURNING id`;
  const facts = [];
  for (const title of ["获批", "开工"])
    facts.push((await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${randomUUID()},${story.id},${title}) RETURNING id`)[0].id);
  for (const [index, id] of ["official", "reprint", "follow-up"].entries()) {
    const at = new Date(now.getTime() - (3 - index) * 3600000);
    await sql`INSERT INTO sources(id,name,kind) VALUES(${id},${id},'rss')`;
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,raw)
      VALUES(${id},${id},${id},${`https://fixture.invalid/${id}`},${id},${at},${at},'{}')`;
    await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,discovered_at,published_at,timeline_at,sort_at,
      visibility,eligible,selected,score,representative_priority,fact_id,story_id)
      VALUES(${id},${id},'合成项目摘要',${id},'news',${`https://fixture.invalid/${id}`},${at},${at},${at},${at},
        'public',true,false,80,${index === 0 ? 0 : 3},${facts[index === 2 ? 1 : 0]},${story.id})`;
    await sql`INSERT INTO fact_articles(article_id,fact_id,role) VALUES(${id},${facts[index === 2 ? 1 : 0]},'report')`;
  }
  const web = await loadTimeline({ scope: "all", channel: "all", category: null, tag: null, now });
  assert.deepEqual(web.cards.map((entry) => entry.item.id).sort(), ["follow-up", "official"]);
  const query = { mode: "all" as const, window: "all" as const, by: "timeline" as const, category: null, q: null, limit: 1, cursor: null };
  const first = await v1Items(query, now),
    next = await v1Items({ ...query, cursor: first.page.nextCursor }, now);
  assert.deepEqual([...first.items, ...next.items].map((entry) => entry.id).sort(), ["follow-up", "official"]);
  assert.equal(next.page.hasMore, false);
  const rss = await itemFeed("all", null, now);
  assert.match(rss, /<amp:content-id>official<\/amp:content-id>/);
  assert.match(rss, /<amp:content-id>follow-up<\/amp:content-id>/);
  assert.doesNotMatch(rss, /<amp:content-id>reprint<\/amp:content-id>/);
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id='official'`;
  const current = await v1Items({ ...query, limit: 20 }, now);
  assert.deepEqual(current.items.map((entry) => entry.id).sort(), ["follow-up", "reprint"]);
});
