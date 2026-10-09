import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { CATEGORY_KEYS, CHANNEL_KEYS, PUBLIC_API_CATEGORY_KEYS, isCategoryKey, isChannelKey, toPublicApiCategory } from "@amp/contracts/taxonomy";
import { MCP_TOOL_NAMES, MCP_TOOLS } from "@amp/contracts/mcp";
import { CATEGORIES, CATEGORY_LABELS, CHANNEL_LABELS } from "@amp/industry/taxonomy";
import { MINING_CATEGORIES } from "@amp/industry/mining-taxonomy";
import { SITE } from "@amp/industry/site";
import { ROOT } from "../lib.ts";

test("public taxonomy identity, display labels and order implement ADR-0022 without changing channel or MCP identity", () => {
  assert.deepEqual(
    CATEGORY_KEYS,
    MINING_CATEGORIES.map((row) => row.key),
  );
  assert.deepEqual(CHANNEL_KEYS, ["all", "news", "firstParty"]);
  assert.equal(PUBLIC_API_CATEGORY_KEYS, CATEGORY_KEYS);
  assert.deepEqual(
    CATEGORIES.map((row) => row.key),
    CATEGORY_KEYS,
  );
  assert.deepEqual(Object.keys(CATEGORY_LABELS), CATEGORY_KEYS);
  assert.deepEqual(CATEGORY_LABELS, Object.fromEntries(MINING_CATEGORIES.map((row) => [row.key, row.label])));
  assert.deepEqual(Object.keys(CHANNEL_LABELS), CHANNEL_KEYS);
  assert.deepEqual(CHANNEL_LABELS, { all: "全部", news: "资讯", firstParty: "一手" });
  for (const key of CATEGORY_KEYS) {
    assert.equal(isCategoryKey(key), true);
    assert.equal(toPublicApiCategory(key), key);
  }
  for (const value of [null, undefined, "unknown", "coal", 1]) assert.equal(isCategoryKey(value), false);
  assert.equal(toPublicApiCategory(null), null);
  assert.equal(toPublicApiCategory("unknown"), null);
  for (const key of CHANNEL_KEYS) assert.equal(isChannelKey(key), true);
  assert.equal(isChannelKey("x"), false);
});

test("eleven MCP tool identities retain the legacy names and agree with the site prefix", () => {
  const names = [
    "aiminingpolicy_get_latest",
    "aiminingpolicy_search",
    "aiminingpolicy_get_hot_topics",
    "aiminingpolicy_get_story",
    "aiminingpolicy_get_daily",
    "aiminingpolicy_get_item",
    "aiminingpolicy_get_report",
    "aiminingpolicy_list_topics",
    "aiminingpolicy_get_policy",
    "aiminingpolicy_search_policies",
    "aiminingpolicy_get_policy_thread",
  ];
  assert.deepEqual(Object.keys(MCP_TOOL_NAMES), [
    "latest",
    "search",
    "hot",
    "story",
    "daily",
    "item",
    "report",
    "topics",
    "policy",
    "policies",
    "policyThread",
  ]);
  assert.deepEqual(Object.values(MCP_TOOL_NAMES), names);
  assert.deepEqual(
    MCP_TOOLS,
    names.map((name) => ({ name })),
  );
  assert.equal(SITE.mcpPrefix, "aiminingpolicy");
  assert.deepEqual(
    [
      "get_latest",
      "search",
      "get_hot_topics",
      "get_story",
      "get_daily",
      "get_item",
      "get_report",
      "list_topics",
      "get_policy",
      "search_policies",
      "get_policy_thread",
    ].map((suffix) => `${SITE.mcpPrefix}_${suffix}`),
    names,
  );
});

test("contract identities load when industry imports are unavailable", () => {
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.startsWith('@amp/industry')) throw new Error('industry is unavailable');
      return next(specifier, context);
    }});
    await import('@amp/contracts/taxonomy');
    await import('@amp/contracts/mcp');
  `,
    ],
    { cwd: ROOT, env: { NODE_ENV: "test" }, stdio: "pipe" },
  );
});
