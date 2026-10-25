// Recorded historical identities, independent of today's installed/renamed capabilities. Never infer by prefix.
const news = new Set([
  "prefilter_article",
  "score_article",
  "understand_article",
  "summarize_article",
  "mend_wording",
  "structure_article",
  "group_article",
  "group_signal",
  "group_story",
  "group_review",
  "group_story_review",
  "story_digest",
  "report_lead",
  "report_daily",
  "report_weekly",
  "report_monthly",
  "translate_body",
]);
const policy = new Set(["policy_fulltext", "policy_group", "policy_interpret", "policy_vision", "policy_verify"]);
export const legacyModelPurposes = Object.freeze([...news, ...policy]);
export function legacyModelLane(purpose: string): "news" | "policy" | null {
  return news.has(purpose) ? "news" : policy.has(purpose) ? "policy" : null;
}
