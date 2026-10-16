import { tag } from "./setup.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { dbOf, closeDb } from "@amp/backend/db";
import { modelsOverview } from "@amp/backend/admin/models";
const sql = dbOf("ai-gateway");
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
) {
  const [r] =
    await sql`INSERT INTO receipts(logical_key,service,purpose,status,request) VALUES(${`usage-${tag()}`},${provider},'translate_body',${usage ? "completed" : "unknown"},'{}') RETURNING id`;
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,cost,cost_basis,currency,usage) VALUES(${r!.id},1,${provider},${model},${usage ? "received" : "unknown"},${cost},${basis},${currency},${sql.json(usage)})`;
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
  await record(0, "CNY", "estimated", `${service}-zero`);
  const zero = (await modelsOverview()).capabilities.find((c) => c.key === "translate")!.usage.find((u) => u.service === `${service}-zero`)!;
  assert.deepEqual(zero.estimate, { amount: 0, currency: "CNY" }, "a known zero estimate keeps its estimate label");
});
