import "./setup.ts";
// The daily reconciliation counts what readers got yesterday, which sources brought nothing and why, whether
// translations keep up and how long the model accounts last; it is kept per day and sent once.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { reconcile, reconcileLines, sendReconcile } from "@amp/backend/operations/reconcile";

after(async () => {
  await stopBoss();
  await closeDb();
});

// "Now" is 10:00 Beijing on 19 November 2026; yesterday is the Beijing day 18 November.
const NOW = Date.parse("2026-11-19T02:00:00Z");
const YESTERDAY = new Date("2026-11-18T04:00:00Z");
const TODAY = new Date("2026-11-19T01:30:00Z");

async function source(id: string, fields: { health?: string; site_fulltext?: boolean } = {}) {
  await sql`INSERT INTO sources(id,name,kind,config,lane,enabled,participation_mode,health,site_fulltext,created_at)
    VALUES(${id},${id},'rss','{}','news',true,'editorial',${fields.health ?? "ok"},${fields.site_fulltext ?? true},'2026-10-01Z')`;
}
async function report(id: string, sourceId: string, at: Date, fields: { language?: string; public?: boolean; selected?: boolean; translated?: boolean } = {}) {
  const url = `https://fixture.invalid/${id}`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,language,body_text,raw)
    VALUES(${id},${sourceId},${id},${url},${id},${at},${at},${fields.language ?? "zh"},'正文','{}')`;
  if (fields.public === false) return;
  await sql`INSERT INTO publications(article_id,title,source_id,channel,url,discovered_at,timeline_at,sort_at,visibility,eligible,selected,
      first_publication_observed,first_public_at,first_selected_at)
    VALUES(${id},${id},${sourceId},'news',${url},${at},${at},${at},'public',true,${fields.selected ?? false},true,${at},${fields.selected ? at : null})`;
  if (fields.translated) await sql`INSERT INTO translations(article_id,lang,revision,title,body_text) VALUES(${id},'zh',1,'标题','译文')`;
}

test("yesterday's flow, the silent sources by reason, translation lag and account days", async () => {
  await sql`UPDATE sources SET enabled=false`;
  await source("reconcile-busy");
  await source("reconcile-failing", { health: "failing" });
  await source("reconcile-quiet");
  await report("reconcile-a", "reconcile-busy", YESTERDAY, { selected: true });
  await report("reconcile-b", "reconcile-busy", YESTERDAY, { language: "en", translated: true });
  await report("reconcile-c", "reconcile-busy", YESTERDAY, { language: "es" });
  await report("reconcile-d", "reconcile-busy", YESTERDAY, { public: false });
  await report("reconcile-today", "reconcile-busy", TODAY);
  // Scored and relevant, yet not public.
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,score,selected,output,created_at)
    VALUES('reconcile-d',1,'model','pass',71,false,'{}',${YESTERDAY})`;
  await sql`INSERT INTO settings(key,value) VALUES('models.balance',${sql.json({ deepseek: { yuan: 90, at: new Date(NOW).toISOString() } })})
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
  await sql`INSERT INTO ai.usage_sums(kind,key,context,settled_micros) VALUES('day','2026-11-18','{}',30000000),('day','2026-11-17','{}',30000000)`;

  const r = await reconcile(NOW);
  assert.equal(r.day, "2026-11-18");
  assert.deepEqual(r.flow, { collected: 4, public: 3, selected: 1, scoredNotPublic: 1 });
  assert.deepEqual(r.sources, { enabled: 3, withNew: 1, silent: { failing: 1, waiting: 0, unstable: 0, overdue: 0, quiet: 1 } });
  assert.deepEqual(r.translation, { due: 2, missing: 1 });
  assert.deepEqual(r.balance, [{ service: "deepseek", yuan: 90, days: 3 }]);

  assert.deepEqual(reconcileLines(r), [
    "读者昨天看到：新公开 3 条，其中进精选 1 条（当天收到 4 条）",
    "信源：开着 3 个，近 7 天有新内容的 1 个，没有新内容的 2 个（连续抓取失败 1、来源本身没更新 1）",
    "评过分、合格但没有公开：1 条",
    "译文：该有中文译文的外文稿 2 条，还没有的 1 条（50%）",
    "模型余额 deepseek：90 元，按近 7 天的用量约够 3 天",
  ]);
});

test("a day is recorded once; the last thirty days are kept for comparison", async () => {
  const first = await sendReconcile(NOW);
  assert.equal(first.day, "2026-11-18");
  const again = await sendReconcile(NOW + 3600_000);
  assert.deepEqual(again, { day: "2026-11-18", sent: false });
  await sendReconcile(NOW + 86_400_000);
  const [row] = await sql<{ value: Array<{ day: string }> }[]>`SELECT value FROM settings WHERE key='reconcile.daily'`;
  assert.deepEqual(
    row!.value.map((entry) => entry.day),
    ["2026-11-18", "2026-11-19"],
  );
});
