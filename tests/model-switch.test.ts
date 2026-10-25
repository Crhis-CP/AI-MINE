import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { switchModel } from "@amp/backend/admin/models";
import { capabilities, CAPABILITIES, modelFor, modelSources } from "@amp/backend/editorial/models";
import { modelPresetReady } from "@amp/backend/providers/llm";

after(closeDb);

test("undeclared capabilities cannot be activated by leftover settings or inherited object keys", async () => {
  assert.deepEqual(Object.fromEntries(Object.entries(capabilities()).map(([key, { lane, ...step }]) => [key, step])), CAPABILITIES);
  const key = "synthetic_unregistered";
  await sql`INSERT INTO settings(key,value) VALUES(${`models.${key}`},${sql.json({ model: "deepseek-flash" })}) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
  try {
    for (const capability of [key, "constructor", "__proto__", "toString"]) await assert.rejects(modelFor(capability), /Unknown model capability/);
  } finally {
    await sql`DELETE FROM settings WHERE key=${`models.${key}`}`;
  }
});

test("model switching validates capability and keeps one route revision clock", async () => {
  await assert.rejects(switchModel("not-a-step", "default", "更换模型", "admin:1"), (e: { statusCode?: number }) => e.statusCode === 400);
  await assert.rejects(switchModel("prefilter", "default", " ", "admin:1"));
  await assert.rejects(switchModel("policy_vision", "deepseek-flash", "视觉环节", "admin:1"), /需要能看图/);
  if (!modelPresetReady("mimo-v2.6-flash")) await assert.rejects(switchModel("summarize", "mimo-v2.6-flash", "尚未配置", "admin:1"), /没有可用的接口/);
  process.env.PREFILTER_MODEL = "deepseek-flash";
  assert.equal(await modelFor("prefilter"), "deepseek-flash");
  assert.equal((await modelSources()).prefilter!.source, "env");
  process.env.DASHSCOPE_API_KEY = "synthetic-only";
  process.env.DASHSCOPE_BASE_URL = "https://fixture.invalid/v1";
  await switchModel("prefilter", "qwen3-vl-flash", "支持文字的多模态模型", "admin:1");
  assert.equal(await modelFor("prefilter"), "qwen3-vl-flash");
  assert.equal((await modelSources()).prefilter!.source, "admin");
  const [first] = await sql`SELECT revision FROM ai.model_routes WHERE capability='prefilter'`;
  await switchModel("prefilter", null, "恢复部署配置", "admin:1");
  const [second] = await sql`SELECT revision FROM ai.model_routes WHERE capability='prefilter'`;
  assert.equal(second!.revision, first!.revision + 1);
  assert.equal(await modelFor("prefilter"), "deepseek-flash");
  delete process.env.PREFILTER_MODEL;
  assert.equal(await modelFor("prefilter"), "default");
  assert.equal((await modelSources()).prefilter!.source, "default");
});
