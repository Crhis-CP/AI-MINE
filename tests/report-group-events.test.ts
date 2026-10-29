import { tag, stub, DROP_RESPONSE } from "./setup.ts";
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { completeMaterialGrouping } from "../packages/backend/src/content/grouping.ts";
import { compareReportGroup, readReportIdentityDecision, detachArticleFromFactTx, requestArticleRegroup } from "@amp/backend/events/group";
import { recoverReportGroupings } from "../packages/backend/src/events/report-groups.ts";
import { readReportGroupMembers } from "@amp/backend/publication/groups";
import { readCurrentSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";
import { ensureQueue, QUEUES, stopBoss } from "@amp/backend/jobs/queue";
import { recoverUnknownOnce } from "../packages/backend/src/providers/unknown-recovery.ts";
import { changeSystemLaneControl, laneControlHolderRevisions } from "@amp/backend/operations/lane-controls";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { grantDateFixture } from "./source-date-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";

type Input = { left: { id: string; text: string }; right: { id: string; text: string } };
let relation: "same_report" | "new_development" | "different" = "same_report";
let evidenceMode: "valid" | "invented" | "missing" = "valid";
let drop = false;
let beforeAnswer: (() => Promise<void>) | null = null;
const requests: Input[] = [];
const provider = await stub(async (_hit, request) => {
  const body = JSON.parse(request.body);
  const input = JSON.parse(body.messages.find((m: { role: string }) => m.role === "user").content) as Input;
  requests.push(input);
  await beforeAnswer?.();
  if (drop) return DROP_RESPONSE;
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            relation,
            evidence:
              evidenceMode === "missing"
                ? null
                : {
                    leftQuote: evidenceMode === "invented" ? "Synthetic invented quotation absent from both materials" : input.left.text.slice(-45),
                    rightQuote: input.right.text.slice(-45),
                  },
            reason: "Synthetic event-stage comparison",
          }),
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
});
process.env.GROUP_REVIEW_MODEL = "deepseek-flash";
process.env.DEEPSEEK_BASE_URL = provider.url;
process.env.DEEPSEEK_API_KEY = "synthetic-test";
before(() => installUsageFixtureForModel("deepseek-flash"));
const created: string[] = [];
afterEach(async () => {
  beforeAnswer = null;
  drop = false;
  relation = "same_report";
  evidenceMode = "valid";
  if (created.length) {
    await sql`DELETE FROM publications WHERE article_id=ANY(${created}::text[])`;
    await sql`DELETE FROM grouping_decisions WHERE article_id=ANY(${created}::text[])`;
    created.length = 0;
  }
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

async function fixture(count = 2) {
  const key = tag(),
    ids: string[] = [],
    sources: string[] = [];
  for (let n = 0; n < count; n++) {
    const source = `report-${key}-${n}`,
      url = `https://example.com/${source}`;
    await sql`INSERT INTO sources(id,name,kind,site_fulltext) VALUES(${source},'合成矿业来源','rss',true)`;
    await grantDateFixture(source, [url]);
    const m = await upsertMaterial({
      sourceId: source,
      url,
      title: "合成矿业综合稿：选举结果与稀土政策",
      bodyText: `${key} 第${n}家来源。选举结果已确认，稀土政策将进入本轮执行。背景包括资源、投资与前期投票。`,
      language: "zh",
      via: "fetch",
    });
    await completeMaterialGrouping(m.articleId, 1, { addsValue: true, reason: "没有已公开精选的相关报道" }, null);
    await sql`INSERT INTO grouping_decisions(article_id,verdict,input_revision,candidates) VALUES(${m.articleId},'roundup',1,'[]')`;
    await sql`INSERT INTO publications(article_id,source_id,title,summary,url,channel,visibility,eligible,selected,score,discovered_at,timeline_at,sort_at)
      VALUES(${m.articleId},${source},'合成矿业综合稿：选举结果与稀土政策',${`${key} 选举结果已确认，稀土政策将进入本轮执行。`},${url},'news','public',true,false,12,now(),now(),now())`;
    ids.push(m.articleId);
    sources.push(source);
    created.push(m.articleId);
  }
  return { ids, sources };
}
async function proof(articleId: string) {
  return (await sql`SELECT decision FROM events.report_group_decisions WHERE article_id=${articleId} AND state='complete' ORDER BY updated_at DESC LIMIT 1`)[0]
    ?.decision;
}
async function groupId(articleId: string) {
  return (await sql`SELECT group_id FROM publication.report_group_members WHERE article_id=${articleId}`)[0]?.group_id as string;
}

test("ordinary composite reports obtain a real paid identity, reuse it on reverse/restart and keep scores and fact identities", async () => {
  const f = await fixture(),
    [a, b] = f.ids as [string, string],
    before = provider.hits();
  await sql`UPDATE sources SET enabled=false WHERE id=${f.sources[1]!}`;
  assert.equal((await compareReportGroup(b)).state, "source-paused");
  assert.equal(provider.hits(), before, "a paused source does not start a new comparison");
  await sql`UPDATE sources SET enabled=true WHERE id=${f.sources[1]!}`;
  assert.equal((await compareReportGroup(b)).matched, true);
  assert.equal(provider.hits(), before + 1);
  const saved = await proof(b),
    id = await groupId(b);
  assert.equal(saved.relation, "same_report");
  assert.match(saved.attemptId, /^[1-9][0-9]*$/);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${saved.receiptId}`)[0]!.status, "completed");
  assert.equal((await readReportGroupMembers(id, sql)).length, 2);
  await sql`UPDATE sources SET enabled=false WHERE id=${f.sources[0]!}`;
  assert.equal((await compareReportGroup(b)).matched, true);
  await sql`UPDATE sources SET enabled=true WHERE id=${f.sources[0]!}`;
  assert.equal((await compareReportGroup(a)).matched, true);
  assert.equal(provider.hits(), before + 1, "reverse material ordering reuses the physical receipt");
  await sql`UPDATE publications SET revision=revision+1 WHERE article_id=${b}`;
  await compareReportGroup(b);
  assert.equal(provider.hits(), before + 1, "presentation revision repairs do not repurchase material comparison");
  assert.equal((await readReportGroupMembers(await groupId(b), sql)).length, 2);
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id=ANY(${f.ids}::text[])`).length, 0);
  assert.deepEqual(
    (await sql`SELECT score,selected FROM publications WHERE article_id=ANY(${f.ids}::text[])`).map((r) => ({ ...r })),
    [
      { score: 12, selected: false },
      { score: 12, selected: false },
    ],
  );
  const revision = (await laneControlHolderRevisions("news", "system")).processing!;
  const hold = { lane: "news" as const, switches: ["processing" as const], reason: "Synthetic model pause", actor: "test" };
  await changeSystemLaneControl({ ...hold, action: "pause", expected: { processing: revision }, expiresAt: new Date(Date.now() + 60000).toISOString() });
  try {
    assert.equal((await compareReportGroup(b)).matched, true);
    assert.equal(provider.hits(), before + 1);
  } finally {
    await changeSystemLaneControl({ ...hold, action: "resume", expected: { processing: revision + 1 } });
  }
  const [existing] = await sql`INSERT INTO facts(public_id,title) VALUES(${tag()},'合成现有事实') RETURNING id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${existing!.id},${a},'primary',NULL)`;
  assert.equal((await compareReportGroup(a)).state, "fact-owned", "legacy fact membership remains owned by the existing fact process");
  assert.equal((await readReportGroupMembers(id, sql)).length, 2, "a fact anchor is not cleared merely because its own job runs again");
  const newcomer = (await fixture(1)).ids[0]!;
  assert.equal((await compareReportGroup(newcomer)).matched, false, "existing fact members cannot anchor a new reading group");
  assert.equal(await groupId(newcomer), undefined);
  assert.equal(provider.hits(), before + 1);
});

test("a group member recalls its fixed anchor and an actual new development remains a separate article", async () => {
  const f = await fixture(3),
    [a, b, c] = f.ids as [string, string, string];
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${c}`;
  await compareReportGroup(b);
  const id = await groupId(b);
  await sql`UPDATE publications SET visibility='public' WHERE article_id=${c}`;
  relation = "new_development";
  const before = provider.hits();
  assert.equal((await compareReportGroup(c)).matched, false);
  assert.equal(provider.hits(), before + 1, "members do not become separate/transitive identity anchors");
  const input = requests.at(-1)!;
  assert.deepEqual([input.left.id, input.right.id].sort(), [a, c].sort());
  assert.equal((await proof(c)).relation, "new_development");
  assert.equal((await readReportGroupMembers(id, sql)).length, 2);
  await compareReportGroup(c);
  assert.equal(provider.hits(), before + 1, "the same negative decision is durable");
});

test("invalid report evidence retains its paid answer across retries, reverse comparisons and restarts", async () => {
  for (const mode of ["invented", "missing"] as const) {
    const f = await fixture(),
      [a, b] = f.ids as [string, string],
      before = provider.hits();
    evidenceMode = mode;
    const evidenceError = /Quotes must occur|Same report needs/;
    await assert.rejects(compareReportGroup(b), evidenceError);
    await assert.rejects(compareReportGroup(b), evidenceError);
    await assert.rejects(compareReportGroup(a), evidenceError);
    const restart = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import('./tests/setup.ts');
      const {compareReportGroup}=await import('@amp/backend/events/group');const {closeDb}=await import('@amp/backend/db');
      try {await compareReportGroup(process.argv[1]);process.exitCode=1;} catch(error){console.log(error.constructor.name);} finally {await closeDb();}`,
        b,
      ],
      { env: process.env },
    );
    assert.match(restart.stdout, /ModelOutputError/);
    assert.equal(provider.hits(), before + 1, "local evidence rejection never buys a replacement answer");
    const waits = await sql`SELECT state,receipt_id,decision FROM events.report_group_decisions WHERE article_id=ANY(${f.ids}::text[])`;
    assert.ok(waits.length >= 2 && waits.every((row) => row.state === "waiting" && row.decision === null));
    assert.equal(new Set(waits.map((row) => row.receipt_id)).size, 1);
    const [receipt] = await sql`SELECT status,attempts FROM receipts WHERE id=${waits[0]!.receipt_id}`;
    assert.deepEqual({ ...receipt }, { status: "received", attempts: 1 });
    assert.equal(await groupId(b), undefined);
    assert.equal(await proof(b), undefined);

    evidenceMode = "valid";
    await upsertMaterial({
      sourceId: f.sources[1]!,
      url: `https://example.com/${f.sources[1]}`,
      title: "合成矿业综合稿：选举结果与稀土政策",
      bodyText: `${tag()} 新修订原文补充了已确认的选举结果和稀土政策执行材料。`,
      language: "zh",
      via: "fetch",
    });
    await completeMaterialGrouping(b, 2, { addsValue: true, reason: "Synthetic changed material" }, null);
    await sql`INSERT INTO grouping_decisions(article_id,verdict,input_revision,candidates) VALUES(${b},'roundup',2,'[]')`;
    assert.equal((await compareReportGroup(b)).matched, true);
    assert.equal(provider.hits(), before + 2, "changed source material may obtain a new model decision");
    assert.equal((await proof(b)).relation, "same_report");
    await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=ANY(${f.ids}::text[])`;
  }
});

test("unknown receipts wait across restarts and resume through the existing bounded queue without fabricating an answer", async () => {
  const f = await fixture(),
    [a, b] = f.ids as [string, string],
    before = provider.hits();
  drop = true;
  const restart = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import('./tests/setup.ts');
    const {compareReportGroup}=await import('@amp/backend/events/group');const {closeDb}=await import('@amp/backend/db');
    try {await compareReportGroup(process.argv[1]);process.exitCode=1;} catch(error){console.log(error.constructor.name);} finally {await closeDb();}`,
      b,
    ],
    { env: process.env },
  );
  assert.match(restart.stdout, /ReceiptUnknownError|ModelRouteWaitingError/);
  assert.equal(provider.hits(), before + 1);
  assert.equal(await proof(b), undefined);
  const [waiting] = await sql`SELECT receipt_id,state,decision FROM events.report_group_decisions WHERE article_id=${b}`;
  assert.equal(waiting!.state, "waiting");
  assert.equal(waiting!.decision, null);
  assert.ok(waiting!.receipt_id);
  await assert.rejects(compareReportGroup(b));
  assert.equal(provider.hits(), before + 1);
  await ensureQueue(QUEUES.group);
  const held = await recoverReportGroupings(50);
  assert.ok(held.waiting >= 1);
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name='events.group' AND data->>'articleId'=${b} AND state IN ('created','active','retry')`).length, 0);
  await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE id=${waiting!.receipt_id}`;
  assert.equal((await recoverUnknownOnce(Date.now(), async () => false)).released, 1);
  assert.ok((await recoverReportGroupings(50)).enqueued >= 1);
  drop = false;
  assert.equal((await compareReportGroup(b)).matched, true);
  assert.equal(provider.hits(), before + 2);
  const attempts = await sql`SELECT status FROM receipt_attempts WHERE receipt_id=${waiting!.receipt_id} ORDER BY attempt`;
  assert.deepEqual(
    attempts.map((r) => r.status),
    ["unknown", "received"],
  );
  assert.deepEqual([...(await readReportGroupMembers(await groupId(b), sql))].map((r) => r.article.articleId).sort(), [a, b].sort());
});

test("material and permission changes reject late results; human standalone and regroup clear the same public transaction", async () => {
  const f = await fixture(),
    [a, b] = f.ids as [string, string];
  beforeAnswer = async () => {
    await sql`UPDATE articles SET revision=revision+1 WHERE id=${b}`;
  };
  await assert.rejects(compareReportGroup(b), /输入|input|fallback|修订|改变|changed|material/i);
  assert.equal(await proof(b), undefined);
  assert.equal(await groupId(b), undefined);
  beforeAnswer = null;
  await sql`UPDATE articles SET revision=revision-1 WHERE id=${b}`;
  await compareReportGroup(b);
  const saved = await proof(b),
    id = await groupId(b);
  assert.ok(await readReportIdentityDecision(saved, sql));
  const source = f.sources[0]!,
    current = (await readCurrentSourcePolicy(source))!,
    policy = { ...structuredClone(current), permission_version: current.permission_version + 1 };
  policy.permissions.external_model = "deny";
  await saveSourcePolicy(source, { policy, expectedVersion: current.permission_version, reason: "Synthetic revoke" }, "test");
  assert.equal(await readReportIdentityDecision(saved, sql), null);
  assert.equal((await readReportGroupMembers(id, sql)).length, 0);
  await sql.begin((tx) => detachArticleFromFactTx(tx, a, "Synthetic independent decision", "test"));
  assert.equal((await sql`SELECT 1 FROM publication.report_group_members WHERE group_id=${id}`).length, 0);
  assert.equal(await readReportIdentityDecision(saved, sql), null);
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=ANY(${f.ids}::text[])`;
  const regroup = await fixture();
  await compareReportGroup(regroup.ids[1]!);
  const regroupId = await groupId(regroup.ids[1]!);
  await sql.begin((tx) => requestArticleRegroup(regroup.ids[0]!, tx));
  assert.equal((await sql`SELECT 1 FROM publication.report_group_members WHERE group_id=${regroupId}`).length, 0);
});
