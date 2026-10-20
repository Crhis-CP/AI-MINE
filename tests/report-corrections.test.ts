import { tag, stub, DROP_RESPONSE } from "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { publishArticle, currentReportPublications } from "@amp/backend/publication/publish";
import { correctNewsReport, writePeriod } from "@amp/backend/reports/compose";
import { loadReport, v1Daily, listReports } from "@amp/backend/publication/reports";
import { readCurrentSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";
import { stopBoss } from "@amp/backend/jobs/queue";
import { ReceiptUnknownError } from "@amp/backend/providers/receipts";
import { ModelPostReceiptGuardError } from "@amp/backend/providers/llm";
import { reportFallbackInput } from "../packages/backend/src/reports/fallback-input.ts";
import { confirmedManualEdit } from "./confirmed-manual-fixture.ts";
import { ensureModelSourceFixture } from "./model-source-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";

let mode = "ok",
  afterSend: (() => Promise<void>) | null = null,
  index = 0;
const provider = await stub(async (_hit, request) => {
  if (afterSend) await afterSend();
  if (mode === "unknown") return DROP_RESPONSE;
  const input = JSON.parse(request.body).messages.at(-1).content as string;
  const text = input.includes("10吨") ? "项目产量更正为10吨" : "当前合成公开报道";
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            title: text,
            leadParagraph: `本期已按当前来源说明核对，${text}。`,
            highlights: [1],
            headline: text,
            overview: `本期综述依据当前引用，${text}。`,
            sections: { 企业与项目: `根据当前依据，${text}。` },
          }),
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 20 },
  };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "synthetic";
process.env.REPORT_MODEL = "deepseek-flash";
process.env.DASHSCOPE_BASE_URL = `${provider.url}/v1`;
process.env.DASHSCOPE_API_KEY = "synthetic";
await installUsageFixtureForModel("deepseek-flash");
await installUsageFixtureForModel("qwen3.7-flash");
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});
async function fixture() {
  index++;
  const members: string[] = [],
    sources: string[] = [];
  for (let n = 0; n < 2; n++) {
    const source = `correction-${tag()}`;
    sources.push(source);
    await sql`INSERT INTO sources(id,name,kind,site_fulltext) VALUES(${source},${source},'rss',true)`;
    await ensureModelSourceFixture(source, ["https://source.invalid/news"]);
    const m = await upsertMaterial({
      sourceId: source,
      url: `https://source.invalid/${source}`,
      title: "矿业来源原始公告",
      bodyText: "原始公告明确记载，铜矿项目本期产量为10吨，另有环保条件和实施期限。",
      language: "zh",
      via: "fetch",
      publishedAt: new Date(),
    });
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,category,selected,score,output)
      VALUES(${m.articleId},1,'rule','pass',${`合成${source}项目产量为100吨`},'现有旧摘要错误记载项目本期产量为100吨。','company_project',true,90,'{}')`;
    await publishArticle(m.articleId);
    members.push(m.articleId);
  }
  const entries = await currentReportPublications(members),
    reports = [];
  for (const kind of ["daily", "weekly", "monthly"] as const) {
    const suffix = String(index).padStart(2, "0"),
      key = kind === "daily" ? `2020-01-${suffix}` : kind === "weekly" ? `2020-W${suffix}` : `2020-${suffix}`;
    const content = {
      generationStatus: "ready",
      title: "旧综合100吨",
      lead: { title: "旧综合100吨", leadParagraph: "旧综合认为项目产量100吨" },
      overview: "旧综述100吨",
      ...(kind === "daily"
        ? { sections: [{ label: "企业与项目", items: entries }] }
        : { themes: [{ heading: "旧主题100吨", summary: "旧主题总结100吨", storyRefs: entries }] }),
    };
    const [r] =
      await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at) VALUES(${kind},${key},'2020-01-01','2020-02-01',${sql.json(content as never)},now()) RETURNING id`;
    reports.push({ id: String(r!.id), kind, key });
  }
  return { members, sources, reports };
}
const correct = async (id: string, version: number, title = `第${index}组项目产量更正为10吨`) =>
  confirmedManualEdit(
    id,
    { fields: { title, summary: "已核对原始公告：铜矿项目本期产量为10吨，并保留环保条件与期限。" }, reason: "PRIVATE_HUMAN_REASON", version },
    "synthetic-human",
  );
async function deny(sourceId: string) {
  const policy = (await readCurrentSourcePolicy(sourceId))!;
  return saveSourcePolicy(
    sourceId,
    {
      expectedVersion: policy.permission_version,
      policy: { ...policy, permissions: { ...policy.permissions, external_model: "deny" } },
      reason: "synthetic deny",
    },
    "test",
  );
}
test("manual corrections immediately remove old synthesis and the worker creates new daily/weekly/monthly revisions", async () => {
  const f = await fixture();
  for (const id of f.members) await correct(id, 0);
  const hits = provider.hits();
  for (const report of f.reports) {
    const pending = (await loadReport(report.kind, report.key))!;
    assert.equal(pending.generationStatus, "pending");
    assert.equal(pending.lead, null);
    assert.equal(pending.overview, null);
    assert.ok(!JSON.stringify(pending).includes("100吨"));
    assert.ok(!JSON.stringify(pending).includes("PRIVATE_HUMAN_REASON"));
    assert.ok(pending.corrections?.length);
    assert.ok(pending.revision > 1);
  }
  assert.equal(provider.hits(), hits, "public reads never call a model");
  assert.ok(!JSON.stringify(await v1Daily(f.reports[0]!.key)).includes("100吨"));
  assert.ok(!(await listReports("daily")).some((r) => r.key === f.reports[0]!.key && r.title?.includes("100吨")));
  for (const report of f.reports) {
    assert.equal((await correctNewsReport(report.id)).status, "corrected");
    const updated = (await loadReport(report.kind, report.key))!;
    assert.equal(updated.generationStatus, "ready");
    assert.ok(JSON.stringify(updated).includes("10吨"));
    assert.ok(!JSON.stringify(updated).includes("100吨"));
    assert.equal((await correctNewsReport(report.id)).status, "current");
    assert.ok((await sql`SELECT revision FROM report_revisions WHERE report_id=${report.id}`).length >= 2);
  }
  const receipts = await sql`SELECT request FROM receipts WHERE subject=${`report:weekly:${f.reports[1]!.key}`} AND status='completed'`;
  assert.deepEqual([...receipts[0]!.request.sourceIds].sort(), f.sources.sort(), "model and fallback source scope contains every member source");
});
test("second source deny blocks both a new report send and reuse of a previously paid correction", async () => {
  const f = await fixture();
  for (const id of f.members) await correct(id, 0);
  const daily = f.reports[1]!;
  const factory = await reportFallbackInput(await currentReportPublications(f.members));
  assert.ok(factory);
  assert.deepEqual([...factory({ system: "fixture", user: "same two-source report" }).sourceIds].sort(), [...f.sources].sort());
  await correctNewsReport(daily.id);
  const hits = provider.hits();
  await correct(f.members[0]!, 1);
  await deny(f.sources[1]!);
  assert.equal((await correctNewsReport(f.reports[0]!.id)).status, "corrected", "daily uses current public copy without an external model");
  await assert.rejects(correctNewsReport(f.reports[2]!.id), /许可/);
  await assert.rejects(correctNewsReport(daily.id), /许可/);
  assert.equal(provider.hits(), hits, "neither new send nor same-input cache bypasses the denied second source");
  assert.equal((await loadReport("weekly", daily.key))!.lead, null);
});
test("permission changed during a paid answer preserves its receipt but cannot publish the correction", async () => {
  const f = await fixture();
  for (const id of f.members) await correct(id, 0);
  afterSend = () => deny(f.sources[1]!).then(() => {});
  try {
    await assert.rejects(correctNewsReport(f.reports[1]!.id), ModelPostReceiptGuardError);
  } finally {
    afterSend = null;
  }
  assert.equal((await loadReport("weekly", f.reports[1]!.key))!.lead, null);
  const [receipt] = await sql`SELECT response,status FROM receipts WHERE subject=${`report:weekly:${f.reports[1]!.key}`}`;
  assert.ok(receipt!.response);
  assert.equal(receipt!.status, "received");
});
test("an unknown report request stays held while corrected input and a new model form a separate request", async () => {
  const f = await fixture();
  for (const id of f.members) await correct(id, 0);
  const daily = f.reports[1]!;
  mode = "unknown";
  try {
    await assert.rejects(correctNewsReport(daily.id), ReceiptUnknownError);
    const hits = provider.hits();
    await assert.rejects(correctNewsReport(daily.id), ReceiptUnknownError);
    assert.equal(provider.hits(), hits);
    await correct(f.members[0]!, 1, "已更正的铜矿产量为10吨");
    mode = "ok";
    process.env.REPORT_MODEL = "qwen3.7-flash";
    await correctNewsReport(daily.id);
    assert.equal(provider.hits(), hits + 1, "changed input and model have their own paid identity");
    assert.ok(
      (await sql`SELECT id FROM receipts WHERE subject=${`report:${daily.kind}:${daily.key}`} AND status='unknown'`).length,
      "old unknown billing remains recorded",
    );
  } finally {
    mode = "ok";
    process.env.REPORT_MODEL = "deepseek-flash";
  }
});

test("every source of a long period brief is checked before payment", async () => {
  const f = await fixture();
  const ids = [f.members[0]!];
  for (let n = 0; n < 30; n++) {
    const material = await upsertMaterial({
      sourceId: f.sources[0]!,
      url: `https://source.invalid/${f.sources[0]}/tail-permit-${n}`,
      title: `合成末尾许可边界材料${n}`,
      bodyText: "合成矿业材料用于核对整份报告的来源许可，末尾条目不得绕过许可门。",
      language: "zh",
      via: "fetch",
      publishedAt: new Date(),
    });
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,selected,score,output)
      VALUES(${material.articleId},1,'rule','pass',${`合成许可边界报道${n}`},'合成来源已经确认，报告必须逐一检查每个成员的当前许可。',true,90,'{}')`;
    await publishArticle(material.articleId);
    ids.push(material.articleId);
  }
  ids.push(f.members[1]!);
  const entries = await currentReportPublications(ids);
  assert.equal(entries.length, 32);
  assert.ok(entries.slice(0, 30).every((entry) => entry.sourceId === f.sources[0]));
  assert.equal(entries.at(-1)!.sourceId, f.sources[1]);
  await deny(f.sources[1]!);
  const hits = provider.hits();
  await assert.rejects(writePeriod("weekly", "2020-W53", "2020-12-28", "2021-01-03", entries, "deepseek-flash"), /许可/);
  assert.equal(provider.hits(), hits, "all sources must permit model processing");
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE subject='report:weekly:2020-W53'`)[0]!.n, 0);
});

test("daily correction preserves related-reading positions across withdrawal and explicit restoration without paying a model", async () => {
  const { invalidateReportCorrections } = await import("@amp/backend/reports/compose");
  const f = await fixture(),
    daily = f.reports[0]!;
  const entries = await currentReportPublications(f.members),
    main = entries[0]!,
    related = entries[1]!;
  await sql`UPDATE reports SET content=${sql.json({ generationStatus: "ready", leadItemId: main.itemId, lead: { title: main.title, leadParagraph: main.summary }, sections: [{ label: "企业与项目", items: [{ ...main, sources: 2, related: [related] }] }], flashes: [] })} WHERE id=${daily.id}`;
  const hits = provider.hits();
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${related.itemId}`;
  await sql.begin((tx) => invalidateReportCorrections(tx, [related.itemId], "withdrawal"));
  assert.equal((await correctNewsReport(daily.id)).status, "corrected");
  assert.equal((await loadReport("daily", daily.key))!.stories[0]!.related?.length ?? 0, 0);
  await sql`UPDATE publications SET visibility='public' WHERE article_id=${related.itemId}`;
  await sql.begin((tx) => invalidateReportCorrections(tx, [related.itemId], "restoration"));
  assert.equal((await correctNewsReport(daily.id)).status, "corrected");
  const view = (await loadReport("daily", daily.key))!;
  assert.equal(view.leadItemId, main.itemId);
  assert.equal(view.stories[0]!.related?.[0]?.itemId, related.itemId);
  assert.equal(provider.hits(), hits);
  assert.ok(!JSON.stringify(view).includes("sourceStructure"));
});

test("period publication keeps its daily selection when prose is unknown and does not purchase it again on schedule", async () => {
  const { composeMonthly } = await import("@amp/backend/reports/compose");
  const f = await fixture(),
    entries = await currentReportPublications(f.members);
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,origin) VALUES('daily','2050-01-02','2050-01-01','2050-01-02',${sql.json({ leadItemId: entries[0]!.itemId, sections: [{ label: "企业与项目", items: entries }], flashes: [] })},now(),'rule')`;
  mode = "unknown";
  const hits = provider.hits();
  try {
    assert.equal((await composeMonthly("2050-01")).entries, 2);
    const view = (await loadReport("monthly", "2050-01"))!;
    assert.equal(view.generationStatus, "summary");
    assert.equal(view.stories.length, 2);
    assert.match(view.overview!, /本月汇集 2 件矿业动态/);
    assert.equal(view.windowStart, "2049-12-31T16:00:00.000Z");
    assert.equal(view.windowEnd, "2050-01-31T16:00:00.000Z");
    const [receipt] = await sql`SELECT status FROM receipts WHERE subject='report:monthly:2050-01'`;
    assert.equal(receipt!.status, "unknown");
    const attempts = provider.hits();
    assert.ok(attempts > hits);
    await composeMonthly("2050-01");
    assert.equal(provider.hits(), attempts);
  } finally {
    mode = "ok";
  }
});
