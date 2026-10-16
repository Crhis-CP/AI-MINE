import { tag } from "./setup.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { publishArticle } from "@amp/backend/publication/publish";
import { computeHotRanking } from "@amp/backend/events/hot";
import { participantKey } from "@amp/backend/events/group";
import { grantDateFixture } from "./source-date-fixture.ts";
import { confirmGroupingFixture } from "./grouping-fixture.ts";
import { scopeVersion, scopeOutput, scopeReceipt } from "./scope-fixture.ts";
import { stopBoss } from "@amp/backend/jobs/queue";

after(async () => {
  await stopBoss();
  await closeDb();
});

test("known company aliases share one participant, unknown ownership is not guessed", () => {
  assert.equal(participantKey({ id: "a", owner_entity_id: "zijin" }), participantKey({ id: "b", owner_entity_id: "Zijin Mining" }));
  assert.equal(participantKey({ id: "a", owner_entity_id: "自然资源部" }), participantKey({ id: "b", owner_entity_id: "自然资源部" }));
  assert.notEqual(participantKey({ id: "a" }), participantKey({ id: "b" }));
  assert.equal(participantKey({ id: "a", owner_entity_id: " " }), "source:a");
});

test("multiple entry points of one owner count once, and owner corrections repair stored heat automatically", async () => {
  const now = new Date();
  const [story] = await sql`INSERT INTO stories(public_id,title) VALUES(${crypto.randomUUID()},'合成项目发布') RETURNING id`;
  const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${`f${tag()}`},${story!.id},'合成项目发布') RETURNING id`;
  const ids: string[] = [];
  for (const owner of ["zijin", "Zijin Mining", null]) {
    const id = `heat-participant-${tag()}`,
      url = `https://example.com/${id}`;
    ids.push(id);
    await sql`INSERT INTO sources(id,name,kind,tier,owner_entity_id,last_ok_at) VALUES(${id},${id},'rss','T2',${owner},${now})`;
    await grantDateFixture(id, [url]);
    const { articleId } = await upsertMaterial({
      sourceId: id,
      url,
      title: "合成矿企发布新项目",
      bodyText: "合成矿企披露新铜矿建设项目的工期和产能。",
      language: "zh",
      via: "fetch",
      publishedAt: new Date(now.getTime() - 60000),
      discoveredAt: new Date(now.getTime() - 60000),
    });
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,selected,prompt_version,receipt_ids,output)
      VALUES(${articleId},1,'rule','pass','company_project','合成矿企发布新项目','合成的新项目披露',false,${scopeVersion},${[await scopeReceipt(articleId)]},${sql.json(scopeOutput)})`;
    await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${fact!.id},${articleId},'report',1)`;
    await confirmGroupingFixture(articleId);
    await publishArticle(articleId);
    await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at) VALUES(${story!.id},${articleId},${`source:${id}`},${id},'editorial',${new Date(now.getTime() - 60000)})`;
  }
  const entries = async () => {
    const ranked = await computeHotRanking(now);
    const [row] = await sql<
      { entries: { storyId: number; participantCount: number; reportCount: number }[] }[]
    >`SELECT entries FROM hot_rankings WHERE id=${ranked.id}`;
    return row!.entries;
  };
  const first = (await entries()).find((r) => r.storyId === Number(story!.id));
  assert.equal(first?.participantCount, 2);
  assert.equal(first?.reportCount, 3);
  const clocks = await sql`SELECT source_id,observed_at FROM story_signals WHERE story_id=${story!.id} ORDER BY source_id`;
  await sql`UPDATE sources SET owner_entity_id='紫金矿业' WHERE id=${ids[2]!}`;
  assert.equal(
    (await entries()).some((r) => r.storyId === Number(story!.id)),
    false,
    "one owner does not qualify as a multi-party hot event",
  );
  await sql`UPDATE sources SET owner_entity_id='independent-newsroom' WHERE id=${ids[2]!}`;
  assert.equal((await entries()).find((r) => r.storyId === Number(story!.id))?.participantCount, 2);
  assert.deepEqual(
    await sql`SELECT source_id,observed_at FROM story_signals WHERE story_id=${story!.id} ORDER BY source_id`,
    clocks,
    "identity repair does not fake fresh attention",
  );
});
