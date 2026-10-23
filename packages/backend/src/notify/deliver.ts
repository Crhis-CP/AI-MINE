// Content-group deliveries (Feishu custom-bot webhooks): selected cards.
// One row per target and dedupe key, so nothing is pushed twice; an outcome we cannot know
// ("unknown") is never retried automatically; content older than a target's enabled_at is never
// back-filled. FEISHU_CONTENT_PUSH_ENABLED is the safety valve: off, deliveries are recorded as
// skipped and nothing leaves the process.
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { audit, requireOwner, type AdminPrincipal } from "../admin/auth.ts";
import { postWebhook } from "./feishu.ts";

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
}

export class DeliveryConflict extends Error {
  code = "conflict";
}

/** Default content targets; they start disabled and are switched on in production only. */
export async function ensureContentTargets() {
  await sql`
    INSERT INTO notify_targets (key, purpose, kind, enabled, config_ref, note) VALUES
      ('feishu-content-main', 'content', 'feishu_webhook', false, 'FEISHU_PUSH_WEBHOOK_URL', '飞书内容主群'),
      ('feishu-content-mirror', 'content', 'feishu_webhook', false, 'FEISHU_PUSH_MIRROR_WEBHOOK_URL', '飞书内容镜像群')
    ON CONFLICT (key) DO NOTHING`;
}

export async function deliverContent(req: DeliveryRequest): Promise<Array<{ target: string; status: string }>> {
  const targets = await sql<Target[]>`SELECT key, kind, enabled_at, config_ref FROM notify_targets WHERE purpose = 'content' AND enabled`;
  const results: Array<{ target: string; status: string }> = [];
  for (const t of targets) {
    if (t.enabled_at && req.contentAt < t.enabled_at) continue;
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
    const url = t.config_ref ? credential("integrations", t.config_ref) : undefined;
    if (!url) {
      await sql`UPDATE deliveries SET status = 'failed', response = 'webhook not configured', updated_at = now() WHERE id = ${row.id}`;
      results.push({ target: t.key, status: "failed" });
      continue;
    }
    await sql`UPDATE deliveries SET status = 'sending', attempts = attempts + 1, updated_at = now() WHERE id = ${row.id}`;
    try {
      const res = await postWebhook(url, req.card);
      // Only an explicit acknowledgement or rejection is known; malformed responses remain uncertain.
      const status = res.ok ? "sent" : res.rejected ? "failed" : "unknown";
      await sql`UPDATE deliveries SET status = ${status}, response = ${res.body.slice(0, 500)}, sent_at = ${res.ok ? new Date() : null}, updated_at = now() WHERE id = ${row.id}`;
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
  const [d] = await sql<
    {
      status: string;
      version: string;
      subject_id: string;
      subject_kind: string;
      dedupe_key: string;
      target_key: string;
      config_ref: string | null;
      kind: string;
      enabled: boolean;
      enabled_at: Date | null;
      purpose: string;
    }[]
  >`
    SELECT d.status, d.updated_at::text AS version, d.subject_id, d.subject_kind, d.dedupe_key, d.target_key, t.config_ref, t.kind, t.enabled, t.enabled_at, t.purpose
    FROM deliveries d JOIN notify_targets t ON t.key = d.target_key WHERE d.id = ${id}`;
  if (!d) throw new Error(`delivery ${id} not found`);
  if (d.status !== "unknown" && d.status !== "failed") throw new DeliveryConflict("这条投递不需要处理");
  if (!config.feishuContentPushEnabled || d.kind !== "feishu_webhook") throw new Error("content push is disabled in this environment");
  if (!d.enabled || d.purpose !== "content") throw new DeliveryConflict("目标已停用，不能重新发送");
  if (d.subject_kind !== "selected") throw new DeliveryConflict("这条投递不支持内容重发");
  const url = d.config_ref ? credential("integrations", d.config_ref) : undefined;
  if (!url) throw new Error("webhook not configured");
  // Claim before reading current content so a queued retry cannot use a pre-withdrawal snapshot.
  const claimed = await sql<{ version: string }[]>`UPDATE deliveries SET status='sending',updated_at=now()
    WHERE id=${id} AND status IN ('unknown','failed') AND updated_at::text=${version ?? d.version}
      AND EXISTS(SELECT 1 FROM notify_targets WHERE key=${d.target_key} AND enabled AND purpose='content')
    RETURNING updated_at::text AS version`;
  if (!claimed.length) throw new DeliveryConflict("这条投递或目标已被其他操作处理，请刷新后重试");
  try {
    const { pushSelected } = await import("./selected.ts");
    const outcome = await pushSelected(d.subject_id, new Date(), async (current) => {
      if (current.dedupeKey !== d.dedupe_key) throw new DeliveryConflict("内容归属已变化，请等待当前事实的正常推送");
      if (d.enabled_at && current.contentAt < d.enabled_at) throw new DeliveryConflict("内容早于目标本次启用，不补发历史内容");
      const sending = await sql`UPDATE deliveries SET attempts=attempts+1,payload=${sql.json(current.card as never)},updated_at=now()
        WHERE id=${id} AND status='sending' AND updated_at::text=${claimed[0]!.version}
        AND EXISTS(SELECT 1 FROM notify_targets WHERE key=${d.target_key} AND enabled AND purpose='content'
          AND (enabled_at IS NULL OR enabled_at<=${current.contentAt}))`;
      if (!sending.count) throw new DeliveryConflict("投递或目标已变化，请刷新后重试");
      try {
        const res = await postWebhook(url, current.card);
        const status = res.ok ? "sent" : res.rejected ? "failed" : "unknown";
        await sql`UPDATE deliveries SET status=${status},response=${res.body.slice(0, 500)},sent_at=${res.ok ? new Date() : null},updated_at=now() WHERE id=${id}`;
        return [{ target: d.target_key, status }];
      } catch (error) {
        await sql`UPDATE deliveries SET status='unknown',response=${String(error).slice(0, 500)},updated_at=now() WHERE id=${id}`;
        return [{ target: d.target_key, status: "unknown" }];
      }
    });
    const status = outcome.status !== "retry" ? outcome.targets?.[0]?.status : null;
    if (!status) throw new DeliveryConflict("内容当前不符合推送条件，请核对公开状态和时效");
    return { status };
  } catch (error) {
    await sql`UPDATE deliveries SET status=${d.status},response=${String(error).slice(0, 500)},updated_at=now()
      WHERE id=${id} AND status='sending' AND updated_at::text=${claimed[0]!.version}`;
    throw error;
  }
}

/**
 * Deliveries a stopped process left half way: "sending" may have reached the group, so it becomes
 * "unknown" (alerted, resolved in the admin); "pending" never left, so it becomes "failed" (the
 * admin can send it). Nothing is re-sent automatically.
 */
export async function markStaleDeliveries(): Promise<{ unknown: number; failed: number }> {
  const cutoff = new Date(Date.now() - 15 * 60_000);
  const unknown = await sql`UPDATE deliveries SET status = 'unknown', response = coalesce(response, '发送中进程中断，是否送达未知'), updated_at = now()
                            WHERE status = 'sending' AND updated_at < ${cutoff}`;
  const failed = await sql`UPDATE deliveries SET status = 'failed', response = coalesce(response, '发送前进程中断，没有发出'), updated_at = now()
                           WHERE status = 'pending' AND updated_at < ${cutoff}`;
  return { unknown: unknown.count, failed: failed.count };
}
