// Worker-only forwarding. Public submission stores its outbox marker in the same transaction.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config, credential, environmentValue } from "../config.ts";
import { dbOf } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { FeedbackDeliveryUncertain, sendAlert, sendFeedbackToChat, uploadFeedbackImage } from "../notify/feishu.ts";

const sql = dbOf("feedback");

interface PendingFeedback {
  id: number;
  content: string;
  email: string | null;
  page_url: string | null;
  screenshot_key: string | null;
  forward_image_key: string | null;
}

/** Notify the existing operations group once per outstanding feedback, without reader material. */
async function notifyFailures() {
  const alertChat = credential("integrations", "FEISHU_ALERT_CHAT_ID");
  if (!alertChat || alertChat === credential("integrations", "FEISHU_INTERNAL_CHAT_ID")) return;
  await sql.begin(async (tx) => {
    const rows = await tx<{ id: number }[]>`SELECT id FROM feedback WHERE forward_status IN ('retry','unknown')
      AND forward_error NOT LIKE '%_notified' AND anonymized_at IS NULL FOR UPDATE SKIP LOCKED LIMIT 100`;
    if (!rows.length) return;
    let outcome: "sent" | "disabled";
    try {
      outcome = await sendAlert("读者反馈通知需要核对", [
        `有 ${rows.length} 条反馈仍保存在网站，飞书通知尚未确认送达。`,
        "明确发送失败的会继续尝试；结果不明的暂停重发，避免重复通知。",
        "请在网站后台查看反馈，并核对读者反馈群。",
      ]);
    } catch {
      return;
    }
    if (outcome === "sent") await tx`UPDATE feedback SET forward_error=forward_error || '_notified' WHERE id IN ${tx(rows.map((row) => row.id))}`;
  });
}

/** No fallback to the operations or public-content group. */
export async function forwardPendingFeedback(): Promise<{ sent: number; failed: number; unknown: number }> {
  const result = { sent: 0, failed: 0, unknown: 0 };
  const chat = credential("integrations", "FEISHU_INTERNAL_CHAT_ID");
  if (environmentValue("FEISHU_FEEDBACK_ENABLED") !== "true" || !chat) return result;
  // A worker crash after a possible send is not evidence of failure. Preserve for reconciliation.
  const stale = await sql`UPDATE feedback SET forward_status='unknown',forward_error='worker_interrupted'
    WHERE forward_status='sending' AND forward_attempted_at < now() - interval '3 minutes' RETURNING id`;
  result.unknown += stale.length;
  for (let i = 0; i < 20; i++) {
    const [claimed] = await sql<{ id: number }[]>`UPDATE feedback SET forward_status='sending',forward_attempted_at=now()
      WHERE id=(SELECT id FROM feedback WHERE forward_status IN ('pending','retry')
        AND (forward_attempted_at IS NULL OR forward_attempted_at < now() - interval '5 minutes')
        AND source_hash IS NOT NULL AND anonymized_at IS NULL
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id`;
    if (!claimed) break;
    await sql.begin(async (tx) => {
      // Deletion/retention and concurrent workers cannot mutate this row while it is being sent.
      const [fb] = await tx<PendingFeedback[]>`SELECT id,content,email,page_url,screenshot_key,forward_image_key FROM feedback
        WHERE id=${claimed.id} AND forward_status='sending' AND source_hash IS NOT NULL AND anonymized_at IS NULL FOR UPDATE`;
      if (!fb) return;
      let sending = false;
      try {
        let imageKey = fb.forward_image_key;
        if (fb.screenshot_key && !imageKey) {
          if (!/^local:[\w.-]+$/.test(fb.screenshot_key)) throw new Error("screenshot_unavailable");
          const file = fb.screenshot_key.slice(6);
          imageKey = await uploadFeedbackImage(await readFile(path.join(config.dataDir, "feedback-screenshots", file)), file);
          await tx`UPDATE feedback SET forward_image_key=${imageKey} WHERE id=${fb.id}`;
        }
        const paragraphs: unknown[][] = [
          [{ tag: "text", text: fb.content }],
          [{ tag: "text", text: `页面：${fb.page_url ? new URL(fb.page_url, config.siteUrl).href : "（未提供）"}` }],
          [{ tag: "text", text: `联系方式：${fb.email ?? "（未留）"}` }],
        ];
        if (imageKey) paragraphs.push([{ tag: "img", image_key: imageKey }]);
        paragraphs.push([{ tag: "a", text: "在网站后台查看及记录处理结果", href: `${config.siteUrl}/admin/feedback` }]);
        sending = true;
        const messageId = await sendFeedbackToChat(
          chat,
          { zh_cn: { title: `读者反馈 #${fb.id}`, content: paragraphs } },
          sha256(`${config.siteUrl}:feedback:${fb.id}`).slice(0, 40),
        );
        await tx`UPDATE feedback SET forward_status='sent',forwarded_at=now(),forward_message_id=${messageId},forward_error=NULL WHERE id=${fb.id}`;
        result.sent++;
      } catch (error) {
        // Do not log remote bodies, reader text, contacts, filenames or credentials.
        const uncertain = sending && error instanceof FeedbackDeliveryUncertain;
        const reason = uncertain ? "delivery_outcome_unknown" : "delivery_failed";
        await tx`UPDATE feedback SET forward_status=${uncertain ? "unknown" : "retry"},
          forward_error=CASE WHEN forward_error LIKE '%_notified' THEN ${`${reason}_notified`} ELSE ${reason} END WHERE id=${fb.id}`;
        if (uncertain) result.unknown++;
        else result.failed++;
      }
    });
  }
  await notifyFailures();
  return result;
}
