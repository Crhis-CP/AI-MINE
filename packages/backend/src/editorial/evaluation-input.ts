import { loadAnalyzeInput, analysisInputIdentity, type AnalyzeInputArticle } from "./input.ts";
import { prepareNewsFallback } from "../providers/news-fallback.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import { sha256, stableJson } from "../lib/ids.ts";

const instant = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
/** Exact fields read by news model renderers; extra export metadata never authorizes edited material. */
export function evaluationInputFingerprint(a: AnalyzeInputArticle) {
  const identity = analysisInputIdentity(a);
  return sha256(
    stableJson({
      sourceId: a.sourceId ?? null,
      id: a.id,
      revision: a.revision,
      title: a.title,
      url: a.url,
      author: a.author,
      publishedAt: instant(a.publishedAt),
      sourceTime: a.sourceTime ?? null,
      discoveredAt: instant(a.discoveredAt),
      bodyText: a.bodyText,
      excerpt: a.excerpt,
      bodyStatus: a.bodyStatus ?? "pending",
      media: identity.media,
      ...(a.xPost ? { xPost: identity.xPost } : {}),
      translationZh: a.translationZh ?? null,
      source: { ...a.source, tags: a.source.tags ?? [], ownerEntityId: a.source.ownerEntityId ?? null, fetchesBody: a.source.fetchesBody ?? false },
    }),
  );
}
export async function prepareEvaluationInput(expected: AnalyzeInputArticle | undefined, fingerprint?: string) {
  if (!expected?.id || !expected.sourceId || !Number.isInteger(expected.revision)) throw new Error("评测样本未绑定来源与材料修订，请从当前材料重新导出");
  const current = await loadAnalyzeInput(expected.id);
  if (
    !current ||
    current.sourceId !== expected.sourceId ||
    current.revision !== expected.revision ||
    evaluationInputFingerprint(current) !== evaluationInputFingerprint(expected) ||
    (fingerprint && fingerprint !== evaluationInputFingerprint(current))
  )
    throw new Error("评测样本与当前原材料或输入哈希不一致，请重新导出；不能以sourceId授权改写的内容");
  const fallbackInput = await prepareNewsFallback({
    root: shutdownSignal.signal,
    expected: analysisInputIdentity(current),
    current: async () => {
      const next = await loadAnalyzeInput(current.id);
      return next ? analysisInputIdentity(next) : null;
    },
    articles: [current],
  });
  if (!fallbackInput) throw new Error("当前评测材料的来源许可或完整输入绑定缺失");
  return { input: current, fallbackInput };
}
