import { CAPABILITIES } from "../editorial/models.ts";
import { RuntimeControlPaused, RuntimeControlStale } from "../operations/lane-controls.ts";
import type { RuntimeControlSnapshot } from "../operations/lane-controls.ts";
// OpenAI-compatible chat calls, always through receipts. One model is enough: `default` is whatever the
// deployment names in LLM_BASE_URL / LLM_API_KEY / LLM_MODEL, and every capability uses it unless an
// environment variable or the admin's model page picks one of the named presets below.
import type { z } from "zod";
import { resolveRegisteredModel, registeredModelSpec, modelConfigurationHash, type RegisteredAccess } from "./model-registry.ts";
import { redactModelSecret } from "./model-vault.ts";
import { guardedFetch, type GuardedFetchOptions } from "../lib/http-fetch.ts";
import { config, credential } from "../config.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import {
  completeReceipt,
  paidRequest,
  ProviderRejectedError,
  UsageProtectionError,
  rejectReceivedResponse,
  type TranslationObservation,
  type PolicyReceiptContext,
  type ModelAttemptSnapshot,
} from "./receipts.ts";
import { dbOf } from "../db.ts";

const sql = dbOf("ai-gateway");

export interface ModelSpec {
  key: string;
  service: string;
  model: string;
  baseUrlEnv: string;
  apiKeyEnv: string;
  /** Extra request fields, e.g. switching reasoning off for short structured tasks. */
  extra?: Record<string, unknown>;
  jsonMode: boolean;
  vision?: boolean;
}

function extraFromEnv(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new Error('LLM_EXTRA_JSON must be a JSON object, e.g. {"enable_thinking": false}');
  }
}

export const MODELS: Record<string, ModelSpec> = {
  // Read from the environment at call time.
  default: {
    key: "default",
    service: "llm",
    baseUrlEnv: "LLM_BASE_URL",
    apiKeyEnv: "LLM_API_KEY",
    get model() {
      return process.env.LLM_MODEL ?? "";
    },
    get extra() {
      return extraFromEnv(process.env.LLM_EXTRA_JSON);
    },
    get jsonMode() {
      return process.env.LLM_JSON_MODE !== "false";
    },
    get vision() {
      return process.env.LLM_VISION === "true";
    },
  },
  // Named presets (the models the upstream project itself runs on); each needs its own key.
  // GLM 5.3 Flash always reasons; the lowest effort keeps short structured tasks fast.
  "glm-5.3-flash": {
    key: "glm-5.3-flash",
    service: "zhipu",
    model: "glm-5.3-flash",
    baseUrlEnv: "ZHIPU_BASE_URL",
    apiKeyEnv: "ZHIPU_API_KEY",
    extra: { thinking: { type: "enabled" }, reasoning_effort: "low" },
    jsonMode: true,
  },
  // The scorer's parameters for glm-5.3-flash (score calls; temperature 1 is set per call).
  "glm-5.3-flash-selection": {
    key: "glm-5.3-flash-selection",
    service: "zhipu",
    model: "glm-5.3-flash",
    baseUrlEnv: "ZHIPU_BASE_URL",
    apiKeyEnv: "ZHIPU_API_KEY",
    extra: { thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "high", top_p: 0.95 },
    jsonMode: true,
  },
  // DeepSeek Flash reasons by default; structured tasks switch it off unless the -think variant is used.
  "deepseek-flash": {
    key: "deepseek-flash",
    service: "deepseek",
    model: "deepseek-flash",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    extra: { thinking: { type: "disabled" } },
    jsonMode: true,
  },
  "deepseek-flash-think": {
    key: "deepseek-flash-think",
    service: "deepseek",
    model: "deepseek-flash",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    jsonMode: true,
  },
  "qwen3.7-flash": {
    key: "qwen3.7-flash",
    service: "dashscope",
    model: "qwen3.7-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false },
    jsonMode: true,
  },
  "qwen3.8-flash": {
    key: "qwen3.8-flash",
    service: "dashscope",
    model: "qwen3.8-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false },
    jsonMode: true,
  },
  "mimo-v2.6-flash": {
    key: "mimo-v2.6-flash",
    service: "mimo",
    model: "mimo-v2.6-flash",
    baseUrlEnv: "XIAOMI_MIMO_BASE_URL",
    apiKeyEnv: "XIAOMI_MIMO_API_KEY",
    extra: { thinking: { type: "disabled" } },
    jsonMode: true,
  },
  "qwen3-vl-flash": {
    key: "qwen3-vl-flash",
    service: "dashscope",
    model: "qwen3-vl-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false },
    jsonMode: false,
    vision: true,
  },
};

function environmentConfiguration(spec: ModelSpec, baseUrl: string) {
  const model = typeof spec.extra?.model === "string" ? spec.extra.model : spec.model;
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  return { model, configuration_hash: sha256(stableJson(["openai-compatible", endpoint, model, !!spec.vision, spec.jsonMode, spec.extra ?? null])) };
}
/** Non-secret setup metadata. It does not claim that a credential, connection test or quality release exists. */
export function environmentModelMetadata(key: string) {
  const spec = MODELS[key];
  if (!spec) return null;
  try {
    const base = credential("models", spec.baseUrlEnv);
    return {
      key,
      service: spec.service,
      model: spec.model,
      vision: !!spec.vision,
      ...(base && spec.model ? environmentConfiguration(spec, base) : { configuration_hash: null }),
    };
  } catch {
    return { key, service: spec.service, model: spec.model, vision: !!spec.vision, configuration_hash: null };
  }
}
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type RegisteredModelTransport = (
  url: string,
  options: GuardedFetchOptions,
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): string | Promise<string> }>;
export async function modelSpecFor(key: string) {
  return (await registeredModelSpec(key)) ?? MODELS[key] ?? null;
}
export interface ChatJsonOptions<S extends z.ZodType> {
  sourceIds?: string[];
  usageObject?: { kind: "article" | "policy"; id: string };
  model: string;
  /** Trusted worker connection test only; the persisted probe must bind this exact revision. */
  registeredProbe?: RegisteredAccess;
  registeredTransport?: RegisteredModelTransport;
  usagePurpose?: "production" | "research" | "evaluation" | "experiment";
  lane?: "news" | "policy";
  purpose: string;
  subject: string;
  promptVersion: string;
  system: string;
  user: string | ContentPart[];
  schema: S;
  temperature?: number;
  maxTokens?: number;
  attemptTag?: string;
  timeoutMs?: number;
  maxRejectedOutputs?: 1 | 3;
  translationObservations?: TranslationObservation[];
  policyContext?: PolicyReceiptContext;
  runtimeControl?: RuntimeControlSnapshot;
  /** Recheck the trusted input and current permissions immediately before any new paid send. */
  beforeRequest?: () => Promise<void>;
  /** false: the model answers in its own text format (no JSON mode); `parse` turns it into the schema's input. */
  json?: boolean;
  parse?: (content: string) => unknown;
}

export interface ChatJsonResult<T> {
  data: T;
  receiptId: number;
  reused: boolean;
  model: string;
  usage: Record<string, unknown> | null;
  finishReason: string | null;
  attemptId: string | null;
}

export class ModelOutputError extends Error {
  readonly receiptId: number | null;
  constructor(message: string, receiptId: number | null = null) {
    super(message);
    this.receiptId = receiptId;
  }
}

export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1]!;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new ModelOutputError("No JSON object in model output");
  const body = t.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    return JSON.parse(escapeControlCharsInStrings(body));
  }
}

/** Models sometimes emit raw newlines or tabs inside JSON strings (multi-line posts); escape only those. */
export function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      else if (ch < " ") {
        out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

function isConnectFailure(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
  return ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET_BEFORE_SEND", "CERT_HAS_EXPIRED"].includes(code ?? "");
}

export async function chatJson<S extends z.ZodType>(opts: ChatJsonOptions<S>): Promise<ChatJsonResult<z.infer<S>>> {
  if (
    ["policy_fulltext", "policy_group", "policy_interpret", "policy_verify", "policy_vision"].includes(opts.purpose) &&
    (!opts.policyContext || !opts.beforeRequest)
  )
    throw new Error("Policy capabilities require the policy gateway");
  const registered = await resolveRegisteredModel(opts.model, opts.registeredProbe);
  const spec: ModelSpec | null = registered ? { ...registered, baseUrlEnv: "", apiKeyEnv: "" } : (MODELS[opts.model] ?? null);
  if (!spec) throw new Error(`Unknown model ${opts.model}`);
  if (opts.purpose === "policy_vision" && (!spec.vision || "messages" in (spec.extra ?? {}) || "model" in (spec.extra ?? {})))
    throw new Error("Policy vision requires explicit image capability and immutable input messages");
  if (!config.modelCallsEnabled) throw new Error("Model calls are disabled (MODEL_CALLS_ENABLED=false)");
  const baseUrl = registered?.baseUrl ?? credential("models", spec.baseUrlEnv);
  const apiKey = registered?.apiKey ?? credential("models", spec.apiKeyEnv);
  if (!baseUrl || !apiKey || !spec.model)
    throw new Error(`Model ${opts.model} is not configured (${spec.baseUrlEnv}, ${spec.apiKeyEnv}${spec.key === "default" ? ", LLM_MODEL" : ""})`);

  const temperature = opts.temperature ?? 0.2;
  const maxTokens = Math.max(opts.maxTokens ?? 1500, opts.registeredProbe ? 16 : 512) + (spec.key.endsWith("-think") ? 4000 : 0);
  const userText = typeof opts.user === "string" ? opts.user : JSON.stringify(opts.user);
  const body: Record<string, unknown> = {
    model: spec.model,
    messages: [
      // A prompt given as one user message (the title/summary prompts) has no system message.
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      // Multimodal parts go through as parts; plain objects are sent as JSON text.
      { role: "user", content: typeof opts.user === "string" || Array.isArray(opts.user) ? opts.user : userText },
    ],
    temperature,
    max_tokens: maxTokens,
    ...(spec.jsonMode && opts.json !== false ? { response_format: { type: "json_object" } } : {}),
    ...(spec.extra ?? {}),
  };
  const requestBody = JSON.stringify(body),
    imageTransport = opts.purpose === "policy_vision" ? { transportHash: sha256(requestBody), transportBytes: Buffer.byteLength(requestBody) } : {};

  if (typeof body.model !== "string" || !body.model) throw new Error("Model transport requires an explicit requested model");
  const configurationHash = registered ? modelConfigurationHash(registered.config) : environmentConfiguration(spec, baseUrl).configuration_hash;
  const registeredIdentity = { configuration_hash: configurationHash, ...(registered ? { connection_id: registered.id } : {}) };
  const registeredSummary: ModelAttemptSnapshot = {
    connection_id: registered?.id ?? null,
    connection_revision: registered?.revision ?? null,
    key_fingerprint: registered?.fingerprint ?? null,
    configuration_hash: configurationHash,
    ...(registered
      ? {
          pricing: {
            input: registered.config.input_cny_per_million,
            output: registered.config.output_cny_per_million,
            currency: "CNY",
            basis: registered.config.billing_basis,
          },
        }
      : {}),
  };
  const costLane =
    opts.policyContext?.lane ??
    opts.runtimeControl?.lane ??
    opts.lane ??
    (Object.entries(CAPABILITIES).some(([key, c]) => !key.startsWith("policy_") && (c.purposes as string[]).includes(opts.purpose)) ? "news" : undefined);
  const receipt = await paidRequest(
    {
      modelSnapshot: registeredSummary,
      usageContext: costLane
        ? {
            lane: costLane,
            capability: opts.purpose,
            sourceIds: opts.sourceIds ?? opts.policyContext?.sourceIds ?? [],
            object:
              opts.usageObject ??
              (/^article:([a-zA-Z0-9_-]+@[1-9][0-9]*)/.test(opts.subject)
                ? { kind: "article", id: /^article:([a-zA-Z0-9_-]+@[1-9][0-9]*)/.exec(opts.subject)![1]! }
                : null),
          }
        : undefined,
      costBounds: {
        input_tokens: Buffer.byteLength(
          JSON.stringify({
            ...body,
            messages: (body.messages as Array<{ role: string; content: string | ContentPart[] }>).map((m) => ({
              ...m,
              content: typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "image_url" ? { type: "image_url" } : p)),
            })),
          }),
        ),
        output_tokens: Number(body.max_tokens),
        images: Array.isArray(opts.user) ? opts.user.filter((p) => p.type === "image_url").length : 0,
      },
      service: spec.service,
      model: body.model,
      purpose: opts.purpose,
      subject: opts.subject,
      policy: opts.policyContext,
      runtimeControl: opts.runtimeControl,
      identity: {
        transportHash: sha256(requestBody),
        ...registeredIdentity,
        ...imageTransport,
        ...(opts.policyContext ? { policy: opts.policyContext } : {}),
        model: spec.model,
        promptVersion: opts.promptVersion,
        system: sha256(opts.system),
        user: sha256(userText),
        temperature,
        maxTokens,
        extra: spec.extra ?? null,
      },
      requestSummary: {
        ...(opts.usagePurpose ? { usage_purpose: opts.usagePurpose } : {}),
        ...(opts.lane ? { lane: opts.lane } : {}),
        ...registeredSummary,
        ...imageTransport,
        ...(opts.policyContext ?? {}),
        promptVersion: opts.promptVersion,
        systemHash: sha256(opts.system),
        userHash: sha256(userText),
        userChars: userText.length,
        temperature,
        maxTokens,
      },
      attemptTag: opts.attemptTag,
      maxRejectedOutputs: opts.maxRejectedOutputs,
      translationObservations: opts.translationObservations,
    },
    async () => {
      const send = async () => {
        if (opts.beforeRequest) {
          try {
            await opts.beforeRequest();
          } catch (error) {
            if (error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale)
              throw new UsageProtectionError(spec.service, "处理已暂停或控制版本发生变化，等待恢复");
            throw new ProviderRejectedError("Current input or processing permission changed before sending", null, false);
          }
        }
        const started = Date.now();
        let res: { status: number; headers: { get(name: string): string | null }; text(): string | Promise<string> };
        try {
          res = registered
            ? await (opts.registeredTransport ?? guardedFetch)(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
                body: requestBody,
                timeoutMs: opts.timeoutMs ?? 120_000,
                maxBytes: 8 * 1024 * 1024,
                maxRedirects: 0,
                route: "direct",
              })
            : await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
                body: requestBody,
                signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
              });
        } catch (error) {
          if (isConnectFailure(error)) throw new ProviderRejectedError(`connect failed: ${registered ? "模型连接失败" : String(error)}`, null, true);
          if (registered) throw new Error("模型服务请求结果未知");
          throw error;
        }
        const text = redactModelSecret(await res.text(), apiKey);
        if (res.status < 200 || res.status >= 300) {
          const retryable = res.status === 429 || res.status >= 500;
          throw new ProviderRejectedError(`HTTP ${res.status}: ${text.slice(0, 500)}`, res.status, retryable);
        }
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(text);
        } catch {
          json = { unparsable: text.slice(0, 20000) };
        }
        const usage = (json.usage as Record<string, unknown> | undefined) ?? null;
        return {
          response: { ...json, _latencyMs: Date.now() - started },
          requestId: (json.id as string | undefined) ?? (res.headers.get("x-request-id") ? redactModelSecret(res.headers.get("x-request-id")!, apiKey) : null),
          usage,
          cost:
            registered && [usage?.prompt_tokens, usage?.completion_tokens].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
              ? {
                  amount:
                    (Number(usage!.prompt_tokens) * Number(registered.config.input_cny_per_million) +
                      Number(usage!.completion_tokens) * Number(registered.config.output_cny_per_million)) /
                    1e6,
                  currency: "CNY",
                  basis: "estimated" as const,
                }
              : null,
        };
      };
      if (!registered) return send();
      return sql.begin(async (tx) => {
        try {
          await registered.assertCurrent(tx);
        } catch {
          throw new ProviderRejectedError("模型配置或密钥已在发送前变更", null, false);
        }
        return send();
      });
    },
  );

  const response = receipt.response as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: Record<string, unknown> };
  const content = response.choices?.[0]?.message?.content ?? "";
  let parsed: z.infer<S>;
  try {
    parsed = opts.schema.parse(opts.parse ? opts.parse(content) : extractJson(content));
  } catch (error) {
    // Unusable output: record it and let a later attempt pay for a fresh answer.
    await rejectReceivedResponse(receipt.receiptId, `unusable output: ${String(error).slice(0, 500)}`, receipt.attemptId);
    throw new ModelOutputError(`Model ${opts.model} returned unusable output for ${opts.subject}: ${String(error).slice(0, 300)}`, receipt.receiptId);
  }
  return {
    data: parsed,
    receiptId: receipt.receiptId,
    reused: receipt.reused,
    model: spec.key,
    usage: response.usage ?? null,
    finishReason: response.choices?.[0]?.finish_reason ?? null,
    attemptId: receipt.attemptId,
  };
}

export async function markReceiptsCompleted(ids: number[]): Promise<void> {
  for (const id of ids) await completeReceipt(sql, id);
}
