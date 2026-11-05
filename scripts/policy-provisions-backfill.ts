// Backfill (法规线重启 · 结构化): split the provisions of policy revisions archived before this stage existed and
// project them for 逐条对照. Uses each revision's newest cached extraction; it never fetches a page, never calls a
// model and never changes a publication edition. Re-running changes nothing that is already stored.
//   node scripts/policy-provisions-backfill.ts            dry run: counts what it would store, writes nothing
//   node scripts/policy-provisions-backfill.ts --apply    stores provisions, then projects those the source allows in public
import { closeDb, initializeDb } from "@amp/backend/db";
import { backfillPolicyStructures } from "../modules/policy/backend/domain/provision-store.ts";
import { projectPendingPolicyProvisions } from "../modules/policy/backend/publication/policy-provisions-project.ts";

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== "--apply");
if (unknown.length) {
  console.error(`unknown argument ${unknown.join(" ")}; nothing written (use --apply to write)`);
  process.exit(2);
}
const apply = args.includes("--apply");
await initializeDb("worker");
try {
  const totals: Record<string, number> = {};
  let provisions = 0,
    after: string | undefined;
  do {
    const page = await backfillPolicyStructures({ apply, after, limit: 200 });
    for (const result of page.results) {
      totals[result.status] = (totals[result.status] ?? 0) + 1;
      provisions += result.provisions;
    }
    after = page.next ?? undefined;
  } while (after);
  const projected: Record<string, number> = {};
  if (apply) {
    let next: string | undefined;
    do {
      const page = await projectPendingPolicyProvisions({ after: next, limit: 200 });
      for (const result of page.results) projected[result.status] = (projected[result.status] ?? 0) + 1;
      next = page.next ?? undefined;
    } while (next);
  }
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", revisions: totals, provisions, projected }, null, 2));
  if (!apply) console.log("Dry run: nothing written. Re-run with --apply to store and project.");
} finally {
  await closeDb();
}
