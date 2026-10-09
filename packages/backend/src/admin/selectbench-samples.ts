import { z } from "zod";
import { dbOf, type Db } from "../db.ts";
import { selectionMaterialSnapshot } from "@amp/backend/content/materials";
import { buildScoreInput, loadAnalyzeInput, type AnalyzeInputArticle } from "@amp/backend/editorial/analyze";
import { audit, type AdminPrincipal } from "./auth.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { SelectionLabel, SelectionLabelRequest, SelectionSamples } from "@amp/contracts/http/private";
import { requireSelectionTool, selectionCommand, SelectionConflict } from "./selectbench-state.ts";
const sql = dbOf("ai-gateway");
const DatasetInput = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  synthetic: z.boolean().default(false),
  samples: z
    .array(
      z.strictObject({
        caseId: z.string().min(1),
        materialId: z.string().min(1),
        materialRevision: z.number().int().positive(),
        split: z.enum(["development", "holdout"]),
        stratum: z.string().nullable(),
      }),
    )
    .min(1)
    .max(200),
});
/** Internal preparation port. No HTTP sampling/import route and no model call; every sample binds a material already collected by this site. */
export async function installSelectionDataset(value: unknown) {
  const input = DatasetInput.parse(value);
  if (new Set(input.samples.map((s) => s.caseId)).size !== input.samples.length) throw new SelectionConflict("样本编号重复");
  await sql.begin(async (tx) => {
    await tx`INSERT INTO ai.selection_datasets(id,label,synthetic) VALUES(${input.id},${input.label},${input.synthetic})`;
    for (const sample of input.samples) {
      const material = await selectionMaterialSnapshot(sample.materialId, tx);
      if (!material || material.revision !== sample.materialRevision) throw new SelectionConflict("原材料修订已变化，不能制作旧样本");
      const a = await loadAnalyzeInput(material.id, tx);
      if (!a || a.revision !== material.revision) throw new SelectionConflict("评分输入已变化，请重新准备样本");
      const scorerInput = buildScoreInput(a),
        hidden = { ...a, language: material.language, sourceId: material.source_id };
      await tx`INSERT INTO ai.selection_samples(dataset_id,case_id,sample_revision,material_id,material_revision,source_date_version,input,input_hash,split,stratum,hidden_input)
     VALUES(${input.id},${sample.caseId},1,${material.id},${material.revision},${material.source_date_version},${scorerInput},${sha256(scorerInput)},${sample.split},${sample.stratum},${tx.json(hidden as never)})`;
    }
  });
  return { id: input.id };
}
type SampleRow = {
  dataset_id: string;
  case_id: string;
  sample_revision: number;
  material_id: string;
  material_revision: number;
  source_date_version: number;
  input: string;
  input_hash: string;
  split: "development" | "holdout";
  stratum: string | null;
  hidden_input: AnalyzeInputArticle & { sourceId?: string };
};
export async function currentSample(row: SampleRow, db: Db) {
  const material = await selectionMaterialSnapshot(row.material_id, db);
  return (
    !!material &&
    material.revision === row.material_revision &&
    Number(material.source_date_version) === Number(row.source_date_version) &&
    sha256(
      buildScoreInput({
        ...row.hidden_input,
        title: material.title,
        bodyText: material.body_text,
        excerpt: material.excerpt,
        publishedAt: material.published_at,
        discoveredAt: material.discovered_at,
      }),
    ) === row.input_hash
  );
}
async function labelFor(datasetId: string, caseId: string, db: Db) {
  const [label] =
    await db`SELECT revision,decision,note,actor,created_at FROM ai.selection_labels WHERE dataset_id=${datasetId} AND case_id=${caseId} ORDER BY revision DESC LIMIT 1`;
  return label
    ? SelectionLabel.parse({ revision: label.revision, decision: label.decision, note: label.note, actor: label.actor, at: label.created_at.toISOString() })
    : null;
}
export async function selectionSamples(principal: AdminPrincipal, datasetId?: string, page = 1) {
  return sql.begin(async (tx) => {
    await requireSelectionTool(principal, tx);
    const [dataset] = datasetId
      ? await tx<{ id: string; label: string; synthetic: boolean }[]>`SELECT id,label,synthetic FROM ai.selection_datasets WHERE id=${datasetId}`
      : await tx<{ id: string; label: string; synthetic: boolean }[]>`SELECT id,label,synthetic FROM ai.selection_datasets ORDER BY created_at DESC,id LIMIT 1`;
    if (!dataset) return SelectionSamples.parse({ datasetId: null, datasetLabel: null, synthetic: false, total: 0, page: 1, pageSize: 20, samples: [] });
    const [count] = await tx`SELECT count(*)::int AS total FROM ai.selection_samples WHERE dataset_id=${dataset.id}`;
    const rows = await tx<
      SampleRow[]
    >`SELECT * FROM ai.selection_samples WHERE dataset_id=${dataset.id} ORDER BY split,case_id LIMIT 20 OFFSET ${(page - 1) * 20}`;
    const samples = [];
    for (const row of rows)
      samples.push({
        datasetId: row.dataset_id,
        caseId: row.case_id,
        sampleRevision: row.sample_revision,
        split: row.split,
        stratum: row.stratum,
        scorerInput: row.input,
        synthetic: dataset.synthetic,
        materialCurrent: await currentSample(row, tx),
        label: await labelFor(row.dataset_id, row.case_id, tx),
      });
    return SelectionSamples.parse({
      datasetId: dataset.id,
      datasetLabel: dataset.label,
      synthetic: dataset.synthetic,
      total: count!.total,
      page,
      pageSize: 20,
      samples,
    });
  });
}
export async function labelSelectionSample(datasetId: string, caseId: string, value: unknown, principal: AdminPrincipal) {
  const input = SelectionLabelRequest.parse(value);
  return selectionCommand(principal, "label", { ...input, datasetId, caseId }, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`selection-sample:${datasetId}:${caseId}`}))`;
    const [sample] = await tx<SampleRow[]>`SELECT * FROM ai.selection_samples WHERE dataset_id=${datasetId} AND case_id=${caseId}`;
    if (!sample || sample.sample_revision !== input.sampleRevision || !(await currentSample(sample, tx)))
      throw new SelectionConflict("原材料已有更新，请保留备注并重新准备样本");
    const before = await labelFor(datasetId, caseId, tx);
    if ((before?.revision ?? 0) !== input.expectedRevision) throw new SelectionConflict("样本标注已变化，请保留草稿并刷新");
    const [saved] =
      await tx`INSERT INTO ai.selection_labels(dataset_id,case_id,revision,decision,note,actor) VALUES(${datasetId},${caseId},${input.expectedRevision + 1},${input.decision},${input.note},${`account:${principal.userId}`}) RETURNING revision,decision,note,actor,created_at`;
    const result = SelectionLabel.parse({
      revision: saved!.revision,
      decision: saved!.decision,
      note: saved!.note,
      actor: saved!.actor,
      at: saved!.created_at.toISOString(),
    });
    await audit(
      result.actor,
      "selection.label",
      `${datasetId}:${caseId}`,
      input.note,
      before,
      { ...result, sampleRevision: sample.sample_revision },
      undefined,
      tx,
    );
    return result;
  });
}
/** Private evaluator reads an immutable input/label manifest. Source facts stay off the annotation DTO. */
export async function selectionDatasetManifest(datasetId: string, db: Db = sql) {
  const [dataset] = await db`SELECT id,label,synthetic FROM ai.selection_datasets WHERE id=${datasetId}`;
  if (!dataset) throw new SelectionConflict("评测样本集不存在");
  const rows = await db<SampleRow[]>`SELECT * FROM ai.selection_samples WHERE dataset_id=${datasetId} ORDER BY case_id`;
  const cases = [];
  for (const row of rows) {
    const label = await labelFor(datasetId, row.case_id, db);
    cases.push({ ...row, label, current: await currentSample(row, db) });
  }
  const version = sha256(
    stableJson(cases.map((r) => [r.case_id, r.sample_revision, r.input_hash, r.split, r.label?.revision ?? 0, r.label?.decision ?? null])),
  );
  return { id: dataset.id, synthetic: dataset.synthetic, version, cases };
}
export async function exportSelectionGold(datasetId: string) {
  return sql.begin(async (tx) => {
    const dataset = await selectionDatasetManifest(datasetId, tx);
    if (dataset.cases.some((c) => !c.current || !c.label)) throw new SelectionConflict("样本尚未全部由Owner标注，或原材料已有变化");
    return {
      datasetId: dataset.id,
      datasetVersion: dataset.version,
      synthetic: dataset.synthetic,
      rows: dataset.cases.map((c) => ({
        caseId: c.case_id,
        material: {
          title: c.hidden_input.title,
          originalTitle: c.hidden_input.title,
          publishedAt: c.hidden_input.publishedAt,
          discoveredAt: c.hidden_input.discoveredAt,
          sourceName: c.hidden_input.source.name,
          bodyZh: null,
          bodyOriginal: c.hidden_input.bodyText ?? c.hidden_input.excerpt,
        },
        sourceFacts: { sourceKind: c.hidden_input.source.kind, sourceTier: c.hidden_input.source.tier, firstParty: c.hidden_input.source.firstParty },
        samplingContext: { benchmarkSplit: c.split, samplingStratum: c.stratum },
        gold: { decision: c.label!.decision },
        sampleRevision: c.sample_revision,
        labelRevision: c.label!.revision,
        inputHash: c.input_hash,
      })),
    };
  });
}
