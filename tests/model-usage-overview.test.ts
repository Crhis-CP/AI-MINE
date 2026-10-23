import { tag } from "./setup.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { sql, closeDb } from "@amp/backend/db";
import { modelsOverview } from "@amp/backend/admin/models";

after(closeDb);
const key = tag(),
  model = `custom-model-${key}`,
  service = `custom-service-${key}`;
async function record(
  cost: number | null,
  currency: string | null,
  basis: "actual" | "estimated" | null,
  provider = service,
  usage: Record<string, number> | null = { prompt_tokens: 100, completion_tokens: 10 },
  status = usage ? "received" : "unknown",
) {
  const [r] =
    await sql`INSERT INTO receipts(logical_key,service,purpose,status,request) VALUES(${`usage-${tag()}`},${provider},'translate_body',${status === "received" ? "completed" : status},'{}') RETURNING id`;
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,cost,cost_basis,currency,usage) VALUES(${r!.id},1,${provider},${model},${status},${cost},${basis},${currency},${sql.json(usage)})`;
}
test("model overview preserves historical estimates and separates currencies and providers", async () => {
  await record(1, "CNY", "actual");
  await record(2, "CNY", "estimated");
  await record(0.5, "USD", "actual");
  await record(7, "CNY", "actual", `${service}-other`);
  await record(null, null, null, service, null);
  await sql`INSERT INTO service_prices(service,model,currency,input_per_mtok,output_per_mtok) VALUES(${service},${model},'CNY',999,999)`;
  const overview = await modelsOverview();
  const rows = overview.capabilities.find((c) => c.key === "translate")!.usage.filter((u) => u.model === model);
  assert.equal(rows.length, 4);
  const cny = rows.find((u) => u.service === service && u.currency === "CNY")!;
  assert.equal(cny.calls, 2);
  assert.equal(cny.actualCost, 1);
  assert.deepEqual(cny.estimate, { amount: 2, currency: "CNY" });
  const usd = rows.find((u) => u.currency === "USD")!;
  assert.equal(usd.actualCost, 0.5);
  assert.equal(usd.estimate, null);
  assert.equal(rows.find((u) => u.service === `${service}-other`)!.actualCost, 7);
  const unknown = rows.find((u) => u.currency === null)!;
  assert.equal(unknown.unpricedCalls, 1);
  assert.equal(unknown.estimate, null);
  assert.equal(unknown.actualCost, null);
  await sql`UPDATE service_prices SET input_per_mtok=1,output_per_mtok=2 WHERE service=${service}`;
  assert.deepEqual(
    new Set((await modelsOverview()).capabilities.find((c) => c.key === "translate")!.usage.filter((u) => u.model === model)),
    new Set(rows),
    "today's price changes neither saved amounts nor missing costs",
  );
  await record(0, "CNY", "estimated", `${service}-zero`);
  await record(0, "CNY", "actual", `${service}-zero`);
  const zero = (await modelsOverview()).capabilities.find((c) => c.key === "translate")!.usage.find((u) => u.service === `${service}-zero`)!;
  assert.deepEqual(zero.estimate, { amount: 0, currency: "CNY" }, "a known zero estimate keeps its estimate label");
  assert.equal(zero.actualCost, 0);
  assert.equal(zero.unpricedCalls, 0);
});

test("known tokens cannot fill a missing historical amount from today's price", async () => {
  const provider = `${service}-unpriced`;
  await record(null, null, null, provider, { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
  await sql`INSERT INTO service_prices(service,model,currency,input_per_mtok,output_per_mtok) VALUES(${provider},${model},'CNY',2,8)`;
  const read = async () => (await modelsOverview()).capabilities.find((c) => c.key === "translate")!.usage.find((u) => u.service === provider)!;
  const before = await read();
  assert.equal(before.actualCost, null);
  assert.equal(before.estimate, null);
  assert.equal(before.unpricedCalls, 1);
  await sql`UPDATE service_prices SET input_per_mtok=200,output_per_mtok=800 WHERE service=${provider}`;
  assert.deepEqual(await read(), before);
});

test("an unknown attempt with zero reported tokens never becomes a zero cost estimate", async () => {
  const provider = `${service}-unknown-zero`;
  await record(null, null, null, provider, { prompt_tokens: 0, completion_tokens: 0 }, "unknown");
  await sql`INSERT INTO service_prices(service,model,currency,input_per_mtok,output_per_mtok) VALUES(${provider},${model},'CNY',2,8)`;
  const row = (await modelsOverview()).capabilities.find((c) => c.key === "translate")!.usage.find((u) => u.service === provider)!;
  assert.equal(row.unknown, 1);
  assert.equal(row.unpricedCalls, 1);
  assert.equal(row.actualCost, null);
  assert.equal(row.estimate, null);
});

test("missing amount, currency or basis is counted without hiding complete costs in the same group", async () => {
  const cases: Array<[number | null, string | null, "actual" | "estimated" | null]> = [
    [null, "CNY", "actual"],
    [3, null, "actual"],
    [4, null, "estimated"],
    [5, " ", "actual"],
    [6, "CNY", null],
  ];
  for (const [index, [cost, currency, basis]] of cases.entries()) {
    const provider = `${service}-missing-${index}`;
    await record(cost, currency, basis, provider);
    const row = (await modelsOverview()).capabilities.find((c) => c.key === "translate")!.usage.find((u) => u.service === provider)!;
    assert.equal(row.unpricedCalls, 1, `missing fee field case ${index}`);
    assert.equal(row.actualCost, null);
    assert.equal(row.estimate, null);
  }
  const provider = `${service}-partial`;
  await record(1, "CNY", "actual", provider);
  await record(2, "CNY", "estimated", provider);
  await record(null, "CNY", "actual", provider);
  await record(6, "CNY", null, provider);
  const row = (await modelsOverview()).capabilities.find((c) => c.key === "translate")!.usage.find((u) => u.service === provider)!;
  assert.equal(row.calls, 4);
  assert.equal(row.actualCost, 1);
  assert.deepEqual(row.estimate, { amount: 2, currency: "CNY" });
  assert.equal(row.unpricedCalls, 2);
});
