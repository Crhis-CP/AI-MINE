// The task card a GitHub Actions run of make verify checks against (TASK-0015). Read from the event file and
// handed on through $GITHUB_ENV, never interpolated into a script with ${{ }}:
//   - a pull request names it on the 任务卡 line of its description, the template's "- 任务卡：" label line: the
//     first TASK-nnnn on that line (a plan PR writes the card it adds; path-guard then applies the plan-PR rule).
//     HTML comments are not read: the template's own note at the top mentions 任务卡 too. Without that line, its
//     branch name agent/<lane>/TASK-nnnn-<slug> names it, as in a local run (rules file 3.3): the run checks out
//     the commit, not the branch;
//   - a manual run (workflow_dispatch) takes the optional input `task`;
//   - a push to main needs none (path-guard has no changes to judge).
// When there is no card the script sets nothing, and path-guard reports the missing card as it always does.
//   node scripts/verify/pr-task.ts      reads $GITHUB_EVENT_NAME and $GITHUB_EVENT_PATH, appends to $GITHUB_ENV
import { appendFileSync, readFileSync } from "node:fs";
import { cardFromBranch } from "./path-guard.ts";

const CARD = /TASK-\d{4}/;
/** The label line of the PR template, "- 任务卡：TASK-nnnn…" (bullet and bold optional). */
const CARD_LINE = /^\s*(?:[-*+]\s+)?(?:\*\*)?任务卡(?:\*\*)?\s*[：:]/;

/** The task card the event names, or null. Only a TASK-nnnn match ever leaves this function. */
export function taskFromEvent(eventName: string, payload: unknown): string | null {
  const event = (payload ?? {}) as { pull_request?: { body?: unknown; head?: { ref?: unknown } }; inputs?: { task?: unknown } };
  if (eventName === "pull_request") {
    const body = typeof event.pull_request?.body === "string" ? event.pull_request.body.replace(/<!--[\s\S]*?-->/g, "") : "";
    const line = body.split(/\r?\n/).find((l) => CARD_LINE.test(l));
    const branch = event.pull_request?.head?.ref;
    return line?.match(CARD)?.[0] ?? (typeof branch === "string" ? cardFromBranch(branch) : null);
  }
  if (eventName === "workflow_dispatch") {
    const task = typeof event.inputs?.task === "string" ? event.inputs.task.trim() : "";
    return /^TASK-\d{4}$/.test(task) ? task : null;
  }
  return null;
}

if (import.meta.main) {
  const name = process.env.GITHUB_EVENT_NAME ?? "";
  const file = process.env.GITHUB_EVENT_PATH;
  const task = file ? taskFromEvent(name, JSON.parse(readFileSync(file, "utf8"))) : null;
  if (task && process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `VERIFY_TASK=${task}\n`);
  console.log(task ? `task card: ${task}` : `no task card in this ${name || "unknown"} event`);
}
