import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { buildApp } from "./site-app.ts";

const app = await buildApp();
after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});

test("about statistics refresh enabled-news facts, match current headlines/reports and fail without stale fallback", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const a = `stats-a-${tag()}`,
    b = `stats-b-${tag()}`,
    policy = `stats-policy-${tag()}`,
    item = `s${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,lane,enabled) VALUES(${a},'当前资讯来源','rss','news',true),
    (${b},'待启用资讯来源','json_list','news',false),(${policy},'暂停业务线的法规来源','web_list','policy',true)`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at) VALUES(${item},${a},${item},'https://source.invalid/stats','合成公开动态',now(),now())`;
  await sql`INSERT INTO publications(article_id,title,source_id,channel,url,discovered_at,timeline_at,sort_at,visible_after,visibility,eligible,selected,selection_candidate,seat)
    VALUES(${item},'合成精选',${a},'news','https://source.invalid/stats',now(),now(),now(),now()-interval '1 minute','public',true,true,true,true)`;
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at) VALUES
    ('daily','2026-10-01',now()-interval '1 day',now(),'{}',now()),('daily','2026-10-02',now()-interval '1 day',now(),'{}',now()),
    ('monthly','2026-09',now()-interval '1 month',now(),'{}',now())`;
  await sql`INSERT INTO publication.withdrawal_targets(withdrawal_id,lane,target_type,target_key) VALUES(999001,'news','report','daily:2026-10-01')`;
  const read = () => app.inject("/api/site/stats");
  const first = await read();
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["cache-control"], "public, max-age=0, must-revalidate");
  const initial = first.json();
  assert.equal(initial.sources, 1);
  assert.deepEqual(initial.sourceKinds, { rss: 1 });
  assert.deepEqual(
    initial.sampleSources.map((s: { name: string }) => s.name),
    ["当前资讯来源"],
  );
  assert.equal(initial.dailies, 1);
  assert.equal(initial.selected, 1);
  assert.equal(initial.latest[0].id, item);
  await sql`UPDATE sources SET enabled=true WHERE id=${b}`;
  assert.equal((await read()).json().sources, 1, "one short, bounded snapshot can still be fresh");
  t.mock.timers.tick(30_001);
  const next = await read();
  assert.equal(next.json().sources, 2);
  assert.deepEqual(next.json().sourceKinds, { rss: 1, json_list: 1 });
  assert.equal(next.json().sampleSources.length, 2);
  assert.notEqual(next.headers.etag, first.headers.etag);
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${item}`;
  const removed = (await read()).json();
  assert.equal(removed.items, 0);
  assert.equal(removed.selected, 0);
  assert.deepEqual(removed.latest, [], "the short count cache cannot keep a withdrawn headline");
  await sql`UPDATE sources SET enabled=false WHERE id=${a}`;
  t.mock.timers.tick(30_001);
  assert.equal((await read()).json().sources, 1);
  t.mock.timers.tick(30_001);
  const broken = t.mock.method(sql, "begin", async () => {
    throw new Error("Synthetic statistics query failure");
  });
  try {
    const failed = await read();
    assert.equal(failed.statusCode, 503);
    assert.match(String(failed.headers["cache-control"]), /no-store/);
    assert.ok(!("sources" in failed.json()), "an expired snapshot is not presented as current or as zero");
  } finally {
    broken.mock.restore();
  }
  const recovered = await read();
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.json().sources, 1);
  assert.deepEqual(
    recovered.json().sampleSources.map((s: { name: string }) => s.name),
    ["待启用资讯来源"],
  );
});
