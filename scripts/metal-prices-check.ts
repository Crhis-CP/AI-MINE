// Read-only by default. Production use in the worker container requires the Owner's approval for each run.
import { parseArgs } from "node:util";
import { closeDb, initializeDb } from "@amp/backend/db";
import { refreshMetalPrices } from "@amp/backend/jobs/publication";
import { recordRun } from "@amp/backend/jobs/queue";
import { readMetalPriceRuns } from "@amp/backend/operations/alerts";
import type { MetalPriceSourceRecord } from "@amp/backend/operations/alerts";

const USAGE = `用法：node --env-file=.env scripts/metal-prices-check.ts
  不带参数：只读最近一次 metals.prices 运行与每个来源上次成功时间，不抓取。
  --dry-run [--source <来源键>] [--force-period <所属期起日>]
  --store --source <来源键> --force-period <所属期起日>
  --force-period 必须同时指定 --source，且该期在最近运行的被扣下清单中。
  所属期起日照 period_start，格式 YYYY-MM-DD：
  旬：“2026年9月中旬” → 2026-09-11；月：“2026年8月” → 2026-08-01。
  周：“2026年9月25日” → 2026-09-25；日：“2026年10月5日定价” → 2026-10-05。
  试跑不写价格和运行记录；入库只跳过指定一期的行数、倍数检查。
  正式库每次运行须 Owner 同意；--store 会写正式库，更须明确同意。`;

function printRecord(record: Record<string, MetalPriceSourceRecord>, preview = false) {
  for (const [key, run] of Object.entries(record)) {
    console.log(`${key}：${run.ok ? "成功" : "未通过"}，${run.at}；${preview ? "会" : "已"}新增 ${run.inserted} 行，只更新时间 ${run.touched} 行`);
    if (run.error) console.log(`  出错：${run.error}`);
    if (run.note) console.log(`  说明：${run.note}`);
    if ("forced" in run) console.log(`  强制检查：${JSON.stringify(run.forced)}`);
    for (const period of run.periods) {
      console.log(`  ${period.period}；版本：${period.version}；新增 ${period.inserted} 行，只更新时间 ${period.touched} 行`);
      for (const row of period.changed) console.log(`    ${row.key}：${row.before} → ${row.after}`);
      console.log(`    ${period.held ? `被扣下：${period.held}` : "检查通过"}`);
      for (const note of period.notes) console.log(`    说明：${note}`);
      for (const row of period.heldSeries ?? []) console.log(`    品种被扣下 ${row.key}：${row.reason}`);
    }
  }
}

try {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean" },
      store: { type: "boolean" },
      source: { type: "string" },
      "force-period": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) console.log(USAGE);
  else {
    const dryRun = values["dry-run"] ?? false;
    const periodStart = values["force-period"];
    if (
      (dryRun && values.store) ||
      (values.store && (!values.source || !periodStart)) ||
      (periodStart !== undefined &&
        (!values.source || !/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || new Date(periodStart).toISOString().slice(0, 10) !== periodStart)) ||
      (!dryRun && !values.store && (values.source !== undefined || periodStart !== undefined))
    )
      throw new Error(USAGE);
    await initializeDb("worker");
    const now = new Date();
    if (!dryRun && !values.store) {
      const runs = await readMetalPriceRuns(now);
      if (!runs.latest) console.log("还没有 metals.prices 运行记录");
      else {
        console.log(`最近定时运行：${runs.latest.at.toISOString()}；${runs.latest.status}`);
        if (runs.latest.error) console.log(`出错：${runs.latest.error}`);
        if (runs.latest.record) printRecord(runs.latest.record);
      }
      for (const [key, source] of Object.entries(runs.sources)) console.log(`${key} 上次成功：${source.lastOkAt?.toISOString() ?? "还没有成功过"}`);
    } else {
      const refresh = async () => {
        const held = periodStart ? ((await readMetalPriceRuns(now)).sources[values.source!]?.held ?? []) : [];
        return refreshMetalPrices({ now, dryRun, source: values.source, force: periodStart ? { periodStart, held } : undefined });
      };
      const record = values.store ? await recordRun("metals.prices.manual", refresh) : await refresh();
      printRecord(record, dryRun);
      if (Object.values(record).some((source) => !source.ok)) process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await closeDb();
}
