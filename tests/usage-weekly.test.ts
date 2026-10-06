// The Monday usage report (TASK-0064): last week's paid calls by service and by capability against the week
// before, amounts in their own currency (recorded, estimated at call time, or by the registered price, and
// "未登记单价" with the count when there is no price, never 0), the days the meter stopped a service, and the
// requests still to reconcile. Sent once per week; nothing goes out with alerts off. Feishu is answered here.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { recordRun, stopBoss } from "@amp/backend/jobs/queue";
import { usageWeekly } from "@amp/backend/operations/reports";

const sql = dbOf("ai-gateway");
const ops = dbOf("ops");
const T = tag();
const [ACTUAL, ESTIMATED, PRICED, UNPRICED] = ["actual", "estimated", "priced", "unpriced"].map((s) => `test-weekly-${s}-${T}`) as [
  string,
  string,
  string,
  string,
];
// Mondays 09:05 in Beijing, far from the real date and from the alert tests' windows: last weeks 2100-W24, W27, W28.
const W24 = Date.parse("2100-06-21T01:05:00Z"),
  W27 = Date.parse("2100-07-12T01:05:00Z"),
  W28 = Date.parse("2100-07-19T01:05:00Z");
const at = (beijing: string) => new Date(`${beijing}+08:00`);

process.env.FEISHU_INTERNAL_ENABLED = "true";
process.env.FEISHU_APP_ID = "test-app";
process.env.FEISHU_APP_SECRET = "test-secret";
process.env.FEISHU_ALERT_CHAT_ID = "oc_alert_test";
const messages: string[] = [];
let requests = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  requests++;
  if (url.hostname === "open.feishu.cn" && url.pathname === "/open-apis/auth/v3/tenant_access_token/internal")
    return Response.json({ code: 0, tenant_access_token: "t-test", expire: 7200 });
  if (url.hostname === "open.feishu.cn" && url.pathname === "/open-apis/im/v1/messages") {
    messages.push((JSON.parse((JSON.parse(String(init?.body)) as { content: string }).content) as { text: string }).text);
    return Response.json({ code: 0, data: { message_id: "om_test" } });
  }
  throw new Error(`unexpected request ${url.href}`);
}) as typeof fetch;
after(async () => {
  globalThis.fetch = realFetch;
  await stopBoss();
  await closeDb();
});

async function call(o: {
  service: string;
  purpose: string;
  at: Date;
  status?: string;
  tokens?: [number, number];
  cost?: [number, string, string];
  origin?: string;
}) {
  const origin = o.origin ?? "live";
  const [r] = await sql<{ id: number }[]>`INSERT INTO receipts (logical_key, service, purpose, status, origin)
    VALUES (${`test-weekly:${randomUUID()}`}, ${o.service}, ${o.purpose}, 'received', ${origin}) RETURNING id`;
  const [cost, currency, basis] = o.cost ?? [null, null, null];
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, origin, status, usage, cost, currency, cost_basis, started_at)
    VALUES (${r!.id}, 1, ${o.service}, ${origin}, ${o.status ?? "received"},
      ${sql.json({ prompt_tokens: o.tokens?.[0] ?? 0, completion_tokens: o.tokens?.[1] ?? 0 })}, ${cost}, ${currency}, ${basis}, ${o.at})`;
}
const lineOf = (text: string, name: string) => text.split("\n").find((l) => l.startsWith(`· ${name}：`)) ?? "";

test("each service and capability against the week before, amounts kept apart, unpriced calls never shown as 0", async () => {
  for (const day of ["2100-06-15T10:00:00", "2100-06-16T10:00:00"])
    await call({ service: ACTUAL, purpose: "score_article", at: at(day), tokens: [100, 50], cost: [1.5, "CNY", "actual"] });
  await call({ service: ACTUAL, purpose: "score_article", at: at("2100-06-08T10:00:00"), tokens: [100, 50], cost: [1.5, "CNY", "actual"] });
  await call({ service: ACTUAL, purpose: "score_article", at: at("2100-06-15T11:00:00"), cost: [9, "CNY", "actual"], origin: "replay" });
  await call({ service: ESTIMATED, purpose: "translate_body", at: at("2100-06-17T10:00:00"), cost: [0.4, "USD", "estimated"] });
  await call({ service: ESTIMATED, purpose: "translate_body", at: at("2100-06-17T11:00:00"), cost: [1, "USD", "actual"] });
  await call({ service: PRICED, purpose: "summarize_article", at: at("2100-06-18T10:00:00"), tokens: [1_000_000, 500_000] });
  await sql`INSERT INTO service_prices (service, model, currency, input_per_mtok, output_per_mtok) VALUES (${PRICED}, '', 'CNY', 2, 8)`;
  for (const status of ["received", "received", "failed"]) await call({ service: UNPRICED, purpose: "test_purpose", at: at("2100-06-19T10:00:00"), status });
  await sql`INSERT INTO receipts (logical_key, service, purpose, status, origin) VALUES (${`test-weekly:${randomUUID()}`}, ${UNPRICED}, 'test_purpose', 'unknown', 'live')`;
  // The meter: coverage from Monday 00:10; the same service stopped by the hour and the day on one day, again another day.
  for (const [when, opened] of [
    ["2100-06-14T00:10:00", []],
    ["2100-06-15T10:00:00", [`budget.hour.${ACTUAL}`]],
    ["2100-06-15T15:00:00", [`budget.day.${ACTUAL}`]],
    ["2100-06-17T10:00:00", [`budget.hour.${ACTUAL}`]],
  ] as const)
    await ops`INSERT INTO job_runs (job, started_at, finished_at, status, detail)
      VALUES ('ops.alerts', ${at(when)}, ${at(when)}, 'ok', ${ops.json({ open: [], sent: [], opened: [...opened] })})`;

  const result = await usageWeekly(W24);
  const [pending] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipts WHERE status = 'unknown'`;
  assert.equal(result.sent, true);
  const text = messages.at(-1)!;
  assert.match(text, /用量周报 · 6月14日至6月20日/);
  assert.match(text, /上周付费调用 8 次（前一周 1 次，\+700%）/);
  assert.equal(
    lineOf(text, ACTUAL),
    `· ${ACTUAL}：2 次（+100%；成功 2、失败 0、结果未知 0），输入 200 token（+100%）、输出 100 token（+100%），金额 ¥3.00（+100%）`,
  );
  assert.match(lineOf(text, ESTIMATED), /2 次（—；.*金额 \$1\.40（—；实际 \$1\.00、估算 \$0\.40）$/);
  assert.match(lineOf(text, PRICED), /输入 1,000,000 token（—）、输出 500,000 token（—），金额 估算 ¥6\.00（—）$/);
  assert.match(lineOf(text, UNPRICED), /3 次（—；成功 2、失败 1、结果未知 0），.*金额 另有 3 次未登记单价$/);
  assert.doesNotMatch(lineOf(text, UNPRICED), /[¥$]0/);
  assert.match(lineOf(text, "精选评分"), /^· 精选评分：2 次（\+100%/);
  assert.match(lineOf(text, "其他"), /^· 其他：3 次/);
  assert.match(text, new RegExp(`自动暂停：上周有 2 天出现过自动暂停（${ACTUAL} 2 天）\n`));
  assert.match(text, new RegExp(`待核对：还有 ${pending!.n} 笔付费请求结果未知`));
});

test("a week without paid calls still gets its report, and says when the meter has no record yet", async () => {
  const result = await usageWeekly(W27);
  assert.deepEqual([result.sent, result.calls], [true, 0]);
  assert.match(messages.at(-1)!, /上周没有付费调用（前一周 0 次）\n\n自动暂停：上周还没有这项记录/);
});

test("one report per week: a second run of the job for the same week sends nothing", async () => {
  const before = messages.length;
  const first = await recordRun("reports.usage-weekly", () => usageWeekly(W24));
  const second = await recordRun("reports.usage-weekly", () => usageWeekly(W24));
  assert.deepEqual([first.sent, first.lastSentWeek, second.sent, second.lastSentWeek], [true, "2100-W24", false, "2100-W24"]);
  assert.equal(messages.length, before + 1);
});

test("with alerts off nothing is requested and the week last sent stays as it was", async () => {
  process.env.FEISHU_INTERNAL_ENABLED = "false";
  try {
    const seen = requests;
    const result = await recordRun("reports.usage-weekly", () => usageWeekly(W28));
    assert.deepEqual([result.week, result.sent, result.lastSentWeek], ["2100-W28", false, "2100-W24"]);
    assert.equal(requests, seen);
  } finally {
    process.env.FEISHU_INTERNAL_ENABLED = "true";
  }
});
