// Changes a person makes to the entity library: folding an entity into another that turned out to be the same
// company, and undoing that. They run with the back office's login (private_ops may update entities and add merges;
// the worker only reads), each in one transaction with its audit row. A merge only points the loser at the winner:
// spellings and article links are not rewritten, the index resolves the loser to the winner, so an undo gives back
// exactly the earlier mapping. Text already published is not touched by either; only later work uses the new mapping.
// No caller yet: the back-office page comes later (design L, PR-J).
import { audit } from "../../admin/auth.ts";
import { sql } from "../../db.ts";

export type MergeRefusal =
  | "same_entity"
  | "missing"
  | "retired"
  | "taxonomy_loser"
  | "already_merged"
  | "winner_merged"
  | "no_reason"
  | "merge_missing"
  | "already_undone"
  | "moved_on";

const REFUSALS: Record<MergeRefusal, string> = {
  same_entity: "不能把一个实体合并到它自己",
  missing: "实体不存在",
  retired: "已停用的实体不能参与合并",
  // Its id is what analyses.subjects and the paid prompt hold; folding it away would orphan both.
  taxonomy_loser: "标签词表里的公司不能作为被合并的一方",
  already_merged: "这个实体已经合并到别处",
  winner_merged: "目标实体本身已经合并到别处，请合并到最终的那一个",
  no_reason: "请写明原因",
  merge_missing: "合并记录不存在",
  already_undone: "这次合并已经撤销过",
  moved_on: "被合并的一方已经不指向这次合并的目标，先撤销之后的合并",
};

export class EntityMergeRefused extends Error {
  readonly reason: MergeRefusal;
  constructor(reason: MergeRefusal) {
    super(REFUSALS[reason]);
    this.name = "EntityMergeRefused";
    this.reason = reason;
  }
}

/**
 * Folds `loserId` into `winnerId`. Both must be active, the winner not merged itself, the loser not merged yet and not
 * a tag-vocabulary company. Entities that pointed at the loser are moved to the winner and listed in the merge row, so
 * the undo can move exactly those back. Rows are locked in id order, the same order undoMerge uses.
 */
export async function mergeEntities(input: {
  loserId: string;
  winnerId: string;
  reason: string;
  actor: string;
}): Promise<{ mergeId: number; repointed: string[] }> {
  const { loserId, winnerId, actor } = input;
  const reason = input.reason.trim();
  if (loserId === winnerId) throw new EntityMergeRefused("same_entity");
  if (!reason) throw new EntityMergeRefused("no_reason");
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string; origin: string; status: string; merged_into: string | null }[]>`
      SELECT id, origin, status, merged_into FROM entities.entities
      WHERE id = ANY(${[loserId, winnerId]}::text[]) OR merged_into = ${loserId} ORDER BY id FOR UPDATE`;
    const loser = rows.find((r) => r.id === loserId),
      winner = rows.find((r) => r.id === winnerId);
    if (!loser || !winner) throw new EntityMergeRefused("missing");
    if (loser.status !== "active" || winner.status !== "active") throw new EntityMergeRefused("retired");
    if (loser.origin === "taxonomy") throw new EntityMergeRefused("taxonomy_loser");
    if (loser.merged_into) throw new EntityMergeRefused("already_merged");
    if (winner.merged_into) throw new EntityMergeRefused("winner_merged");
    const repointed = (
      await tx<{ id: string }[]>`UPDATE entities.entities SET merged_into = ${winnerId}, updated_at = now(), updated_by = ${actor}
        WHERE merged_into = ${loserId} RETURNING id`
    )
      .map((r) => r.id)
      .sort();
    await tx`UPDATE entities.entities SET merged_into = ${winnerId}, updated_at = now(), updated_by = ${actor} WHERE id = ${loserId}`;
    const [merge] = await tx<{ id: number }[]>`INSERT INTO entities.merges (loser_id, winner_id, repointed, actor, reason)
      VALUES (${loserId}, ${winnerId}, ${repointed}::text[], ${actor}, ${reason}) RETURNING id`;
    await audit(
      actor,
      "entities.merge",
      `entity:${loserId}`,
      reason,
      { mergedInto: null },
      { mergedInto: winnerId, mergeId: merge!.id, repointed },
      undefined,
      tx,
    );
    return { mergeId: merge!.id, repointed };
  });
}

/**
 * Undoes a merge while its loser still points at that merge's winner (a later merge of the winner moved it on: undo
 * that one first). The loser stands on its own again and the entities the merge moved go back to it, those still on
 * the winner. The merge row keeps its history with the time and person of the undo.
 */
export async function undoMerge(input: { mergeId: number; reason: string; actor: string }): Promise<{ restored: string[] }> {
  const { mergeId, actor } = input;
  const reason = input.reason.trim();
  if (!reason) throw new EntityMergeRefused("no_reason");
  return sql.begin(async (tx) => {
    const [merge] = await tx<{ loser_id: string; winner_id: string; repointed: string[]; undone_at: Date | null }[]>`
      SELECT loser_id, winner_id, repointed, undone_at FROM entities.merges WHERE id = ${mergeId} FOR UPDATE`;
    if (!merge) throw new EntityMergeRefused("merge_missing");
    if (merge.undone_at) throw new EntityMergeRefused("already_undone");
    const rows = await tx<{ id: string; merged_into: string | null }[]>`
      SELECT id, merged_into FROM entities.entities
      WHERE id = ANY(${[merge.loser_id, merge.winner_id, ...merge.repointed]}::text[]) ORDER BY id FOR UPDATE`;
    if (rows.find((r) => r.id === merge.loser_id)?.merged_into !== merge.winner_id) throw new EntityMergeRefused("moved_on");
    await tx`UPDATE entities.entities SET merged_into = NULL, updated_at = now(), updated_by = ${actor} WHERE id = ${merge.loser_id}`;
    const restored = (
      await tx<{ id: string }[]>`UPDATE entities.entities SET merged_into = ${merge.loser_id}, updated_at = now(), updated_by = ${actor}
        WHERE id = ANY(${merge.repointed}::text[]) AND merged_into = ${merge.winner_id} RETURNING id`
    )
      .map((r) => r.id)
      .sort();
    await tx`UPDATE entities.merges SET undone_at = now(), undone_by = ${actor} WHERE id = ${mergeId}`;
    await audit(
      actor,
      "entities.merge.undo",
      `entity:${merge.loser_id}`,
      reason,
      { mergedInto: merge.winner_id },
      { mergedInto: null, mergeId, restored },
      undefined,
      tx,
    );
    return { restored };
  });
}
