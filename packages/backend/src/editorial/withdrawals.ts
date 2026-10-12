import { dbOf, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { withdrawalEventMembers, invalidateWithdrawalStories } from "@amp/backend/events/group";
import { newsReportWithdrawalSnapshot, invalidateReportCorrections } from "@amp/backend/reports/compose";
import {
  applyWithdrawalProjection,
  policyReportWithdrawalSnapshot,
  projectedWithdrawalMembers,
  withdrawalIdentity,
  publishArticleTx,
  type WithdrawalTarget,
} from "@amp/backend/publication/publish";
import { audit } from "../admin/auth.ts";
import { Conflict } from "../admin/sources.ts";
import { enqueue } from "../jobs/queue.ts";
const sql = dbOf("editorial");
type Active = { id: number; member_ids: string[]; reason: string; created_at: Date };
async function snapshot(target: WithdrawalTarget, db: Db) {
  const identity = withdrawalIdentity(target);
  const current =
    target.type === "report"
      ? identity.lane === "policy"
        ? await policyReportWithdrawalSnapshot(target.kind, target.key, db)
        : await newsReportWithdrawalSnapshot(target.kind, target.key, db)
      : await withdrawalEventMembers(target.type, target.id, db).then((ids) => (ids === null ? null : { memberIds: ids, revision: null }));
  if (!current) throw new Conflict("下架对象不存在，请刷新后重试。");
  const records = await db<Active[]>`SELECT w.id,w.member_ids,w.reason,w.created_at FROM editorial.withdrawal_records w
    WHERE w.lane=${identity.lane} AND w.target_type=${identity.type} AND w.target_key=${identity.key}
      AND NOT EXISTS(SELECT 1 FROM editorial.withdrawal_restorations r WHERE r.withdrawal_id=w.id) ORDER BY w.id`;
  const active = await Promise.all(
    records.map(async (record) => ({
      ...record,
      heldMemberIds: [...new Set([...record.member_ids, ...(await projectedWithdrawalMembers(record.id, db))])].sort(),
    })),
  );
  const memberIds = [...new Set([...current.memberIds, ...active.flatMap((r) => r.heldMemberIds)])].sort();
  return {
    identity,
    current,
    active,
    memberIds,
    snapshotHash: sha256(
      stableJson({
        target: identity,
        revision: current.revision,
        current: current.memberIds,
        active: active.map((r) => [r.id, r.member_ids, r.heldMemberIds]),
      }),
    ),
  };
}
export async function previewWithdrawal(target: WithdrawalTarget) {
  const state = await snapshot(target, sql);
  return {
    target,
    memberIds: state.memberIds,
    memberCount: state.memberIds.length,
    activeRecords: state.active.map((r) => ({
      withdrawalId: r.id,
      reason: r.reason,
      createdAt: r.created_at.toISOString(),
      memberCount: r.heldMemberIds.length,
    })),
    snapshotHash: state.snapshotHash,
  };
}
export async function actWithdrawal(
  input: { target: WithdrawalTarget; action: "withdraw" | "restore"; reason: string; expectedSnapshotHash: string; withdrawalId?: number },
  actor: string,
) {
  if (!input.reason.trim() || !actor.trim()) throw new Conflict("须填写下架或恢复原因。");
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
    const key = withdrawalIdentity(input.target);
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`withdrawal:${key.lane}:${key.type}:${key.key}`}))`;
    const state = await snapshot(input.target, tx);
    if (state.snapshotHash !== input.expectedSnapshotHash) throw new Conflict("影响范围或下架记录已变化，请重新查看影响后确认。");
    let id: number, members: string[];
    if (input.action === "withdraw") {
      members = state.current.memberIds;
      const [record] = await tx<{ id: number }[]>`INSERT INTO editorial.withdrawal_records(lane,target_type,target_key,target,member_ids,reason,actor)
        VALUES(${key.lane},${key.type},${key.key},${tx.json(input.target)},${members},${input.reason},${actor}) RETURNING id`;
      id = record!.id;
    } else {
      const record = state.active.find((r) => r.id === input.withdrawalId);
      if (!record) throw new Conflict("指定下架记录不存在或已经恢复。");
      id = record.id;
      members = [...new Set([...record.member_ids, ...(await projectedWithdrawalMembers(id, tx))])].sort();
      await tx`INSERT INTO editorial.withdrawal_restorations(withdrawal_id,actor,reason) VALUES(${id},${actor},${input.reason})`;
    }
    await applyWithdrawalProjection(tx, id, input.target, members, input.action === "withdraw");
    if (input.target.type !== "report") {
      for (const member of members) await publishArticleTx(tx, member);
      await invalidateWithdrawalStories(input.target, members, tx);
      await invalidateReportCorrections(tx, members, input.action === "withdraw" ? "withdrawal" : "restoration");
      await enqueue("events.hot-refresh", { lane: "news", articleId: members[0] ?? "" }, { singletonKey: "hot-ranking" }, tx);
    }
    await audit(
      actor,
      `content.${input.action}`,
      `${key.lane}:${key.type}:${key.key}`,
      input.reason,
      null,
      { withdrawal_id: id, member_count: members.length },
      undefined,
      tx,
    );
    return { withdrawalId: id, action: input.action, affectedItems: members.length };
  });
}
