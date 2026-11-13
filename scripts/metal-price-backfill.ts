// Earlier days for the metal trend chart (TASK-0632): fills days before the newest stored one for the two daily official
// sources, from the same official pages the schedule reads. A day already stored is never touched; a value goes in only
// as printed and only when it passes the checks in modules/metals/backend/backfill.ts; the rest is listed and left out.
//   node scripts/metal-price-backfill.ts --source cbr                      dry run (default): what would go in
//   node scripts/metal-price-backfill.ts --source cochilco --limit 40      dry run of the 40 newest missing days
//   node scripts/metal-price-backfill.ts --source cochilco --limit 40 --apply    writes; run again to go further back
//   --from YYYY-MM-DD   how far back (default: one year before today)
//   --before YYYY-MM-DD only days before this one, to go past days that can never go in (the run prints the next value)
// Bank of Russia: two requests for the whole range. Cochilco: one PDF per day, through the relay when one is configured.
import { closeDb, initializeDb } from "@amp/backend/db";
import { backfillMetalPrices } from "../modules/metals/backend/backfill.ts";

const args = process.argv.slice(2);
const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const known = ["--source", "--limit", "--from", "--before", "--apply"];
const stray = args.filter((arg, i) => !known.includes(arg) && !["--source", "--limit", "--from", "--before"].includes(args[i - 1] ?? ""));
const source = value("--source");
const limit = Number(value("--limit") ?? (source === "cbr" ? 400 : 40));
const from = value("--from") ?? new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
const before = value("--before");
const day = /^\d{4}-\d{2}-\d{2}$/;
if (
  stray.length ||
  (source !== "cbr" && source !== "cochilco") ||
  !Number.isInteger(limit) ||
  limit < 1 ||
  limit > 400 ||
  !day.test(from) ||
  (before !== undefined && !day.test(before))
) {
  console.error("usage: metal-price-backfill.ts --source cbr|cochilco [--from YYYY-MM-DD] [--before YYYY-MM-DD] [--limit 1..400] [--apply]; nothing written");
  process.exit(2);
}

await initializeDb("worker");
try {
  const report = await backfillMetalPrices({ source, from, before, limit, apply: args.includes("--apply") });
  for (const one of report.days) {
    console.log(
      `${one.day}  ${report.applied ? "入库" : "可入库"} ${one.stored.length} 项${one.stored.length ? `（${one.stored.map((key) => key.split(".")[1]).join("、")}）` : ""}`,
    );
    for (const left of one.left) console.log(`            未入：${left}`);
  }
  const stored = report.days.reduce((sum, day) => sum + day.stored.length, 0);
  console.log(
    `${report.source}：${report.from} 起官方有而库里没有的共 ${report.missing} 天；这次${report.applied ? "写入" : "预演"} ${report.days.length} 天、${stored} 个数值；还剩 ${report.remaining} 天${report.applied ? "" : "。预演没有写入任何数据"}`,
  );
  if (report.remaining && report.earliest) console.log(`再往前补：加上 --before ${report.earliest}（这次没补进去的日子会被跳过，不会每次都占名额）`);
} finally {
  await closeDb();
}
