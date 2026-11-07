// Removes company and mineral tags the material never names from published news (TASK-0584, Owner 2026-11-07:
// 紫金矿业 showed a Codelco story). New analyses are grounded when they are published; this handles history by
// republishing each affected item, which applies the same grounding. The republish refreshes the projection only:
// it queues no translation or other paid work (Codex review #380, PIT-112), and no model is called. Tags a person
// set stay. The dry run prints each example's original title and language so a removal can be checked by hand.
//   node scripts/ground-tags.ts            --dry-run (default): counts per tag and a few examples, writes nothing
//   node scripts/ground-tags.ts --apply    republishes every affected item, resumable (it pages by article id)
import { closeDb, initializeDb } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { republishProjectionOnly, ungroundedTagPublications } from "@amp/backend/publication/publish";

const args = process.argv.slice(2);
if (args.some((a) => a !== "--dry-run" && a !== "--apply") || args.length > 1) {
  console.error("usage: ground-tags.ts [--dry-run | --apply]; nothing written");
  process.exit(2);
}
const apply = args[0] === "--apply";

await initializeDb("worker");
const counts = new Map<string, number>();
const examples: string[] = [];
let scanned = 0;
let affected = 0;
let afterId: string | null = null;
try {
  for (;;) {
    const page = await ungroundedTagPublications(afterId, 500);
    if (!page.length) break;
    afterId = page[page.length - 1]!.articleId;
    scanned += page.length;
    for (const row of page) {
      if (!row.dropped.length) continue;
      affected += 1;
      for (const tag of row.dropped) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      if (examples.length < 20) examples.push(`${row.articleId} [${row.language ?? "?"}] ${row.title.slice(0, 80)} → ${row.dropped.join(", ")}`);
      if (apply) await republishProjectionOnly(row.articleId);
    }
  }
  console.log(`${apply ? "republished" : "would republish"} ${affected} of ${scanned} news publications`);
  for (const [tag, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(6)}  ${tag}`);
  if (examples.length) console.log(`examples:\n  ${examples.join("\n  ")}`);
} finally {
  await stopBoss();
  await closeDb();
}
