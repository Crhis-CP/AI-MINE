// 读者兴趣记录 backfill (TASK-0596): records the complete days that already have visit figures (ops.visit_pages) but
// no record yet, with the same code as the hourly ops.reader-interest job. No model, no reader-visible change.
// Each day is computed and stored in its own transaction, so a stopped run resumes where it left off.
//   node scripts/reader-interest-backfill.ts                 dry run (default): per day, what would be stored; writes nothing
//   node scripts/reader-interest-backfill.ts --apply         stores every day not recorded yet
//   node scripts/reader-interest-backfill.ts --apply --again also replaces days already recorded (classified as of now)
import { closeDb, initializeDb } from "@amp/backend/db";
import { computeInterestDay, interestDaysToRecord, storeInterestDay } from "../modules/site-admin/backend/reader-interest.ts";

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== "--apply" && a !== "--again" && a !== "--dry-run");
if (unknown.length || (args.includes("--again") && !args.includes("--apply")) || (args.includes("--dry-run") && args.includes("--apply"))) {
  console.error("usage: reader-interest-backfill.ts [--dry-run | --apply [--again]]; nothing written");
  process.exit(2);
}
const apply = args.includes("--apply");
const again = args.includes("--again");
await initializeDb("worker");
try {
  const days = await interestDaysToRecord(new Date(), { again });
  let items = 0;
  for (const day of days) {
    const record = await computeInterestDay(day);
    items += record.itemViews;
    const top = record.items[0];
    const counts = ["category", "mineral", "company", "country", "page"].map((d) => `${d} ${record.facets.filter((f) => f.dimension === d).length}`);
    console.log(
      `${day}  article views ${record.itemViews} (classified ${record.classifiedViews})  list views ${record.listViews}  ${counts.join(" · ")}` +
        (top ? `  top: ${top.views} ${top.title?.slice(0, 40) ?? top.articleId}` : ""),
    );
    if (apply) await storeInterestDay(record);
  }
  console.log(`${apply ? "recorded" : "would record"} ${days.length} day(s), ${items} article views${apply ? "" : "; nothing written (use --apply)"}`);
} finally {
  await closeDb();
}
