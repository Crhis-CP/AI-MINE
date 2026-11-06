// Reclassifying stored judgements after the category re-cut (ADR-0031, Owner 2026-11-05). New material is classified by
// the structure step with the new classes; history is moved here, one latest judgement at a time:
//   - a retired key with a single successor (and a current key) is mapped in code, without a model;
//   - 企业与项目 (split in two) and judgements without a category get the structure step again: the same prompt,
//     model route, receipt and runtime controls as analysis, so a later analysis of the revision reuses the receipt.
// Only the category, its leading tag and a note of the change are written; the judgement's copy, score, selection,
// fact and geography stay. Categories a person set are never touched (publication shows theirs anyway).
import { isLegacyMiningCategoryKey, mappedMiningCategory } from "@amp/contracts/mining-taxonomy";
import { CATEGORY_KEYS, type CategoryKey } from "@amp/contracts/taxonomy";
import { categoryLedTags } from "@amp/industry/mining-taxonomy";
import { sql, type Db } from "../db.ts";
import { assertRuntimeControl, runtimeControlSnapshot } from "../operations/lane-controls.ts";
import { ModelContentFiltered } from "../providers/model-fallback.ts";
import { ModelOutputError } from "../providers/llm.ts";
import { lockNewsProcessingPermissions } from "../providers/news-fallback.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { awaitsMaterial, PROMPT_VERSIONS, runCategoryStructure } from "./analyze.ts";
import { loadAnalyzeInput } from "./input.ts";

/** Which of these articles have a category set by a person (editorial owns the overrides). */
export { manualCategoryArticles } from "./manual-revisions.ts";
/** The current keys, for callers outside the workspace contracts (the production image runs the script). */
export { CATEGORY_KEYS } from "@amp/contracts/taxonomy";

/** An article's latest judgement, as far as its category goes. */
export interface CategoryJudgement {
  article_id: string;
  analysis_id: number;
  input_revision: number;
  category: string | null;
  prompt_version: string | null;
  /** Past the prefilter with scores (a complete judgement), not only the committed scope. */
  complete: boolean;
  /** The structure recipe a previous reclassification asked, if any. */
  reclassified_recipe: string | null;
}

export type CategoryPlan = { kind: "current" } | { kind: "mapped"; to: CategoryKey } | { kind: "model" } | { kind: "none" };

/**
 * What a latest judgement needs. Current keys stay; retired keys with one successor map; 企业与项目, and a complete
 * judgement without a category that the current structure recipe has not seen, need the model. Anything else
 * (an unknown key, an incomplete judgement) is left as it is: publication shows no category for it.
 */
export function planCategory(
  row: Pick<CategoryJudgement, "category" | "prompt_version" | "complete" | "reclassified_recipe">,
  recipe = PROMPT_VERSIONS.structure,
): CategoryPlan {
  if ((CATEGORY_KEYS as readonly string[]).includes(row.category ?? "")) return { kind: "current" };
  if (row.category !== null) {
    if (!isLegacyMiningCategoryKey(row.category)) return { kind: "none" };
    const to = mappedMiningCategory(row.category);
    return to ? { kind: "mapped", to } : { kind: "model" };
  }
  if (!row.complete || row.reclassified_recipe === recipe || (row.prompt_version ?? "").includes(recipe)) return { kind: "none" };
  return { kind: "model" };
}

/** Latest judgement (not a BLOCK) of every article whose category is not a current key (null included). */
export async function categoryJudgementsToReview(db: Db = sql): Promise<CategoryJudgement[]> {
  return db<CategoryJudgement[]>`
    SELECT article_id,analysis_id,input_revision,category,prompt_version,complete,reclassified_recipe FROM (
      SELECT DISTINCT ON (a.article_id) a.article_id,a.id AS analysis_id,a.input_revision,a.category,a.prompt_version,a.relevance,
        coalesce(jsonb_typeof(a.output) = 'object' AND a.output ? 'scores', false) AS complete,
        a.output->'categoryReclassification'->>'recipe' AS reclassified_recipe
      FROM analyses a ORDER BY a.article_id,a.input_revision DESC,a.id DESC) latest
    WHERE relevance IS DISTINCT FROM 'block' AND (category IS NULL OR category <> ALL(${[...CATEGORY_KEYS]}::text[]))
    ORDER BY analysis_id DESC`;
}

type Note = {
  from: string | null;
  to: CategoryKey | null;
  method: "mapped" | "model";
  recipe?: string;
  receiptId?: number;
  refused?: true;
  /** The answer was unusable (cut off at the length limit, or not the asked shape): no category, not asked again under this recipe. */
  unusable?: true;
};

/** Writes a category onto the judgement it was planned for; a newer judgement or a changed category wins. */
async function writeCategory(tx: Db, row: CategoryJudgement, note: Note): Promise<boolean> {
  const [latest] = await tx<{ id: number; category: string | null; tags: string[] }[]>`
    SELECT id,category,tags FROM analyses WHERE article_id=${row.article_id} ORDER BY input_revision DESC,id DESC LIMIT 1 FOR UPDATE`;
  if (latest?.id !== row.analysis_id || latest.category !== row.category) return false;
  const categoryReclassification = { ...note, at: new Date().toISOString() };
  await tx`UPDATE analyses SET category=${note.to},tags=${categoryLedTags(note.to, latest.tags ?? [])},
    output=coalesce(output,'{}'::jsonb) || ${tx.json({ categoryReclassification } as never)} WHERE id=${latest.id}`;
  return true;
}

/** The deterministic move of a retired key to its single successor; no model. False when the judgement moved on. */
export async function applyMappedCategory(row: CategoryJudgement, to: CategoryKey): Promise<boolean> {
  return sql.begin((tx) => writeCategory(tx, row, { from: row.category, to, method: "mapped" }));
}

export type ModelReclassification =
  | { outcome: "updated" | "superseded"; category: CategoryKey | null; receiptId: number; reused: boolean }
  | { outcome: "unusable"; written: boolean }
  | { outcome: "skipped"; reason: "missing" | "revision" | "material" };

/**
 * The structure step for one planned judgement, then its category written in the processing fence. The receipt is
 * completed whether or not the judgement moved on meanwhile; a content-filter refusal is noted so it is not asked again.
 */
export async function reclassifyCategoryWithModel(row: CategoryJudgement): Promise<ModelReclassification> {
  const runtimeControl = await runtimeControlSnapshot("news", ["processing"]);
  const input = await loadAnalyzeInput(row.article_id);
  if (!input) return { outcome: "skipped", reason: "missing" };
  if (input.revision !== row.input_revision) return { outcome: "skipped", reason: "revision" };
  if (awaitsMaterial(input) || (input.translationZh && !input.bodyText && !input.xPost)) return { outcome: "skipped", reason: "material" };
  const recipe = PROMPT_VERSIONS.structure;
  let result: Awaited<ReturnType<typeof runCategoryStructure>>;
  try {
    result = await runCategoryStructure(input, { runtimeControl });
  } catch (error) {
    // An unusable answer (cut off at the length limit, or not the asked shape) is noted like a refusal: the item keeps
    // no category and is not asked again under this recipe, so a later batch does not start on it again.
    if (error instanceof ModelOutputError) {
      const written = await sql.begin(async (tx) => {
        await lockNewsProcessingPermissions([row.article_id], tx);
        await assertRuntimeControl(tx, runtimeControl);
        return writeCategory(tx, row, {
          from: row.category,
          to: null,
          method: "model",
          recipe,
          ...(error.receiptId ? { receiptId: error.receiptId } : {}),
          unusable: true,
        });
      });
      return { outcome: "unusable", written };
    }
    if (!(error instanceof ModelContentFiltered)) throw error;
    const written = await sql.begin(async (tx) => {
      await lockNewsProcessingPermissions([row.article_id], tx);
      await assertRuntimeControl(tx, runtimeControl);
      return writeCategory(tx, row, { from: row.category, to: null, method: "model", recipe, receiptId: error.receiptId, refused: true });
    });
    return { outcome: written ? "updated" : "superseded", category: null, receiptId: error.receiptId, reused: false };
  }
  const written = await sql.begin(async (tx) => {
    await lockNewsProcessingPermissions([row.article_id], tx);
    await assertRuntimeControl(tx, runtimeControl);
    const done = await writeCategory(tx, row, { from: row.category, to: result.category, method: "model", recipe, receiptId: result.receiptId });
    await completeReceipt(tx, result.receiptId);
    return done;
  });
  return { outcome: written ? "updated" : "superseded", category: result.category, receiptId: result.receiptId, reused: result.reused };
}
