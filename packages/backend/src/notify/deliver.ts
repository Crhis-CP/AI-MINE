// Content-group deliveries (Feishu custom-bot webhooks): selected cards.
// One row per target and dedupe key, so nothing is pushed twice; an outcome we cannot know
// ("unknown") is never retried automatically; content older than a target's enabled_at is never
// back-filled. FEISHU_CONTENT_PUSH_ENABLED is the safety valve: off, deliveries are recorded as
// skipped and nothing leaves the process.
import { config, credential } from "../config.ts";
import { sql, type Db } from "../db.ts";
import { publicItemMetadata } from "@amp/backend/publication/detail";
import { lockReportPublications } from "@amp/backend/publication/publish";
import { lockNewsModelMaterials } from "@amp/backend/content/materials";
import { jurisdictionDescendants } from "@amp/industry/jurisdictions";
import { audit, requireOwner, type AdminPrincipal } from "../admin/auth.ts";
import { postWebhook } from "./feishu.ts";
import { runtimeControlSnapshot, requireRuntimeRunning, RuntimeControlPaused } from "@amp/backend/operations/lane-controls";

const MAX_AUTO_ATTEMPTS = 6;
async function pushPaused() {
  return (await runtimeControlSnapshot("news", ["publication"])).paused;
}

// For scripts/feishu-check.ts: the backend's entry points are frozen, so the check reaches Feishu through this one.
export { feishuInternalEnabled, feishuSettingsSummary, listBotChats, sendAlert } from "./feishu.ts";

export async function listTargets() {
  return sql`
    SELECT t.key, t.purpose, t.kind, t.enabled, t.enabled_at, t.config_ref, t.note, t.updated_at,
           (SELECT count(*)::int FROM deliveries d WHERE d.target_key = t.key AND d.created_at > now() - interval '7 days') AS deliveries_7d,
           (SELECT max(d.sent_at) FROM deliveries d WHERE d.target_key = t.key) AS last_sent_at
    FROM notify_targets t ORDER BY t.purpose, t.key`;
}

export async function setTargetEnabled(key: string, enabled: boolean, reason: string, actor: string, principal?: AdminPrincipal) {
  return sql.begin(async (tx) => {
    if (principal) await requireOwner(principal, tx);
    if (!reason?.trim()) throw new Error("reason is required");
    const [before] = await tx`SELECT enabled, enabled_at FROM notify_targets WHERE key = ${key}`;
    if (!before) return null;
    const [after] = await tx`
    UPDATE notify_targets SET enabled = ${enabled}, enabled_at = CASE WHEN ${enabled} AND NOT enabled THEN now() ELSE enabled_at END, updated_at = now()
    WHERE key = ${key} RETURNING key, enabled, enabled_at`;
    await audit(actor, enabled ? "notify.enable" : "notify.disable", `notify-target:${key}`, reason, before, after, undefined, tx);
    return { ...after, pushEnabledHere: config.feishuContentPushEnabled };
  });
}

export interface DeliveryRequest {
  subjectKind: "selected";
  subjectId: string;
  dedupeKey: string;
  /** When the underlying content appeared; older than a target's enabled_at means skip. */
  contentAt: Date;
  card: unknown;
}

interface Target {
  key: string;
  kind: "feishu_webhook" | "feishu_chat" | "log";
  enabled_at: Date | null;
  config_ref: string | null;
  jurisdiction: string | null;
}

async function matchesCountry(articleId: string, jurisdiction: string | null, db: Db = sql) {
  if (jurisdiction === null) return true;
  const countries = (await publicItemMetadata(articleId, db))?.jurisdictions ?? [];
  return jurisdictionDescendants(jurisdiction).some((code) => countries.includes(code));
}

async function currentTargetMatches(target: Target, req: DeliveryRequest, db: Db) {
  // Match publication writers' fence order; check geography only after every potentially waiting lock.
  await db`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
  await requireRuntimeRunning("news", ["publication"], db);
  await lockNewsModelMaterials([req.subjectId], db);
  await lockReportPublications([req.subjectId], db);
  const [current] = await db`SELECT key FROM notify_targets WHERE key=${target.key} AND enabled AND purpose IN ('content','country_content')
    AND kind=${target.kind} AND config_ref IS NOT DISTINCT FROM ${target.config_ref}
    AND jurisdiction IS NOT DISTINCT FROM ${target.jurisdiction}
    AND (enabled_at IS NULL OR enabled_at<=${req.contentAt}) FOR SHARE`;
  return !!current && (await matchesCountry(req.subjectId, target.jurisdiction, db));
}

export class DeliveryConflict extends Error {
  code = "conflict";
}

/** Default content targets; they start disabled and are switched on in production only. */
export async function ensureContentTargets() {
  await sql`
    INSERT INTO notify_targets (key, purpose, kind, enabled, config_ref, note, jurisdiction) VALUES
      ('feishu-content-main', 'content', 'feishu_webhook', false, 'FEISHU_PUSH_WEBHOOK_URL', '飞书内容主群', NULL),
      ('feishu-content-mirror', 'content', 'feishu_webhook', false, 'FEISHU_PUSH_MIRROR_WEBHOOK_URL', '飞书内容镜像群', NULL),
      ('feishu-content-argentina', 'country_content', 'feishu_webhook', false, 'FEISHU_PUSH_ARGENTINA_WEBHOOK_URL', '阿根廷矿业精选', 'AR')
    ON CONFLICT (key) DO NOTHING`;
}

/** Persist the known outcome and only retry a definite rate-limit rejection. */
async function recordDeliveryResult(id: number, res: Awaited<ReturnType<typeof postWebhook>>) {
  const status = res.ok ? "sent" : res.rejected ? "failed" : "unknown";
  const [row] = await sql<{ attempts: number }[]>`SELECT attempts FROM deliveries WHERE id=${id}`;
  const now = Date.now();
  let retryAt: Date | null = null;
  if (res.status === 429 && row && row.attempts < MAX_AUTO_ATTEMPTS) {
    const header = res.retryAfter?.trim();
    const requested = header ? (/^\d+$/.test(header) ? now + Number(header) * 1000 : Date.parse(header)) : now;
    const next = Math.max(now + Math.min(3600000, 120000 * 2 ** Math.max(0, row.attempts - 1)), Number.isFinite(requested) ? requested : now);
    if (next <= now + 12 * 3600000) retryAt = new Date(next);
  }
  await sql`UPDATE deliveries SET status=${status},response=${res.body.slice(0, 500)},sent_at=${res.ok ? new Date() : null},
    retry_reason=${retryAt ? "rate_limited" : null},retry_at=${retryAt},updated_at=now() WHERE id=${id}`;
  return status;
}

export async function deliverContent(req: DeliveryRequest): Promise<Array<{ target: string; status: string }>> {
  const targets = await sql<
    Target[]
  >`SELECT key, kind, enabled_at, config_ref, jurisdiction FROM notify_targets WHERE purpose IN ('content','country_content') AND enabled`;
  const results: Array<{ target: string; status: string }> = [];
  for (const t of targets) {
    if (t.enabled_at && req.contentAt < t.enabled_at) continue;
    if (!(await matchesCountry(req.subjectId, t.jurisdiction))) continue;
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO deliveries (target_key, subject_kind, subject_id, dedupe_key, status, payload)
      VALUES (${t.key}, ${req.subjectKind}, ${req.subjectId}, ${req.dedupeKey}, 'pending', ${sql.json(req.card as never)})
      ON CONFLICT (target_key, dedupe_key) DO NOTHING RETURNING id`;
    if (!row) continue; // already delivered, skipped or in doubt
    if (!config.feishuContentPushEnabled || t.kind !== "feishu_webhook") {
      await sql`UPDATE deliveries SET status = 'skipped', response = 'content push disabled', updated_at = now() WHERE id = ${row.id}`;
      results.push({ target: t.key, status: "skipped" });
      continue;
    }
    if (await pushPaused()) {
      await sql`UPDATE deliveries SET response='发布已暂停，等待恢复' WHERE id=${row.id}`;
      results.push({ target: t.key, status: "pending" });
      continue;
    }
    const url = t.config_ref ? credential("integrations", t.config_ref) : undefined;
    if (!url) {
      await sql`UPDATE deliveries SET status = 'failed', response = 'webhook not configured', updated_at = now() WHERE id = ${row.id}`;
      results.push({ target: t.key, status: "failed" });
      continue;
    }
    let sending: number;
    try {
      sending = await sql.begin(async (tx) => {
        if (!(await currentTargetMatches(t, req, tx))) return 0;
        const changed = await tx`UPDATE deliveries SET status='sending',attempts=attempts+1,updated_at=now() WHERE id=${row.id} AND status='pending'
      AND EXISTS(SELECT 1 FROM notify_targets WHERE key=${t.key} AND enabled AND purpose IN ('content','country_content') AND kind=${t.kind}
        AND config_ref IS NOT DISTINCT FROM ${t.config_ref} AND (enabled_at IS NULL OR enabled_at<=${req.contentAt}))`;
        return changed.count;
      });
    } catch (error) {
      if (!(error instanceof RuntimeControlPaused)) throw error;
      await sql`UPDATE deliveries SET response='发布已暂停，等待恢复' WHERE id=${row.id} AND status='pending'`;
      results.push({ target: t.key, status: "pending" });
      continue;
    }
    if (!sending) {
      await sql`UPDATE deliveries SET status='skipped',response='目标状态已变化',updated_at=now() WHERE id=${row.id} AND status='pending'`;
      continue;
    }
    try {
      const res = await postWebhook(url, req.card);
      // Only an explicit acknowledgement or rejection is known; malformed responses remain uncertain.
      const status = await recordDeliveryResult(row.id, res);
      results.push({ target: t.key, status });
    } catch (error) {
      // Timeout or connection loss after sending may still have delivered: never resend.
      await sql`UPDATE deliveries SET status = 'unknown', response = ${String(error).slice(0, 500)}, updated_at = now() WHERE id = ${row.id}`;
      results.push({ target: t.key, status: "unknown" });
    }
  }
  return results;
}

/**
 * Sends a stored delivery again after an operator checked the group and found it missing. Only
 * for deliveries in doubt or definitely failed; the safety valve still applies.
 */
export async function resendDelivery(id: number, version?: string): Promise<{ status: string }> {
  return retryDelivery(id, version, false);
}

async function retryDelivery(id: number, version: string | undefined, automatic: boolean): Promise<{ status: string }> {
  const [d] = await sql<
    {
      status: string;
      version: string;
      abandoned_at: Date | null;
      response: string | null;
      subject_id: string;
      subject_kind: string;
      dedupe_key: string;
      target_key: string;
      config_ref: string | null;
      kind: string;
      enabled: boolean;
      enabled_at: Date | null;
      purpose: string;
      jurisdiction: string | null;
    }[]
  >`
    SELECT d.status, d.abandoned_at, d.response, d.updated_at::text AS version, d.subject_id, d.subject_kind, d.dedupe_key, d.target_key, t.config_ref, t.kind, t.enabled, t.enabled_at, t.purpose, t.jurisdiction
    FROM deliveries d JOIN notify_targets t ON t.key = d.target_key WHERE d.id = ${id}`;
  if (!d) throw new Error(`delivery ${id} not found`);
  if (d.abandoned_at || d.response?.startsWith("人工放弃：") || (d.status !== "unknown" && d.status !== "failed"))
    throw new DeliveryConflict("这条投递不需要处理");
  if (!config.feishuContentPushEnabled || d.kind !== "feishu_webhook") throw new Error("content push is disabled in this environment");
  if (!d.enabled || !["content", "country_content"].includes(d.purpose)) throw new DeliveryConflict("目标已停用，不能重新发送");
  if (await pushPaused()) throw new DeliveryConflict("发布已暂停，等待恢复后再处理");
  if (d.subject_kind !== "selected") throw new DeliveryConflict("这条投递不支持内容重发");
  const url = d.config_ref ? credential("integrations", d.config_ref) : undefined;
  if (!url) throw new Error("webhook not configured");
  // Claim before reading current content so a queued retry cannot use a pre-withdrawal snapshot.
  const claimed = await sql<{ version: string }[]>`UPDATE deliveries SET status='sending',updated_at=now()
    WHERE id=${id} AND status IN ('unknown','failed') AND updated_at::text=${version ?? d.version} AND abandoned_at IS NULL
      AND (${!automatic} OR (status='failed' AND (response IS NULL OR response NOT LIKE '人工放弃：%') AND retry_reason IS NOT NULL AND retry_at<=now() AND attempts<${MAX_AUTO_ATTEMPTS}))
      AND EXISTS(SELECT 1 FROM notify_targets WHERE key=${d.target_key} AND enabled AND purpose IN ('content','country_content'))
    RETURNING updated_at::text AS version`;
  if (!claimed.length) throw new DeliveryConflict("这条投递或目标已被其他操作处理，请刷新后重试");
  try {
    const { pushSelected } = await import("./selected.ts");
    const outcome = await pushSelected(d.subject_id, undefined, async (current) => {
      if (current.dedupeKey !== d.dedupe_key) throw new DeliveryConflict("内容归属已变化，请等待当前事实的正常推送");
      if (d.enabled_at && current.contentAt < d.enabled_at) throw new DeliveryConflict("内容早于目标本次启用，不补发历史内容");
      const sending = await sql.begin(async (tx) => {
        if (!(await currentTargetMatches({ ...d, key: d.target_key, kind: "feishu_webhook" }, current, tx)))
          throw new DeliveryConflict("内容不再属于此目标的当前国家范围，或目标已经变化");
        const changed = await tx`UPDATE deliveries SET attempts=attempts+1,payload=${tx.json(current.card as never)},updated_at=now()
        WHERE id=${id} AND status='sending' AND updated_at::text=${claimed[0]!.version}
        AND EXISTS(SELECT 1 FROM notify_targets WHERE key=${d.target_key} AND enabled AND purpose IN ('content','country_content') AND kind=${d.kind} AND config_ref IS NOT DISTINCT FROM ${d.config_ref}
          AND (enabled_at IS NULL OR enabled_at<=${current.contentAt}))`;
        return changed.count;
      });
      if (!sending) throw new DeliveryConflict("投递或目标已变化，请刷新后重试");
      try {
        const res = await postWebhook(url, current.card);
        const status = await recordDeliveryResult(id, res);
        return [{ target: d.target_key, status }];
      } catch (error) {
        await sql`UPDATE deliveries SET status='unknown',retry_reason=null,retry_at=null,response=${String(error).slice(0, 500)},updated_at=now() WHERE id=${id}`;
        return [{ target: d.target_key, status: "unknown" }];
      }
    });
    if (automatic && outcome.status === "retry") {
      await sql`UPDATE deliveries SET status='failed',retry_reason='not_sent',retry_at=${outcome.after},response=${outcome.reason},updated_at=now()
        WHERE id=${id} AND status='sending' AND updated_at::text=${claimed[0]!.version}`;
      return { status: "failed" };
    }
    const status = outcome.status !== "retry" ? outcome.targets?.[0]?.status : null;
    if (!status) throw new DeliveryConflict("内容当前不符合推送条件，请核对公开状态和时效");
    return { status };
  } catch (error) {
    await sql`UPDATE deliveries SET status=${d.status},retry_reason=CASE WHEN ${automatic && !(error instanceof RuntimeControlPaused)} THEN null ELSE retry_reason END,
      retry_at=CASE WHEN ${automatic && !(error instanceof RuntimeControlPaused)} THEN null ELSE retry_at END,response=${String(error).slice(0, 500)},updated_at=now()
      WHERE id=${id} AND status='sending' AND updated_at::text=${claimed[0]!.version}`;
    throw error;
  }
}

/**
 * Deliveries a stopped process left half way: "sending" may have reached the group, so it becomes
 * "unknown" (alerted, resolved in the admin); "pending" never left, so it becomes "failed" (the
 * recovery may retry it). Unknown sends and failures without explicit evidence stay manual.
 */
export async function markStaleDeliveries(): Promise<{ unknown: number; failed: number }> {
  // Older binaries persisted abandonment in this fixed response marker and retain our nullable columns on rollback.
  await sql`UPDATE deliveries SET abandoned_at=updated_at,retry_reason=null,retry_at=null
    WHERE status='failed' AND abandoned_at IS NULL AND response LIKE '人工放弃：%'`;
  const cutoff = new Date(Date.now() - 15 * 60_000);
  const unknown =
    await sql`UPDATE deliveries SET status = 'unknown', retry_reason=null,retry_at=null,response = coalesce(response, '发送中进程中断，是否送达未知'), updated_at = now()
                            WHERE status = 'sending' AND updated_at < ${cutoff}`;
  const failed = await sql`UPDATE deliveries SET status = 'failed',retry_reason=CASE WHEN attempts=0 AND origin='live' THEN 'not_sent' ELSE null END,
                           retry_at=CASE WHEN attempts=0 AND origin='live' THEN now() ELSE null END, response = coalesce(response, '发送前进程中断，没有发出'), updated_at = now()
                           WHERE status = 'pending' AND updated_at < ${cutoff}`;
  if (config.feishuContentPushEnabled && !(await pushPaused())) {
    const ready = await sql<{ id: number; version: string }[]>`SELECT id,updated_at::text AS version FROM deliveries
      WHERE status='failed' AND origin='live' AND abandoned_at IS NULL AND (response IS NULL OR response NOT LIKE '人工放弃：%') AND retry_reason IS NOT NULL AND retry_at<=now() AND attempts<${MAX_AUTO_ATTEMPTS}
      ORDER BY retry_at,id LIMIT 40`;
    for (const row of ready) {
      try {
        await retryDelivery(row.id, row.version, true);
      } catch (error) {
        if (await pushPaused()) break;
        await sql`UPDATE deliveries SET retry_reason=null,retry_at=null,response=${String(error).slice(0, 500)},updated_at=now()
          WHERE id=${row.id} AND status='failed' AND updated_at::text=${row.version}`;
      }
    }
  }
  return { unknown: unknown.count, failed: failed.count };
}
