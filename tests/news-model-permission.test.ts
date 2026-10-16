import { stub, tag } from "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { chatJson } from "@amp/backend/providers/llm";
import { prepareNewsFallback } from "../packages/backend/src/providers/news-fallback.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
import { saveSourcePolicy } from "@amp/backend/admin/sources";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
const provider = await stub(() => ({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
process.env.DEEPSEEK_BASE_URL = provider.url;
process.env.DEEPSEEK_API_KEY = "synthetic";
after(async () => {
  await provider.close();
  await closeDb();
});
test("primary sends and cached reuse recheck actual source external_model permission", async () => {
  const sourceId = `permit-${tag()}`,
    url = "https://example.com/permit";
  await sql`INSERT INTO sources(id,name,kind) VALUES(${sourceId},'Test','rss')`;
  let policy = await grantDateFixture(sourceId, [url]);
  const m = await upsertMaterial({ sourceId, url, title: "材料", bodyText: "合成材料正文用于许可检验", via: "fetch" });
  await installUsageFixtureForModel("deepseek-flash");
  const prepare = () =>
    prepareNewsFallback({
      root: new AbortController().signal,
      expected: { id: m.articleId },
      current: async () => ({ id: m.articleId }),
      articles: [{ id: m.articleId, revision: 1 }],
    });
  const request = {
    model: "deepseek-flash",
    purpose: "summarize_article",
    subject: `article:${m.articleId}@1`,
    promptVersion: "permission-test",
    system: "test",
    user: "synthetic input",
    schema: z.object({ ok: z.boolean() }),
  };
  const input = await prepare();
  assert.ok(input);
  await chatJson({ ...request, fallbackPermit: input(request) });
  const hits = provider.hits();
  policy = await saveSourcePolicy(
    sourceId,
    {
      expectedVersion: policy.permission_version,
      policy: { ...policy, permissions: { ...policy.permissions, external_model: "deny" } },
      reason: "synthetic deny",
    },
    "test",
  );
  const denied = await prepare();
  assert.ok(denied);
  await assert.rejects(() => chatJson({ ...request, fallbackPermit: denied(request) }), /许可/);
  assert.equal(provider.hits(), hits);
  await assert.rejects(() => chatJson({ ...request, user: "new input", fallbackPermit: denied({ ...request, user: "new input" }) }), /许可/);
  assert.equal(provider.hits(), hits);
});

test("evaluation rejects unbound and edited inputs instead of trusting a claimed source ID", async () => {
  const { boundEvaluationFixture } = await import("./bound-eval-fixture.ts");
  const { prepareEvaluationInput } = await import("@amp/backend/editorial/analyze");
  const bound = await boundEvaluationFixture({
    title: "Synthetic mining evaluation",
    body: "Original synthetic mining material.",
    source: "Test evaluation",
    kind: "rss",
    tier: "T1",
    firstParty: true,
    publishedAt: null,
  });
  await assert.rejects(() => prepareEvaluationInput(undefined), /重新导出/);
  await assert.rejects(() => prepareEvaluationInput({ ...bound.analysisInput, bodyText: "Forged unrelated text" }, bound.inputFingerprint), /不一致/);
  assert.equal((await prepareEvaluationInput(bound.analysisInput, bound.inputFingerprint)).input.id, bound.analysisInput.id);
});
