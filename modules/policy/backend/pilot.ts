/**
 * Operator switches for the policy-line restart (DEC-78补充·五项决定与降本原则 item 5; 法规线重启设计 §4/§7). Read on
 * every call, like the collection switches, so tests and a restarted process observe the current environment.
 *
 * - POLICY_PILOT_ENABLED=true resumes the two stages that call no model: archive (directory scans and original
 *   acquisition) and structure (extraction and provisions). It adds to, never replaces, COLLECT_ENABLED,
 *   COLLECT_POLICY_ENABLED and the Owner's runtime holds; the policy list then says “试点范围更新中”.
 * - POLICY_MODEL_STAGES_ENABLED=true is required before any policy model purpose runs (policy_fulltext,
 *   policy_vision, policy_interpret, policy_verify, policy_group). The Owner set no budget cap on 2026-11-05; cost is bounded by design (modules/policy/README.md
 *   “成本设计”): translation memory, change-only interpretation, deterministic verification and grouping, and paid
 *   calls only in the provider's off-peak hours. MODEL_CALLS_ENABLED alone never starts these stages.
 * - POLICY_VISION_ENABLED=true is additionally required before a scanned original (no text layer) goes to the vision
 *   model. Without it such a revision is marked needs_manual and nothing is rendered or sent (法规线成本设计).
 */
import { environmentValue, sourceCollectionEnabled } from "@amp/backend/config";

export const policyPilotEnabled = () => environmentValue("POLICY_PILOT_ENABLED") === "true";
export const policyModelStagesEnabled = () => environmentValue("POLICY_MODEL_STAGES_ENABLED") === "true";
export const policyVisionEnabled = () => policyModelStagesEnabled() && environmentValue("POLICY_VISION_ENABLED") === "true";
/** Archive may run: the general and policy collection switches are on and the operator has resumed the pilot. */
export const policyArchiveEnabled = () => sourceCollectionEnabled("policy") && policyPilotEnabled();

export class PolicyModelStagesDisabled extends Error {
  constructor() {
    super("Policy model stages are off (POLICY_MODEL_STAGES_ENABLED is not true)");
  }
}
