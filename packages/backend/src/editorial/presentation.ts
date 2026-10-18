import {
  assemblePartialTranslation,
  assembleTranslation,
  shield,
  translationLeaves,
  translationSourceManifest,
  type TranslationCheckpoint,
} from "./translation-readiness.ts";

export class PresentationMismatch extends Error {
  constructor() {
    super("正文展示变化无法与已保存译文核对，保留原版本等待处理。");
  }
}

/** Reuse exact retained model text only when every model-visible input remains identical. */
export function presentationPlan(
  previous: string,
  next: string,
  current: { revision: number; recipe: string },
  saved: Array<TranslationCheckpoint & { replacement: boolean }>,
) {
  const oldSource = translationSourceManifest(previous),
    source = translationSourceManifest(next);
  const replacements = saved.filter((row) => row.replacement).map((row) => row.index);
  const oldLeaves = translationLeaves(oldSource, replacements),
    leaves = translationLeaves(source, replacements);
  if (!oldLeaves || !leaves || oldLeaves.length !== leaves.length || !leaves.length) throw new PresentationMismatch();
  for (const [i, leaf] of leaves.entries()) {
    const old = oldLeaves[i]!;
    if (old.index !== leaf.index || old.unitIndex !== leaf.unitIndex || old.reference !== leaf.reference || shield(old.html).html !== shield(leaf.html).html)
      throw new PresentationMismatch();
  }
  const checkpoints = leaves.map((leaf, i): TranslationCheckpoint => {
    const row = saved.find((row) => row.index === leaf.index);
    if (row && (row.revision !== current.revision || row.recipe !== current.recipe || row.sourceHash !== oldLeaves[i]!.sourceHash))
      throw new PresentationMismatch();
    return { ...current, index: leaf.index, sourceHash: leaf.sourceHash, state: row?.state ?? "pending", text: row?.text ?? "" };
  });
  const complete = assembleTranslation(next, current, checkpoints, replacements);
  const assembled = complete || assemblePartialTranslation(next, current, checkpoints, replacements);
  if (!assembled) throw new PresentationMismatch();
  return { source, replacements, leaves, checkpoints, assembled, complete: !!complete };
}
