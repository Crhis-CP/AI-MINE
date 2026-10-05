// Collection picks up where it stopped: a WeChat body that failed for a passing reason is fetched again
// on the next check.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@amp/backend/config";
import { closeDb, dbOf } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { checkMpAccount } from "@amp/backend/sources/mp";
import { grantDateFixture } from "./source-date-fixture.ts";

const sql = dbOf("acquisition");

const T = tag();
const MP_SOURCE = `test-mp-${T}`;

// Dajiala: one new post whose body answers 503 the first time.
const MP_URL = `https://mp.weixin.qq.com/s/test-${T}`;
let bodyCalls = 0;
let historyOverride: Array<Record<string, string | number>> | null = null;
const dajiala = await stub((_hit, req) => {
  if (req.url.startsWith("/fbmain/monitor/v3/post_history")) {
    return {
      code: 0,
      data: historyOverride ?? [
        { position: 1, url: MP_URL, title: `公众号文章 ${T}`, post_time: String(Math.floor(Date.now() / 1000) - 3600), digest: "摘要", sn: `sn-${T}` },
      ],
      remain_money: 100,
    };
  }
  bodyCalls += 1;
  if (bodyCalls === 1) return new Reply(503, { error: "busy" });
  return { code: 0, title: `公众号文章 ${T}`, content: `<p>正文第一段 ${T}</p><p>正文第二段</p>`, author: "作者", desc: "描述" };
});

process.env.DAJIALA_BASE_URL = dajiala.url;
process.env.DAJIALA_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

let savedBudgets: Array<{ service: string; per_minute: number; per_hour: number; per_day: number }> = [];
before(async () => {
  savedBudgets = await sql`SELECT service, per_minute, per_hour, per_day FROM budgets WHERE service = 'dajiala'`;
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service = 'dajiala'`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
            VALUES (${MP_SOURCE}, 'Test mp', 'mp_account', ${sql.json({ ghid: `gh_${T}` })}, 'T1', 'editorial',
                    ${sql.json({ lastCheckedAt: new Date().toISOString() })}, '2100-01-01')`;
  await grantDateFixture(MP_SOURCE, ["https://mp.weixin.qq.com"]);
});
after(async () => {
  for (const b of savedBudgets)
    await sql`UPDATE budgets SET per_minute = ${b.per_minute}, per_hour = ${b.per_hour}, per_day = ${b.per_day} WHERE service = ${b.service}`;
  await dajiala.close();
  await stopBoss();
  await closeDb();
});

test("a WeChat body that failed for a passing reason is fetched on the next check and analysed again", async () => {
  const article = async () =>
    (
      await sql<{ body_status: string; revision: number; retry: { attempts: number } | null }[]>`
      SELECT body_status, revision, raw->'dajiala'->'bodyRetry' AS retry FROM articles WHERE source_id = ${MP_SOURCE}`
    )[0]!;

  const first = await checkMpAccount(MP_SOURCE, "manual");
  assert.equal(first.status, "ok");
  assert.deepEqual({ ...(await article()) }, { body_status: "none", revision: 1, retry: { attempts: 1, error: "dajiala HTTP 503" } });

  const second = await checkMpAccount(MP_SOURCE, "manual");
  assert.equal(second.status, "ok");
  assert.equal(bodyCalls, 2, "the body is asked for once more");
  const now = await article();
  assert.deepEqual([now.body_status, now.revision, now.retry], ["ok", 2, null], "the body arrives as a new revision and retrying stops");
  const [queued] = await sql<{ processing_state: string }[]>`SELECT processing_state FROM articles WHERE source_id = ${MP_SOURCE}`;
  assert.equal(queued!.processing_state, "new", "the article goes back to analysis");

  await checkMpAccount(MP_SOURCE, "manual");
  assert.equal(bodyCalls, 2, "a body already stored is not bought again");
  const [date] = await sql`SELECT a.published_at, a.source_date_state, o.observation, o.result FROM articles a
    JOIN content.source_date_observations o ON o.id=a.source_date_observation_id WHERE a.source_id=${MP_SOURCE}`;
  assert.equal(date!.source_date_state, "reliable");
  assert.match(date!.observation.observationId, /^receipt:\d+:post:/);
  assert.equal(date!.result.evidence.format, "epoch_seconds");
  assert.equal(Date.parse(date!.result.evidence.time.utc), date!.published_at.getTime());
});

test("first MP window retains unknown lexical dates while still excluding proven old seconds", async (t) => {
  const sourceId = `test-mp-window-${T}`,
    before = bodyCalls;
  historyOverride = [
    {
      position: 1,
      url: `https://mp.weixin.qq.com/s/recent-${T}`,
      title: "近期铜矿新闻",
      post_time: String(Math.floor(Date.now() / 1000) - 60),
      digest: "近期摘要",
      sn: `recent-${T}`,
    },
    { position: 2, url: `https://mp.weixin.qq.com/s/old-${T}`, title: "已证实旧稿", post_time: "946684800", digest: "旧稿摘要", sn: `old-${T}` },
    { position: 3, url: `https://mp.weixin.qq.com/s/unknown-${T}`, title: "日期尚未证实", post_time: "1e3", digest: "待补日期", sn: `unknown-${T}` },
  ];
  t.after(() => {
    historyOverride = null;
  });
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,next_fetch_at)
    VALUES (${sourceId},'MP date window fixture','mp_account',${sql.json({ ghid: `gh-window-${T}` })},'T1','editorial','2100-01-01')`;
  await grantDateFixture(sourceId, ["https://mp.weixin.qq.com"]);
  const run = await checkMpAccount(sourceId, "manual");
  assert.equal(run.status, "ok");
  assert.equal("created" in run ? run.created : null, 2);
  assert.equal(bodyCalls - before, 2, "the proven old post is not bought, while the unknown date is retained");
  const rows = await sql`SELECT a.url,a.published_at,a.source_date_state,a.source_date_error,o.observation FROM articles a
    JOIN content.source_date_observations o ON o.id=a.source_date_observation_id WHERE a.source_id=${sourceId} ORDER BY a.url`;
  assert.match(rows[0]!.url, /recent-/);
  assert.equal(rows[0]!.source_date_state, "reliable");
  assert.deepEqual(
    [rows[1]!.source_date_state, rows[1]!.source_date_error, rows[1]!.published_at, rows[1]!.observation.raw],
    ["pending", "unrecognized_format", null, "1e3"],
  );
});
