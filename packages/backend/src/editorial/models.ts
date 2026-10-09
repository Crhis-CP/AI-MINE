import { environmentValue } from "../config.ts";
// Model per capability: the code default (`default`, the deployment's own model), an environment
// override, and an admin switch kept in settings (every switch is audited). Read at call time and
// cached for a minute, so a switch applies to the next call without a restart; a changed model only
// affects work done from then on (history is not re-judged).
import { dbOf, type Db } from "../db.ts";
import { MODELS, modelSpecFor } from "../providers/llm.ts";

const sql = dbOf("ai-gateway");

export interface Capability {
  label: string;
  env: string;
  default: string;
  /** Receipt purposes this capability produces (for the admin statistics). */
  purposes: string[];
  vision?: boolean;
}

export const CAPABILITIES = {
  prefilter: { label: "精选预筛（是否属于这个行业，宽召回）", env: "PREFILTER_MODEL", default: "default", purposes: ["prefilter_article"] },
  score: { label: "精选评分（两次独立评分，按信源分级门槛）", env: "SCORE_MODEL", default: "default", purposes: ["score_article"] },
  understand: {
    label: "内容理解（入选和接近入选的标题、摘要、推荐理由、标签，能看图时看首图）",
    env: "UNDERSTAND_MODEL",
    default: "default",
    purposes: ["understand_article"],
  },
  summarize: { label: "标题摘要（其余文章的中文标题与摘要）", env: "SUMMARIZE_MODEL", default: "default", purposes: ["summarize_article"] },
  structure: { label: "结构抽取（分类、标签、主体公司、事件事实，不写读者文字）", env: "STRUCTURE_MODEL", default: "default", purposes: ["structure_article"] },
  group: {
    label: "事件归组（新报道与候选事实的关系：同一次发生、同一事件的进展、无关；被同一篇报道连起来的两个事件是否同一事件）",
    env: "GROUP_MODEL",
    default: "default",
    purposes: ["group_article", "group_signal", "group_story"],
  },
  groupReview: {
    label: "归组复核（相似度不高的合并、两个事件的合并，写入前再读一遍；最好换一家模型）",
    env: "GROUP_REVIEW_MODEL",
    default: "default",
    purposes: ["group_review", "group_story_review"],
  },
  digest: { label: "事件综述", env: "DIGEST_MODEL", default: "default", purposes: ["story_digest"] },
  report: { label: "日报、周报、月报", env: "REPORT_MODEL", default: "default", purposes: ["report_lead", "report_daily", "report_weekly", "report_monthly"] },
  translate: { label: "精选全文翻译", env: "TRANSLATE_MODEL", default: "default", purposes: ["translate_body"] },
  policy_fulltext: { label: "法规全文事实与完整中文", env: "POLICY_FULLTEXT_MODEL", default: "default", purposes: ["policy_fulltext"] },
  policy_group: { label: "法规分组核对与归并", env: "POLICY_GROUP_MODEL", default: "default", purposes: ["policy_group"] },
  policy_interpret: { label: "法规身份与候选解读", env: "POLICY_INTERPRET_MODEL", default: "default", purposes: ["policy_interpret"] },
  policy_vision: { label: "法规附件逐页视觉处理（须明确配置）", env: "POLICY_VISION_MODEL", default: "", purposes: ["policy_vision"], vision: true },
  policy_verify: { label: "法规全篇语义核验", env: "POLICY_VERIFY_MODEL", default: "default", purposes: ["policy_verify"] },
} satisfies Record<string, Capability>;

export type CapabilityKey = keyof typeof CAPABILITIES;

async function overrides(db: Db = sql): Promise<Record<string, string>> {
  const rows = await db<{ key: string; value: { model?: string } }[]>`SELECT key, value FROM settings WHERE key LIKE 'models.%'`;
  const map: Record<string, string> = {};
  for (const r of rows)
    if (r.value?.model && (MODELS[r.value.model] || r.value.model.startsWith("registered:"))) map[r.key.slice("models.".length)] = r.value.model;

  return map;
}

export function invalidateModelCache() {
  // Routing is read per new task; no cross-process stale cache.
}

export class PolicyVisionConfigurationError extends Error {}

/** The model a capability uses now: admin switch, else environment, else the code default. */
export async function modelFor(capability: CapabilityKey): Promise<string> {
  const c: Capability = CAPABILITIES[capability];
  const chosen = (await overrides())[capability] ?? process.env[c.env] ?? c.default;
  const spec = await modelSpecFor(chosen);
  if (capability === "policy_vision" && (!chosen || !spec?.vision))
    throw new PolicyVisionConfigurationError("Configure POLICY_VISION_MODEL (or models.policy_vision) with an explicitly vision-capable registered model");
  if (capability.startsWith("policy_") && !spec) throw new Error(`Unknown configured policy model ${chosen}`);
  return spec ? chosen : c.default;
}

/** Where the current choice comes from, for the admin page. */
export async function modelSources(db: Db = sql): Promise<Record<string, { model: string; source: "admin" | "env" | "default" }>> {
  const o = await overrides(db);
  const out: Record<string, { model: string; source: "admin" | "env" | "default" }> = {};
  for (const [key, c] of Object.entries(CAPABILITIES) as Array<[string, Capability]>) {
    if (o[key]) out[key] = { model: o[key]!, source: "admin" };
    else if (process.env[c.env] && (MODELS[process.env[c.env]!] || environmentValue(c.env)!.startsWith("registered:")))
      out[key] = { model: process.env[c.env]!, source: "env" };
    else out[key] = { model: c.default, source: "default" };
  }
  return out;
}
