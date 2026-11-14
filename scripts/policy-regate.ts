// Re-gate the policy documents already public (TASK-0576): the same deterministic instrument gate the publisher now
// applies. No model, no network, never deletes. Run in the worker environment after the deploy that adds the gate:
//   node scripts/policy-regate.ts            dry run (default): counts by source, kind and reason, and 10 samples
//   node scripts/policy-regate.ts --apply    hide failing documents (reversible) and lift gate holds that now pass
//   node scripts/policy-regate.ts --restore  undo: lift every hold the gate set (manual withdrawals and model exclusions stay)
import { closeDb, initializeDb } from "@amp/backend/db";
import { regatePolicyDocuments } from "../modules/policy/backend/publication/policy-regate.ts";

const args = process.argv.slice(2);
const unknown = args.filter((arg) => !["--apply", "--restore", "--dry-run"].includes(arg));
if (unknown.length || (args.includes("--apply") && args.includes("--restore"))) {
  console.error("用法：node scripts/policy-regate.ts [--dry-run | --apply | --restore]");
  process.exit(2);
}
const mode = args.includes("--apply") ? "apply" : args.includes("--restore") ? "restore" : "dry-run";

if (import.meta.main) {
  await initializeDb("worker");
  try {
    const report = await regatePolicyDocuments({ mode });
    console.log(JSON.stringify(report, null, 2));
    if (mode === "dry-run") console.log("试算完成，未改动任何条目；确认后加 --apply 执行（可用 --restore 撤销）。");
  } finally {
    await closeDb();
  }
}
