// Removes company and mineral tags the material never names from published news (TASK-0584, Owner 2026-11-07:
// 紫金矿业 showed a Codelco story). New analyses are grounded when they are published; this handles history by
// updating only the stored tags and search text of each affected item (regroundPublicationTags): no publish runs,
// so selection, grouping, notifications and translation are untouched and nothing is queued (Codex review #380,
// PIT-112); no model is called. Tags a person set stay and are not counted. The dry run prints each example's
// original title and language so a removal can be checked by hand.
//   node scripts/ground-tags.ts            --dry-run (default): counts per tag and a few examples, writes nothing
//   node scripts/ground-tags.ts --apply    republishes every affected item, resumable (it pages by article id)
//   node scripts/ground-tags.ts --audit    read-only: also counts items a company or mineral filter still shows
//                                          though the material never names it (through the AI title or summary,
//                                          TASK-0589); nothing is written
import { closeDb, initializeDb } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { regroundPublicationTags, ungroundedTagPublications } from "@amp/backend/publication/publish";

const args = process.argv.slice(2);
if (args.some((a) => a !== "--dry-run" && a !== "--apply" && a !== "--audit") || args.length > 1) {
  console.error("usage: ground-tags.ts [--dry-run | --apply | --audit]; nothing written");
  process.exit(2);
}
const apply = args[0] === "--apply";
const audit = args[0] === "--audit";
const filterCounts = new Map<string, number>();
const filterExamples: string[] = [];
let filterAffected = 0;

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
      if (audit) {
        const after = row.filterOnly.filter((label) => !row.dropped.some((tag) => tag === label));
        if (after.length) {
          filterAffected += 1;
          for (const label of after) filterCounts.set(label, (filterCounts.get(label) ?? 0) + 1);
          if (filterExamples.length < 20) filterExamples.push(`${row.articleId} [${row.language ?? "?"}] ${row.title.slice(0, 80)} → ${after.join(", ")}`);
        }
      }
      if (!row.dropped.length) continue;
      affected += 1;
      for (const tag of row.dropped) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      if (examples.length < 20) examples.push(`${row.articleId} [${row.language ?? "?"}] ${row.title.slice(0, 80)} → ${row.dropped.join(", ")}`);
      if (apply) await regroundPublicationTags(row.articleId);
    }
  }
  console.log(`${apply ? "updated" : "would update"} ${affected} of ${scanned} news publications (tags and search text only)`);
  for (const [tag, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(6)}  ${tag}`);
  if (examples.length) console.log(`examples:\n  ${examples.join("\n  ")}`);
  if (audit) {
    console.log(`filters still showing an unnamed company or mineral (other than the tags above): ${filterAffected} of ${scanned}`);
    for (const [label, n] of [...filterCounts].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(6)}  ${label}`);
    if (filterExamples.length) console.log(`examples:\n  ${filterExamples.join("\n  ")}`);
  }
} finally {
  await stopBoss();
  await closeDb();
}
