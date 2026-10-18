import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { z } from "zod";
import { sql, closeDb } from "@amp/backend/db";
import { chatJson, ModelOutputError } from "@amp/backend/providers/llm";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";

let finishReason = "length";
const provider = await stub(() => ({
  choices: [{ message: { content: '{"ok":true}' }, finish_reason: finishReason }],
  usage: { prompt_tokens: 80, completion_tokens: 512, total_tokens: 592 },
}));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
before(() => installUsageFixtureForModel("deepseek-flash"));
after(async () => {
  await provider.close();
  await closeDb();
});

const ask = (subject: string, maxTokens: number) =>
  chatJson({
    model: "deepseek-flash",
    purpose: "invariant_test",
    lane: "news",
    subject,
    promptVersion: "truncation-fixture",
    system: "fixture",
    user: `input ${subject}`,
    schema: z.object({ ok: z.boolean() }),
    maxTokens,
  });

test("an explicitly truncated answer is rejected even when parseable, and five identical retries make only one paid request", async () => {
  const subject = `truncated-${tag()}`;
  const hits = provider.hits();
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) {
    await assert.rejects(ask(subject, 512), (error: unknown) => {
      assert.ok(error instanceof ModelOutputError);
      assert.match(error.message, /长度上限/);
      assert.notEqual(error.receiptId, null);
      ids.push(error.receiptId!);
      return true;
    });
  }
  assert.equal(provider.hits() - hits, 1);
  assert.equal(new Set(ids).size, 1);
  const [saved] = await sql`SELECT status,attempts,response->'choices'->0->>'finish_reason' AS finish FROM receipts WHERE id=${ids[0]!}`;
  assert.deepEqual([saved!.status, saved!.attempts, saved!.finish], ["failed", 1, "length"]);
  const [charged] = await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id=${ids[0]!} AND status='received'`;
  assert.equal(charged!.n, 1);

  finishReason = "stop";
  const repaired = await ask(subject, 2560);
  assert.equal(repaired.data.ok, true);
  assert.notEqual(repaired.receiptId, ids[0]);
  assert.equal(provider.hits() - hits, 2, "an intentional output-budget correction may make one new request");
  const cached = await ask(subject, 2560);
  assert.equal(cached.reused, true);
  assert.equal(provider.hits() - hits, 2);
});
