// SelectBench: selection-model comparison runs on the human gold set. Runs come from
// scripts/eval-selection.ts (imported automatically) or an uploaded report; the admin compares
// models on the same cases and browses each case.
import { randomBytes } from "node:crypto";
import { dbOf, type Db } from "../db.ts";
import { audit } from "./auth.ts";

const sql = dbOf("ai-gateway");

interface CaseIn {
  caseId: string;
  title: string;
  stratum?: string | null;
  gold: string;
  decision: string | null;
  score?: number | null;
  relevance?: string | null;
  category?: string | null;
  reason?: string | null;
  receiptId?: number | null;
  error?: string | null;
}

interface ModelReport {
  summary: Record<string, unknown>;
  sweep?: unknown[];
  cases?: CaseIn[];
}

/** Accepts { meta, models } or the older report shape keyed by model name. */
export async function importSelectBenchRun(report: unknown, label: string, actor: string, db?: Db) {
  const r = report as { meta?: Record<string, unknown>; models?: Record<string, ModelReport> } & Record<string, ModelReport>;
  const models = (r.models ?? Object.fromEntries(Object.entries(r).filter(([k]) => k !== "meta"))) as Record<string, ModelReport>;
  const names = Object.keys(models).filter((m) => m !== "model_configurations" && models[m]?.summary);
  if (!names.length) throw new Error("report has no model summaries");
  const meta = r.meta ?? {};
  const id = `sb-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(3).toString("hex")}`;
  const summary = Object.fromEntries(names.map((m) => [m, { ...models[m]!.summary, sweep: models[m]!.sweep ?? [] }]));
  const sampleSize = Number(meta.n ?? (models[names[0]!]!.summary as { n?: number }).n ?? 0);
  const insert = async (tx: Db) => {
    await tx`
      INSERT INTO selectbench_runs (id, label, split, sample_size, seed, prompt_version, models, summary, imported_by)
      VALUES (${id}, ${label}, ${(meta.split as string) ?? null}, ${sampleSize}, ${(meta.seed as number) ?? null}, ${(meta.promptVersion as string) ?? null}, ${names}, ${tx.json(summary as never)}, ${actor})`;
    for (const m of names) {
      const cases = models[m]!.cases ?? [];
      for (let i = 0; i < cases.length; i += 500) {
        const rows = cases.slice(i, i + 500).map((c) => ({
          run_id: id,
          model: m,
          case_id: c.caseId,
          title: c.title,
          stratum: c.stratum ?? null,
          gold: c.gold,
          decision: c.decision,
          score: c.score ?? null,
          relevance: c.relevance ?? null,
          category: c.category ?? null,
          reason: c.reason ?? null,
          receipt_id: c.receiptId ?? null,
          error: c.error ?? null,
        }));
        await tx`INSERT INTO selectbench_results ${tx(rows)} ON CONFLICT DO NOTHING`;
      }
    }
  };
  if (db) await insert(db);
  else await sql.begin(insert);
  await audit(actor, "selectbench.import", `selectbench:${id}`, null, null, { label, models: names, sampleSize }, undefined, db);
  return { id };
}

export async function listSelectBenchRuns(db: Db = sql) {
  return db`
    SELECT r.id, r.label, r.split, r.sample_size, r.prompt_version, r.models,
           (SELECT coalesce(jsonb_object_agg(key, value - 'sweep'), '{}'::jsonb) FROM jsonb_each(r.summary)) AS summary,
           r.created_at, r.imported_by,
           (SELECT e.metadata - 'cases' FROM ai.selection_run_evidence e WHERE e.run_id=r.id) AS calibration,
           (SELECT count(*)::int FROM selectbench_results x WHERE x.run_id = r.id) AS cases
    FROM selectbench_runs r ORDER BY r.created_at DESC LIMIT 100`;
}

export async function selectBenchRun(id: string, f: { model?: string; outcome?: string; stratum?: string; disagree?: boolean }, db: Db = sql) {
  const [run] = await db`SELECT * FROM selectbench_runs WHERE id = ${id}`;
  if (!run) return null;
  const outcome = f.outcome ?? null;
  // One row per case with every model's decision, so disagreements are visible side by side.
  const rows = await db`
    SELECT case_id, min(title) AS title, min(stratum) AS stratum, min(gold) AS gold,
           jsonb_object_agg(model, jsonb_build_object('decision', decision, 'score', score, 'relevance', relevance, 'category', category, 'reason', reason, 'error', error, 'receiptId', receipt_id)) AS by_model
    FROM selectbench_results WHERE run_id = ${id} AND (${f.stratum ?? null}::text IS NULL OR stratum = ${f.stratum ?? null})
    GROUP BY case_id
    HAVING (${outcome}::text IS NULL OR bool_or(
      model = ${f.model ?? (run.models as string[])[0]!} AND CASE ${outcome}
        WHEN 'fp' THEN decision = 'select' AND gold = 'reject'
        WHEN 'fn' THEN decision = 'reject' AND gold = 'select'
        WHEN 'tp' THEN decision = 'select' AND gold = 'select'
        WHEN 'tn' THEN decision = 'reject' AND gold = 'reject'
        WHEN 'either' THEN gold = 'either'
        WHEN 'error' THEN decision IS NULL
        ELSE true END))
      AND (${!!f.disagree} IS FALSE OR count(DISTINCT decision) > 1)
    ORDER BY min(stratum), case_id LIMIT 400`;
  const strata = await db`SELECT stratum, count(DISTINCT case_id)::int AS n FROM selectbench_results WHERE run_id = ${id} GROUP BY 1 ORDER BY 2 DESC`;
  return { run, rows, strata };
}

// Existing facade: no new package export or model/publication action.
export { selectionTool, changeSelectionTool, requireSelectionTool, withSelectionTool } from "./selectbench-state.ts";
export { installSelectionDataset, selectionSamples, labelSelectionSample, exportSelectionGold } from "./selectbench-samples.ts";
export { selectionStandards, submitSelectionStandard, reviewSelectionStandard, confirmSelectionHoldout } from "./selectbench-records.ts";
export {
  selectionRunEvidence,
  readApprovedSelectionCalibration,
  recordSelectionEvaluation,
  type SelectionEvaluationMetadata,
  type ApprovedSelectionCalibration,
} from "./selectbench-evidence.ts";

export { selectionModelIdentity } from "./selectbench-runtime.ts";
