// The daily reconciliation: one message every morning with the numbers that say whether the site did its job
// yesterday. It answers what used to be asked by hand before each release (how many sources are silent and why,
// what was collected and what reached readers, whether translations keep up, how long the model accounts last),
// so the Owner sees a drift the day it starts, not when a reader notices. Read-only; no model, no network.
// The alerts (alerts.ts) tell of single things that broke; this is the whole picture, sent whether or not
// anything broke. Each number is read through the module that owns the table; this file only puts them together.
import { addDays, beijingDate, beijingMidnight } from "@amp/contracts/time";
import { sql } from "../db.ts";
import { beijingDay, beijingStamp, sendAlert } from "../notify/feishu.ts";
import { sourceIdsOnLane } from "../admin/sources.ts";
import { countDiscovered } from "../content/materials.ts";
import { scoredRelevantArticles } from "../enrichment/records.ts";
import { articleLinkCoverage } from "../pipeline/entities/store.ts";
import type { DatelineKind } from "../pipeline/understand/dateline.ts";
import { articleCheckSummary } from "../pipeline/understand/observe.ts";
import { type AccountDaysLeft, accountDaysLeft } from "../providers/account-balance.ts";
import { notPublicAmong, publicationFlow, translationLag } from "../publication/items.ts";
import { sourceHealth } from "../sources/health.ts";

/**
 * Why a source brought nothing in seven days, in the order the reasons are tried. "quiet" is said only of a source whose
 * usual rhythm is known and not exceeded; without enough history to know the rhythm the cause is "unknown", not assumed.
 */
export const SILENCE_REASONS = ["failing", "waiting", "unstable", "overdue", "unknown", "quiet"] as const;
export type SilenceReason = (typeof SILENCE_REASONS)[number];
const REASON_ZH: Record<SilenceReason, string> = {
  failing: "连续抓取失败",
  waiting: "被源站限流或在等待",
  unstable: "时好时坏",
  overdue: "按平时节奏早该更新",
  unknown: "历史太短，还看不出规律",
  quiet: "来源本身没更新",
};

export interface Reconciliation {
  /** The Beijing day the numbers are about (yesterday of the run). */
  day: string;
  sources: { enabled: number; withNew: number; silent: Record<SilenceReason, number> };
  /**
   * Collected: new reports found that day, history imports left out. Public: reports first shown to readers that day.
   * Selected: reports first shown as selected that day, which may have become public on an earlier day.
   */
  flow: { collected: number; public: number; selected: number; scoredNotPublic: number };
  /** Foreign-language reports shown with their full text, public for more than an hour, and those among them without a finished Chinese translation. */
  translation: { due: number; missing: number };
  /** Each model account's latest reading; for a fresh one, the days it lasts at the recent daily spend. */
  balance: AccountDaysLeft[];
  /**
   * The per-article shadow (pipeline/understand/observe.ts), which changes nothing readers see: articles judged that
   * day that were checked, those with at least one company found, how many entities the library holds (0: not seeded
   * yet), the soft figure findings and the datelines by kind. The hard figure class is left out until a labelled sample shows how
   * often it is right (design L, review F7). Absent in days stored before it existed.
   */
  articleChecks?: { checked: number; linked: number; library: number; softFlags: number; softArticles: number; datelines: Record<DatelineKind, number> };
}

export async function reconcile(now = Date.now()): Promise<Reconciliation> {
  const today = beijingDate(now),
    day = addDays(today, -1),
    start = beijingMidnight(day),
    end = beijingMidnight(today);

  const groups = await sourceHealth(now);
  const silent: Record<SilenceReason, number> = { failing: 0, waiting: 0, unstable: 0, overdue: 0, unknown: 0, quiet: 0 };
  // sourceHealth measures the rhythm only of sources older than its seven-day window; a newer one has no rhythm yet.
  const measuredBefore = now - 7 * 86400_000;
  let enabled = 0,
    withNew = 0;
  for (const group of groups) {
    const ids = (rows: ReadonlyArray<{ id: string }>) => new Set(rows.map((s) => s.id));
    const failing = ids(group.failing),
      waiting = ids(group.waiting),
      unstable = ids(group.unstable),
      overdue = ids(group.overdue),
      unknown = ids(group.unknown);
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
              : unknown.has(source.id) || source.created_at.getTime() >= measuredBefore
                ? "unknown"
                : "quiet";
      silent[reason]++;
    }
  }

  const [collected, shown, scored] = await Promise.all([
    sourceIdsOnLane("news").then((ids) => countDiscovered(ids, start, end)),
    publicationFlow(start, end),
    scoredRelevantArticles(start, end),
  ]);
  const scoredNotPublic = await notPublicAmong(scored);
  // A report needs an hour to be translated before it counts as late.
  const translation = await translationLag(start, new Date(Math.min(end.getTime(), now - 3600_000)));
  const balance = await accountDaysLeft(now);
  const checks = await articleCheckSummary(start, end);
  const coverage = await articleLinkCoverage(checks.articles);

  return {
    day,
    sources: { enabled, withNew, silent },
    flow: { collected, public: shown.public, selected: shown.selected, scoredNotPublic },
    translation,
    balance,
    articleChecks: {
      checked: checks.articles.length,
      linked: coverage.linked,
      library: coverage.library,
      softFlags: checks.softFlags,
      softArticles: checks.softArticles,
      datelines: checks.datelines,
    },
  };
}

const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "0%");

/** A stale reading is told as what it is, the last figure read and when, never as today's money. */
function balanceLine(b: AccountDaysLeft): string {
  if (b.stale) {
    const when = Number.isFinite(Date.parse(b.at)) ? `（${beijingStamp(b.at)}）` : "";
    return `模型余额 ${b.service}：最新余额没读到，上次读到的是 ${b.yuan.toFixed(0)} 元${when}，这个读数已过期`;
  }
  const lasts = b.days === null ? "" : b.days < 1 ? "，按近 7 天的用量不到 1 天就会用完" : `，按近 7 天的用量约够 ${b.days} 天`;
  return `模型余额 ${b.service}：${b.yuan.toFixed(0)} 元${lasts}`;
}

/**
 * The per-article shadow in three lines, counts only; none on a day nothing was checked (the switch is off). The soft
 * figure class is what the check is unsure of; the hard class stays out of the message (design L, review F7).
 */
function articleCheckLines(c: Reconciliation["articleChecks"]): string[] {
  if (!c?.checked) return [];
  return [
    `单篇核对（只记录，读者看不到）：昨天判断的稿件核对了 ${c.checked} 条，认出至少一家公司的 ${c.linked} 条（${percent(c.linked, c.checked)}）${c.library ? "" : "；公司库还没导入，认出的公司没有存下"}`,
    `数字核对（只标记，不改稿）：程序拿不准的数字或日期 ${c.softFlags} 处（${c.softArticles} 条）`,
    `电头：新闻稿 ${c.datelines.release_wire} 条，通讯社 ${c.datelines.news_agency} 条，只写地点和日期 ${c.datelines.unmarked} 条`,
  ];
}

/** The message, in the Owner's words: what readers got, what did not arrive, what needs money. */
export function reconcileLines(r: Reconciliation): string[] {
  const silentTotal = SILENCE_REASONS.reduce((n, reason) => n + r.sources.silent[reason], 0);
  const reasons = SILENCE_REASONS.filter((reason) => r.sources.silent[reason] > 0).map((reason) => `${REASON_ZH[reason]} ${r.sources.silent[reason]}`);
  // The three counts of the first line are separate events; none is worded as a part of another.
  const lines = [
    `读者昨天看到：新公开 ${r.flow.public} 条，新进精选 ${r.flow.selected} 条；当天新收到 ${r.flow.collected} 条（不含历史补录）`,
    `信源：开着 ${r.sources.enabled} 个，近 7 天有新内容的 ${r.sources.withNew} 个，没有新内容的 ${silentTotal} 个${reasons.length ? `（${reasons.join("；")}）` : ""}`,
  ];
  if (r.flow.scoredNotPublic > 0) lines.push(`评过分、合格但没有公开：${r.flow.scoredNotPublic} 条`);
  lines.push(
    r.translation.due
      ? `译文：该有中文译文的外文稿 ${r.translation.due} 条，还没有的 ${r.translation.missing} 条（${percent(r.translation.missing, r.translation.due)}）`
      : "译文：昨天没有需要翻译的外文稿",
  );
  lines.push(...articleCheckLines(r.articleChecks));
  lines.push(...r.balance.map(balanceLine));
  return lines;
}

const HISTORY_SETTING = "reconcile.daily";
const HISTORY_DAYS = 30;

/** A day as kept in the history: its numbers, and whether the message about them went out. */
type StoredDay = Reconciliation & { sent: boolean };

/**
 * Every morning: compute, keep the last thirty days for comparison, and send. The day is stored before sending, marked
 * unsent, so a Feishu failure never loses the numbers. The error fails the job; the queue retries it once at once, and
 * any later run for the same day sends the message. Nothing else runs it again that day (the schedule fires once), so
 * after a longer outage the day stays stored and unsent. A day already sent is not sent again. With sending switched
 * off the day stays unsent and goes out if a later run that day finds sending on.
 */
export async function sendReconcile(now = Date.now()): Promise<{ day: string; sent: boolean }> {
  const result = await reconcile(now);
  const [row] = await sql<{ value: StoredDay[] }[]>`SELECT value FROM settings WHERE key = ${HISTORY_SETTING}`;
  const history = Array.isArray(row?.value) ? row.value : [];
  if (history.some((entry) => entry.day === result.day && entry.sent)) return { day: result.day, sent: false };
  // The numbers just computed replace an unsent entry of the same day, so what is stored is what the message says.
  const store = async (sent: boolean) => {
    const kept = [...history.filter((entry) => entry.day !== result.day), { ...result, sent }].sort((a, b) => a.day.localeCompare(b.day)).slice(-HISTORY_DAYS);
    await sql`INSERT INTO settings(key, value, updated_by) VALUES(${HISTORY_SETTING}, ${sql.json(kept as never)}, 'reconcile')
      ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  };
  await store(false);
  const sent = (await sendAlert(`📊 每日对账 · ${beijingDay(beijingMidnight(result.day))}`, reconcileLines(result))) === "sent";
  if (sent) await store(true);
  return { day: result.day, sent };
}
