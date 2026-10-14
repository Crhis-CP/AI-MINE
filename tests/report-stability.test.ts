import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { gate, Reply, stub } from "./setup.ts";
import { ensureModelSourceFixture } from "./model-source-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { dbOf, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { composeDaily, catchUpReports } from "@amp/backend/reports/compose";
import { loadReport } from "@amp/backend/publication/reports";
import { stopBoss } from "@amp/backend/jobs/queue";

const sql = dbOf("reports");
let respond: (() => Promise<unknown>) | null = null;
const answer = {
  choices: [{ message: { content: JSON.stringify({ title: "合成导语", leadParagraph: "只依据本期报道", highlights: [1] }) } }],
  usage: { prompt_tokens: 10, completion_tokens: 10 },
};
const provider = await stub(async () => (respond ? respond() : answer));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
before(async () => {
  await installUsageFixtureForModel("deepseek-flash");
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES('report-stability','测试来源','rss','T1','editorial')`;
  await ensureModelSourceFixture("report-stability", ["https://example.invalid/source"]);
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});
async function seed(day: string) {
  const at = new Date(`${day}T12:00:00Z`);
  const { articleId } = await upsertMaterial({
    sourceId: "report-stability",
    title: `合成矿业报道 ${day}`,
    url: `https://example.invalid/${day}`,
    discoveredAt: at,
    publishedAt: at,
    via: "fetch",
  });
  const [analysis] = await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh)
    VALUES(${articleId},1,'rule','pass',${`合成矿业报道 ${day}`},'只用于隔离测试') RETURNING id`;
  await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,discovered_at,published_at,timeline_at,sort_at,visible_after,selected,eligible,category)
    VALUES(${articleId},${`合成矿业报道 ${day}`},'只用于隔离测试','report-stability','news',${`https://example.invalid/${day}`},${at},${at},${at},${at},${at},true,true,'company_project')`;
  await sql`UPDATE publications SET analysis_id=${analysis!.id} WHERE article_id=${articleId}`;
  return articleId;
}
test("daily deterministic content is readable before the model returns and completion stays idempotent", async () => {
  const id = await seed("2020-08-01");
  const entered = gate(),
    release = gate();
  respond = async () => {
    entered.open();
    await release.promise;
    return answer;
  };
  const composing = composeDaily("2020-08-02");
  try {
    await entered.promise;
    const pending = await loadReport("daily", "2020-08-02");
    assert.ok(pending, "the deterministic edition must exist while its model is pending");
    assert.equal(pending.generationStatus, "pending");
    assert.equal(pending.stories[0]?.itemId, id);
  } finally {
    release.open();
    await composing;
    respond = null;
  }
  const hits = provider.hits();
  await Promise.all([composeDaily("2020-08-02"), composeDaily("2020-08-02")]);
  assert.equal(provider.hits(), hits);
  assert.equal((await loadReport("daily", "2020-08-02"))!.generationStatus, "ready");
  assert.equal((await loadReport("daily", "2020-08-02"))!.revision, 1);
});
test("failed synthesis leaves content and hourly recovery only enriches the saved members", async () => {
  const id = await seed("2020-08-02");
  respond = async () => ({ ...answer, choices: [{ message: { content: "{invalid JSON" } }] });
  await assert.rejects(composeDaily("2020-08-03"));
  respond = null;
  const failed = await loadReport("daily", "2020-08-03");
  assert.ok(failed, "a provider failure must not remove the entire edition");
  assert.equal(failed.generationStatus, "failed");
  assert.equal(failed.stories[0]?.itemId, id);
  await catchUpReports(new Date("2020-08-03T01:00:00Z"), 1);
  assert.equal((await loadReport("daily", "2020-08-03"))!.generationStatus, "ready");
  assert.equal((await loadReport("daily", "2020-08-03"))!.revision, 1);
});
test("unknown paid outcome preserves the summary and is never sent again", async () => {
  await seed("2020-08-03");
  respond = async () => new Reply(503, { error: { message: "Ambiguous provider failure" } });
  await assert.rejects(composeDaily("2020-08-04"));
  respond = null;
  assert.ok(await loadReport("daily", "2020-08-04"));
  const hits = provider.hits();
  await assert.rejects(composeDaily("2020-08-04"));
  assert.equal(provider.hits(), hits);
});
test("manual report correction wins over an in-flight lead", async () => {
  await seed("2020-08-04");
  respond = async () => {
    await sql`UPDATE reports SET revision=revision+1,content=content || '{"correctionPending":true,"generationStatus":"pending"}'::jsonb WHERE kind='daily' AND key='2020-08-05'`;
    return answer;
  };
  await composeDaily("2020-08-05");
  respond = null;
  const [report] = await sql`SELECT revision,content FROM reports WHERE kind='daily' AND key='2020-08-05'`;
  assert.equal(report!.revision, 2);
  assert.equal(report!.content.correctionPending, true);
  assert.equal(report!.content.lead, null);
});

test("an unresolved older model bill cannot block a later deterministic edition", async () => {
  const id = await seed("2020-08-05");
  // This test isolates daily recovery; the already-issued previous week needs no synthesis.
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at) VALUES('weekly','2020-W31',now(),now(),'{}',now())`;
  const hits = provider.hits();
  await assert.rejects(catchUpReports(new Date("2020-08-06T01:00:00Z"), 3), AggregateError);
  assert.equal((await loadReport("daily", "2020-08-06"))!.stories[0]?.itemId, id);
  assert.equal(provider.hits(), hits + 1);
});

test("a citation withdrawn while the model answers never gains synthesized prose", async () => {
  const id = await seed("2020-08-06");
  respond = async () => {
    await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${id}`;
    return answer;
  };
  await assert.rejects(composeDaily("2020-08-07"));
  respond = null;
  const report = (await loadReport("daily", "2020-08-07"))!;
  assert.equal(report.lead, null);
  assert.equal(report.stories[0]?.available, false);
  const hits = provider.hits();
  await assert.rejects(composeDaily("2020-08-07"));
  assert.equal(provider.hits(), hits);
});

test("automatic metadata revisions do not strand a failed daily lead", async () => {
  const id = await seed("2020-08-07");
  respond = async () => ({ ...answer, choices: [{ message: { content: "{invalid JSON" } }] });
  await assert.rejects(composeDaily("2020-08-08"));
  respond = null;
  await sql`UPDATE publications SET tags=ARRAY['synthetic-tag'],revision=revision+1 WHERE article_id=${id}`;
  await composeDaily("2020-08-08");
  const report = (await loadReport("daily", "2020-08-08"))!;
  assert.equal(report.generationStatus, "ready");
  assert.equal(report.lead?.title, "合成导语");
  assert.equal(report.revision, 1);
});
for (const field of ["title", "summary"] as const) {
  test(`a changed public ${field} cannot reuse a lead for the old text`, async () => {
    const day = field === "title" ? "2020-08-09" : "2020-08-11",
      key = field === "title" ? "2020-08-10" : "2020-08-12";
    const id = await seed(day);
    respond = async () => {
      // Keep the paid response, but fail its current-material guard after an automatic revision.
      if (field === "title") await sql`UPDATE publications SET title='更新的公开标题',revision=revision+1 WHERE article_id=${id}`;
      else await sql`UPDATE publications SET summary='更新的公开导读',revision=revision+1 WHERE article_id=${id}`;
      return answer;
    };
    await assert.rejects(composeDaily(key));
    respond = null;
    const hits = provider.hits();
    await assert.rejects(composeDaily(key), /citations changed/);
    assert.equal(provider.hits(), hits);
    assert.equal((await loadReport("daily", key))!.lead, null);
  });
}

test("existing failed daily editions remain recoverable after the seven-day catch-up window", async () => {
  await seed("2020-09-01");
  respond = async () => ({ ...answer, choices: [{ message: { content: "{invalid JSON" } }] });
  await assert.rejects(composeDaily("2020-09-02"));
  respond = null;
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at) VALUES('monthly','2020-08',now(),now(),'{}',now())`;
  // Other old fixtures include an unresolved bill; it must remain blocked without starving this one.
  await catchUpReports(new Date("2020-09-14T01:00:00Z")).catch((error) => assert.ok(error instanceof AggregateError));
  assert.equal((await loadReport("daily", "2020-09-02"))!.generationStatus, "ready");
});
