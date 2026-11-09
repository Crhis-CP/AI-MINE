import { tag, stub } from "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, before, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { completeMaterialGrouping } from "../packages/backend/src/content/grouping.ts";
import { compareReportGroup } from "@amp/backend/events/group";
import { recoverReportGroupings, reportGroupOutcomeCounts } from "../packages/backend/src/events/report-groups.ts";
import { readReportGroupMembers } from "@amp/backend/publication/groups";
import { ensureQueue, QUEUES, stopBoss } from "@amp/backend/jobs/queue";
import { grantDateFixture } from "./source-date-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";

// TASK-0578: report-group conditions that retrying cannot change end the comparison with one recorded outcome; they
// never fail the events.group job, so the two-minute recovery pass does not send the same article back again and again.
type Input = { left: { id: string; text: string }; right: { id: string; text: string } };
let evidenceMode: "valid" | "invented" | "filtered" = "valid";
let beforeAnswer: (() => Promise<void>) | null = null;
const provider = await stub(async (_hit, request) => {
  const body = JSON.parse(request.body);
  const input = JSON.parse(body.messages.find((m: { role: string }) => m.role === "user").content) as Input;
  await beforeAnswer?.();
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            relation: "same_report",
            evidence: {
              leftQuote: evidenceMode === "invented" ? "Synthetic invented quotation absent from both materials" : input.left.text.slice(-45),
              rightQuote: input.right.text.slice(-45),
            },
            reason: "Synthetic event-stage comparison",
          }),
        },
        finish_reason: evidenceMode === "filtered" ? "content_filter" : "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
});
process.env.GROUP_REVIEW_MODEL = "deepseek-flash";
process.env.DEEPSEEK_BASE_URL = provider.url;
process.env.DEEPSEEK_API_KEY = "synthetic-test";
before(async () => {
  await installUsageFixtureForModel("deepseek-flash");
  await ensureQueue(QUEUES.group);
});
const created: string[] = [];
afterEach(async () => {
  evidenceMode = "valid";
  beforeAnswer = null;
  if (created.length) {
    await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=ANY(${created}::text[])`;
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
    const source = `loop-${key}-${n}`,
      url = `https://example.com/${source}`;
    await sql`INSERT INTO sources(id,name,kind,site_fulltext) VALUES(${source},'合成矿业来源','rss',true)`;
    await grantDateFixture(source, [url]);
    const m = await upsertMaterial({
      sourceId: source,
      url,
      title: "合成矿业综合稿：铜矿罢工与出口许可",
      bodyText: `${key} 第${n}家来源。铜矿罢工已经结束，出口许可将进入本轮审批。背景包括产量、合同与前期谈判。`,
      language: "zh",
      via: "fetch",
    });
    await completeMaterialGrouping(m.articleId, 1, { addsValue: true, reason: "没有已公开精选的相关报道" }, null);
    await sql`INSERT INTO grouping_decisions(article_id,verdict,input_revision,candidates) VALUES(${m.articleId},'roundup',1,'[]')`;
    await sql`INSERT INTO publications(article_id,source_id,title,summary,url,channel,visibility,eligible,selected,score,discovered_at,timeline_at,sort_at)
      VALUES(${m.articleId},${source},'合成矿业综合稿：铜矿罢工与出口许可',${`${key} 铜矿罢工已经结束，出口许可将进入本轮审批。`},${url},'news','public',true,false,12,now(),now(),now())`;
    ids.push(m.articleId);
    sources.push(source);
    created.push(m.articleId);
  }
  return { ids, sources };
}
const check = async (articleId: string) =>
  (await sql`SELECT state,outcome,group_id FROM events.report_group_checks WHERE article_id=${articleId}`)[0] as
    | { state: string; outcome: string | null; group_id: string | null }
    | undefined;
/** Jobs the recovery pass sent for the article and nobody has taken yet. */
const queued = async (articleId: string) =>
  (await sql`SELECT 1 FROM pgboss.job WHERE name='events.group' AND data->>'articleId'=${articleId} AND state IN ('created','retry')`).length;
const dropQueued = (articleId: string) => sql`DELETE FROM pgboss.job WHERE name='events.group' AND data->>'articleId'=${articleId}`;
const age = (articleId: string, hours: number) =>
  sql`UPDATE events.report_group_checks SET outcome_at=now()-make_interval(hours=>${hours}) WHERE article_id=${articleId}`;
/** A public projection saved before the processing grant was projected (2026-10-13): readers' permission view lacks it. */
const legacyProjection = (source: string) => sql`UPDATE sources.source_policy_current SET public_policy=public_policy-'processing' WHERE source_id=${source}`;
const repairMigration = readFileSync(new URL("../database/migrations/sources/202611071401_public_processing_projection.sql", import.meta.url), "utf8");

test("a source whose public projection predates the processing grant: one not-public outcome, no throw, no loop; the repair attaches it", async () => {
  const f = await fixture(),
    [a, b] = f.ids as [string, string];
  const projection = async () => (await sql`SELECT public_policy FROM sources.source_policy_current WHERE source_id=${f.sources[0]!}`)[0]!.public_policy;
  const original = await projection();
  await legacyProjection(f.sources[0]!);
  const hits = provider.hits();
  // Before TASK-0578 this threw "Report-group projection lost its current public binding" on every attempt.
  const result = await compareReportGroup(b);
  assert.equal(result.state, "not-public");
  assert.equal(result.matched, false);
  assert.equal(provider.hits(), hits + 1, "the comparison itself was bought once");
  assert.equal((await sql`SELECT 1 FROM publication.report_group_members WHERE article_id=ANY(${f.ids}::text[])`).length, 0, "nothing half-written");
  assert.deepEqual({ ...(await check(b)) }, { state: "complete", outcome: "not_public", group_id: null });
  assert.equal((await compareReportGroup(b)).state, "checked", "the same inputs are not compared again");
  await recoverReportGroupings(50);
  await recoverReportGroupings(50);
  assert.equal(await queued(b), 0, "the recovery pass does not send it back to events.group");
  assert.equal((await check(b))!.outcome, "not_public", "the recovery pass keeps the recorded outcome");
  assert.ok((await reportGroupOutcomeCounts()).not_public >= 1);

  // The migration writes the projection the current policy version has always implied, nothing else.
  await sql.unsafe(repairMigration);
  assert.deepEqual(await projection(), original);
  await recoverReportGroupings(50);
  assert.equal(await queued(b), 0, "within a day the outcome stands");
  await age(b, 25);
  await recoverReportGroupings(50);
  assert.equal(await queued(b), 1, "a not-public outcome is looked at again after a day");
  await dropQueued(b);
  assert.equal((await compareReportGroup(b)).matched, true);
  assert.equal(provider.hits(), hits + 1, "attaching after the repair reuses the stored answer");
  assert.deepEqual((await readReportGroupMembers((await check(b))!.group_id!, sql)).map((m) => m.article.articleId).sort(), [a, b].sort());
  assert.equal((await check(b))!.outcome, null);
});

test("the repair migration leaves current projections alone and is idempotent", async () => {
  const f = await fixture(1);
  const read = async () => (await sql`SELECT public_policy FROM sources.source_policy_current WHERE source_id=${f.sources[0]!}`)[0]!.public_policy;
  const current = await read();
  await sql.unsafe(repairMigration);
  assert.deepEqual(await read(), current);
  await legacyProjection(f.sources[0]!);
  await sql.unsafe(repairMigration);
  await sql.unsafe(repairMigration);
  assert.deepEqual(await read(), current);
});

test("quotes absent from the inputs: one unusable-answer outcome per article, no throw, no re-enqueue, never bought again", async () => {
  const f = await fixture(),
    [a, b] = f.ids as [string, string],
    hits = provider.hits();
  evidenceMode = "invented";
  // Before TASK-0578 this threw ModelOutputError("Quotes must occur in both actual inputs") and failed the job.
  const result = await compareReportGroup(b);
  assert.deepEqual({ state: result.state, matched: result.matched }, { state: "unusable-answer", matched: false });
  assert.deepEqual({ ...(await check(b)) }, { state: "complete", outcome: "unusable_answer", group_id: null });
  assert.equal((await compareReportGroup(b)).state, "checked");
  assert.equal((await compareReportGroup(a)).state, "unusable-answer", "the reverse pair replays the same stored answer");
  assert.equal(provider.hits(), hits + 1, "the paid answer is never bought again for the same inputs");
  const [decision] = await sql`SELECT state,receipt_id FROM events.report_group_decisions WHERE article_id=${b}`;
  assert.equal(decision!.state, "waiting", "no decision is invented from the rejected answer");
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${decision!.receipt_id}`)[0]!.status, "received");
  await age(b, 72);
  await recoverReportGroupings(50);
  assert.equal(await queued(b), 0, "an unusable answer waits for changed inputs, not for time");
  assert.equal(await queued(a), 0);
  assert.ok((await reportGroupOutcomeCounts()).unusable_answer >= 2);
});

test("a content-filter refusal on the stored receipt is settled the same way instead of failing the job on every replay", async () => {
  const f = await fixture(),
    [, b] = f.ids as [string, string],
    hits = provider.hits();
  evidenceMode = "filtered";
  assert.equal((await compareReportGroup(b)).state, "unusable-answer");
  assert.deepEqual({ ...(await check(b)) }, { state: "complete", outcome: "unusable_answer", group_id: null });
  assert.equal((await compareReportGroup(b)).state, "checked");
  await recoverReportGroupings(50);
  assert.equal(await queued(b), 0);
  assert.equal(provider.hits(), hits + 1);
});

test("the group moving between planning and writing: one superseded outcome, no waiting loop; it attaches once the candidates show the move", async () => {
  const f = await fixture(3),
    [a, b, c] = f.ids as [string, string, string];
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${c}`;
  assert.equal((await compareReportGroup(b)).matched, true);
  await sql`UPDATE publications SET visibility='public' WHERE article_id=${c}`;
  const first = (await check(b))!.group_id!;
  const moved = crypto.randomUUID();
  // While c's comparison waits for its answer, the group is renumbered (as a concurrent re-anchoring would).
  beforeAnswer = async () => {
    await sql`UPDATE publication.report_group_members SET group_id=${moved} WHERE group_id=${first}`;
  };
  // Before TASK-0578 this threw GroupingSupersededError, which the job re-enqueued every minute for as long as it lasted.
  const result = await compareReportGroup(c);
  assert.equal(result.state, "superseded");
  assert.deepEqual({ ...(await check(c)) }, { state: "complete", outcome: "superseded", group_id: null });
  beforeAnswer = null;
  await recoverReportGroupings(50);
  assert.equal(await queued(c), 1, "the candidates now carry the moved group: planned again at once");
  await dropQueued(c);
  const hits = provider.hits();
  assert.equal((await compareReportGroup(c)).matched, true);
  assert.equal(provider.hits(), hits, "the stored answer is reused");
  assert.deepEqual((await readReportGroupMembers(moved, sql)).map((m) => m.article.articleId).sort(), [a, b, c].sort());
});

test("a settled check is stored as a binding object, so the recovery pass leaves an unchanged article alone", async () => {
  const f = await fixture(),
    [a, b] = f.ids as [string, string];
  assert.equal((await compareReportGroup(b)).matched, true);
  assert.equal((await compareReportGroup(b)).state, "current");
  assert.equal((await compareReportGroup(a)).state, "current");
  const types = await sql`SELECT jsonb_typeof(article_binding) AS type FROM events.report_group_checks WHERE article_id=ANY(${f.ids}::text[])`;
  assert.deepEqual(
    types.map((r) => r.type),
    ["object", "object"],
    "before TASK-0578 the binding was stored as a JSON string and never compared equal",
  );
  await recoverReportGroupings(50);
  await recoverReportGroupings(50);
  assert.equal((await queued(a)) + (await queued(b)), 0, "nothing changed: not sent to events.group again");
});
