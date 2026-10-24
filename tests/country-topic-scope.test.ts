import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { loadTopicPage, seedTopics, topicPageCounts } from "@amp/backend/publication/topics";
import { loadPool } from "@amp/backend/publication/pool";
import { geographyRecipe, compatibleGeographyRecipes } from "../packages/backend/src/editorial/geography.ts";
after(closeDb);

test("country topics share evidenced geography with country filters and do not admit background mentions", async () => {
  const source = tag(),
    at = new Date(Date.now() - 60_000);
  await sql`INSERT INTO sources(id,name,kind) VALUES(${source},'Synthetic country-topic source','rss')`;
  async function item(key: string, title: string, tags: string[], codes: string[] | null, visibility = "public") {
    const id = `${source}-${key}`;
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
      VALUES(${id},${source},${id},${`https://example.invalid/${id}`},${title},${at},${at})`;
    await sql`INSERT INTO publications(article_id,source_id,channel,url,title,tags,search_text,eligible,visibility,discovered_at,timeline_at,sort_at)
      VALUES(${id},${source},'news',${`https://example.invalid/${id}`},${title},${tags},${title},true,${visibility},${at},${at},${at})`;
    if (codes)
      await sql`INSERT INTO publication.news_geography(article_id,article_revision,analysis_id,recipe,state,jurisdictions)
      VALUES(${id},1,NULL,${geographyRecipe()},'identified',${codes})`;
    return id;
  }
  const background = await item("background", "美国黄金市场，仅比较阿根廷旧数据", ["阿根廷"], ["US"]);
  const actual = await item("actual", "卡塔马卡项目许可新增条件", [], ["AR", "CL"]);
  const unknown = await item("unknown", "提到阿根廷但作用地仍未确认", ["阿根廷"], null);
  await item("withdrawn", "阿根廷已撤回资讯", ["阿根廷"], ["AR"], "withdrawn");
  const stale = await item("stale", "阿根廷旧修订证明", ["阿根廷"], ["AR"]);
  await sql`UPDATE articles SET revision=2 WHERE id=${stale}`;
  const wrongAnalysis = await item("analysis", "阿根廷旧分析证明", ["阿根廷"], ["AR"]);
  await sql`UPDATE publication.news_geography SET analysis_id=99 WHERE article_id=${wrongAnalysis}`;
  const wrongRecipe = await item("recipe", "阿根廷无关配方证明", ["阿根廷"], ["AR"]);
  await sql`UPDATE publication.news_geography SET recipe='unrelated' WHERE article_id=${wrongRecipe}`;
  const scheduled = await item("scheduled", "阿根廷尚未出刊", ["阿根廷"], ["AR"]);
  await sql`UPDATE publications SET selected=true,visible_after=now()+interval '1 day' WHERE article_id=${scheduled}`;
  await sql`INSERT INTO topics(slug,name,grp,tags,definition,position) VALUES(${source},'Synthetic empty topic','field','{}','No matching tags',999)`;
  await seedTopics();
  assert.deepEqual((await loadTopicPage(source, 1))!.items, [], "an empty topic must not turn into an unfiltered news list");
  assert.equal((await topicPageCounts()).find((row) => row.slug === source)!.total, 0);
  assert.deepEqual(
    (await loadTopicPage("argentina", 1))!.items.filter((row) => row.id.startsWith(source)).map((row) => row.id),
    [actual],
  );
  assert.equal((await topicPageCounts()).find((row) => row.slug === "argentina")!.total, 1);
  assert.deepEqual(
    (await loadTopicPage("chile", 1))!.items.filter((row) => row.id.startsWith(source)).map((row) => row.id),
    [actual],
  );
  const query = { channel: "all", category: null, tag: null, topicTags: ["阿根廷"] } as never;
  assert.deepEqual(
    (await loadPool(query)).items.filter((row) => row.id.startsWith(source)).map((row) => row.id),
    [actual],
  );
  const search = await loadPool({ channel: "all", category: null, tag: null, q: "阿根廷" } as never);
  assert.ok(search.items.some((row) => row.id === background));
  assert.ok(
    search.items.some((row) => row.id === unknown),
    "full-text lookup remains available for mentions without location proof",
  );
  await sql`UPDATE publication.news_geography SET recipe=${compatibleGeographyRecipes()[1]!} WHERE article_id=${actual}`;
  await seedTopics(); // Recompute counts, rather than assert against the previous one-minute cache.
  assert.equal((await topicPageCounts()).find((row) => row.slug === "argentina")!.total, 1, "compatible valid evidence stays counted after the alias upgrade");
  assert.deepEqual(
    (await loadTopicPage("argentina", 1))!.items.filter((row) => row.id.startsWith(source)).map((row) => row.id),
    [actual],
  );
});
