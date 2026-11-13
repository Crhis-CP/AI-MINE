import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { z } from "zod";
import { sql, closeDb } from "@amp/backend/db";
import { chatJson, MODELS, type ModelRequestGuardContext } from "@amp/backend/providers/llm";
import { sha256 } from "@amp/backend/lib/ids";
import { stopBoss } from "@amp/backend/jobs/queue";
import { paidRequest, ProviderRejectedError } from "@amp/backend/providers/receipts";
import { boundEvaluationFixture } from "./bound-eval-fixture.ts";
import { materialFixturePermit } from "./model-source-fixture.ts";
import { installUsageFixtureForModel, installUsageFixtureForService } from "./usage-protection-fixture.ts";

const bodies: string[] = [];
const provider = await stub((_hit, request) => {
  bodies.push(request.body);
  return { choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "synthetic-send-quote-key";
beforeEach(() => installUsageFixtureForModel("deepseek-flash"));
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});
const ask = (subject: string) => ({
  model: "deepseek-flash",
  purpose: "send_quote_fixture",
  lane: "news" as const,
  subject,
  promptVersion: "quote-v1",
  system: "private-system-quote-marker",
  prefix: { material: "private-material-quote-marker", acknowledgement: "private-ack-quote-marker" },
  user: `private-user-quote-marker ${subject}`,
  maxTokens: 800,
  schema: z.object({ ok: z.boolean() }),
});

test("the real model send receives its own frozen quote and hard bounds without exposing request contents", async () => {
  const contexts: ModelRequestGuardContext[] = [];
  const options = {
    ...ask(`send-quote-${tag()}`),
    beforeRequest: async (context?: ModelRequestGuardContext) => {
      if (context) contexts.push(context);
    },
  };
  const before = provider.hits(),
    first = await chatJson(options);
  const send = contexts.find((one) => one.phase === "send");
  assert.ok(send, "every physical send must carry its actual quote context");
  assert.equal(send.receiptId, first.receiptId);
  assert.equal(send.attemptId, first.attemptId);
  assert.equal(send.requestHash, sha256(bodies.at(-1)!));
  const [row] = await sql`SELECT reserved_micros::text,quote FROM ai.usage_attempts WHERE attempt_id=${first.attemptId}`;
  assert.ok(send.quote, "an explicitly registered zero price is still a valid quote");
  assert.equal(send.quote.reservedMicros, row.reserved_micros);
  assert.deepEqual(send.quote.bounds, row.quote.bounds);
  assert.equal(send.quote.bounds?.output_tokens, 800);
  assert.equal(send.quote.bounds?.input_tokens, Buffer.byteLength(bodies.at(-1)!));
  assert.ok(Object.isFrozen(send) && Object.isFrozen(send.quote) && Object.isFrozen(send.quote.bounds));
  for (const marker of ["synthetic-send-quote-key", "private-system-quote-marker", "private-material-quote-marker", "private-user-quote-marker"])
    assert.ok(!JSON.stringify(send).includes(marker));
  const second = await chatJson(options);
  assert.equal(second.receiptId, first.receiptId);
  assert.equal(second.reused, true);
  assert.equal(provider.hits() - before, 1);
  assert.equal(contexts.filter((one) => one.phase === "send").length, 1, "free reuse creates no paid-send admission");
});

test("a real 0.20-yuan quote is refused with only 0.15 left, before transport and without unknown debt", async () => {
  await sql`UPDATE ai.usage_prices SET price=jsonb_set(price,'{output_per_million_micros}','"100000000"'),version=version+1 WHERE price->>'service'='deepseek'`;
  const options = { ...ask(`reject-${tag()}`), maxTokens: 2000 },
    before = provider.hits();
  await assert.rejects(
    chatJson({
      ...options,
      beforeRequest: async (context) => {
        if (context?.phase !== "send") return;
        assert.equal(context.quote?.reservedMicros, "200000");
        if (BigInt(context.quote.reservedMicros) > 150000n) throw new Error("experiment remainder cannot cover this call");
      },
    }),
    ProviderRejectedError,
  );
  assert.equal(provider.hits(), before);
  const [row] = await sql`SELECT a.status,a.failure_kind,u.state,u.settled_micros::text FROM receipt_attempts a
    JOIN receipts r ON r.id=a.receipt_id JOIN ai.usage_attempts u ON u.attempt_id=a.id WHERE r.subject=${options.subject}`;
  assert.deepEqual([row.status, row.failure_kind, row.state, row.settled_micros], ["failed", "input_changed", "failed", null]);
  assert.equal((await sql`SELECT coalesce(sum(reserved_micros),0)::text n FROM ai.usage_sums WHERE kind='day'`)[0].n, "0");
});

test("missing or inconsistent pricing can stop an experiment while old no-argument guards keep their defaults", async () => {
  for (const mode of ["missing", "mismatch", "expired", "foreign"]) {
    await installUsageFixtureForModel("deepseek-flash");
    if (mode === "mismatch") await sql`UPDATE ai.usage_prices SET price=jsonb_set(price,'{model}','"different-model"') WHERE price->>'service'='deepseek'`;
    else if (mode === "expired")
      await sql`UPDATE ai.usage_prices SET price=jsonb_set(price,'{valid_until}',to_jsonb(${new Date(Date.now() - 86400_000).toISOString().slice(0, 10)}::text)) WHERE price->>'service'='deepseek'`;
    else if (mode === "foreign") await sql`UPDATE ai.usage_prices SET price=jsonb_set(price,'{currency}','"USD"') WHERE price->>'service'='deepseek'`;
    else await sql`DELETE FROM ai.usage_prices WHERE price->>'service'='deepseek'`;
    const before = provider.hits();
    await assert.rejects(
      chatJson({
        ...ask(`unpriced-${tag()}`),
        beforeRequest: async (context) => {
          if (context?.phase === "send") {
            assert.equal(context.quote, null);
            throw new Error("no verifiable quote");
          }
        },
      }),
      ProviderRejectedError,
    );
    assert.equal(provider.hits(), before);
    await installUsageFixtureForModel("deepseek-flash");
  }
  await sql`DELETE FROM ai.usage_prices WHERE price->>'service'='deepseek'`;
  let checked = 0;
  const before = provider.hits();
  await chatJson({
    ...ask(`legacy-${tag()}`),
    beforeRequest: async () => {
      checked++;
    },
  });
  assert.equal(provider.hits() - before, 1);
  assert.equal(checked, 1, "the additive interface does not change default admission");
});

test("actual extra overrides and think allowance are included, while unknown sample multiplication is uncertifiable", async () => {
  const spec = MODELS["deepseek-flash-think"]!,
    original = spec.extra;
  try {
    for (const [extra, limit] of [
      [undefined, 4800],
      [{ max_tokens: 1200 }, 1200],
    ] as const) {
      spec.extra = extra;
      await installUsageFixtureForModel(spec.key);
      let bound = 0;
      await chatJson({
        ...ask(`limits-${tag()}`),
        model: spec.key,
        beforeRequest: async (context) => {
          if (context?.phase === "send") bound = context.quote?.bounds?.output_tokens ?? 0;
        },
      });
      assert.equal(bound, limit);
      assert.equal(JSON.parse(bodies.at(-1)!).max_tokens, limit);
    }
    spec.extra = { n: 2 };
    await installUsageFixtureForModel(spec.key);
    const before = provider.hits();
    await assert.rejects(
      chatJson({
        ...ask(`unknown-limits-${tag()}`),
        model: spec.key,
        beforeRequest: async (context) => {
          if (context?.phase === "send") {
            assert.equal(context.quote, null);
            assert.equal(context.issue, "unsupported_request_options");
            throw new Error("unbounded request");
          }
        },
      }),
      ProviderRejectedError,
    );
    assert.equal(provider.hits(), before);
  } finally {
    spec.extra = original;
  }
});

test("the permit wrapper distinguishes preflight and forwards this send's quote", async () => {
  const f = await boundEvaluationFixture({
    title: tag(),
    body: "Synthetic mining material",
    source: tag(),
    tier: "T1",
    kind: "rss",
    firstParty: true,
    publishedAt: new Date().toISOString(),
  });
  assert.ok(f.analysisInput.bodyText);
  const request = { system: "Return a synthetic boolean", user: f.analysisInput.bodyText };
  const phases: string[] = [];
  await chatJson({
    ...ask(`article:${f.analysisInput.id}@${f.analysisInput.revision}`),
    ...request,
    prefix: undefined,
    purpose: "score_article",
    usagePurpose: "evaluation",
    sourceIds: [f.analysisInput.sourceId!],
    fallbackPermit: await materialFixturePermit(f.analysisInput.id, request),
    beforeRequest: async (context) => {
      phases.push(context?.phase ?? "missing");
      if (context?.phase === "send") assert.ok(context.quote);
    },
  });
  assert.deepEqual(phases, ["prepare", "send"]);
});

test("a price window that changes after admission is frozen again before the actual send", async (t) => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  t.mock.timers.enable({ apis: ["Date"], now });
  await installUsageFixtureForService("deepseek");
  const windows = [
    {
      starts_at: new Date(now - 1000).toISOString().replace(".000Z", "Z"),
      ends_at: new Date(now + 1000).toISOString().replace(".000Z", "Z"),
      input_per_million_micros: "0",
      cache_hit_input_per_million_micros: null,
      output_per_million_micros: "1000000",
    },
  ];
  await sql`UPDATE ai.usage_prices SET price=price||${sql.json({ input_per_million_micros: "0", output_per_million_micros: "100000000", rate_windows: windows })} WHERE price->>'service'='deepseek' AND price->>'model'=''`;
  let observed = "";
  const result = await paidRequest(
    {
      service: "deepseek",
      purpose: "quote_window_fixture",
      subject: tag(),
      identity: tag(),
      lane: "news",
      usageContext: { lane: "news", capability: "quote_window_fixture", sourceIds: [], object: null },
      costBounds: { input_tokens: 10, output_tokens: 2000 },
    },
    async (context) => {
      observed = context.quote?.reservedMicros ?? "missing";
      return { response: { ok: true }, usage: { prompt_tokens: 0, completion_tokens: 1 } };
    },
    async () => {
      t.mock.timers.setTime(now + 2000);
    },
  );
  assert.equal(observed, "200000");
  const [row] = await sql`SELECT reserved_micros::text,quote FROM ai.usage_attempts WHERE attempt_id=${result.attemptId}`;
  assert.equal(row.reserved_micros, observed);
  assert.equal(row.quote.quoted_at, new Date(now + 2000).toISOString());
});
