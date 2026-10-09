// Operations alerts. The person reading them is the site owner, not an engineer: each
// message says what readers see, whether it heals by itself and what, if anything, the owner must do.
//   now    — readers are affected and it has not healed: sent at once, repeated hourly, recovery reported.
//   today  — money at risk or only the owner can act: sent at once, repeated at most daily, recovery reported.
//   digest — follow-ups without reader impact: one 09:00 message a day, meant to be handed to the AI.
// Delivery goes through sendAlert (ops chat, internal-chat fallback; off unless FEISHU_INTERNAL_ENABLED).
import { beijingDate, beijingTime } from "@amp/contracts/time";
import { sourceIdsOnLane } from "../admin/sources.ts";
import { dbOf } from "../db.ts";
import { beijingDay, beijingStamp, duration, formatAlert, formatRecovery, sendAlert, type Finding, type Level } from "../notify/feishu.ts";
import { backupConfigured } from "./backup.ts";
import { readMetalPriceRuns, type MetalPriceSourceRecord } from "./metal-price-runs.ts";

// The metal price runs, for TASK-0076's check script: the backend's entries are frozen, so they go out through this one.
export { readMetalPriceRuns, type MetalPriceRuns, type MetalPriceSourceRecord } from "./metal-price-runs.ts";

const sql = dbOf("ops");

const REPEAT_MS: Record<Exclude<Level, "digest">, number> = { now: 3600_000, today: 24 * 3600_000 };

const collecting = () => process.env.COLLECT_ENABLED !== "false";
const modelsOn = () => process.env.MODEL_CALLS_ENABLED !== "false";
/** First-discovery silence warrants a check; it does not by itself prove collection or publication stopped. */
const QUIET_MS = Number(process.env.ALERT_QUIET_MINUTES || 360) * 60_000;
/** Where the metal price item sends the reader (TASK-0071); TASK-0076 adds its check script after it. */
const METALS_WHERE = "看 job_runs 里 metals.prices 的运行记录，或在 worker 容器里跑 scripts/metal-prices-check.ts";
/** An error or reason cut to 200 characters, as left(…, 200) does for the other items. */
const clip = (text: string) => [...text].slice(0, 200).join("");

/** Everything wrong right now, with its level. */
export async function collectFindings(now = Date.now(), observeIntake?: (lastDiscoveredAt: Date | null) => void): Promise<Finding[]> {
  const out: Finding[] = [];

  // ---- Readers affected now ----------------------------------------------------------------------
  // First discoveries are distinct from successful fetches and public updates. Reuse this same read
  // for recovery; a disabled or warming-up check supplies no evidence that intake recovered.
  const [hb] = await sql<{ value: { startedAt?: string } }[]>`SELECT value FROM settings WHERE key = 'heartbeat.worker'`;
  const settled = !hb?.value.startedAt || now - Date.parse(hb.value.startedAt) > 20 * 60_000;
  if (settled && collecting()) {
    // Policy arrivals must not conceal first-discovery silence on the news line (INV-42).
    const news = await sourceIdsOnLane("news");
    const [last] = await sql<{ at: Date | null }[]>`SELECT max(discovered_at) AS at FROM articles
      WHERE source_id = ANY(${news}::text[]) AND discovered_at > ${new Date(now - 4 * QUIET_MS)}`;
    const [anySource] = await sql`SELECT 1 FROM sources WHERE enabled AND lane = 'news' LIMIT 1`;
    if (anySource) observeIntake?.(last?.at ?? null);
    if (anySource && (!last?.at || now - last.at.getTime() > QUIET_MS)) {
      out.push({
        key: "content.collect",
        level: "now",
        title: "新文章入库长时间无新增",
        impact: last?.at
          ? `最近一次新文章入库于 ${beijingStamp(last.at)}；采集或公开是否异常仍需核查`
          : "检查窗口内没有新文章首次入库记录；采集或公开是否异常仍需核查",
        heals: "尚不能判断，需核对采集及处理记录",
        action: "转给 AI 核查采集、处理与公开记录",
        detail: `articles.discovered_at 超过 ${Math.round(QUIET_MS / 60_000)} 分钟没有新值（ALERT_QUIET_MINUTES）；查 sources.schedule、出网代理与采集失败`,
        since: last?.at ?? undefined,
      });
    }
  }
  if (settled && collecting() && modelsOn()) {
    const [p] = await sql<{ waiting: number; oldest: Date | null; failed: number }[]>`
      SELECT count(*) FILTER (WHERE processing_state = 'new' AND discovered_at < now() - interval '2 hours')::int AS waiting,
             min(discovered_at) FILTER (WHERE processing_state = 'new') AS oldest,
             count(*) FILTER (WHERE processing_state = 'failed' AND discovered_at > now() - interval '3 hours')::int AS failed
      FROM articles WHERE processing_state IN ('new', 'failed') AND discovered_at > now() - interval '2 days'`;
    if (p!.waiting >= 10 || p!.failed >= 20) {
      const errors = await sql<{ error: string; n: number }[]>`
        SELECT left(coalesce(processing_error, '（无）'), 120) AS error, count(*)::int AS n FROM articles
        WHERE processing_state IN ('new', 'failed') AND discovered_at > now() - interval '3 hours' AND processing_error IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC LIMIT 3`;
      out.push({
        key: "content.process",
        level: "now",
        title: "新内容卡住了，进不了网站",
        impact:
          [p!.waiting >= 10 && `${p!.waiting} 篇新文章等了 2 小时以上还没处理完`, p!.failed >= 20 && `最近 3 小时 ${p!.failed} 篇新文章处理失败`]
            .filter(Boolean)
            .join("；") + "，精选和热点会缺内容",
        heals: p!.waiting >= 10 ? "服务恢复后会自动补处理" : "不会，需要修好后重新处理这些文章",
        action: "转给 AI 处理",
        detail: errors.map((e) => `${e.error}（${e.n}）`).join("；") || "没有记录错误",
        since: p!.waiting >= 10 && p!.oldest ? p!.oldest : undefined,
      });
    }
    // The daily report is composed at 08:00 and caught up hourly.
    if (Number(beijingTime(now).slice(0, 2)) >= 10) {
      const [r] = await sql`SELECT 1 FROM reports WHERE kind = 'daily' AND key = ${beijingDate(now)}`;
      if (!r) {
        out.push({
          key: "report.daily",
          level: "now",
          title: "今天的日报还没生成",
          impact: "读者看不到今天的日报",
          heals: "系统每小时补做一次，到现在还没成功",
          action: "转给 AI 处理",
          detail: `reports daily ${beijingDate(now)} 不存在；看 reports.daily / reports.catch-up 的运行记录`,
        });
      }
    }
  }

  // ---- Money, and things only the owner can do --------------------------------------------------
  out.push(...(await providerFindings()));

  // Content-group pushes the Feishu webhook refused (a removed bot, a changed address); nothing resends them.
  const [refused] = await sql<{ n: number; target: string | null; response: string | null }[]>`
    SELECT count(*)::int AS n, max(t.note) AS target, left(max(d.response), 200) AS response FROM deliveries d JOIN notify_targets t ON t.key = d.target_key
    WHERE d.status = 'failed' AND d.updated_at > now() - interval '1 day'`;
  if (refused!.n > 0) {
    out.push({
      key: "deliveries.failed",
      level: "today",
      title: "飞书内容群有推送没发出去",
      impact: `过去 24 小时 ${refused!.n} 条精选通知没进${refused!.target ?? "内容群"}`,
      heals: "不会自动重发",
      action: "转给 AI 处理；如果推送机器人被移出了群，需要你把它加回去",
      detail: refused!.response ?? "",
    });
  }

  if (backupConfigured()) {
    const [b] = await sql<{ value: { at: string; uploaded: boolean; filesError?: string } }[]>`SELECT value FROM settings WHERE key = 'backup.last'`;
    const age = b ? now - Date.parse(b.value.at) : Infinity;
    const state = b?.value.filesError ? `数据库已上传，附件打包失败：${b.value.filesError}` : b?.value.uploaded === false ? "未上传" : "";
    if (b?.value.uploaded && age > 50 * 3600_000) {
      out.push({
        key: "backup.failed",
        level: "today",
        title: "数据库备份连续两天没成功",
        impact: "平时没有影响；万一服务器出事，最多会丢两天的数据",
        heals: "不会",
        action: "转给 AI 处理",
        detail: `最近一次成功 ${beijingStamp(b.value.at)}；看 ops.backup 的运行记录`,
        since: new Date(b.value.at),
      });
    } else if (!b || !b.value.uploaded || age > 30 * 3600_000) {
      out.push({
        key: "backup.stale",
        level: "digest",
        title: "数据库备份超过一天没成功",
        detail: b ? `最近一次 ${beijingStamp(b.value.at)}${state ? `（${state}）` : ""}；看 ops.backup` : "还没有成功的备份记录",
      });
    }
  }

  // ---- Follow-ups for the daily digest ------------------------------------------------------------
  const [r] = await sql<{ receipts: number; services: string | null; deliveries: number }[]>`
    SELECT (SELECT count(*)::int FROM receipts WHERE status = 'unknown') AS receipts,
           (SELECT string_agg(DISTINCT service || '/' || purpose, '、') FROM receipts WHERE status = 'unknown') AS services,
           (SELECT count(*)::int FROM deliveries WHERE status = 'unknown') AS deliveries`;
  if (r!.receipts > 0) {
    out.push({
      key: "receipts.unknown",
      level: "digest",
      title: `${r!.receipts} 个付费请求自动重试过一次，结果仍未知`,
      detail: `${r!.services}；在后台“用量与模型密钥”里的“费用与投递核对”核对后放行`,
    });
  }
  if (r!.deliveries > 0)
    out.push({
      key: "deliveries.unknown",
      level: "digest",
      title: `${r!.deliveries} 条飞书内容群推送不确定是否送达`,
      detail: "在后台“用量与模型密钥”里的“费用与投递核对”核对群里有没有，再标记或重发",
    });

  // Runnable jobs (deferred ones excluded) that have waited more than two hours.
  const queues = await sql<{ name: string; n: number; oldest: Date }[]>`
    SELECT name, count(*)::int AS n, min(start_after) AS oldest FROM pgboss.job
    WHERE state IN ('created', 'retry') AND start_after <= now() AND name NOT LIKE 'cron.%' GROUP BY 1`;
  for (const q of queues) {
    if (now - q.oldest.getTime() > 2 * 3600_000) {
      out.push({
        key: `queue.${q.name}`,
        level: "digest",
        title: `后台任务排队超过 2 小时：${q.name}`,
        detail: `${q.n} 个等待，最早的等了 ${duration(now - q.oldest.getTime())}`,
      });
    }
  }

  // Metal prices (TASK-0071), as upstream's leaderboard sources: one not fetched for over a day leaves the page showing its
  // last period (marked stale past the threshold), so it waits for the digest. The schedule runs only while collecting.
  // A run record this cannot read becomes the item instead of stopping every other alert.
  if (collecting()) {
    try {
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

  return out;
}

const MODEL_STOPS = "用到这家模型的步骤停了（看后台“用量与模型密钥”里的“模型与近期用量”），新内容可能进不了精选";
const PROVIDERS: Record<string, { name: string; stops: string; where: string }> = {
  llm: { name: "默认模型服务", stops: "新文章的精选、摘要、归组和日报停了", where: "模型服务商的控制台" },
  zhipu: { name: "智谱", stops: MODEL_STOPS, where: "智谱开放平台" },
  dashscope: { name: "阿里云百炼", stops: MODEL_STOPS, where: "阿里云百炼控制台" },
  deepseek: { name: "DeepSeek", stops: MODEL_STOPS, where: "DeepSeek 开放平台" },
  mimo: { name: "小米 MiMo", stops: MODEL_STOPS, where: "小米 MiMo 开放平台" },
  jina: { name: "Jina", stops: "部分文章取不到正文", where: "Jina 后台" },
  dajiala: { name: "极致了（Dajiala）", stops: "公众号新文章收不到", where: "极致了后台" },
};
export const providerName = (service: string) => PROVIDERS[service]?.name ?? service;
export const providerStops = (service: string) => PROVIDERS[service]?.stops ?? "相关功能停了";
export const providerConsole = (service: string) => PROVIDERS[service]?.where ?? `${service} 后台`;

/** Paid services that refuse us (no balance, a dead key), and services the request meter stopped for an hour or a day. */
async function providerFindings(): Promise<Finding[]> {
  const out: Finding[] = [];
  const refused = await sql<{ service: string; n: number; last: string }[]>`
    SELECT service, count(*)::int AS n, (array_agg(left(error, 200) ORDER BY started_at DESC))[1] AS last FROM receipt_attempts
    WHERE status = 'failed' AND started_at > now() - interval '1 hour'
      AND error ~* '(HTTP 40[123]\\M|insufficient|balance|arrear|good standing|欠费|余额)'
    GROUP BY 1 HAVING count(*) >= 3`;
  for (const p of refused) {
    out.push({
      key: `provider.refused.${p.service}`,
      level: "today",
      title: `${providerName(p.service)} 拒绝服务，可能欠费或账号失效`,
      impact: providerStops(p.service),
      heals: "不会",
      action: `去${providerConsole(p.service)}看余额和账号状态；充值或恢复后系统会自动继续`,
      detail: `最近 1 小时被拒 ${p.n} 次：${p.last}`,
    });
  }
  // The meter in providers/receipts.ts (checkBudget) stops a service while its live calls of the past hour or day reach the
  // limit, and lets it go once they fall back. The per-minute window is a 60-second pause and is not announced. A service
  // with any limit at 0 or below was stopped by hand, not by the meter.
  // A stop already announced stays open until its window falls below 80% of the limit: while a burst lasts, retries refill
  // the window as old calls leave it, and without this margin the alert would close and reopen every few minutes.
  const [alerts] = await sql<{ value: Record<string, unknown> }[]>`SELECT value FROM settings WHERE key = 'alerts.state'`;
  const announced = (key: string) => !!alerts?.value[key];
  const capped = await sql<{ service: string; per_hour: number; per_day: number; models: boolean; hour: number; day: number }[]>`
    SELECT b.service, b.per_hour, b.per_day, bool_or(a.model IS NOT NULL) AS models,
           (count(a.id) FILTER (WHERE a.started_at > now() - interval '1 hour'))::int AS hour, count(a.id)::int AS day
    FROM budgets b
    JOIN receipt_attempts a ON a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 day'
    WHERE b.per_minute > 0 AND b.per_hour > 0 AND b.per_day > 0
    GROUP BY 1, 2, 3
    HAVING count(a.id) FILTER (WHERE a.started_at > now() - interval '1 hour') >= b.per_hour * 0.8 OR count(a.id) >= b.per_day * 0.8`;
  for (const c of capped) {
    const windows = [
      { key: "hour", used: c.hour, limit: c.per_hour, span: "1 小时", column: "per_hour" },
      { key: "day", used: c.day, limit: c.per_day, span: "24 小时", column: "per_day" },
    ];
    for (const w of windows.filter((w) => w.used >= w.limit || (w.used >= w.limit * 0.8 && announced(`budget.${w.key}.${c.service}`)))) {
      out.push({
        key: `budget.${w.key}.${c.service}`,
        level: "today",
        title: `${providerName(c.service)} 过去 ${w.span}的调用次数异常，已自动暂停付费调用（不是总额上限）`,
        impact: `${providerStops(c.service)}，直到调用次数回落`,
        heals: `会，过去 ${w.span}的调用次数回落到限额以下就自动恢复；降到限额的八成以下时再发“已恢复”`,
        action: `先看后台“用量与模型密钥”里的${c.models ? "“模型与近期用量”，是哪一步调用变多" : "“通知与请求频率”，这项服务近 1 小时、近 24 小时各用了多少次"}；这不是总额上限，经常出现再决定要不要在“通知与请求频率”里调高限额`,
        detail: `${w.span}内 ${w.used} 次，限额 ${w.limit}（budgets 表 ${w.column}）`,
      });
    }
  }
  return out;
}

interface AlertState {
  [key: string]: { title: string; level?: Level; since: string; sentAt: string };
}

/** Every 10 minutes: new problems and recoveries of the now/today levels go out; digest items wait for 09:00. */
export async function checkAlerts(now = Date.now()) {
  const intake: { at?: Date | null } = {};
  const found = (
    await collectFindings(now, (at) => {
      intake.at = at;
    })
  ).filter((f) => f.level !== "digest");
  const [row] = await sql<{ value: AlertState }[]>`SELECT value FROM settings WHERE key = 'alerts.state'`;
  const state: AlertState = { ...(row?.value ?? {}) };
  const sent: string[] = [];
  const opened: string[] = [];
  for (const f of found) {
    const level = f.level as Exclude<Level, "digest">;
    const open = state[f.key]?.level ? state[f.key] : undefined;
    if (open && now - Date.parse(open.sentAt) <= REPEAT_MS[level]) continue;
    const since = open ? new Date(open.since) : (f.since ?? new Date(now));
    const msg = formatAlert(f, since, now, !!open);
    await sendAlert(msg.title, msg.lines);
    state[f.key] = { title: f.title, level, since: since.toISOString(), sentAt: new Date(now).toISOString() };
    sent.push(f.key);
    if (!open) opened.push(f.key);
  }
  for (const key of Object.keys(state)) {
    if (found.some((f) => f.key === key)) continue;
    // Entries without a level predate this scheme (2026-09-29) and close without a message.
    if (state[key]!.level) {
      // A missing finding may mean collection was paused or the worker is warming up. Keep this
      // incident open until a real discovery advances; never replay its legacy outage title.
      if (key === "content.collect" && !(intake.at && intake.at.getTime() > Date.parse(state[key]!.since) && intake.at.getTime() <= now)) continue;
      const msg = formatRecovery(key === "content.collect" ? "新文章入库" : state[key]!.title, new Date(state[key]!.since), now);
      await sendAlert(msg.title, msg.lines);
      sent.push(`${key}:recovered`);
    }
    delete state[key];
  }
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('alerts.state', ${sql.json(state as never)}, 'alerts')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  // `opened` (the keys first announced this round) is kept in the ops.alerts run record for autoStopsBetween.
  return { open: Object.keys(state), sent, opened };
}

/**
 * The days on which the meter had a service stopped between `from` and `to` (TASK-0063, for the weekly usage report), read
 * from the ops.alerts run records: a budget.* key in a run's `open` (the alerts open after that run), counted once per
 * service and Beijing day, so a stop that lasts past midnight counts on both days and one that opens and closes several
 * times a day is one day. Runs from before `opened` was recorded are not counted; `coveredFrom` is the first run in the
 * window that records it.
 */
export async function autoStopsBetween(from: Date, to: Date): Promise<{ days: number; byService: Record<string, number>; coveredFrom: Date | null }> {
  const runs = await sql<{ started_at: Date; detail: { open?: unknown; opened?: unknown } | null }[]>`
    SELECT started_at, detail FROM job_runs
    WHERE job = 'ops.alerts' AND status = 'ok' AND started_at >= ${from} AND started_at < ${to}
    ORDER BY started_at`;
  const allDays = new Set<string>();
  const serviceDays = new Map<string, Set<string>>();
  let coveredFrom: Date | null = null;
  for (const run of runs) {
    if (!Array.isArray(run.detail?.opened)) continue;
    coveredFrom ??= run.started_at;
    const open = Array.isArray(run.detail?.open) ? run.detail.open : [];
    const day = beijingDate(run.started_at);
    for (const key of open) {
      if (typeof key !== "string" || !key.startsWith("budget.")) continue;
      const service = key.split(".").slice(2).join(".");
      allDays.add(day);
      if (!serviceDays.has(service)) serviceDays.set(service, new Set());
      serviceDays.get(service)!.add(day);
    }
  }
  const byService = Object.fromEntries([...serviceDays].map(([service, days]) => [service, days.size]));
  return { days: allDays.size, byService, coveredFrom };
}

/** 09:00: one message with the follow-ups that do not touch readers; nothing when there are none. */
export async function sendDigest(now = Date.now()) {
  const items = (await collectFindings(now)).filter((f) => f.level === "digest");
  const lines = items.map((f, i) => `${i + 1}. ${f.title}${f.detail ? `\n   ${f.detail}` : ""}`);
  if (!lines.length) return { items: 0 };
  await sendAlert(`📋 系统日报 · ${beijingDay(now)}`, ["以下事项不影响读者，你不用处理；需要的话把整条转给 AI。", ...lines]);
  return { items: lines.length };
}
