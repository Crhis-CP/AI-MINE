import fs from "node:fs";
import { z } from "zod";
import { stableJson } from "@amp/backend/lib/ids";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const Case = z.object({
  caseId: z.string().min(1),
  materialId: z.string().min(1),
  revision: z.number().int().positive(),
  inputHash: hash,
  url: z.string(),
  title: z.string(),
  reference: z.object({ decision: z.enum(["select", "reject", "either"]), revision: z.number().int().positive(), actor: z.string() }).nullable(),
  decision: z.enum(["select", "reject"]).nullable(),
  score: z.number().nullable(),
  jurisdictions: z.array(z.string()).nullable(),
  titleZh: z.string().nullable(),
  reason: z.string().nullable(),
  prefilterReason: z.string().nullable(),
  geographyReason: z.string().nullable(),
  models: z.array(z.string()),
  receiptIds: z.array(z.number().int().positive().safe()),
  stepReceiptsComplete: z.boolean(),
  reused: z.boolean().nullable(),
  error: z.string().nullable(),
});
const Routes = z.record(
  z.string(),
  z.object({ key: z.string(), service: z.string().nullable(), requestedModel: z.string().nullable(), configuration: hash.nullable() }),
);
export const PipelineReportSchema = z.object({
  format: z.literal("article-analysis-evaluation-v1"),
  datasetId: z.string(),
  datasetVersion: hash,
  inputManifest: hash,
  ruleHash: hash,
  promptVersion: z.string(),
  release: z.string(),
  synthetic: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  expectedCases: z.number().int().positive(),
  executionComplete: z.boolean(),
  configurationSnapshotsMatch: z.boolean(),
  modelStart: Routes,
  modelEnd: Routes.nullable(),
  stopReason: z.string().nullable(),
  cases: z.array(Case),
});
export type PipelineReport = z.infer<typeof PipelineReportSchema>;
export type CaseResult = z.infer<typeof Case>;

export function quality(cases: CaseResult[]) {
  const rows = cases.filter((c) => !c.error && c.decision && c.reference && c.reference.decision !== "either");
  return {
    referencedCases: rows.length,
    falseNegatives: rows.length ? rows.filter((c) => c.reference!.decision === "select" && c.decision === "reject").length : null,
    falsePositives: rows.length ? rows.filter((c) => c.reference!.decision === "reject" && c.decision === "select").length : null,
  };
}
export function sameCases(before: PipelineReport, after: PipelineReport) {
  const identities = (report: PipelineReport) =>
    report.cases.map((c) => [c.caseId, c.materialId, c.revision, c.inputHash, c.reference]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  if (
    !before.executionComplete ||
    before.cases.length !== before.expectedCases ||
    after.expectedCases !== before.expectedCases ||
    after.cases.length !== after.expectedCases ||
    new Set(before.cases.map((c) => c.caseId)).size !== before.cases.length ||
    before.synthetic !== after.synthetic ||
    before.datasetId !== after.datasetId ||
    before.datasetVersion !== after.datasetVersion ||
    before.inputManifest !== after.inputManifest ||
    before.ruleHash !== after.ruleHash ||
    stableJson(identities(before)) !== stableJson(identities(after))
  )
    throw new Error("评测基线的样本、输入或规则不一致");
}
export function comparePipelineReports(beforeValue: unknown, afterValue: unknown) {
  const before = PipelineReportSchema.parse(beforeValue),
    after = PipelineReportSchema.parse(afterValue);
  sameCases(before, after);
  if (!after.executionComplete || !stableConfigurations(before) || !stableConfigurations(after)) throw new Error("评测未执行完毕或模型配置未确认稳定");
  const old = new Map(before.cases.map((c) => [c.caseId, c]));
  const changes: Array<{
    caseId: string;
    url: string;
    addedCandidate: boolean;
    removedCandidate: boolean;
    jurisdictionsBefore: string[] | null;
    jurisdictionsAfter: string[] | null;
    jurisdictionsComparable: boolean;
  }> = [];
  const incomparable: string[] = [];
  for (const current of after.cases) {
    const previous = old.get(current.caseId)!;
    if (previous.error || current.error || previous.decision === null || current.decision === null) {
      incomparable.push(current.caseId);
      continue;
    }
    const jurisdictionsChanged = stableJson(previous.jurisdictions) !== stableJson(current.jurisdictions);
    if (previous.decision !== current.decision || jurisdictionsChanged)
      changes.push({
        caseId: current.caseId,
        url: current.url,
        addedCandidate: previous.decision === "reject" && current.decision === "select",
        removedCandidate: previous.decision === "select" && current.decision === "reject",
        jurisdictionsBefore: previous.jurisdictions,
        jurisdictionsAfter: current.jurisdictions,
        jurisdictionsComparable: previous.jurisdictions !== null && current.jurisdictions !== null,
      });
  }
  return { changes, incomparable, before: quality(before.cases), after: quality(after.cases) };
}
export const STEPS = ["prefilter", "score", "structure", "understand", "summarize", "wording"] as const;
export function stableConfigurations(report: PipelineReport) {
  return !!report.modelEnd && STEPS.every((step) => !!report.modelStart[step]?.configuration) && stableJson(report.modelStart) === stableJson(report.modelEnd);
}

/** A failed write keeps the last checkpoint; a failed rename keeps both complete files. */
export function writePipelineCheckpoint(filename: string, text: string) {
  const pending = `${filename}.pending`;
  let fd: number | undefined;
  let created = false,
    complete = false;
  try {
    fd = fs.openSync(pending, "wx", 0o600);
    created = true;
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    complete = true;
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(pending, filename);
    created = false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created && !complete) fs.rmSync(pending, { force: true });
  }
}
