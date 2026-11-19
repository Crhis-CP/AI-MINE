// The daily reconciliation: one message every morning with the numbers that say whether the site did its job
// yesterday. It answers what used to be asked by hand before each release (how many sources are silent and why,
// what was collected and what reached readers, whether translations keep up, how long the model accounts last),
// so the Owner sees a drift the day it starts, not when a reader notices. Read-only; no model, no network.
// The alerts (alerts.ts) tell of single things that broke; this is the whole picture, sent whether or not
// anything broke.
import { addDays, beijingDate, beijingMidnight } from "@amp/contracts/time";
import { sql } from "../db.ts";
import { beijingDay, sendAlert } from "../notify/feishu.ts";
import { BALANCE_SETTING, type BalanceState, recentDailySpend } from "../providers/account-balance.ts";
import { sourceHealth } from "../sources/health.ts";

/** Why a source brought nothing in seven days, in the order the reasons are tried. */
export const SILENCE_REASONS = ["failing", "waiting", "unstable", "overdue", "quiet"] as const;
export type SilenceReason = (typeof SILENCE_REASONS)[number];
const REASON_ZH: Record<SilenceReason, string> = {
  failing: "连续抓取失败",
  waiting: "被源站限流或在等待",
  unstable: "时好时坏",
  overdue: "按平时节奏早该更新",
  quiet: "来源本身没更新",
};

export interface Reconciliation {
  /** The Beijing day the numbers are about (yesterday of the run). */
  day: string;
  sources: { enabled: number; withNew: number; silent: Record<SilenceReason, number> };
  /** Collected: new reports found that day. Public and selected: reports first shown to readers that day. */
  flow: { collected: number; public: number; selected: number; scoredNotPublic: number };
  /** Foreign-language reports from full-text sources, public for more than an hour, and those among them without a Chinese translation. */
  translation: { due: number; missing: number };
  /** Days each model account lasts at the recent daily spend; null when there is no spend on record. */
  balance: Array<{ service: string; yuan: number; days: number | null }>;
}

export async function reconcile(now = Date.now()): Promise<Reconciliation> {
  const today = beijingDate(now),
    day = addDays(today, -1),
    start = beijingMidnight(day),
    end = beijingMidnight(today);

  const groups = await sourceHealth(now);
  const silent: Record<SilenceReason, number> = { failing: 0, waiting: 0, unstable: 0, overdue: 0, quiet: 0 };
  let enabled = 0,
    withNew = 0;
  for (const group of groups) {
    const ids = (rows: ReadonlyArray<{ id: string }>) => new Set(rows.map((s) => s.id));
    const failing = ids(group.failing),
      waiting = ids(group.waiting),
      unstable = ids(group.unstable),
      overdue = ids(group.overdue);
    for (const source of group.sources) {
      enabled++;
      if (source.discoveries > 0) {
        withNew++;
        continue;
      }
      const reason: SilenceReason = failing.has(source.id)
        ? "failing"
        : waiting.has(source.id)
          ? "waiting"
          : unstable.has(source.id)
            ? "unstable"
            : overdue.has(source.id)
              ? "overdue"
              : "quiet";
      silent[reason]++;
    }
  }

  const [flow] = await sql<{ collected: number; public: number; selected: number; scored_not_public: number }[]>`
    SELECT
      (SELECT count(*)::int FROM articles a JOIN sources s ON s.id = a.source_id
        WHERE s.lane = 'news' AND NOT a.backfill AND a.discovered_at >= ${start} AND a.discovered_at < ${end}) AS collected,
      (SELECT count(*)::int FROM publications WHERE first_public_at >= ${start} AND first_public_at < ${end}) AS public,
      (SELECT count(*)::int FROM publications WHERE first_selected_at >= ${start} AND first_selected_at < ${end}) AS selected,
      (SELECT count(*)::int FROM (
          SELECT DISTINCT ON (article_id) article_id, relevance, score FROM analyses
          WHERE created_at >= ${start} AND created_at < ${end} ORDER BY article_id, id DESC) latest
        LEFT JOIN publications p ON p.article_id = latest.article_id
        WHERE latest.relevance = 'pass' AND latest.score IS NOT NULL
          AND (p.article_id IS NULL OR NOT p.eligible OR p.visibility <> 'public')) AS scored_not_public`;

  const [translation] = await sql<{ due: number; missing: number }[]>`
    SELECT count(*)::int AS due, count(*) FILTER (WHERE t.article_id IS NULL)::int AS missing
    FROM publications p
    JOIN articles a ON a.id = p.article_id
    JOIN sources s ON s.id = a.source_id
    LEFT JOIN translations t ON t.article_id = a.id AND t.lang = 'zh'
    WHERE p.visibility = 'public' AND p.eligible AND s.lane = 'news' AND s.site_fulltext
      AND a.language IS NOT NULL AND a.language NOT ILIKE 'zh%'
      AND p.first_public_at >= ${start} AND p.first_public_at < ${new Date(Math.min(end.getTime(), now - 3600_000))}`;

  const [setting] = await sql<{ value: BalanceState }[]>`SELECT value FROM settings WHERE key = ${BALANCE_SETTING}`;
  const daily = await recentDailySpend(now);
  const balance = Object.entries(setting?.value ?? {})
    .map(([service, reading]) => ({ service, yuan: reading.yuan, days: daily && daily > 0 ? Math.floor(reading.yuan / daily) : null }))
    .sort((a, b) => a.service.localeCompare(b.service));

  return {
    day,
    sources: { enabled, withNew, silent },
    flow: { collected: flow!.collected, public: flow!.public, selected: flow!.selected, scoredNotPublic: flow!.scored_not_public },
    translation: translation!,
    balance,
  };
}

const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "0%");

/** The message, in the Owner's words: what readers got, what did not arrive, what needs money. */
export function reconcileLines(r: Reconciliation): string[] {
  const silentTotal = SILENCE_REASONS.reduce((n, reason) => n + r.sources.silent[reason], 0);
  const reasons = SILENCE_REASONS.filter((reason) => r.sources.silent[reason] > 0).map((reason) => `${REASON_ZH[reason]} ${r.sources.silent[reason]}`);
  const lines = [
    `读者昨天看到：新公开 ${r.flow.public} 条，其中进精选 ${r.flow.selected} 条（当天收到 ${r.flow.collected} 条）`,
    `信源：开着 ${r.sources.enabled} 个，近 7 天有新内容的 ${r.sources.withNew} 个，没有新内容的 ${silentTotal} 个${reasons.length ? `（${reasons.join("、")}）` : ""}`,
  ];
  if (r.flow.scoredNotPublic > 0) lines.push(`评过分、合格但没有公开：${r.flow.scoredNotPublic} 条`);
  lines.push(
    r.translation.due
      ? `译文：该有中文译文的外文稿 ${r.translation.due} 条，还没有的 ${r.translation.missing} 条（${percent(r.translation.missing, r.translation.due)}）`
      : "译文：昨天没有需要翻译的外文稿",
  );
  for (const b of r.balance) lines.push(`模型余额 ${b.service}：${b.yuan.toFixed(0)} 元${b.days === null ? "" : `，按近 7 天的用量约够 ${b.days} 天`}`);
  return lines;
}

const HISTORY_SETTING = "reconcile.daily";
const HISTORY_DAYS = 30;

/** Every morning: compute, keep the last thirty days for comparison, and send. Running twice for one day sends once. */
export async function sendReconcile(now = Date.now()): Promise<{ day: string; sent: boolean }> {
  const result = await reconcile(now);
  const [row] = await sql<{ value: Reconciliation[] }[]>`SELECT value FROM settings WHERE key = ${HISTORY_SETTING}`;
  const history = Array.isArray(row?.value) ? row.value : [];
  if (history.some((entry) => entry.day === result.day)) return { day: result.day, sent: false };
  const sent = (await sendAlert(`📊 每日对账 · ${beijingDay(beijingMidnight(result.day))}`, reconcileLines(result))) === "sent";
  const kept = [...history, result].slice(-HISTORY_DAYS);
  await sql`INSERT INTO settings(key, value, updated_by) VALUES(${HISTORY_SETTING}, ${sql.json(kept as never)}, 'reconcile')
    ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return { day: result.day, sent };
}
