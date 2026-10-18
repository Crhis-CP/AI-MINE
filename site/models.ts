/** Optional site presets name environment variables, never credential values. No supplier is enabled by declaring a preset. */
export interface ModelPreset {
  service: string;
  model: string;
  baseUrlEnv: string;
  apiKeyEnv: string;
  extra?: Record<string, unknown>;
  jsonMode: boolean;
  vision?: boolean;
}
export const PRESETS: Record<string, ModelPreset> = {
  // GLM 5.3 Flash always reasons; the lowest effort keeps short structured tasks fast.
  "glm-5.3-flash": {
    service: "zhipu",
    model: "glm-5.3-flash",
    baseUrlEnv: "ZHIPU_BASE_URL",
    apiKeyEnv: "ZHIPU_API_KEY",
    extra: { thinking: { type: "enabled" }, reasoning_effort: "low" },
    jsonMode: true,
  },
  // The scorer's parameters for glm-5.3-flash (score calls; temperature 1 is set per call).
  "glm-5.3-flash-selection": {
    service: "zhipu",
    model: "glm-5.3-flash",
    baseUrlEnv: "ZHIPU_BASE_URL",
    apiKeyEnv: "ZHIPU_API_KEY",
    extra: { thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "high", top_p: 0.95 },
    jsonMode: true,
  },
  // DeepSeek Flash reasons by default; structured tasks switch it off unless the -think variant is used.
  "deepseek-flash": {
    service: "deepseek",
    model: "deepseek-flash",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    extra: { thinking: { type: "disabled" } },
    jsonMode: true,
  },
  "deepseek-flash-think": {
    service: "deepseek",
    model: "deepseek-flash",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    jsonMode: true,
  },
  "qwen3.7-flash": {
    service: "dashscope",
    model: "qwen3.7-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false },
    jsonMode: true,
  },
  "qwen3.8-flash": {
    service: "dashscope",
    model: "qwen3.8-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false },
    jsonMode: true,
  },
  "mimo-v2.6-flash": {
    service: "mimo",
    model: "mimo-v2.6-flash",
    baseUrlEnv: "XIAOMI_MIMO_BASE_URL",
    apiKeyEnv: "XIAOMI_MIMO_API_KEY",
    extra: { thinking: { type: "disabled" } },
    jsonMode: true,
  },
  "qwen3-vl-flash": {
    service: "dashscope",
    model: "qwen3-vl-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false },
    jsonMode: false,
    vision: true,
  },
};

/** Empty by default: later work uses admin choice, environment, then the deployment default. */
export const DEFAULTS: Record<string, string> = {};

export const MODEL_FAMILIES = [
  {
    id: "deepseek",
    label: "DeepSeek",
    duty: "其余稿的中文标题和摘要；几篇报道是不是同一件矿业上的事；事件综述；周报和月报的导读。全文翻译也归这一家。",
    presets: ["deepseek-flash", "deepseek-flash-think"],
  },
  {
    id: "glm",
    label: "智谱 GLM",
    duty: "精选评分：同一标准独立打两次分。入选或接近入选的稿，写中文标题、导读和推荐理由。",
    presets: ["glm-5.3-flash", "glm-5.3-flash-selection"],
  },
  {
    id: "qwen",
    label: "通义千问",
    duty: "预筛：是不是金属矿业的事，宽进，只拦明显无关。结构抽取：分类、主体和事件事实，不写给读者看的文字。能看图的预设留给法规附件，现在不单独接。",
    presets: ["qwen3.8-flash", "qwen3.7-flash", "qwen3-vl-flash"],
  },
  {
    id: "mimo",
    label: "小米 MiMo",
    duty: "归组拿不准时再读一遍：两篇要不要并成一件事。设计上最好和归组不是同一家；测试阶段先共用已经接入的那一个模型。",
    presets: ["mimo-v2.6-flash"],
  },
] as const;
