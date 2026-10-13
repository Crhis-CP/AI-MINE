import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  MINING_CATEGORY_KEYS,
  MiningCategoryKeySchema,
  MiningCategorySchema,
  isMiningCategoryKey,
  normalizeMiningCategory,
} from "@amp/contracts/mining-taxonomy";
import { MINING_CATEGORIES, MINING_CATEGORY_LABELS, MINING_CATEGORY_GUIDE, MINING_REPORT_SECTIONS, miningReportSection } from "@amp/industry/mining-taxonomy";
import { ROOT } from "../lib.ts";

const legacy = ["ai-models", "ai-products", "industry", "paper", "tip", "opinion"];
const rows = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
const spec = (file: string) => readFileSync(path.join(ROOT, "docs/01-product", file), "utf8");

test("nine stable keys, definitions and display names match the current glossary and DR-100", () => {
  const glossary = spec("09-glossary.md").split("## 3. 编辑分类（一级，九类）")[1]!.split("\n## 4.")[0]!;
  const canonical = rows(glossary).filter(([key]) => key!.startsWith("`"));
  assert.equal(canonical.length, 9);
  assert.deepEqual(
    MINING_CATEGORY_KEYS,
    canonical.map(([key]) => key!.slice(1, -1)),
  );
  assert.deepEqual(
    MINING_CATEGORIES.map((c) => [c.key, c.label, c.shortLabel, c.guide]),
    canonical.map(([key, ...rest]) => [key!.slice(1, -1), ...rest]),
  );
  const display = rows(spec("06-content-standards.md").split("**DR-100｜")[1]!.split("### 9.5")[0]!).filter(([key]) => key!.startsWith("`"));
  assert.deepEqual(
    MINING_CATEGORIES.map((c) => [c.key, c.label, c.shortLabel]),
    display.map(([key, ...rest]) => [key!.slice(1, -1), ...rest]),
  );
  assert.deepEqual(Object.keys(MINING_CATEGORY_LABELS), MINING_CATEGORY_KEYS);
  for (const c of MINING_CATEGORIES) assert.equal(MINING_CATEGORY_LABELS[c.key], c.label);
});

test("schemas reject legacy/invalid keys while public normalization preserves only nine keys or null", () => {
  for (const key of MINING_CATEGORY_KEYS) {
    assert.equal(MiningCategorySchema.parse(key), key);
    assert.equal(MiningCategoryKeySchema.parse(key), key);
    assert.equal(isMiningCategoryKey(key), true);
    assert.equal(normalizeMiningCategory(key), key);
  }
  assert.equal(MiningCategorySchema.parse(null), null);
  assert.equal(MiningCategoryKeySchema.safeParse(null).success, false);
  for (const value of [...legacy, "", "POLICY_REGULATION", "policy_regulation ", "铜", "mine", 0, false, {}, [], undefined]) {
    assert.equal(MiningCategorySchema.safeParse(value).success, false);
    assert.equal(isMiningCategoryKey(value), false);
    assert.equal(normalizeMiningCategory(value), null);
  }
  assert.equal(normalizeMiningCategory(null), null);
  const original = { category: "industry", output: { category: "industry" } };
  normalizeMiningCategory(original.category);
  assert.deepEqual(original, { category: "industry", output: { category: "industry" } });
});

test("DR-89 gives each category one thematic section and no unknown/country fallback", () => {
  const report = rows(spec("06-content-standards.md").split("**DR-89｜")[1]!.split("\n---")[0]!);
  assert.deepEqual(MINING_REPORT_SECTIONS, ["政策与安全", "企业与项目", "市场与技术"]);
  for (const category of MINING_CATEGORIES) {
    const matching = report.filter(([, labels]) => labels?.includes(category.label));
    assert.equal(matching.length, 1);
    assert.equal(miningReportSection(category.key), matching[0]![0]);
    assert.equal(category.section, matching[0]![0]);
  }
  for (const unknown of [null, undefined, ...legacy, "中国", "海外", "铜"]) assert.equal(miningReportSection(unknown), null);
  assert.match(MINING_CATEGORY_GUIDE, /核心动作/);
  assert.match(MINING_CATEGORY_GUIDE, /返回 null/);
});

test("contracts and industry load independently and dormant schemas register nowhere", () => {
  for (const [target, forbidden] of [
    ["@amp/contracts/mining-taxonomy", "@amp/industry"],
    ["@amp/industry/mining-taxonomy", "@amp/contracts"],
  ]) {
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      import { z } from 'zod';
      const [target, forbidden] = process.argv.slice(1);
      registerHooks({ resolve(specifier, context, next) {
        if (specifier.startsWith(forbidden)) throw new Error('cross-package dependency');
        return next(specifier, context);
      }});
      const loaded = await import(target);
      for (const schema of [loaded.MiningCategorySchema, loaded.MiningCategoryKeySchema].filter(Boolean))
        assert.equal(z.globalRegistry.has(schema), false);
    `,
        target!,
        forbidden!,
      ],
      { cwd: ROOT, env: { NODE_ENV: "test" }, stdio: "pipe" },
    );
  }
});

test("configured versions hash actual rendered text, ignoring unused values and property order", () => {
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import { MINING_CATEGORIES, MINING_CATEGORY_GUIDE } from '@amp/industry/mining-taxonomy';
    import { configuredPromptVersion, promptText, promptVersion } from '@amp/backend/editorial/prompts';
    const values = { categoryCount: '九', categoryGuide: MINING_CATEGORY_GUIDE,
      categoryTags: MINING_CATEGORIES.map(c => c.label).join('、'), topicTags: '', entityTags: '', entities: '', jurisdictions: 'CN=中国;AR=阿根廷' };
    const before = [promptVersion('prefilter'), promptVersion('selection-score'), promptVersion('structure')];
    const version = configuredPromptVersion('structure', values);
    assert.equal(version, 'structure@' + createHash('sha256').update(promptText('structure', values)).digest('hex').slice(0, 10));
    assert.equal(version, configuredPromptVersion('structure', Object.fromEntries(Object.entries(values).reverse())));
    assert.equal(version, configuredPromptVersion('structure', { ...values, unused: 'does not reach the prompt' }));
    for (const key of ['categoryGuide', 'categoryTags', 'jurisdictions'])
      assert.notEqual(version, configuredPromptVersion('structure', { ...values, [key]: values[key] + '合成配置变化' }));
    assert.throws(() => configuredPromptVersion('structure'), /no value/);
    for (const name of ['prefilter', 'selection-score'])
      assert.equal(configuredPromptVersion(name, { unused: 'one' }), configuredPromptVersion(name, { unused: 'two' }));
    assert.deepEqual([promptVersion('prefilter'), promptVersion('selection-score'), promptVersion('structure')], before);
  `,
    ],
    {
      cwd: ROOT,
      env: { NODE_ENV: "test", AMP_CREDENTIALS_DIR: "/nonexistent-mining-taxonomy-test", MODEL_CALLS_ENABLED: "false", COLLECT_ENABLED: "false" },
      stdio: "pipe",
    },
  );
});
