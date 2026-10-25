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
        policy_named_news: { ...step, purposes: ["synthetic_prefixed_news"] },
        module_policy: { ...step, lane: "policy", purposes: ["synthetic_module_policy"] },
        legacy_metadata: { label: "旧元数据", env: step.env, purposes: ["synthetic_missing_lane"] },
      },
    },
    { name: "synthetic-core-override", models: { score: { ...step, env: "CANNOT_REPLACE_SCORE", purposes: ["cannot_replace_score"] } } },
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
    { bad_space: { ...step, purposes: [" synthetic_module_read "] } },
  ];
  for (const models of invalid) {
    installModules([...prior, { name: "healthy", models: { healthy: { ...step, purposes: ["healthy_purpose"] } } }, { name: "synthetic-invalid", models }]);
    const available = capabilities();
    assert.equal(available.score!.env, CAPABILITIES.score.env);
    assert.ok(available.healthy);
    assert.ok(!Object.hasOwn(available, "first"), "a broken module cannot register an earlier partial step");
    for (const key of Object.keys(models)) assert.ok(!Object.hasOwn(available, key));
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
  const prefixed = { ...request, purpose: "synthetic_prefixed_news" };
  await chatJson({ ...prefixed, fallbackPermit: permit(prefixed) });
  const response = await chatJson({ ...request, fallbackPermit: permit(request) });
  const working = serverModules();
  installModules([
    ...working,
    { name: "broken-core-purpose", models: { bad: { ...step, purposes: ["score_article"] } } },
    {
      name: "unreadable-models",
      get models(): Record<string, ModelStep> {
        throw new Error("synthetic read failure");
      },
    },
  ]);
  for (const purpose of ["score_article", "prefilter_article"]) {
    const core = { ...request, purpose };
    await chatJson({ ...core, fallbackPermit: permit(core) });
  }
  await assert.rejects(modelFor("bad"), /Unknown model capability/);
  installModules([
    ...working,
    {
      name: "quarantined-batch",
      models: {
        allowed_shape: { ...step, purposes: ["quarantined_unique"] },
        conflict: { ...step, purposes: ["score_article"] },
      },
    },
    { name: "quarantined-label", models: { invalid: { ...step, label: "", purposes: ["quarantined_invalid_label"] } } },
    {
      name: "quarantined-getter",
      models: {
        get broken(): ModelStep {
          throw new Error("synthetic step getter");
        },
        readable: { ...step, purposes: ["quarantined_readable"] },
      },
    },
    { name: "quarantined-probe-name", models: { shadow: { ...step, purposes: ["model_connection_test"] } } },
  ]);
  const callsBeforeBlocked = provider.hits();
  for (const purpose of ["quarantined_unique", "quarantined_invalid_label", "quarantined_readable"]) {
    const rejected = { ...request, purpose, lane: "news" as const };
    await assert.rejects(chatJson(rejected), /disabled.*module/i);
    await assert.rejects(chatJson({ ...rejected, fallbackPermit: permit(rejected) }), /disabled.*module/i);
  }
  await assert.rejects(chatJson({ ...request, purpose: "model_connection_test", lane: "news" }), /probe/i);
  await assert.rejects(
    chatJson({ ...request, purpose: "model_connection_test", lane: "news", registeredProbe: { probeId: "synthetic-invalid", revision: 1 } }),
    /probe/i,
  );
  assert.equal(provider.hits(), callsBeforeBlocked, "a rejected module purpose never reaches transport");
  for (const purpose of ["score_article", "prefilter_article", step.purposes[0]!]) {
    const healthy = { ...request, purpose, user: `healthy after quarantine ${purpose}` };
    await chatJson({ ...healthy, fallbackPermit: permit(healthy) });
  }
  installModules([...working, { name: "bad-shape", models: { bad: { ...step, label: "" } } }]);
  assert.ok(capabilities().prefilter);
  await assert.rejects(modelFor("bad"), /Unknown model capability/);
  installModules(working);

  const [usage] = await sql`SELECT lane,capability FROM ai.usage_attempts WHERE receipt_id=${response.receiptId}`;
  assert.deepEqual({ lane: usage.lane, capability: usage.capability }, { lane: "news", capability: step.purposes[0] });
  await sql`UPDATE ops.lane_controls SET paused=true,reason='合成暂停',actor='test',expires_at=now()+interval '1 hour' WHERE lane='news' AND switch='processing' AND holder='owner'`;
  try {
    const next = { ...request, user: "different synthetic input" };
    await assert.rejects(chatJson({ ...next, fallbackPermit: permit(next) }), /暂停|paused/i);
    assert.equal(provider.hits(), before + 7);
  } finally {
    await sql`UPDATE ops.lane_controls SET paused=false WHERE lane='news' AND switch='processing' AND holder='owner'`;
  }
});

test("a probe purpose name or flag cannot impersonate a registered connection test", async () => {
  installModules([...prior, { name: "probe-shadow", models: { shadow: { ...step, purposes: ["model_connection_test"] } } }]);
  const before = provider.hits();
  const request = {
    model: "deepseek-flash",
    purpose: "model_connection_test",
    lane: "news" as const,
    subject: "synthetic-probe-shadow",
    promptVersion: "probe-boundary-test",
    system: "synthetic",
    user: "synthetic",
    schema: z.object({ ok: z.boolean() }),
  };
  try {
    await assert.rejects(chatJson(request), /probe/i);
    await assert.rejects(chatJson({ ...request, registeredProbe: { probeId: "synthetic-invalid", revision: 1 } }), /probe/i);
    await assert.rejects(chatJson({ ...request, purpose: "score_article", registeredProbe: { probeId: "synthetic-invalid", revision: 1 } }), /probe/i);
    assert.equal(provider.hits(), before);
  } finally {
    install();
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

test("legacy accounting survives removal from the current directory without guessing malformed lane fields", async () => {
  install();
  const saved = [...CAPABILITIES.policy_verify.purposes];
  const ids: number[] = [];
  for (const request of [{}, { lane: "" }]) {
    const [receipt] =
      await sql`INSERT INTO receipts(logical_key,service,purpose,status,request) VALUES(${tag()},'synthetic-legacy','policy_verify','received',${sql.json(request)}) RETURNING id`;
    ids.push(Number(receipt.id));
    await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,cost,cost_basis,currency,response) VALUES(${receipt.id},1,'synthetic-legacy','synthetic','received',2,'actual','CNY','{}')`;
  }
  CAPABILITIES.policy_verify.purposes.length = 0;
  try {
    await evaluateUsageProtection();
    assert.equal((await sql`SELECT lane FROM ai.usage_attempts WHERE receipt_id=${ids[0]!}`)[0]?.lane, "policy");
    assert.equal((await sql`SELECT count(*)::int AS n FROM ai.usage_attempts WHERE receipt_id=${ids[1]!}`)[0].n, 0);
    await evaluateUsageProtection();
    assert.equal(
      (await sql`SELECT count(*)::int AS n,sum(settled_micros)::text AS total FROM ai.usage_attempts WHERE receipt_id=${ids[0]!}`)[0].total,
      "2000000",
    );
  } finally {
    CAPABILITIES.policy_verify.purposes.push(...saved);
  }
});
