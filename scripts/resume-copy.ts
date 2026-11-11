// Items whose model-written Chinese title or summary came back empty used to stop as "analyzed" and never reached
// readers (TASK-0594; 2026-11-08 read-only check: about 517). New items are written again automatically
// (jobs/content.ts copyRewrite); this script handles the ones left behind before that.
//   node scripts/resume-copy.ts                 --dry-run (default): counts and examples, writes nothing, calls no model
//   node scripts/resume-copy.ts --apply [--limit N]
//       republishes each item (no model call: a Chinese original with full-text permission goes public on its own
//       title and source excerpt), then queues a rewrite, at low priority and off-peak for history, for each item
//       still not public; at most N rewrites per run (default 50). Each rewrite is at least one paid writing request,
//       more when the judging prompts changed since (counted below). Resumable: a queued item is no longer "analyzed",
//       so the next run goes on with the rest.
import { closeDb, initializeDb } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { incompleteCopyCandidates, resumeIncompleteCopy } from "@amp/backend/jobs/content";
import { analyzePromptVersion } from "@amp/backend/editorial/analyze";
import { publishArticle } from "@amp/backend/publication/publish";
import { isChineseOriginal } from "@amp/backend/editorial/translation-readiness";

const args = process.argv.slice(2);
const limitAt = args.indexOf("--limit");
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : 50;
const rest = limitAt >= 0 ? args.filter((_, i) => i !== limitAt && i !== limitAt + 1) : args;
if (rest.some((a) => a !== "--dry-run" && a !== "--apply") || rest.length > 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
  console.error("usage: resume-copy.ts [--dry-run | --apply [--limit N (1-1000)]]; nothing written");
  process.exit(2);
}
const apply = rest[0] === "--apply";

await initializeDb("worker");
const current = analyzePromptVersion();
const bySource = new Map<string, number>();
const examples: string[] = [];
let scanned = 0;
let chinese = 0;
let published = 0;
let rewrites = 0;
let rejudged = 0;
let afterId: string | null = null;
try {
  for (;;) {
    const page = await incompleteCopyCandidates(afterId, 500);
    if (!page.length) break;
    afterId = page[page.length - 1]!.id;
    for (const row of page) {
      scanned += 1;
      bySource.set(row.sourceId, (bySource.get(row.sourceId) ?? 0) + 1);
      if (examples.length < 20) examples.push(`${row.id} [${row.language ?? "?"}] ${row.writer} ${row.title.slice(0, 80)}`);
      const zh = isChineseOriginal(row.language);
      if (zh) chinese += 1;
      let visibility = row.visibility;
      if (apply) visibility = (await publishArticle(row.id))?.visibility ?? visibility;
      if (visibility === "public") {
        published += 1;
        continue;
      }
      if (rewrites >= limit) continue;
      rewrites += 1;
      if (row.promptVersion !== current) rejudged += 1;
      if (apply) await resumeIncompleteCopy(row.id);
    }
  }
  console.log(`${scanned} items with incomplete model copy (${chinese} Chinese originals)`);
  console.log(`${published} ${apply ? "are" : "are already"} public${apply ? " after republishing (no model call)" : ""}`);
  console.log(
    `${apply ? "queued" : "would queue"} ${rewrites} rewrites (limit ${limit}); ${rejudged} of them were judged with older prompts and also re-pay prefilter, score and structure`,
  );
  if (!apply) console.log("a dry run does not republish; Chinese originals with full-text permission go public with --apply before any rewrite is counted");
  for (const [source, n] of [...bySource].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`${String(n).padStart(6)}  ${source}`);
  if (examples.length) console.log(`examples:\n  ${examples.join("\n  ")}`);
} finally {
  await stopBoss();
  await closeDb();
}
