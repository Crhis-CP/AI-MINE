import { sql, type Db } from "../db.ts";

export type ReportWithdrawalKind = "daily" | "weekly" | "monthly";
export type WithdrawalTarget = { type: "event" | "story"; id: string } | { type: "report"; lane?: "news" | "policy"; kind: ReportWithdrawalKind; key: string };
export const withdrawalIdentity = (target: WithdrawalTarget) => ({
  lane: target.type === "report" ? (target.lane ?? "news") : "news",
  type: target.type,
  key: target.type === "report" ? `${target.kind}:${target.key}` : target.id,
});

/** Current public projection only; unavailable storage must fail closed by throwing. */
export async function isReportWithdrawn(lane: "news" | "policy", kind: ReportWithdrawalKind, key: string, db: Db = sql): Promise<boolean> {
  const [row] = await db<
    { withdrawn: boolean }[]
  >`SELECT EXISTS(SELECT 1 FROM publication.withdrawal_targets WHERE active AND lane=${lane} AND target_type='report' AND target_key=${`${kind}:${key}`}) AS withdrawn`;
  return row!.withdrawn;
}

/** Policy report snapshots contain only already-public edition IDs, never policy-private rows. */
export async function policyReportWithdrawalSnapshot(kind: ReportWithdrawalKind, key: string, db: Db = sql) {
  const [report] = await db<
    { id: string; current_revision: number }[]
  >`SELECT id,current_revision FROM publication.policy_reports WHERE kind=${kind} AND period_key=${key}`;
  if (!report) return null;
  const rows = await db<
    { edition_id: string }[]
  >`SELECT edition_id FROM publication.policy_report_members WHERE report_id=${report.id} AND report_revision=${report.current_revision} ORDER BY edition_id`;
  return { memberIds: rows.map((r) => r.edition_id), revision: report.current_revision };
}

export async function applyWithdrawalProjection(db: Db, id: number, target: WithdrawalTarget, memberIds: string[], active: boolean) {
  const identity = withdrawalIdentity(target);
  if (active) {
    await db`INSERT INTO publication.withdrawal_targets(withdrawal_id,lane,target_type,target_key) VALUES(${id},${identity.lane},${identity.type},${identity.key})`;
    if (target.type !== "report")
      for (const articleId of memberIds)
        await db`INSERT INTO publication.withdrawal_members(withdrawal_id,article_id) VALUES(${id},${articleId}) ON CONFLICT DO NOTHING`;
  } else await db`UPDATE publication.withdrawal_targets SET active=false WHERE withdrawal_id=${id} AND lane=${identity.lane}`;
  await db`UPDATE publication.read_watermarks SET version=version+1,withdrawal_version=withdrawal_version+1 WHERE lane=${identity.lane}`;
}

/** Capture later members while an event remains withdrawn, so regrouping cannot revive them. */
export async function articleWithdrawalHeld(db: Db, articleId: string, factPublicId: string | null, storyPublicId: string | null) {
  await db`INSERT INTO publication.withdrawal_members(withdrawal_id,article_id)
    SELECT withdrawal_id,${articleId} FROM publication.withdrawal_targets WHERE active AND lane='news'
      AND ((target_type='event' AND target_key=${factPublicId}) OR (target_type='story' AND target_key=${storyPublicId})) ON CONFLICT DO NOTHING`;
  const [row] = await db<
    { held: boolean }[]
  >`SELECT EXISTS(SELECT 1 FROM publication.withdrawal_members m JOIN publication.withdrawal_targets t ON t.withdrawal_id=m.withdrawal_id
    WHERE m.article_id=${articleId} AND t.active AND t.lane='news') AS held`;
  return row!.held;
}

export async function projectedWithdrawalMembers(id: number, db: Db = sql): Promise<string[]> {
  return (await db<{ article_id: string }[]>`SELECT article_id FROM publication.withdrawal_members WHERE withdrawal_id=${id} ORDER BY article_id`).map(
    (r) => r.article_id,
  );
}

export function storyTextNeedsRefresh(story: { version: number; updated_at: Date; digest_updated_at: Date | null; text_stale?: boolean }) {
  if (story.text_stale !== undefined) return story.text_stale;
  return story.digest_updated_at ? story.updated_at.getTime() > story.digest_updated_at.getTime() : story.version > 1;
}
export async function storyWithdrawalAffected(storyId: number, publicId: string, factIds: string[], db: Db = sql) {
  const [row] = await db<{ affected: boolean }[]>`SELECT
    EXISTS(SELECT 1 FROM publication.withdrawal_targets WHERE active AND lane='news' AND
      ((target_type='story' AND target_key=${publicId}) OR (target_type='event' AND target_key=ANY(${factIds}::text[]))))
    OR EXISTS(SELECT 1 FROM publications WHERE story_id=${storyId} AND visibility='withdrawn') AS affected`;
  return row!.affected;
}
