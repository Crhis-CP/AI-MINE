import { sql } from "../db.ts";
import { sourceCollectionWaits, sourceFetchHealth, sourcePresentationFailures } from "../acquisition/source-health.ts";
import { sourceMaterialHealth, sourceOutputRhythm, presentationMaterialRevisions } from "../content/source-health.ts";
import { presentationRefreshTimes } from "../admin/auth.ts";
import { runtimeControlSnapshot } from "../operations/lane-controls.ts";
import { sourceCollectionEnabled } from "../config.ts";

export const SOURCE_USE_NAMES = { editorial: "编辑内容", hot_signal: "热度信号" };
const often = (failures: number, tries: number) => failures >= 5 && failures / tries >= 0.1;

export interface SourceHealthRow {
  id: string;
  name: string;
  participation_mode: string;
  created_at: Date;
  health: string;
  fail_count: number;
  last_error: string | null;
  runs: number;
  failed: number;
  discoveries: number;
  items: number;
  undated: number;
  repeated: number;
  detail_attempts: number;
  detail_failures: number;
  ever_output: boolean;
  presentation_failures: Array<{ url: string; reason: string }>;
  waiting: { observed_at: Date; reason: string; retry_at: string | null } | null;
}
export interface QuietSource extends SourceHealthRow {
  evidence_days: number;
  median_gap_days: number | null;
  quiet_days: number | null;
}
export function rhythmMultiple(row: QuietSource) {
  return row.evidence_days >= 4 && row.median_gap_days && row.quiet_days !== null ? row.quiet_days / row.median_gap_days : null;
}
export function rhythmText(row: QuietSource) {
  const times = rhythmMultiple(row);
  if (times !== null) return `近 ${row.quiet_days} 天没有新内容，平时约 ${row.median_gap_days} 天一条（${Number(times.toFixed(1))} 倍）`;
  return `近 7 天 ${row.runs} 次抓取、0 条新内容；${!row.ever_output ? "从未收到过内容" : row.evidence_days ? `窗口内可比较的历史只有 ${row.evidence_days} 天` : "近 90 天窗口内没有可比较的产出"}`;
}
export const SOURCE_PROBLEMS = [
  {
    problem: "waiting",
    title: "采集仍在等待",
    describe: (s: SourceHealthRow) => {
      const reasons: Record<string, string> = {
        robots_unavailable: "暂时无法取得源站访问规则",
        transport_unavailable: "源站连接暂不可用",
        "HTTP 429": "源站限制请求频率",
        "HTTP 503": "源站服务暂不可用",
        source_reader_pending: "读取服务结果尚未返回",
      };
      const wait = s.waiting!;
      return `${reasons[wait.reason]}；最近等待记录 ${wait.observed_at.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（北京时间）；${wait.retry_at ? `该次计划重试 ${new Date(wait.retry_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（北京时间）` : "重试时间未记录"}`;
    },
    action: "程序按已有等待安排重试；请查看后续采集记录，勿绕过源站访问规则",
  },
  {
    problem: "failing",
    title: "连续抓取失败",
    describe: (s: SourceHealthRow) => `连续失败 ${s.fail_count} 次${s.last_error ? `，${s.last_error}` : ""}`,
    action: "检查抓取错误",
  },
  {
    problem: "unstable",
    title: "反复抓取失败",
    describe: (s: SourceHealthRow) => `近 7 天失败 ${s.failed}/${s.runs} 次`,
    action: "即使最近成功也需检查，避免继续漏收",
  },
  {
    problem: "quality",
    title: "文章质量待核实",
    describe: (s: SourceHealthRow) =>
      `近 7 天${[s.undated && `缺发布时间 ${s.undated} 篇`, s.repeated && `反复修订 ${s.repeated} 篇`].filter(Boolean).join("、")}`,
    action: "核对原站日期和正文是否混入变化内容",
  },
  {
    problem: "details",
    title: "详情补全失败",
    describe: (s: SourceHealthRow) => `近 7 天失败 ${s.detail_failures}/${s.detail_attempts} 页`,
    action: "查看抓取记录中的详情地址与错误",
  },
  {
    problem: "presentation",
    title: "正文展示待处理",
    describe: (s: SourceHealthRow) => s.presentation_failures.map((f) => `${f.url}：${f.reason}`).join("；"),
    action: "已保留前版原文与译文，请核对同篇正文展示或正常重翻",
  },
] as const;

/** News sources only; module-specific collectors keep their own operational reports. */
export async function sourceHealth(now = Date.now()) {
  const since = new Date(now - 7 * 86400_000),
    until = new Date(now);
  const [sources, fetches, materials, presentation, waits, controls] = await Promise.all([
    sql<Pick<SourceHealthRow, "id" | "name" | "participation_mode" | "created_at" | "health" | "fail_count" | "last_error">[]>`
      SELECT id,name,participation_mode,created_at,health,fail_count,left(regexp_replace(last_error,'[[:space:]]+',' ','g'),160) AS last_error
      FROM sources WHERE enabled AND lane='news' AND archived_at IS NULL AND kind NOT IN ('external','mp_account')
        AND participation_mode IN ('editorial','hot_signal') ORDER BY name,id`,
    sourceFetchHealth(since, until),
    sourceMaterialHealth(since, until),
    sourcePresentationFailures(),
    sourceCollectionWaits(until),
    runtimeControlSnapshot("news", ["collection"]),
  ]);
  const bodies = await presentationMaterialRevisions(
    presentation.map((p) => p.url),
    presentation.flatMap((p) => (p.identity_key ? [p.identity_key] : [])),
  );
  const repaired = new Map((await presentationRefreshTimes(bodies.map((b) => b.id))).map((r) => [r.subject, r.at]));
  const currentFailures = presentation.filter((f) => {
    const body = bodies.find((b) => (f.identity_key ? b.identity_key === f.identity_key : b.url === f.url)),
      at = body ? repaired.get(`content:${body.id}`) : null;
    return !body || (!(body.revised_at && body.revised_at > f.at) && !(at && at > f.at));
  });
  const fetchById = new Map(fetches.map((r) => [r.source_id, r])),
    materialById = new Map(materials.map((r) => [r.source_id, r])),
    waitById = new Map(waits.map((r) => [r.source_id, r]));
  const rows: SourceHealthRow[] = sources.map((s) => ({
    ...s,
    runs: 0,
    failed: 0,
    detail_attempts: 0,
    detail_failures: 0,
    discoveries: 0,
    items: 0,
    undated: 0,
    repeated: 0,
    ever_output: false,
    ...fetchById.get(s.id),
    ...materialById.get(s.id),
    presentation_failures: currentFailures.filter((f) => f.source_id === s.id),
    waiting: controls.paused || !sourceCollectionEnabled("news") ? null : (waitById.get(s.id) ?? null),
  }));
  const quiet = rows.filter((s) => s.created_at < since && s.discoveries === 0);
  const rhythms = new Map(
    (
      await sourceOutputRhythm(
        quiet.map((s) => s.id),
        until,
      )
    ).map((r) => [r.id, r]),
  );
  const measured: QuietSource[] = quiet.map((s) => ({ ...s, evidence_days: 0, median_gap_days: null, quiet_days: null, ...rhythms.get(s.id) }));
  return Object.entries(SOURCE_USE_NAMES).map(([mode, name]) => {
    const own = rows.filter((s) => s.participation_mode === mode),
      history = measured.filter((s) => s.participation_mode === mode);
    return {
      mode,
      name,
      sources: own,
      waiting: own.filter((s) => s.waiting !== null),
      failing: own.filter((s) => s.health === "failing"),
      unstable: own.filter((s) => s.health !== "failing" && often(s.failed, s.runs)),
      quality: mode === "editorial" ? own.filter((s) => s.undated > 0 || s.repeated > 0) : [],
      details: own.filter((s) => often(s.detail_failures, s.detail_attempts)),
      presentation: own.filter((s) => s.presentation_failures.length),
      overdue: history.filter((s) => (rhythmMultiple(s) ?? 0) > 4).sort((a, b) => rhythmMultiple(b)! - rhythmMultiple(a)!),
      unknown: history.filter((s) => rhythmMultiple(s) === null),
    };
  });
}

export async function sourceWeeklyCounts(since: Date) {
  const [row] = await sql<{ enabled: number; failing: number; degraded: number; added: number }[]>`SELECT
    count(*) FILTER(WHERE enabled)::int AS enabled,count(*) FILTER(WHERE enabled AND health='failing')::int AS failing,
    count(*) FILTER(WHERE enabled AND health='degraded')::int AS degraded,count(*) FILTER(WHERE created_at>=${since})::int AS added
    FROM sources WHERE lane='news' AND archived_at IS NULL`;
  return row!;
}

/** Recheck the old notice's window with current metadata; no source text or new quality threshold. */
export async function sourceQualityClearance(sourceId: string, sentAt: string, now: number): Promise<"window" | "observed" | null> {
  const at = Date.parse(sentAt);
  if (!Number.isFinite(at) || at > now) return null;
  const [old] = await sourceMaterialHealth(new Date(at - 7 * 86400_000), new Date(at), sourceId);
  if (!old || (!old.items && !old.repeated)) return null;
  return old.undated || old.repeated ? "window" : "observed";
}
