import { z } from "zod";
import { pickRepresentative } from "@amp/backend/publication/timeline";
import type { AnalyzeInputArticle } from "@amp/backend/editorial/analyze";

const decision = z.enum(["select", "reject", "either"]);
const label = z.object({ reviewer: z.string().trim().min(1), global: decision, argentina: decision, reason: z.string().trim().min(1) });
const sample = z.object({
  caseId: z.string().min(1),
  familyId: z.string().min(1),
  occurrenceId: z.string().min(1),
  split: z.enum(["development", "holdout"]),
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  analysisInput: z.custom<AnalyzeInputArticle>(
    (v) =>
      !!v &&
      typeof v === "object" &&
      "id" in v &&
      typeof v.id === "string" &&
      "sourceId" in v &&
      typeof v.sourceId === "string" &&
      "revision" in v &&
      Number.isInteger(v.revision),
  ),
  labels: z.array(label).max(2),
});
export const ExperimentManifest = z
  .object({
    version: z.literal(1),
    datasetId: z.string().min(1),
    frozenAt: z.iso.datetime(),
    synthetic: z.boolean(),
    bindings: z
      .object({
        model: z.string(),
        prefilterModel: z.string(),
        modelIdentity: z.string(),
        prefilterIdentity: z.string(),
        prefilterHash: z.string(),
        promptHashes: z.object({ A: z.string(), B: z.string(), AR: z.string() }),
      })
      .optional(),
    cases: z.array(sample).min(1).max(200),
  })
  .superRefine((value, ctx) => {
    const materials = new Set<string>();
    const ids = new Set<string>(),
      splits = new Map<string, string>(),
      inputs = new Map<string, string>(),
      occurrences = new Map<string, string>();
    for (const row of value.cases) {
      const material = `${row.analysisInput.id}@${row.analysisInput.revision}`;
      if (materials.has(material)) ctx.addIssue({ code: "custom", message: "duplicate material revision cannot represent independent occurrences" });
      materials.add(material);
      if (ids.has(row.caseId)) ctx.addIssue({ code: "custom", message: "duplicate caseId" });
      ids.add(row.caseId);
      if (splits.has(row.familyId) && splits.get(row.familyId) !== row.split) ctx.addIssue({ code: "custom", message: "event family crosses split" });
      splits.set(row.familyId, row.split);
      if (inputs.has(row.inputFingerprint) && inputs.get(row.inputFingerprint) !== row.familyId)
        ctx.addIssue({ code: "custom", message: "identical input split across families" });
      inputs.set(row.inputFingerprint, row.familyId);
      if (occurrences.has(row.occurrenceId) && occurrences.get(row.occurrenceId) !== row.familyId)
        ctx.addIssue({ code: "custom", message: "occurrence split across families" });
      occurrences.set(row.occurrenceId, row.familyId);
      if (row.labels.length === 2 && row.labels[0]!.reviewer === row.labels[1]!.reviewer)
        ctx.addIssue({ code: "custom", message: "two independent reviewers required" });
    }
  });
export type Experiment = z.infer<typeof ExperimentManifest>;
export type ExperimentCase = Experiment["cases"][number];
export type Variant = "A" | "B" | "AR";
export type Outcome = { caseId: string; variant: Variant; scores: number[]; selected: boolean | null; receipts: number[]; error: string | null };

/** Failures stay in the important-content denominator; disagreements never become invented gold. */
export function metrics(cases: ExperimentCase[], outcomes: Outcome[], variant: Variant) {
  const groups = new Map<string, ExperimentCase[]>();
  for (const row of cases) {
    const group = groups.get(row.occurrenceId) ?? [];
    group.push(row);
    groups.set(row.occurrenceId, group);
  }
  const result = {
    cases: cases.length,
    occurrences: groups.size,
    families: new Set(cases.map((r) => r.familyId)).size,
    important: 0,
    missed: 0,
    negative: 0,
    falsePositive: 0,
    selected: 0,
    failures: 0,
    disputed: 0,
  };
  for (const rows of groups.values()) {
    const labels = rows.flatMap((r) => r.labels.map((l) => (variant === "AR" ? l.argentina : l.global)));
    const gold = labels.length === rows.length * 2 && labels.every((v) => v === labels[0]) ? labels[0] : "either";
    const outputs = rows.map((r) => outcomes.find((o) => o.caseId === r.caseId && o.variant === variant));
    const prediction = outputs.some((o) => o?.selected === true) ? true : outputs.some((o) => !o || o.selected === null) ? null : false;
    if (prediction === null) result.failures++;
    if (gold === "either") {
      result.disputed++;
      continue;
    }
    if (gold === "select") {
      result.important++;
      if (prediction !== true) result.missed++;
    } else {
      result.negative++;
      if (prediction === true) result.falsePositive++;
    }
    if (prediction === true) result.selected++;
  }
  const rate = (n: number, d: number) => (d ? n / d : null);
  return {
    ...result,
    unit: "occurrence",
    missedRate: rate(result.missed, result.important),
    falsePositiveRate: rate(result.falsePositive, result.negative),
    noiseRate: rate(result.falsePositive, result.selected),
    failureRate: rate(result.failures, result.occurrences),
  };
}

/** Trial output only: never writes a publication or calls a notification transport. */
export function countryPreview(cases: ExperimentCase[], outcomes: Outcome[], currentCandidates: Set<string>) {
  const groups = new Map<string, ExperimentCase[]>();
  for (const row of cases) {
    const ar = outcomes.find((o) => o.caseId === row.caseId && o.variant === "AR");
    if (!currentCandidates.has(row.analysisInput.id) || ar?.selected !== true) continue;
    const list = groups.get(row.occurrenceId) ?? [];
    list.push(row);
    groups.set(row.occurrenceId, list);
  }
  return [...groups.entries()].map(([occurrenceId, rows]) => {
    const representative = pickRepresentative(
      rows.map((r) => {
        const values = outcomes.find((o) => o.caseId === r.caseId && o.variant === "AR")!.scores;
        return {
          caseId: r.caseId,
          id: r.analysisInput.id,
          source_tier: r.analysisInput.source.tier,
          body_mode: "link",
          score: Math.floor(values.reduce((a, b) => a + b, 0) / 2),
          timeline_at: new Date(r.analysisInput.publishedAt ?? r.analysisInput.discoveredAt ?? 0),
        };
      }),
    );
    return {
      status: "nomination_only_requires_grouping_and_release_checks",
      occurrenceId,
      representative: representative.caseId,
      members: rows.map((r) => r.caseId),
      website: { scope: "AR", caseId: representative.caseId },
      delivery: { mode: "preview_only", target: "AR", caseId: representative.caseId, dedupeKey: `AR:${occurrenceId}` },
    };
  });
}

export function attemptSummary(attempts: Array<{ cost: unknown; currency: unknown; cost_basis: unknown; status: unknown; latency_ms: unknown }>) {
  const totals = new Map<string, number>();
  let unknownCost = 0;
  const latencies: number[] = [];
  for (const a of attempts) {
    const amount = typeof a.cost === "string" || typeof a.cost === "number" ? Number(a.cost) : NaN;
    if (
      a.status === "unknown" ||
      !Number.isFinite(amount) ||
      amount < 0 ||
      typeof a.currency !== "string" ||
      !a.currency ||
      !["actual", "estimated"].includes(String(a.cost_basis))
    )
      unknownCost++;
    else {
      const key = `${a.currency}:${a.cost_basis}`;
      totals.set(key, (totals.get(key) ?? 0) + amount);
    }
    if (typeof a.latency_ms === "number" && Number.isFinite(a.latency_ms) && a.latency_ms >= 0) latencies.push(a.latency_ms);
  }
  latencies.sort((a, b) => a - b);
  return {
    attempts: attempts.length,
    unknownCost,
    totals: Object.fromEntries(totals),
    latencySamples: latencies.length,
    p50Ms: latencies.length ? latencies[Math.ceil(latencies.length * 0.5) - 1] : null,
    p95Ms: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null,
  };
}
