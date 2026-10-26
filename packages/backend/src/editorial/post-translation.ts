// Quoted text has its own identity and receipt; it never supplies a complete HTML-body manifest.
import { z } from "zod";
import { sql, type Db } from "../db.ts";
import { manualMaterialSnapshot } from "../content/materials.ts";
import { evaluateSourcePolicy, readCurrentSourcePolicy } from "../admin/sources.ts";
import { escapeHtml, collapseWhitespace, isEmptyOrLinkOnly } from "../lib/text.ts";
import { sha256 } from "../lib/ids.ts";
import { chatJson, ModelPostReceiptGuardError } from "../providers/llm.ts";
import { settleTranslationResponse } from "../providers/receipts.ts";
import { prepareNewsFallback, lockNewsProcessingPermissions } from "../providers/news-fallback.ts";
import { requireRuntimeRunning, assertRuntimeControl } from "../operations/lane-controls.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import { loadAnalyzeInput, type AnalyzeInputArticle } from "./input.ts";
import { modelFor } from "./models.ts";
import { looksZh } from "./writing.ts";
import { promptText, quoteTranslationRecipe } from "./prompts.ts";
import { translationTextIssue } from "./translation-readiness.ts";

export { quoteTranslationRecipe } from "./prompts.ts";
const Output = z.strictObject({ t: z.tuple([z.string().trim().min(1)]) });
export function quoteTranslatable(text: string): boolean {
  const words = collapseWhitespace(text.replace(/https?:\/\/\S+/g, " "));
  return !isEmptyOrLinkOnly(text) && words.length >= 10 && (words.match(/\p{L}/gu) ?? []).length >= 2 && !looksZh(words);
}

/** Called from the existing translation job after publication's current permission/admission check. */
export async function translatePostQuote(articleId: string, revision: number): Promise<"none" | "ready" | "partial" | "stale" | "denied"> {
  const input = await loadAnalyzeInput(articleId);
  if (!input || input.revision !== revision) return "stale";
  const quote = input.xPost?.quoted;
  if (!quote || !quoteTranslatable(quote.text) || !input.sourceId) return "none";
  const policy = await readCurrentSourcePolicy(input.sourceId);
  if (!policy) return "denied";
  const permissionsAllow = async (capabilities: Array<"process_locally" | "store_fulltext" | "external_model">, db: Db = sql) => {
    for (const url of new Set([input.url, quote.url]))
      for (const capability of capabilities) {
        const result = await evaluateSourcePolicy(
          {
            source_id: input.sourceId!,
            lane: "news",
            capability,
            expected_permission_version: policy.permission_version,
            resource: { url, attachment: false, document_type: null },
          },
          undefined,
          db,
        );
        if (result.decision !== "allow") return false;
      }
    return true;
  };
  const checkPermissions = async (capabilities: Array<"process_locally" | "store_fulltext" | "external_model">, db: Db = sql) => {
    if (!(await permissionsAllow(capabilities, db))) throw new Error("当前来源不允许处理或保存该引用 URL 的全文译文");
  };
  if (!(await permissionsAllow(["process_locally", "store_fulltext"]))) return "denied";
  const hash = sha256(quote.text),
    recipe = quoteTranslationRecipe();
  const [saved] = await sql`SELECT text_zh FROM enrichment.quote_translations
    WHERE source_id=${input.sourceId} AND quote_url=${quote.url} AND text_hash=${hash} AND recipe=${recipe}`;
  if (saved) return "ready";
  if (!(await permissionsAllow(["external_model"]))) return "denied";
  const runtimeControl = await requireRuntimeRunning("news", ["processing"]);
  const identity = (value: AnalyzeInputArticle) => ({
    id: value.id,
    revision: value.revision,
    sourceId: value.sourceId,
    quote: value.xPost?.quoted ? { url: value.xPost.quoted.url, text: value.xPost.quoted.text } : null,
  });
  const fallback = await prepareNewsFallback({
    root: shutdownSignal.signal,
    expected: identity(input),
    current: async () => {
      const current = await loadAnalyzeInput(articleId);
      return current ? identity(current) : null;
    },
    articles: [input],
  });
  if (!fallback) throw new Error("引用翻译缺少当前材料许可");
  let text: string | null = null;
  let reply: Awaited<ReturnType<typeof chatJson<z.ZodUnknown>>>;
  const system = promptText("translate-post"),
    user = JSON.stringify({ segments: [quote.text] });
  try {
    reply = await chatJson({
      model: await modelFor("translate"),
      purpose: "translate_body",
      sourceIds: [input.sourceId],
      runtimeControl,
      subject: `article:${articleId}@${revision}#quote:${sha256(quote.url)}`,
      promptVersion: recipe,
      system,
      user,
      fallbackPermit: fallback({ system, user }),
      beforeRequest: () => checkPermissions(["process_locally", "store_fulltext", "external_model"]),
      schema: z.unknown(),
      parse: (content) => content,
      temperature: 0.2,
      maxTokens: Math.min(4000, Math.ceil(quote.text.length * 1.5) + 200),
      timeoutMs: 120_000,
      maxRejectedOutputs: 3,
    });
  } catch (error) {
    if (error instanceof ModelPostReceiptGuardError && (await loadAnalyzeInput(articleId))?.revision !== revision) return "stale";
    throw error;
  }
  if (reply.attemptId === null) return "partial";
  try {
    const output = Output.safeParse(JSON.parse(String(reply.data)));
    if (output.success && [null, "", "stop"].includes(reply.finishReason)) text = output.data.t[0];
  } catch {
    /* Retain the actual response and its usage before rejecting the output. */
  }
  shutdownSignal.signal.throwIfAborted();
  const valid = text !== null && translationTextIssue(escapeHtml(text)) === null;
  return sql.begin(async (tx) => {
    await lockNewsProcessingPermissions([articleId], tx);
    await checkPermissions(["process_locally", "store_fulltext"], tx);
    await assertRuntimeControl(tx, runtimeControl);
    const locked = await manualMaterialSnapshot(articleId, tx);
    const current = locked?.revision === revision ? await loadAnalyzeInput(articleId, tx) : null;
    if (current?.revision !== revision || current.xPost?.quoted?.url !== quote.url || current.xPost?.quoted?.text !== quote.text) return "stale" as const;
    const settled = await settleTranslationResponse(tx, reply, valid ? { accepted: true } : { accepted: false, reason: "invalid quoted-post translation" });
    if (!settled || !valid) return "partial" as const;
    await tx`INSERT INTO enrichment.quote_translations(source_id,quote_url,text_hash,recipe,text_zh,input_article_id,input_revision,receipt_id,attempt_id)
      VALUES(${input.sourceId!},${quote.url},${hash},${recipe},${text!},${articleId},${revision},${reply.receiptId},${reply.attemptId!})
      ON CONFLICT(source_id,quote_url,text_hash,recipe) DO NOTHING`;
    return "ready" as const;
  });
}
