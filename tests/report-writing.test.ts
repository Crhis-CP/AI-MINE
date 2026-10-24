import { test } from "node:test";
import assert from "node:assert/strict";
import { fitted, grounded, PeriodSchema, periodPrompt } from "../packages/backend/src/reports/period-writing.ts";
test("period prose keeps whole sentences and rejects unsupported entities, versions and material figures", () => {
  assert.equal(fitted("产量增加。项目投产。", 6), "产量增加。");
  assert.equal(fitted("首句过长无法容纳。", 3), null);
  assert.equal(grounded("必和必拓产量增加12.5%。", "BHP reports 12.5% growth"), true);
  assert.equal(grounded("嘉能可增加12.5%。", "BHP reports 12.5% growth"), false);
  assert.equal(grounded("BHP产量增加25%。", "BHP reports 12.5% growth"), false);
  assert.equal(grounded("Project-X2投产。", "Project-X1 opened"), false);
});
test("writer contract accepts only prose, and brief reserves selection and order for rules", () => {
  const value = PeriodSchema.parse({
    overview: "本期矿业动态。",
    sections: { 企业与项目: "矿山建设推进。" },
    themes: [{ refs: [999] }],
    headline: "模型选的标题",
  });
  assert.deepEqual(Object.keys(value).sort(), ["overview", "sections"]);
  const brief = periodPrompt("weekly", "2020-01-01", "2020-01-07", []);
  assert.match(brief.system, /不选择或删改条目/);
  assert.match(brief.user, /sections 返回空对象/);
});
