import { SELECTION } from "@amp/industry/selection";
import { sha256, stableJson } from "../lib/ids.ts";

const thresholdVersion = `selection-thresholds@${sha256(stableJson(SELECTION.thresholds)).slice(0, 12)}`;
const tierRule = (tier: string) => ({ tier, threshold: SELECTION.thresholds[tier] ?? null, thresholdVersion });

/** Reuse the original two scores only when the recorded tier threshold changed (BR-SEL-02/03). */
export function recomputeSelection(
  analysis: { id: number; selected: boolean | null; relevance: string | null; output: unknown },
  tier: string,
  timelineAt: Date,
  now: Date,
  previous?: { analysis_id: number | null; eligible: boolean; selected: boolean },
) {
  const output = analysis.output;
  if (!output || typeof output !== "object" || Array.isArray(output) || !("threshold" in output)) return null;
  const original = (output as Record<string, unknown>).threshold;
  // Old-format analyses do not prove which rule ran; never infer it from a rounded display score.
  if (original !== null && (typeof original !== "number" || !Number.isFinite(original))) return null;
  const rule = tierRule(tier);
  if (timelineAt.getTime() < now.getTime() - 7 * 86_400_000) {
    // A recent recalculation must not revert to its original analysis when the item naturally ages.
    return { selected: previous?.analysis_id === analysis.id && previous.eligible ? previous.selected : analysis.selected, evidence: null };
  }
  if (original === rule.threshold) return null;
  const data = output as Record<string, unknown>;
  const values =
    (data.scoreRefused === undefined || data.scoreRefused === false) &&
    Array.isArray(data.scores) &&
    data.scores.length === 2 &&
    data.scores.every((value) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100)
      ? (data.scores as number[])
      : null;
  const selected = analysis.relevance === "pass" && values !== null && rule.threshold !== null && values[0]! + values[1]! >= rule.threshold * 2;
  return {
    selected,
    evidence: { ...rule, originalThreshold: original, scores: values, scoreModel: data.scoreModel ?? null, analysisId: analysis.id, selected },
  };
}
