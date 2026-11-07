// Opens the full original text and its Chinese translation on our own pages for news-lane editorial sources
// (TASK-0569; Owner 2026-11-07, DEC-78补充·新闻原文全文与中文译文, overturning the 2026-10-05 tightening of DEC-40).
// Uses the same permission store, audit and republication as the admin source page; off-site redistribution stays off.
//   node scripts/open-news-fulltext.ts                          dry run (default): lists what would change, writes nothing
//   node scripts/open-news-fulltext.ts --apply                  opens every source that is not tightened per source
//   node scripts/open-news-fulltext.ts --apply --include-owner-closed
//                                                               also reopens sources an owner instruction closed
//                                                               (only after the Owner confirms those named sources)
// Idempotent: a second run reports already_open. Sources kept closed (source objection, legal requirement, owner
// instruction) and policies needing review are listed by id with the recorded basis.
import { pathToFileURL } from "node:url";
import { closeDb, initializeDb } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { openNewsFulltext } from "@amp/backend/admin/sources";

export const NEWS_FULLTEXT_ACTOR = "ops:news-fulltext-20261107";

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--apply", "--include-owner-closed"].includes(arg))) {
    console.error("usage: open-news-fulltext.ts [--apply] [--include-owner-closed]; nothing written");
    process.exit(2);
  }
  await initializeDb("worker");
  try {
    const result = await openNewsFulltext(NEWS_FULLTEXT_ACTOR, {
      apply: args.includes("--apply"),
      includeOwnerClosed: args.includes("--include-owner-closed"),
    });
    console.log(
      JSON.stringify(
        {
          applied: result.applied,
          counts: result.counts,
          archivedSkipped: result.archivedSkipped,
          listed: result.sources.filter((s) => ["kept_tightened", "needs_review", "missing_policy"].includes(s.status)),
        },
        null,
        2,
      ),
    );
  } finally {
    await stopBoss();
    await closeDb();
  }
}
