import "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { getBoss, stopBoss } from "@amp/backend/jobs/queue";
import { collectFindings } from "@amp/backend/operations/alerts";
import { BALANCE_SETTING, deepseekBalance, lowBalances, readAccountBalances, recentDailySpend } from "../packages/backend/src/providers/account-balance.ts";

before(async () => void (await getBoss())); // collectFindings reads the job tables
after(async () => {
  await stopBoss();
  await closeDb();
});

const NOW = Date.parse("2026-11-12T06:00:00Z");
const day = (back: number) => new Date(NOW + 8 * 3600_000 - back * 86400_000).toISOString().slice(0, 10);
const answer = (total: string) => ({
  ok: true,
  json: async () => ({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: total, granted_balance: "0.00", topped_up_balance: total }] }),
});
const spend = async (yuanADay: number) => {
  for (let back = 1; back <= 7; back += 1)
    await sql`INSERT INTO ai.usage_sums(kind, key, context, settled_micros, unknown_micros) VALUES('day', ${day(back)}, '{}'::jsonb, ${String(yuanADay * 1_000_000)}, 0)`;
};

beforeEach(async () => {
  process.env.LLM_BASE_URL = "https://api.deepseek.com/v1";
  process.env.LLM_API_KEY = "sk-test-balance";
  await sql`DELETE FROM settings WHERE key = ${BALANCE_SETTING}`;
  await sql`DELETE FROM ai.usage_sums WHERE kind = 'day'`;
});

test("the provider's answer is read as yuan; anything else is no reading", () => {
  assert.equal(deepseekBalance({ balance_infos: [{ currency: "CNY", total_balance: "110.50" }] }), 110.5);
  assert.equal(deepseekBalance({ balance_infos: [{ currency: "USD", total_balance: "3.00" }] }), null);
  assert.equal(deepseekBalance({ balance_infos: [{ currency: "CNY", total_balance: "n/a" }] }), null);
  assert.equal(deepseekBalance({ error: "nope" }), null);
  assert.equal(deepseekBalance(null), null);
});

test("the balance is asked with the key in use and kept; a provider that does not answer keeps the earlier reading", async () => {
  const asked: { url: string; auth: string }[] = [];
  const read = await readAccountBalances({
    now: NOW,
    fetch: async (url, init) => {
      asked.push({ url, auth: init.headers.authorization! });
      return answer("25.00");
    },
  });
  assert.deepEqual(asked, [{ url: "https://api.deepseek.com/user/balance", auth: "Bearer sk-test-balance" }]);
  assert.deepEqual(read, { deepseek: { yuan: 25, at: new Date(NOW).toISOString() } });
  for (const broken of [async () => ({ ok: false, json: async () => ({}) }), async () => Promise.reject(new Error("timeout"))])
    assert.deepEqual(await readAccountBalances({ now: NOW + 60_000, fetch: broken }), {});
  const [kept] = await sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = ${BALANCE_SETTING}`;
  assert.deepEqual(kept!.value, read);
  assert.doesNotMatch(JSON.stringify(kept), /sk-test/, "the key is never stored");
});

test("another provider's address is not asked", async () => {
  process.env.LLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
  let asked = 0;
  await readAccountBalances({
    now: NOW,
    fetch: async () => {
      asked += 1;
      return answer("1.00");
    },
  });
  assert.equal(asked, 0);
});

test("warns below three days of recent spend, not above; a stale reading says nothing", async () => {
  await spend(10);
  assert.equal(await recentDailySpend(NOW), 10);
  await readAccountBalances({ now: NOW, fetch: async () => answer("31.00") });
  assert.deepEqual(await lowBalances(NOW), []);
  await readAccountBalances({ now: NOW, fetch: async () => answer("20.00") });
  assert.deepEqual(await lowBalances(NOW), [{ service: "deepseek", yuan: 20, days: 2, daily: 10 }]);
  assert.deepEqual(await lowBalances(NOW + 4 * 3600_000), [], "four hours old");
});

test("with no spend on record the line is five yuan", async () => {
  await readAccountBalances({ now: NOW, fetch: async () => answer("5.00") });
  assert.deepEqual(await lowBalances(NOW), []);
  await readAccountBalances({ now: NOW, fetch: async () => answer("4.99") });
  assert.deepEqual(await lowBalances(NOW), [{ service: "deepseek", yuan: 4.99, days: null, daily: null }]);
});

test("the alert says how much is left and how long it lasts, and closes after a top-up", async () => {
  await spend(10);
  const now = Date.now();
  await readAccountBalances({ now, fetch: async () => answer("14.20") });
  // Spend rows are keyed to NOW's days; move them to the real last week for collectFindings, which reads the clock.
  await sql`DELETE FROM ai.usage_sums WHERE kind = 'day'`;
  for (let back = 1; back <= 7; back += 1)
    await sql`INSERT INTO ai.usage_sums(kind, key, context, settled_micros, unknown_micros)
      VALUES('day', ${new Date(now + 8 * 3600_000 - back * 86400_000).toISOString().slice(0, 10)}, '{}'::jsonb, '10000000', 0)`;
  const low = (await collectFindings(now)).find((f) => f.key === "provider.balance.deepseek");
  assert.ok(low);
  assert.equal(low.title, "DeepSeek 余额只剩 ¥14.20，按最近用量约够 1 天");
  assert.equal(low.level, "today");
  assert.match(low.action ?? "", /充值/);
  assert.match(low.detail!, /日均花费 ¥10\.00/);
  await readAccountBalances({ now, fetch: async () => answer("214.20") });
  assert.equal(
    (await collectFindings(now)).some((f) => f.key === "provider.balance.deepseek"),
    false,
  );
});
