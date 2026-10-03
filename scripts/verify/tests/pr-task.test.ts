// pr-task: the task card a GitHub Actions run checks against comes from the event, and only a TASK-nnnn match
// ever leaves the script (TASK-0015).
import assert from "node:assert/strict";
import { test } from "node:test";
import { taskFromEvent } from "../pr-task.ts";

const pr = (body: string | null) => ({ pull_request: { body } });

test("a pull request names its card on the 任务卡 line, plan PRs included", () => {
  assert.equal(taskFromEvent("pull_request", pr("## 任务与规格\n\n- 任务卡：TASK-0004（第 1 个实施 PR）\n- 依赖 TASK-0002")), "TASK-0004");
  assert.equal(taskFromEvent("pull_request", pr("- 任务卡：TASK-0016（本 PR 新增；计划 PR，只含任务卡）\r\n- base 上还没有这张卡")), "TASK-0016");
});

test("a description without the 任务卡 line names no card, whatever else it mentions", () => {
  assert.equal(taskFromEvent("pull_request", pr("Fixes the build; see TASK-0003 for the background")), null);
  assert.equal(taskFromEvent("pull_request", pr(null)), null);
});

test("HTML comments are not read: the template's own note mentions 任务卡 too", () => {
  const body = [
    "<!--",
    "放到新仓库 .github/pull_request_template.md。",
    "本模板里没有“Owner 批准”这一项——Owner 只通过任务卡的 owner_decision_needed 与 Q 卡片介入。",
    "- 任务卡：TASK-9999",
    "-->",
    "",
    "## 任务与规格",
    "",
    "- 任务卡：TASK-0015（第 1 个实施 PR）",
  ].join("\n");
  assert.equal(taskFromEvent("pull_request", pr(body)), "TASK-0015");
});

test("only the 任务卡 label line counts: prose that mentions a card is not it, and an unfilled line names none", () => {
  assert.equal(taskFromEvent("pull_request", pr("按任务卡 TASK-0003 的建议改。\n\n- **任务卡**：TASK-0015")), "TASK-0015");
  assert.equal(taskFromEvent("pull_request", pr("- 任务卡：TASK-<编号>（`tasks/` 下的卡已在 main 上）\n- 依赖 TASK-0002")), null);
});

test("a manual run takes the input task, and nothing that is not a card number", () => {
  assert.equal(taskFromEvent("workflow_dispatch", { inputs: { task: " TASK-0015 " } }), "TASK-0015");
  assert.equal(taskFromEvent("workflow_dispatch", { inputs: { task: "TASK-0015; echo hi" } }), null);
  assert.equal(taskFromEvent("workflow_dispatch", { inputs: {} }), null);
});

test("a push to main needs no card", () => {
  assert.equal(taskFromEvent("push", { ref: "refs/heads/main", head_commit: { message: "任务卡：TASK-0001" } }), null);
});
