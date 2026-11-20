// Back-fill of the event order (package 2, step 2.5): the timing of each fact (events.fact_timing) and the order row of
// each public news report (publication.event_rank) since --days, newest first, page by page.
//   node scripts/event-order-backfill.ts [--days 14] [--batch 200]            dry run (default): computes and counts, writes nothing
//   node scripts/event-order-backfill.ts [--days 14] [--batch 200] --apply    writes the timing and the rows
// No model call, and it never goes through publishing, so nothing a reader sees changes. Safe to repeat: a row that is
// already current is left as it is. Rows are refreshed afterwards by the event shadow's job while its switch is on.
import { parseArgs } from "node:util";
import { closeDb, initializeDb } from "@amp/backend/db";
import { eventOrderBackfillPage } from "../packages/backend/src/pipeline/rank/project.ts";

const { values } = parseArgs({
  options: { days: { type: "string", default: "14" }, batch: { type: "string", default: "200" }, apply: { type: "boolean", default: false } },
});
const days = Number(values.days),
  batch = Number(values.batch);
if (!Number.isInteger(days) || days < 1 || days > 400 || !Number.isInteger(batch) || batch < 1 || batch > 1000) {
  console.error("usage: event-order-backfill.ts [--days 1..400] [--batch 1..1000] [--apply]; nothing written");
  process.exit(2);
}

await initializeDb("worker");
try {
  const since = new Date(Date.now() - days * 86_400_000);
  const totals = { seen: 0, written: 0, removed: 0, facts: 0, classes: { new: 0, follow_up: 0, old: 0 } };
  let after: { at: Date; id: string } | null = null;
  do {
    const page = await eventOrderBackfillPage({ since, after, limit: batch, apply: values.apply });
    totals.seen += page.seen;
    totals.written += page.written;
    totals.removed += page.removed;
    totals.facts += page.facts;
    for (const key of ["new", "follow_up", "old"] as const) totals.classes[key] += page.classes[key];
    console.log(`… ${totals.seen} reports`);
    after = page.next;
  } while (after);
  console.log(
    [
      `${values.apply ? "已写入" : "试算（未写入任何数据）"}：近 ${days} 天公开资讯 ${totals.seen} 篇，涉及事实 ${totals.facts} 个（分页计数，跨页的事实可能重复）`,
      `新 ${totals.classes.new}、跟进 ${totals.classes.follow_up}、旧闻 ${totals.classes.old}`,
      ...(values.apply ? [`排序行写入或更新 ${totals.written} 条，移除 ${totals.removed} 条`] : ["加 --apply 才写入"]),
    ].join("\n"),
  );
} finally {
  await closeDb();
}
