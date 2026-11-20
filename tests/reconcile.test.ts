import "./setup.ts";
// The daily reconciliation counts what readers got yesterday, which sources brought nothing and why, whether
// translations keep up and how long the model accounts last; it is kept per day and sent once, also after a failed send.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { type Reconciliation, reconcile, reconcileLines, sendReconcile } from "@amp/backend/operations/reconcile";
import { seedRows } from "../packages/backend/src/pipeline/entities/seed.ts";
import { seedEntityLibrary } from "../packages/backend/src/pipeline/entities/store.ts";
import { mockFeishuAlerts } from "./feishu-alert-fixture.ts";

after(async () => {
  await stopBoss();
  await closeDb();
});

// "Now" is 10:00 Beijing on 19 November 2026; yesterday is the Beijing day 18 November.
const NOW = Date.parse("2026-11-19T02:00:00Z");
const YESTERDAY = new Date("2026-11-18T04:00:00Z");
const TODAY = new Date("2026-11-19T01:30:00Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000);

async function source(id: string, fields: { health?: string; created?: Date } = {}) {
  await sql`INSERT INTO sources(id,name,kind,config,lane,enabled,participation_mode,health,site_fulltext,created_at)
    VALUES(${id},${id},'rss','{}','news',true,'editorial',${fields.health ?? "ok"},true,${fields.created ?? new Date("2026-10-01Z")})`;
}

interface ReportFields {
  language?: string;
  /** The article's current revision; a translation is of revision 1 unless said otherwise. */
  revision?: number;
  public?: boolean;
  /** When the report was first shown as selected; not necessarily the day it became public. */
  selectedAt?: Date;
  bodyMode?: "full" | "summary";
  /** A translations row as the translator leaves it: finished, claimed before any text exists, or supplied by the source. */
  translation?: "finished" | "claimed" | "source";
}
async function report(id: string, sourceId: string, at: Date, fields: ReportFields = {}) {
  const url = `https://fixture.invalid/${id}`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,language,revision,body_text,raw)
    VALUES(${id},${sourceId},${id},${url},${id},${at},${at},${fields.language ?? "zh"},${fields.revision ?? 1},'正文','{}')`;
  if (fields.public === false) return;
  await sql`INSERT INTO publications(article_id,title,source_id,channel,url,discovered_at,timeline_at,sort_at,visibility,eligible,selected,
      body_mode,first_publication_observed,first_public_at,first_selected_at)
    VALUES(${id},${id},${sourceId},'news',${url},${at},${at},${at},'public',true,${!!fields.selectedAt},
      ${fields.bodyMode ?? "full"},true,${at},${fields.selectedAt ?? null})`;
  if (fields.translation === "claimed") await sql`INSERT INTO translations(article_id,lang,revision,complete,origin) VALUES(${id},'zh',1,false,'model')`;
  else if (fields.translation)
    await sql`INSERT INTO translations(article_id,lang,revision,title,body_html,body_text,complete,origin)
      VALUES(${id},'zh',1,'标题','<p>译文</p>','译文',true,${fields.translation === "source" ? "source" : "model"})`;
}

const storedDays = async () => {
  const [row] = await sql<{ value: Array<{ day: string; sent: boolean }> }[]>`SELECT value FROM settings WHERE key='reconcile.daily'`;
  return (row?.value ?? []).map((entry) => ({ day: entry.day, sent: entry.sent }));
};

test("yesterday's flow, the silent sources by reason, translation lag and account days", async () => {
  await sql`UPDATE sources SET enabled=false`;
  await source("reconcile-busy");
  await source("reconcile-failing", { health: "failing" });
  // Four output days ten days apart, the last one ten days ago: a known rhythm that is not exceeded.
  await source("reconcile-steady");
  for (const days of [40, 30, 20, 10]) await report(`reconcile-steady-${days}`, "reconcile-steady", daysAgo(days), { public: false });
  // Never brought anything, and too new to have a history: in both cases nothing says the origin simply had no news.
  await source("reconcile-unknown");
  await source("reconcile-new", { created: daysAgo(2) });

  await report("reconcile-a", "reconcile-busy", YESTERDAY, { language: "zh-CN", selectedAt: YESTERDAY });
  // Public two days ago and selected yesterday: counted as newly selected, not as newly public.
  await report("reconcile-late", "reconcile-busy", daysAgo(2), { selectedAt: YESTERDAY });
  await report("reconcile-b", "reconcile-busy", YESTERDAY, { language: "en", translation: "finished" });
  await report("reconcile-c", "reconcile-busy", YESTERDAY, { language: "es" });
  // Claimed by the translator and never finished: readers have no Chinese text.
  await report("reconcile-e", "reconcile-busy", YESTERDAY, { language: "en", translation: "claimed" });
  // Translated, then the article was revised: the translation is of the older text.
  await report("reconcile-f", "reconcile-busy", YESTERDAY, { language: "en-US", revision: 2, translation: "finished" });
  // A Chinese text supplied by the source itself is not redone when the article is revised.
  await report("reconcile-g", "reconcile-busy", YESTERDAY, { language: "en", revision: 2, translation: "source" });
  // Shown as a summary only: the translator never takes it, so it is not due.
  await report("reconcile-h", "reconcile-busy", YESTERDAY, { language: "en", bodyMode: "summary" });
  await report("reconcile-d", "reconcile-busy", YESTERDAY, { public: false });
  await report("reconcile-today", "reconcile-busy", TODAY);
  // Scored and relevant, yet not public.
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,score,selected,output,created_at)
    VALUES('reconcile-d',1,'model','pass',71,false,'{}',${YESTERDAY})`;
  // One account read just now, one whose last reading is from 06:00 Beijing the day before.
  const fresh = new Date(NOW).toISOString();
  await sql`INSERT INTO settings(key,value) VALUES('models.balance',${sql.json({ deepseek: { yuan: 90, at: fresh }, qwen: { yuan: 40, at: "2026-11-17T22:00:00.000Z" } })})
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
  await sql`INSERT INTO ai.usage_sums(kind,key,context,settled_micros) VALUES('day','2026-11-18','{}',30000000),('day','2026-11-17','{}',30000000)`;

  const r = await reconcile(NOW);
  assert.equal(r.day, "2026-11-18");
  assert.deepEqual(r.flow, { collected: 8, public: 7, selected: 2, scoredNotPublic: 1 });
  assert.deepEqual(r.sources, { enabled: 5, withNew: 1, silent: { failing: 1, waiting: 0, unstable: 0, overdue: 0, unknown: 2, quiet: 1 } });
  assert.deepEqual(r.translation, { due: 5, missing: 3 });
  assert.deepEqual(r.balance, [
    { service: "deepseek", yuan: 90, at: fresh, stale: false, days: 3 },
    { service: "qwen", yuan: 40, at: "2026-11-17T22:00:00.000Z", stale: true, days: null },
  ]);

  assert.deepEqual(reconcileLines(r), [
    "读者昨天看到：新公开 7 条，新进精选 2 条；当天新收到 8 条（不含历史补录）",
    "信源：开着 5 个，近 7 天有新内容的 1 个，没有新内容的 4 个（连续抓取失败 1；历史太短，还看不出规律 2；来源本身没更新 1）",
    "评过分、合格但没有公开：1 条",
    "译文：该有中文译文的外文稿 5 条，还没有的 3 条（60%）",
    "模型余额 deepseek：90 元，按近 7 天的用量约够 3 天",
    "模型余额 qwen：最新余额没读到，上次读到的是 40 元（11月18日 06:00），这个读数已过期",
  ]);
});

test("a balance that lasts less than a day is not worded as zero days", () => {
  const r: Reconciliation = {
    day: "2026-11-18",
    sources: { enabled: 0, withNew: 0, silent: { failing: 0, waiting: 0, unstable: 0, overdue: 0, unknown: 0, quiet: 0 } },
    flow: { collected: 0, public: 0, selected: 0, scoredNotPublic: 0 },
    translation: { due: 0, missing: 0 },
    balance: [
      { service: "deepseek", yuan: 12, at: new Date(NOW).toISOString(), stale: false, days: 0 },
      { service: "qwen", yuan: 5, at: new Date(NOW).toISOString(), stale: false, days: null },
    ],
  };
  assert.deepEqual(reconcileLines(r).slice(-2), ["模型余额 deepseek：12 元，按近 7 天的用量不到 1 天就会用完", "模型余额 qwen：5 元"]);
});

test("a failed send keeps the day's numbers unsent, the next run sends them, and a sent day is not sent twice", async (t) => {
  const feishu = mockFeishuAlerts(t);
  feishu.fail = true;
  await assert.rejects(sendReconcile(NOW), /synthetic delivery outcome unknown/);
  assert.deepEqual(await storedDays(), [{ day: "2026-11-18", sent: false }]);
  assert.deepEqual(feishu.messages, []);

  feishu.fail = false;
  assert.deepEqual(await sendReconcile(NOW + 60_000), { day: "2026-11-18", sent: true });
  assert.deepEqual(await storedDays(), [{ day: "2026-11-18", sent: true }]);
  assert.equal(feishu.messages.length, 1);
  assert.match(feishu.messages[0]!, /📊 每日对账 · 11月18日\n读者昨天看到：新公开 \d+ 条/);

  assert.deepEqual(await sendReconcile(NOW + 3600_000), { day: "2026-11-18", sent: false });
  assert.equal(feishu.messages.length, 1);
});

test("with sending off the day stays unsent and goes out once sending is on; the last thirty days are kept", async (t) => {
  // Twenty-nine older days and 18 November make thirty; the next day pushes the oldest out.
  // The history is written here in full, so this test does not lean on what an earlier test left behind.
  const older = Array.from({ length: 29 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, "0")}`, sent: true }));
  const seeded = [...older, { day: "2026-11-18", sent: true }];
  await sql`INSERT INTO settings(key, value, updated_by) VALUES('reconcile.daily', ${sql.json(seeded as never)}, 'test')
    ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`;

  const before = process.env.FEISHU_INTERNAL_ENABLED;
  process.env.FEISHU_INTERNAL_ENABLED = "false";
  t.after(() => {
    if (before === undefined) delete process.env.FEISHU_INTERNAL_ENABLED;
    else process.env.FEISHU_INTERNAL_ENABLED = before;
  });
  const tomorrow = NOW + 86_400_000;
  assert.deepEqual(await sendReconcile(tomorrow), { day: "2026-11-19", sent: false });
  assert.deepEqual((await storedDays()).at(-1), { day: "2026-11-19", sent: false });

  const feishu = mockFeishuAlerts(t);
  assert.deepEqual(await sendReconcile(tomorrow + 3600_000), { day: "2026-11-19", sent: true });
  assert.equal(feishu.messages.length, 1);
  const days = await storedDays();
  assert.equal(days.length, 30);
  assert.deepEqual(
    [days[0], ...days.slice(-2)],
    [
      { day: "2026-10-02", sent: true },
      { day: "2026-11-18", sent: true },
      { day: "2026-11-19", sent: true },
    ],
  );
});

test("the per-article shadow adds three count lines before the balances, and none on a day nothing was checked", () => {
  const at = new Date(NOW).toISOString();
  const base: Reconciliation = {
    day: "2026-11-18",
    sources: { enabled: 0, withNew: 0, silent: { failing: 0, waiting: 0, unstable: 0, overdue: 0, unknown: 0, quiet: 0 } },
    flow: { collected: 0, public: 0, selected: 0, scoredNotPublic: 0 },
    translation: { due: 0, missing: 0 },
    balance: [{ service: "deepseek", yuan: 12, at, stale: false, days: 3 }],
  };
  const checks = { checked: 120, linked: 78, library: 38, softFlags: 15, softArticles: 12, datelines: { release_wire: 30, news_agency: 10, unmarked: 5 } };
  assert.deepEqual(reconcileLines({ ...base, articleChecks: checks }).slice(-4), [
    "单篇核对（只记录，读者看不到）：昨天判断的稿件核对了 120 条，认出至少一家公司的 78 条（65%）",
    "数字核对（只标记，不改稿）：程序拿不准的数字或日期 15 处（12 条）",
    "电头：新闻稿 30 条，通讯社 10 条，只写地点和日期 5 条",
    "模型余额 deepseek：12 元，按近 7 天的用量约够 3 天",
  ]);
  assert.equal(
    reconcileLines({ ...base, articleChecks: { ...checks, linked: 0, library: 0 } }).at(-4),
    "单篇核对（只记录，读者看不到）：昨天判断的稿件核对了 120 条，认出至少一家公司的 0 条（0%）；公司库还没导入，认出的公司没有存下",
  );
  const plain = reconcileLines(base);
  for (const articleChecks of [undefined, { ...checks, checked: 0 }]) assert.deepEqual(reconcileLines({ ...base, articleChecks }), plain);
});

test("yesterday's per-article checks are read through their owners: the latest check of each article judged that day", async () => {
  await seedEntityLibrary(seedRows(), "test", { apply: true });
  const check = async (articleId: string, judgedAt: Date, checkedAt: Date, figures: unknown[], geography: unknown[]) => {
    await report(articleId, "reconcile-busy", judgedAt, { public: false, revision: 2 });
    const [judged] = await sql<{ id: number }[]>`INSERT INTO analyses (article_id, input_revision, origin, relevance, selected, output, created_at)
      VALUES (${articleId}, 2, 'model', 'pass', false, '{"scores": []}', ${judgedAt}) RETURNING id`;
    await sql`INSERT INTO enrichment.analysis_checks (analysis_id, article_id, input_revision, lane, recipe, mode, verdict, figures, geography, created_at)
      VALUES (${judged!.id}, ${articleId}, 2, 'news', 'test', 'observed', 'ok', ${sql.json(figures as never)}, ${sql.json(geography as never)}, ${checkedAt})`;
  };
  await check("reconcile-check-a", YESTERDAY, YESTERDAY, [{ class: "soft" }, { class: "hard" }], [{ kind: "dateline", dateline: "release_wire" }]);
  // Judged yesterday, checked this morning before the reconciliation ran.
  await check("reconcile-check-b", YESTERDAY, TODAY, [{ class: "hard" }], []);
  await check("reconcile-check-c", TODAY, TODAY, [{ class: "soft" }], [{ kind: "dateline", dateline: "news_agency" }]);
  // Judged ten days ago and checked yesterday by the back-fill: not yesterday's.
  await check("reconcile-check-d", daysAgo(10), YESTERDAY, [{ class: "soft" }], [{ kind: "dateline", dateline: "unmarked" }]);
  await sql`INSERT INTO entities.article_links (article_id, input_revision, entity_id, lane, role, method, alias, segment, linker_version)
    VALUES ('reconcile-check-a', 2, 'bhp', 'news', 'mention', 'text', 'BHP', 'body', 'test')`;
  try {
    const r = await reconcile(NOW);
    assert.deepEqual(r.articleChecks, {
      checked: 2,
      linked: 1,
      library: seedRows().entities.length,
      softFlags: 1,
      softArticles: 1,
      datelines: { release_wire: 1, news_agency: 0, unmarked: 0 },
    });
    assert.ok(reconcileLines(r).includes("数字核对（只标记，不改稿）：程序拿不准的数字或日期 1 处（1 条）"), "the hard findings stay out of the message");
  } finally {
    await sql`DELETE FROM entities.article_links WHERE article_id LIKE 'reconcile-check-%'`;
    await sql`DELETE FROM enrichment.analysis_checks WHERE article_id LIKE 'reconcile-check-%'`;
    await sql`DELETE FROM articles WHERE id LIKE 'reconcile-check-%'`;
  }
});
