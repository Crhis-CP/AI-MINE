import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { selectedDeliveryCandidate } from "@amp/backend/publication/detail";
import { geographyRecipe } from "../packages/backend/src/editorial/geography.ts";
after(closeDb);

async function fixture() {
  const id = `delivery-candidate-${tag()}`,
    at = new Date(Date.now() + 60_000);
  await sql`INSERT INTO sources(id,name,kind,lane,participation_mode) VALUES(${id},'合成来源','rss','news','editorial')`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,body_text,revision,discovered_at,timeline_at) VALUES(${id},${id},${id},'https://example.invalid/item','原始合成标题','不得进入投递接口的原文',1,now(),now())`;
  await sql`INSERT INTO publications(article_id,source_id,channel,title,summary,url,eligible,selected,selection_candidate,seat,visible_after,timeline_at,discovered_at,sort_at)
    VALUES(${id},${id},'news','合成中文标题','合成导读','https://example.invalid/item',true,true,true,false,${at},now(),now(),now())`;
  return { id, at };
}

test("current qualified non-seat candidates retain release facts without exposing raw material", async () => {
  const { id, at } = await fixture();
  const candidate = await sql.begin((tx) => selectedDeliveryCandidate(id, tx));
  assert.ok(candidate);
  assert.equal(candidate.seat, false);
  assert.equal(candidate.source_name, "合成来源");
  assert.equal(candidate.visible_after.toISOString(), at.toISOString());
  assert.deepEqual(candidate.jurisdictions, []);
  assert.doesNotMatch(JSON.stringify(candidate), /不得进入|body_text|内部备注/);
  const invalid: Array<
    Partial<{ eligible: boolean; selected: boolean; candidate: boolean; visibility: string; withdrawn: boolean; mode: string; lane: string; release: boolean }>
  > = [
    { eligible: false },
    { selected: false },
    { candidate: false },
    { visibility: "withdrawn" },
    { withdrawn: true },
    { mode: "hot_signal" },
    { lane: "policy" },
    { release: false },
  ];
  for (const change of invalid) {
    await sql`UPDATE publications SET eligible=${change.eligible ?? true},selected=${change.selected ?? true},selection_candidate=${change.candidate ?? true},
      visibility=${change.visibility ?? "public"},operator_withdrawn=${change.withdrawn ?? false},visible_after=${change.release === false ? null : at} WHERE article_id=${id}`;
    await sql`UPDATE sources SET participation_mode=${change.mode ?? "editorial"},lane=${change.lane ?? "news"} WHERE id=${id}`;
    assert.equal(await selectedDeliveryCandidate(id), null, JSON.stringify(change));
  }
});

test("country evidence follows the current material revision and accepted recipe", async () => {
  const { id } = await fixture();
  await sql`INSERT INTO publication.news_geography(article_id,article_revision,analysis_id,recipe,state,jurisdictions)
    VALUES(${id},1,NULL,${geographyRecipe()},'identified',ARRAY['AR','PE'])`;
  assert.deepEqual((await selectedDeliveryCandidate(id))!.jurisdictions, ["AR", "PE"]);
  await sql`UPDATE articles SET revision=2 WHERE id=${id}`;
  assert.deepEqual((await selectedDeliveryCandidate(id))!.jurisdictions, []);
  await sql`UPDATE publication.news_geography SET article_revision=2,recipe='unknown' WHERE article_id=${id}`;
  assert.deepEqual((await selectedDeliveryCandidate(id))!.jurisdictions, []);
  await sql`UPDATE publication.news_geography SET recipe=${geographyRecipe()} WHERE article_id=${id}`;
  assert.deepEqual((await selectedDeliveryCandidate(id))!.jurisdictions, ["AR", "PE"]);
});
