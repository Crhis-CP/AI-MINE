import type { MetalPriceSourceRecord } from "@amp/backend/operations/alerts";
import type { Finding } from "@amp/backend/modules";
import { beijingDate, beijingTime, monthDay } from "@amp/contracts/time";
import { loadMetalPrices } from "./read.ts";
import { metalPriceChangeIssues } from "./change.ts";

const collecting = () => process.env.COLLECT_ENABLED !== "false";
const clip = (text: string) => [...text].slice(0, 200).join("");
const beijingStamp = (at: Date | string | number) => `${monthDay(beijingDate(at))} ${beijingTime(at)}`;
const METALS_WHERE = "看 job_runs 里 metals.prices 的运行记录，或在 worker 容器里跑 scripts/metal-prices-check.ts";

/** The price page's own read: a period past its registered stale window, a 暂缺 quote, or a table that cannot be read. */
async function metalPageFindings(now: number): Promise<Finding[]> {
  if (!collecting()) return [];
  const { readMetalPriceRuns } = await import("@amp/backend/operations/alerts");
  let prices: Awaited<ReturnType<typeof loadMetalPrices>>;
  try {
    prices = await loadMetalPrices(new Date(now));
  } catch (error) {
    return [
      {
        key: "metals.table",
        level: "now",
        title: "金属价格表读不出来",
        impact: "读者打开金属价格页会看到“价格数据暂时无法读取”",
        heals: "不会拿别的数字填上",
        action: "转给 AI 处理",
        detail: clip(error instanceof Error ? error.message : String(error)),
      },
    ];
  }
  const out: Finding[] = [];
  const aged = prices.sources.filter((source) => source.status === "stale");
  const checks = aged.length ? await readMetalPriceRuns(new Date(now)) : null;
  const stale = aged.filter((source) => {
    const check = checks?.sources[source.key];
    return !check?.latest.ok || !check.lastOkAt || now - check.lastOkAt.getTime() > 26 * 3600_000;
  });
  if (stale.length) {
    out.push({
      key: "metals.period",
      level: "now",
      title: stale.length === 1 ? `${stale[0]!.name}的价格过了该更新的期限` : `金属价格有 ${stale.length} 个来源过了该更新的期限`,
      impact: `页面仍显示较早期的数据：${stale.map((source) => `${source.name} ${source.latest?.label ?? "没有期名"}`).join("；")}`,
      heals: "系统每半小时检查一次，拿到新一期并核对通过后会自动更新；官方尚未更新时保留原期次",
      action: "转给 AI 处理",
      detail: "按各来源登记的有效期核对，没有把期限改长；近期检查成功且没有新一期时正常等待，不作为抓取故障",
    });
  }
  const hasAny = prices.metals.some((metal) => metal.quotes.some((quote) => quote.value !== null));
  const emptySources = prices.sources.filter((source) => source.status === "empty");
  const missingSeries = prices.metals.flatMap((metal) =>
    metal.quotes
      .filter((quote) => quote.value === null && prices.sources.find((source) => source.key === quote.source)?.status !== "empty")
      .map((quote) => `${metal.name}的${quote.title}`),
  );
  if (hasAny && (emptySources.length || missingSeries.length)) {
    const parts = [...emptySources.map((source) => source.name), ...missingSeries];
    out.push({
      key: "metals.gap",
      level: "now",
      title: "金属价格有报价是暂缺",
      impact: `读者在价格表里看到“暂缺”：${parts.slice(0, 6).join("、")}${parts.length > 6 ? "等" : ""}`,
      heals: "不会用别的数字填上。下一轮抓到并核对通过才会出现",
      action: "转给 AI 处理",
      detail: parts.join("、"),
    });
  }
  if (!hasAny) {
    const runs = await readMetalPriceRuns(new Date(now));
    if (runs.latest) {
      out.push({
        key: "metals.table",
        level: "now",
        title: "金属价格表没有任何报价",
        impact: "读者打开金属价格页看不到价格",
        heals: "不会编造价格。抓取成功并入库后才会出现",
        action: "转给 AI 处理",
        detail:
          runs.latest.status === "failed"
            ? `最近一次抓取失败：${clip(runs.latest.error ?? "标成失败，但没有写下错误原因")}`
            : "定时任务有运行记录，但页面一个价都没有",
      });
    }
  }
  const changes = metalPriceChangeIssues(prices);
  if (changes.length) {
    out.push({
      key: "metals.change",
      level: "now",
      title: changes.length === 1 ? "金属价格有一行涨跌算错了" : `金属价格有 ${changes.length} 行涨跌算错了`,
      impact: `读者看到的涨跌和本期减去上一期对不上：${changes.slice(0, 3).join("；")}${changes.length > 3 ? "等" : ""}`,
      heals: "不会自己改数字。某一来源还在等官方下一期，或周六没有新的日价，不会因此报警",
      action: "转给 AI 处理",
      detail: clip(changes.join("；")),
    });
  }
  return out;
}

export async function metalFindings(now: number): Promise<Finding[]> {
  const out: Finding[] = [];
  // Metal prices (TASK-0071), as upstream's leaderboard sources: one not fetched for over a day leaves the page showing its
  // last period (marked stale past the threshold), so it waits for the digest. The schedule runs only while collecting.
  // A run record this cannot read becomes the item instead of stopping every other alert.
  if (collecting()) {
    try {
      const { readMetalPriceRuns } = await import("@amp/backend/operations/alerts");
      const late = 26 * 3600_000;
      const prices = await readMetalPriceRuns(new Date(now));
      const stale = Object.entries(prices.sources).filter(([, s]) => now - (s.lastOkAt ?? s.firstSeenAt).getTime() > late);
      // Runs on record but none ok for that long: the schedule itself stopped or fails (a bad registry throws).
      const stopped = !!prices.latest && (!prices.lastOkRunAt || now - prices.lastOkRunAt.getTime() > late);
      if (stale.length || stopped) {
        // The source's error, else its first period held back, else its series held back alone; when its last record
        // went well, the schedule has not run well since (a failed latest run's own error is said once, first).
        const reason = ({ error, periods }: MetalPriceSourceRecord) => {
          const held = periods.find((p) => p.held !== null);
          const alone = periods.find((p) => p.heldSeries?.length);
          if (error) return error;
          if (held) return `${held.period}被扣下：${held.held}`;
          if (alone) return `${alone.period}按品种扣下：${alone.heldSeries!.map((s) => `${s.key}（${s.reason}）`).join("、")}`;
          return "定时任务之后没有跑成功";
        };
        out.push({
          key: "metals.fetch",
          level: "digest",
          title: stopped ? "金属价格超过一天没有抓取成功，暂用上一期数据" : `金属价格有 ${stale.length} 个来源超过一天没抓到，暂用上一期数据`,
          detail: [
            ...(prices.latest?.status === "failed" ? [`定时任务出错：${clip(prices.latest.error ?? "（无）")}`] : []),
            ...stale
              .slice(0, 6)
              .map(([key, s]) => `${key}：${clip(reason(s.latest))}（${s.lastOkAt ? `上次成功 ${beijingStamp(s.lastOkAt)}` : "还没有成功过"}）`),
            METALS_WHERE,
          ].join("；"),
        });
      }
    } catch (error) {
      out.push({
        key: "metals.fetch",
        level: "digest",
        title: "金属价格的运行记录读不出来，没法判断有没有抓到",
        detail: `${clip(String(error))}；${METALS_WHERE}`,
      });
    }
  }

  try {
    out.push(...(await metalPageFindings(now)));
  } catch (error) {
    out.push({
      key: "metals.table",
      level: "now",
      title: "金属价格表读不出来",
      impact: "读者打开金属价格页会看到“价格数据暂时无法读取”",
      heals: "不会拿别的数字填上",
      action: "转给 AI 处理",
      detail: clip(error instanceof Error ? error.message : String(error)),
    });
  }
  return out;
}
