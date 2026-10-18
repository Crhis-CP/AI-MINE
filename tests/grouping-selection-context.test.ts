import { tag } from "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, sql } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { completeMaterialGrouping } from "../packages/backend/src/content/grouping.ts";
import { readGroupingSelectionSnapshot } from "@amp/backend/publication/publish";

after(closeDb);
test("only already-visible current confirmed picks count as reader coverage", async () => {
  const sourceId = `reading-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind) VALUES(${sourceId},'合成矿业发布方','rss')`;
  const ids: string[] = [];
  for (let n = 0; n < 4; n++) {
    const { articleId } = await upsertMaterial({
      sourceId,
      url: `https://example.com/${sourceId}/${n}`,
      title: "铜矿项目更新",
      bodyText: `原文${n}`,
      via: "fetch",
    });
    ids.push(articleId);
    await sql`INSERT INTO publications(article_id,source_id,title,url,channel,visibility,eligible,selected,published_at,discovered_at,timeline_at,selected_ready_at,visible_after,sort_at)
   VALUES(${articleId},${sourceId},'铜矿项目更新',${`https://example.com/${sourceId}/${n}`},'news','public',true,true,now(),now(),now(),now(),now()-interval '1 minute',now())`;
  }
  assert.equal((await readGroupingSelectionSnapshot("new-query", [])).length, 0, "old selected flags are not confirmation");
  for (const id of ids) await completeMaterialGrouping(id, 1, { addsValue: true, reason: "合成已确认材料" }, null);
  await sql`UPDATE publications SET visible_after=now()+interval '1 hour' WHERE article_id=${ids[1]}`;
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${ids[2]}`;
  await upsertMaterial({ sourceId, url: `https://example.com/${sourceId}/3`, title: "铜矿项目更新", bodyText: "修订后的新原文", via: "fetch" });
  const current = await readGroupingSelectionSnapshot("new-query", []);
  assert.deepEqual(
    current.map((r) => r.article_id),
    [ids[0]],
  );
  assert.equal(current[0].material_revision, 1);
  assert.equal(current[0].source_name, "合成矿业发布方");
  assert.equal((await readGroupingSelectionSnapshot(ids[0], [])).length, 0, "query is never its own already-read evidence");
  await sql`UPDATE publications SET discovered_at=now()-interval '45 days' WHERE article_id=${ids[0]}`;
  assert.deepEqual(
    (await readGroupingSelectionSnapshot("new-query", [])).map((row) => row.article_id),
    [ids[0]],
    "reader coverage lasts beyond identity recall",
  );
  await sql`UPDATE publications SET discovered_at=now()-interval '61 days' WHERE article_id=${ids[0]}`;
  assert.equal((await readGroupingSelectionSnapshot("new-query", [])).length, 0);
});
