import "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { getBoss, stopBoss } from "@amp/backend/jobs/queue";
import { checkAlerts, collectFindings } from "@amp/backend/operations/alerts";
import { catchUpReports, composeMonthly } from "@amp/backend/reports/compose";

const NOW = Date.parse("2026-10-19T02:00:16Z");
const SOURCE = "report-alert-evidence";
process.env.COLLECT_ENABLED = "true";
process.env.MODEL_CALLS_ENABLED = "true";
process.env.FEISHU_INTERNAL_ENABLED = "false";

before(async () => {
  await getBoss();
  await sql`INSERT INTO sources(id,name,kind,lane,participation_mode) VALUES(${SOURCE},'合成报告告警来源','rss','news','editorial')`;
});
beforeEach(async () => {
  await sql`DELETE FROM reports`;
  await sql`DELETE FROM job_runs WHERE job IN ('reports.catch-up','reports.monthly')`;
  await sql`DELETE FROM settings WHERE key IN ('alerts.state','heartbeat.worker')`;
});
after(async () => {
  assert.equal((await sql`SELECT id FROM receipts`).length, 0, "report evidence checks must not create paid requests");
  assert.equal((await sql`SELECT id FROM receipt_attempts`).length, 0, "report evidence checks must not submit model attempts");
  await stopBoss();
  await closeDb();
});

async function quietDailies(start: string, end: string) {
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,origin)
    SELECT 'daily',to_char(day,'YYYY-MM-DD'),day-interval '1 day',day,
      ${sql.json({ sections: [], flashes: [], lead: { title: "今日无大事发生", leadParagraph: "合成已完成评判的安静日报。" } })},day,'rule'
    FROM generate_series(${start}::date,${end}::date,interval '1 day') day`;
}

async function run(status: "ok" | "running" | "failed", agoMs = 0) {
  const at = new Date(NOW - agoMs);
  const [row] = await sql`INSERT INTO job_runs(job,status,started_at,finished_at,detail,error)
    VALUES('reports.catch-up',${status},${at},${status === "running" ? null : at},${sql.json({ generated: [] })},${status === "failed" ? "weekly:2026-W42 failed" : null}) RETURNING id`;
  return row!.id;
}

const monthlyFindings = async () => (await collectFindings(NOW)).filter((finding) => finding.key.startsWith("report.monthly"));

test("a period before the first daily stays absent without running/ok alert oscillation", async (t) => {
  t.mock.method(console, "log", () => {});
  await quietDailies("2026-10-11", "2026-10-19");
  assert.deepEqual(await catchUpReports(new Date(NOW)), { generated: [] }, "September is outside the actual daily archive");
  await run("ok", 30 * 60_000);
  const active = await run("running");
  assert.deepEqual(await monthlyFindings(), [], "the next catch-up starting does not make September an applicable period");
  const during = await checkAlerts(NOW);
  assert.deepEqual(
    [...during.open, ...during.sent, ...during.opened].filter((key) => key.startsWith("report.monthly")),
    [],
  );
  assert.equal((await sql`SELECT status FROM job_runs WHERE id=${active}`)[0]!.status, "running", "reading period evidence must not settle a running task");
  await sql`UPDATE job_runs SET status='ok',finished_at=${new Date(NOW + 50)} WHERE id=${active}`;
  const afterRun = await checkAlerts(NOW + 10 * 60_000);
  assert.deepEqual(
    [...afterRun.open, ...afterRun.sent, ...afterRun.opened].filter((key) => key.startsWith("report.monthly")),
    [],
  );
  assert.equal((await sql`SELECT id FROM reports WHERE kind='monthly' AND key='2026-09'`).length, 0, "no empty month is fabricated");
});

test("completed quiet daily evidence survives a later running or unrelated failed catch-up", async () => {
  await quietDailies("2026-09-01", "2026-09-30");
  assert.deepEqual(await composeMonthly("2026-09"), { key: "2026-09", entries: 0 });
  await run("ok", 30 * 60_000);
  const active = await run("running");
  assert.deepEqual(await monthlyFindings(), [], "persisted complete quiet dailies remain proof while the next run is active");
  await sql`UPDATE job_runs SET status='failed',finished_at=${new Date(NOW)},error='weekly:2026-W42 failed' WHERE id=${active}`;
  assert.deepEqual(await monthlyFindings(), [], "an unrelated edition failure does not undo the proven quiet month");
  assert.equal((await sql`SELECT id FROM reports WHERE kind='monthly' AND key='2026-09'`).length, 0);
});

test("no dailies or a missing daily is unresolved even when a generic catch-up says ok", async () => {
  const latest = await run("ok");
  assert.ok(
    (await monthlyFindings()).some((finding) => finding.key === "report.monthly"),
    "no completed daily evidence is not a quiet month",
  );
  await quietDailies("2026-09-01", "2026-09-29");
  assert.ok(
    (await monthlyFindings()).some((finding) => finding.key === "report.monthly"),
    "a missing September 30 cannot be hidden by generic success",
  );
  await sql`UPDATE job_runs SET status='running',finished_at=NULL WHERE id=${latest}`;
  assert.ok(
    (await monthlyFindings()).some((finding) => finding.key === "report.monthly"),
    "running with incomplete evidence remains unresolved",
  );
});

async function carriedArticle(visibility: "public" | "withdrawn", suffix: string) {
  const at = new Date("2026-09-29T12:00:00Z");
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.invalid/report-alerts/${suffix}`,
    title: "合成已刊矿业报道",
    publishedAt: at,
    discoveredAt: at,
    via: "fetch",
  });
  await sql`INSERT INTO publications(article_id,title,summary,url,source_id,channel,discovered_at,timeline_at,sort_at,selected,eligible,visibility)
    VALUES(${articleId},'合成已刊矿业报道','合成条目，仅用于验证报告告警。',${`https://example.invalid/report-alerts/${suffix}`},${SOURCE},'news',${at},${at},${at},true,true,${visibility})`;
  await sql`UPDATE reports SET content=${sql.json({ sections: [{ label: "企业与项目", items: [{ itemId: articleId }] }], flashes: [] })}
    WHERE kind='daily' AND key='2026-09-30'`;
  return articleId;
}

test("withdrawn carried entries cannot turn a complete archive into a quiet month", async () => {
  await quietDailies("2026-09-01", "2026-09-30");
  const id = await carriedArticle("withdrawn", "withdrawn");
  await run("ok");
  const found = await monthlyFindings();
  assert.ok(found.some((finding) => finding.key === "report.monthly"));
  assert.match(found[0]!.detail ?? "", /0 条/);
  assert.equal((await sql`SELECT visibility FROM publications WHERE article_id=${id}`)[0]!.visibility, "withdrawn");
});

test("a real public candidate with a running catch-up still needs its monthly issue", async () => {
  await quietDailies("2026-09-01", "2026-09-30");
  await carriedArticle("public", "public");
  await run("running");
  const found = await monthlyFindings();
  assert.ok(found.some((finding) => finding.key === "report.monthly"));
  assert.match(found[0]!.detail ?? "", /1 条/);
});

test("pre-archive evidence never hides an already published empty or broken monthly issue", async () => {
  await quietDailies("2026-10-11", "2026-10-19");
  await run("ok");
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,origin)
    VALUES('monthly','2026-09','2026-09-01','2026-10-01',${sql.json({ overview: "", themes: [], storyOrder: [] })},now(),'rule')`;
  assert.ok((await monthlyFindings()).some((finding) => finding.key === "report.monthly.empty"));
  await sql`UPDATE reports SET content=${sql.json({ themes: "broken", storyOrder: [] })} WHERE kind='monthly' AND key='2026-09'`;
  assert.ok((await monthlyFindings()).some((finding) => finding.key === "report.monthly.broken"));
});
