import { stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { closeDb, dbOf } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { composeDaily, composeMonthly } from "@amp/backend/reports/compose";
import { composeStoryDigest } from "@amp/backend/events/digest";
import { getBoss, stopBoss, QUEUES } from "@amp/backend/jobs/queue";
import { registerEventJobs } from "@amp/backend/jobs/events";
import {
  changeOwnerLaneControls,
  changeSystemLaneControl,
  listLaneControls,
  RuntimeControlStale,
  RuntimeControlPaused,
} from "../packages/backend/src/operations/lane-controls.ts";

const sql = dbOf("reports");
let duringResponse: (() => Promise<void>) | null = null;
const provider = await stub(async () => {
  if (duringResponse) await duringResponse();
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            title: "合成报告",
            leadParagraph: "合成测试导语",
            highlights: [1],
            digest: "用于隔离测试的事件综述，不是真实矿业内容。",
            latest: "合成进展",
          }),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "synthetic-test-key";
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

async function owner(action: "pause" | "resume", lane: "news" | "policy") {
  const revision = (await listLaneControls()).owner_revisions.find((r) => r.lane === lane && r.switch === "processing")!.revision;
  return changeOwnerLaneControls(
    {
      lane,
      mode: "processing",
      action,
      reason: "Synthetic test control",
      confirm_all: false,
      expected_revisions: { processing: revision },
      ...(action === "pause" ? { expires_at: new Date(Date.now() + 3600_000).toISOString() } : {}),
    },
    "test",
  );
}
async function seed() {
  await sql`INSERT INTO sources(id,name,kind,lane) VALUES('runtime-report-source','Synthetic report source','external','news')`;
  const at = new Date("2020-02-01T04:00:00Z"),
    { articleId } = await upsertMaterial({
      sourceId: "runtime-report-source",
      title: "合成矿业报告材料",
      url: "https://example.invalid/runtime-report",
      discoveredAt: at,
      publishedAt: at,
      via: "fetch",
    });
  await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,discovered_at,published_at,timeline_at,sort_at,visible_after,selected,eligible,category)
    VALUES(${articleId},'合成矿业报告材料','只用于隔离测试','runtime-report-source','news','https://example.invalid/runtime-report',${at},${at},${at},${at},${at},true,true,'company_project')`;
  return articleId;
}

test("daily report and story digest keep paid receipts but reject stale control generations before public writes", async () => {
  const articleId = await seed();
  duringResponse = async () => {
    await owner("pause", "news");
    await owner("resume", "news");
  };
  await assert.rejects(composeDaily("2020-02-02"), RuntimeControlStale);
  duringResponse = null;
  assert.equal((await sql`SELECT id FROM reports WHERE key='2020-02-02'`).length, 0);
  assert.equal(provider.hits(), 1);
  await composeDaily("2020-02-02");
  assert.equal(provider.hits(), 1);
  const [story] = await sql`INSERT INTO stories(public_id,title,first_report_at,latest_at) VALUES(${randomUUID()},'Synthetic story',now(),now()) RETURNING id`;
  const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${randomUUID()},${story.id},'Synthetic fact') RETURNING id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${fact.id},${articleId},'report')`;
  duringResponse = async () => {
    await owner("pause", "news");
    await owner("resume", "news");
  };
  await assert.rejects(composeStoryDigest(Number(story.id)), RuntimeControlStale);
  duringResponse = null;
  assert.equal((await sql`SELECT version FROM story_digests WHERE story_id=${story.id}`).length, 0);
  assert.equal(provider.hits(), 2);
  assert.equal((await composeStoryDigest(Number(story.id))).updated, true);
  assert.equal(provider.hits(), 2);
});

test("empty deterministic reports do not use models; processing and publication holds stay independent across lanes", async () => {
  const hits = provider.hits();
  await owner("pause", "news");
  await owner("pause", "policy");
  await composeMonthly("1999-01");
  assert.equal(provider.hits(), hits);
  const control = { lane: "news" as const, switches: ["publication" as const], reason: "Synthetic public hold", actor: "test" };
  await changeSystemLaneControl({ ...control, action: "pause", expected: { publication: 0 }, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  await assert.rejects(composeMonthly("1999-02"), RuntimeControlPaused);
  assert.equal((await sql`SELECT id FROM reports WHERE key='1999-02'`).length, 0);
  await changeSystemLaneControl({ ...control, action: "resume", expected: { publication: 1 } });
  await owner("resume", "news");
  await composeMonthly("1999-02");
  assert.equal(provider.hits(), hits);
  assert.ok((await listLaneControls()).controls.some((c) => c.lane === "policy" && c.switch === "processing"));
});

test("paused event jobs defer into durable future work without consuming ordinary failure retries", async () => {
  const handlers = new Map<string, (jobs: any[]) => Promise<unknown>>();
  const worker = {
    work: async (name: string, _options: unknown, handler: (jobs: any[]) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  } as unknown as Awaited<ReturnType<typeof getBoss>>;
  await registerEventJobs(worker);
  const [article] = await sql`SELECT article_id FROM publications WHERE source_id='runtime-report-source'`,
    [fact] = await sql`SELECT story_id FROM facts WHERE title='Synthetic fact'`,
    [control] = await sql`SELECT revision FROM ops.lane_controls WHERE lane='news' AND switch='publication' AND holder='system'`;
  await changeSystemLaneControl({
    lane: "news",
    switches: ["publication"],
    action: "pause",
    expected: { publication: control.revision },
    reason: "Synthetic held queue",
    actor: "test",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  await sql`UPDATE publications SET summary=summary || ' 合成更正' WHERE article_id=${article.article_id}`;
  const group = { articleId: article.article_id, force: true },
    digest = { storyId: Number(fact.story_id), afterCorrection: true };
  for (const [queue, data] of [
    [QUEUES.group, group],
    [QUEUES.digest, digest],
  ] as const) {
    assert.deepEqual(await handlers.get(queue)!([{ data }]), { state: "waiting", reason: "runtime_control" });
    assert.deepEqual(await handlers.get(queue)!([{ data }]), { state: "waiting", reason: "runtime_control" });
    const rows = await sql`SELECT data,state,retry_count,start_after>now() AS deferred FROM pgboss.job WHERE name=${queue} AND singleton_key LIKE 'control:%'`;
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].data, data);
    assert.equal(rows[0].state, "created");
    assert.equal(rows[0].retry_count, 0);
    assert.equal(rows[0].deferred, true);
  }
});
