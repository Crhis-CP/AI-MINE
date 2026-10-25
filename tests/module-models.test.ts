import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { sql, closeDb } from "@amp/backend/db";
import { installModules, serverModules, type ModelStep } from "@amp/backend/modules";
import { capabilities, modelFor, modelSources, CAPABILITIES } from "@amp/backend/editorial/models";
import { modelsOverview, switchModel, currentModelConfiguration } from "@amp/backend/admin/models";
import { chatJson } from "@amp/backend/providers/llm";
import { upsertMaterial } from "@amp/backend/content/materials";
import { prepareNewsFallback } from "../packages/backend/src/providers/news-fallback.ts";
import { evaluateUsageProtection } from "../packages/backend/src/providers/usage-protection.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { grantDateFixture } from "./source-date-fixture.ts";

const prior = serverModules();
const step = { label: "合成模块阅读", env: "SYNTHETIC_MODULE_MODEL", lane: "news" as const, purposes: ["synthetic_module_read"] };
const provider = await stub(() => ({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
process.env.DEEPSEEK_BASE_URL = provider.url;
process.env.DEEPSEEK_API_KEY = "synthetic";
process.env.SYNTHETIC_MODULE_MODEL = "deepseek-flash";
after(async () => {
  installModules(prior);
  delete process.env.SYNTHETIC_MODULE_MODEL;
  await provider.close();
  await closeDb();
});
const install = () =>
  installModules([
    ...prior,
    {
      name: "synthetic-models",
      models: {
        module_read: step,
        module_policy: { ...step, lane: "policy", purposes: ["synthetic_module_policy"] },
        legacy_metadata: { label: "旧元数据", env: step.env, purposes: ["synthetic_missing_lane"] },
        score: { ...step, env: "CANNOT_REPLACE_SCORE", purposes: ["cannot_replace_score"] },
      },
    },
  ]);

test("installed model steps share admin choices, overview and route lookup without replacing core", async () => {
  install();
  assert.equal(capabilities().score!.env, CAPABILITIES.score.env);
  assert.equal(capabilities().module_read!.lane, "news");
  assert.equal(await modelFor("module_read"), "deepseek-flash");
  assert.equal((await modelSources()).module_read!.source, "env");
  await switchModel("module_read", "deepseek-flash-think", "合成切换", "test");
  assert.equal(await modelFor("module_read"), "deepseek-flash-think");
  assert.equal((await currentModelConfiguration("module_read")).requestedModel, "deepseek-flash");
  const overview = await modelsOverview();
  assert.equal(overview.capabilities.find((c) => c.key === "module_read")?.current.source, "admin");
  await switchModel("module_read", null, "合成恢复", "test");
  assert.equal(await modelFor("module_read"), "deepseek-flash");
  for (const key of ["legacy_metadata", "constructor", "toString", "__proto__"]) {
    await assert.rejects(modelFor(key));
    await assert.rejects(switchModel(key, "deepseek-flash", "合成拒绝", "test"));
  }
  installModules(prior);
  await assert.rejects(modelFor("module_read"), /Unknown model capability/);
  assert.ok(!(await modelsOverview()).capabilities.some((c) => c.key === "module_read"));
});

test("purpose collisions and inherited keys cannot redirect existing processing", () => {
  const invalid: Record<string, ModelStep>[] = [
    { other: { ...step, purposes: ["score_article"] } },
    { first: step, second: { ...step, lane: "policy" as const } },
    { constructor: step },
  ];
  for (const models of invalid) {
    installModules([...prior, { name: "synthetic-invalid", models }]);
    assert.throws(capabilities, /Invalid or ambiguous model step/);
  }
  install();
});

test("module calls keep declared lanes, current permits, processing pause and accounted use", async () => {
  install();
  const sourceId = `module-${tag()}`,
    url = `https://example.com/${sourceId}`;
  await sql`INSERT INTO sources(id,name,kind) VALUES(${sourceId},'合成模块来源','rss')`;
  await grantDateFixture(sourceId, [url]);
  const material = await upsertMaterial({ sourceId, url, title: "合成材料", bodyText: "仅用于本地许可回归", via: "fetch" });
  await installUsageFixtureForModel("deepseek-flash");
  const permit = await prepareNewsFallback({
    root: new AbortController().signal,
    expected: { id: material.articleId },
    current: async () => ({ id: material.articleId }),
    articles: [{ id: material.articleId, revision: 1 }],
  });
  assert.ok(permit);
  const request = {
    model: "deepseek-flash",
    purpose: step.purposes[0]!,
    subject: `article:${material.articleId}@1`,
    promptVersion: "module-test",
    system: "synthetic",
    user: "synthetic",
    schema: z.object({ ok: z.boolean() }),
  };
  const before = provider.hits();
  await assert.rejects(chatJson(request), /缺少当前材料许可/);
  await assert.rejects(chatJson({ ...request, lane: "policy" }), /lane mismatch/);
  await assert.rejects(chatJson({ ...request, purpose: "synthetic_missing_lane", lane: "news" }), /explicit lane/);
  await assert.rejects(chatJson({ ...request, purpose: "synthetic_module_policy" }), /policy gateway/);
  assert.equal(provider.hits(), before);
  const response = await chatJson({ ...request, fallbackPermit: permit(request) });
  const [usage] = await sql`SELECT lane,capability FROM ai.usage_attempts WHERE receipt_id=${response.receiptId}`;
  assert.deepEqual({ lane: usage.lane, capability: usage.capability }, { lane: "news", capability: step.purposes[0] });
  await sql`UPDATE ops.lane_controls SET paused=true,reason='合成暂停',actor='test',expires_at=now()+interval '1 hour' WHERE lane='news' AND switch='processing' AND holder='owner'`;
  try {
    const next = { ...request, user: "different synthetic input" };
    await assert.rejects(chatJson({ ...next, fallbackPermit: permit(next) }), /暂停|paused/i);
    assert.equal(provider.hits(), before + 1);
  } finally {
    await sql`UPDATE ops.lane_controls SET paused=false WHERE lane='news' AND switch='processing' AND holder='owner'`;
  }
});

test("recorded module costs use only declared historical attribution and never invent a missing lane", async () => {
  install();
  for (const purpose of [step.purposes[0]!, "synthetic_missing_lane"]) {
    const [receipt] =
      await sql`INSERT INTO receipts(logical_key,service,purpose,status,request) VALUES(${tag()},'synthetic-module',${purpose},'received','{}') RETURNING id`;
    await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,cost,cost_basis,currency,response) VALUES(${receipt.id},1,'synthetic-module','synthetic','received',1,'actual','CNY','{}')`;
  }
  const [explicit] =
    await sql`INSERT INTO receipts(logical_key,service,purpose,status,request) VALUES(${tag()},'synthetic-module',${step.purposes[0]!},'received','{"lane":"news"}') RETURNING id`;
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,cost,cost_basis,currency,response) VALUES(${explicit.id},1,'synthetic-module','synthetic','received',1,'actual','CNY','{}')`;
  await evaluateUsageProtection();
  assert.equal((await sql`SELECT count(*)::int AS n FROM ai.usage_attempts WHERE capability='synthetic_missing_lane'`)[0].n, 0);
  assert.equal(
    (await sql`SELECT count(*)::int AS n FROM ai.usage_attempts WHERE capability=${step.purposes[0]!} AND settled_micros=1000000 AND lane='news'`)[0].n,
    1,
  );
  const before = await sql`SELECT attempt_id,settled_micros FROM ai.usage_attempts WHERE capability=${step.purposes[0]!} ORDER BY attempt_id`;
  await evaluateUsageProtection();
  assert.deepEqual(await sql`SELECT attempt_id,settled_micros FROM ai.usage_attempts WHERE capability=${step.purposes[0]!} ORDER BY attempt_id`, before);
  const usage = (await modelsOverview()).capabilities.find((c) => c.key === "module_read")!.usage;
  assert.ok(usage.some((u) => u.service === "synthetic-module" && u.actualCost === 2));
});
