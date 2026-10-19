import { SELECTION } from "@amp/industry/selection";
import { SCORE_CALLS, tierThreshold } from "../editorial/analyze.ts";
import { sha256, stableJson } from "../lib/ids.ts";

const thresholdVersion = `selection-thresholds@${sha256(stableJson(SELECTION.thresholds)).slice(0, 12)}`;

/** A source tier edit reuses its recorded scores; it does not rewrite the analysis or buy new scores. */
export function recomputeSelection(
  analysis: { id: number; selected: boolean | null; relevance: string | null; output: unknown },
  tier: string,
  timelineAt: Date,
  now: Date,
  previous?: { analysis_id: number | null; eligible: boolean; selection_candidate: boolean },
) {
  const output = analysis.output;
  if (!output || typeof output !== "object" || Array.isArray(output) || !("threshold" in output)) return null;
  const data = output as Record<string, unknown>;
  const original = data.threshold;
  // A legacy display score is not evidence of two independent scores or of the rule they used.
  if (original !== null && (typeof original !== "number" || !Number.isFinite(original))) return null;
  if (timelineAt.getTime() < now.getTime() - 7 * 86_400_000) {
    // Keep the nomination when it ages out, including one still waiting for grouping confirmation.
    return { selected: previous?.analysis_id === analysis.id && previous.eligible ? previous.selection_candidate : analysis.selected, evidence: null };
  }
  const threshold = tierThreshold(tier);
  if (original === threshold) return null;
  const values =
    (data.scoreRefused === undefined || data.scoreRefused === false) &&
    Array.isArray(data.scores) &&
    data.scores.length === SCORE_CALLS &&
    data.scores.every((value) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100)
      ? (data.scores as number[])
      : null;
  const selected =
    analysis.relevance === "pass" && values !== null && threshold !== null && values.reduce((sum, value) => sum + value, 0) >= threshold * SCORE_CALLS;
  return {
    selected,
    evidence: { tier, threshold, thresholdVersion, originalThreshold: original, scores: values, analysisId: analysis.id },
  };
}
