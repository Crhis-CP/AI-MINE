import { dbOf } from "../db.ts";
import { settlePolicyResponse } from "@amp/backend/providers/receipts";
import { withCurrentPolicyRun, type FulltextRun } from "./fulltext-store.ts";
import { sha256, stableJson } from "../lib/ids.ts";

const sql = dbOf("policy");
export type InterpretationRun = { id: string; fulltext: FulltextRun; recipeVersion: string };
export type StageCheckpoint = {
  stage_id: string;
  input_hash: string;
  purpose: string;
  status: "accepted" | "rejected";
  result: unknown;
  receipt_id: number;
  attempt_id: string;
};
export async function beginInterpretation(fulltext: FulltextRun, recipeVersion: string): Promise<InterpretationRun> {
  const run = { id: sha256(stableJson([fulltext.id, recipeVersion])), fulltext, recipeVersion };
  await withCurrentPolicyRun(fulltext, async (tx) => {
    await tx`INSERT INTO policy.interpretation_runs(id,fulltext_run_id,recipe_version) VALUES(${run.id},${fulltext.id},${recipeVersion}) ON CONFLICT DO NOTHING`;
  });
  return run;
}
export async function interpretationStages(run: InterpretationRun) {
  const rows = await sql<
    StageCheckpoint[]
  >`SELECT stage_id,input_hash,purpose,status,result,receipt_id,attempt_id FROM policy.interpretation_stages WHERE run_id=${run.id}`;
  return withCurrentPolicyRun(run.fulltext, async () => rows);
}
export async function saveInterpretationStage(run: InterpretationRun, stage: Omit<StageCheckpoint, "status">, accepted: boolean) {
  return withCurrentPolicyRun(run.fulltext, async (tx) => {
    const settled = await settlePolicyResponse(tx, { receiptId: stage.receipt_id, attemptId: stage.attempt_id }, accepted);
    if (!settled) throw new Error("stage_receipt_not_current");
    if (!settled.knownUsage) return false;
    await tx`INSERT INTO policy.interpretation_stages(run_id,stage_id,input_hash,purpose,status,result,receipt_id,attempt_id)
      VALUES(${run.id},${stage.stage_id},${stage.input_hash},${stage.purpose},${accepted ? "accepted" : "rejected"},${tx.json(stage.result as never)},${stage.receipt_id},${stage.attempt_id})
      ON CONFLICT DO NOTHING`;
    return true;
  });
}
export async function finishInterpretation(run: InterpretationRun, status: string, output: Record<string, unknown>) {
  if (output.publication_authorized !== false) throw new Error("interpretation_is_not_publication_authority");
  const contentHash = sha256(stableJson(output));
  await withCurrentPolicyRun(run.fulltext, async (tx) => {
    await tx`UPDATE policy.interpretation_runs SET status=${status},output=${tx.json(output as never)},content_hash=${contentHash},updated_at=now() WHERE id=${run.id}`;
  });
  return contentHash;
}
export async function storedInterpretation(run: InterpretationRun) {
  return withCurrentPolicyRun(run.fulltext, async (tx) => {
    const [row] = await tx<{ status: string; output: Record<string, unknown> | null; content_hash: string | null }[]>`
      SELECT status,output,content_hash FROM policy.interpretation_runs WHERE id=${run.id}`;
    if (row?.output && sha256(stableJson(row.output)) !== row.content_hash) throw new Error("interpretation_integrity_mismatch");
    return row ?? null;
  });
}
