import { storeEmbeddingBatch } from "../events/embedding-store.ts";
import { runtimeControlSnapshot, type RuntimeControlSnapshot } from "../operations/lane-controls.ts";
// Text embeddings through receipts, used only for the event grouping's candidate recall. Any
// OpenAI-compatible /embeddings endpoint (EMBEDDING_BASE_URL, EMBEDDING_API_KEY, EMBEDDING_MODEL);
// with a DashScope key and nothing else set, Aliyun text-embedding-v4 at 1024 dimensions. Without
// either, recall falls back to the other signal (the same address).
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { paidRequest, ProviderRejectedError } from "./receipts.ts";
import { newsMaterialBindings } from "@amp/backend/content/materials";
import { readCurrentSourcePolicy, evaluateSourcePolicy } from "@amp/backend/admin/sources";
import { shutdownSignal } from "../jobs/queue.ts";
import { prepareNewsFallback } from "./news-fallback.ts";
import type { FallbackPermitPort } from "./model-fallback-permit.ts";

const own = !!credential("models", "EMBEDDING_API_KEY");
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || (own ? "text-embedding-3-small" : "text-embedding-v4");
/** Requested dimensions, when the provider takes the parameter (0 leaves it to the model). */
export const EMBEDDING_DIMS = Number(process.env.EMBEDDING_DIMS ?? (own ? 0 : 1024));
const SERVICE = own ? "embedding" : "dashscope";

// Recall reads fresh fact/story titles on every call, so the full text hash also invalidates this
// cache when either title changes. Keep enough entries for the 4,000-fact recall window, not the
// unbounded article history. Expiry also picks up a stored-vector repair with an unchanged hash.
const FACT_CACHE_LIMIT = 4096;
const FACT_CACHE_TTL_MS = 5 * 60_000;
const factVectors = new Map<string, { textHash: string; vector: number[]; expiresAt: number }>();

function cacheFact(id: string, textHash: string, vector: number[]) {
  factVectors.delete(id);
  factVectors.set(id, { textHash, vector, expiresAt: Date.now() + FACT_CACHE_TTL_MS });
  if (factVectors.size > FACT_CACHE_LIMIT) factVectors.delete(factVectors.keys().next().value!);
}

/** Embeddings are paid model calls: MODEL_CALLS_ENABLED=false switches them off like every other call. */
export function embeddingsAvailable(): boolean {
  return (
    config.modelCallsEnabled &&
    !!(credential("models", "EMBEDDING_API_KEY") ?? credential("models", "DASHSCOPE_API_KEY")) &&
    process.env.EMBEDDINGS_ENABLED !== "false"
  );
}

type EmbeddingItem = { id: string; text: string };
async function permittedItems(kind: string, items: EmbeddingItem[]) {
  // Old fact/story vectors can be read locally, but new external work requires actual material identities.
  if (kind !== "article") return [];
  const materials = await newsMaterialBindings(items.map((item) => item.id));
  const allowed: Array<EmbeddingItem & { revision: number }> = [];
  for (const item of items) {
    const material = materials.find((row) => row.id === item.id);
    if (!material?.content_hash) continue;
    const policy = await readCurrentSourcePolicy(material.source_id);
    if (!policy) continue;
    const decision = await evaluateSourcePolicy({
      source_id: material.source_id,
      lane: "news",
      capability: "external_model",
      expected_permission_version: policy.permission_version,
      resource: { url: material.url, document_type: null, attachment: false },
    });
    if (decision.decision === "allow") allowed.push({ ...item, revision: material.revision });
  }
  return allowed;
}

async function embedBatch(texts: string[], subject: string, runtimeControl: RuntimeControlSnapshot, input: FallbackPermitPort): Promise<number[][]> {
  if (!config.modelCallsEnabled) throw new Error("Model calls are disabled (MODEL_CALLS_ENABLED=false)");
  const base = own
    ? (credential("models", "EMBEDDING_BASE_URL") ?? "https://api.openai.com/v1")
    : (credential("models", "DASHSCOPE_BASE_URL") ?? "https://dashscope.aliyuncs.com/compatible-mode/v1");
  const key = own ? credential("models", "EMBEDDING_API_KEY") : credential("models", "DASHSCOPE_API_KEY");
  if (!key) throw new Error("EMBEDDING_API_KEY (or DASHSCOPE_API_KEY) missing");
  const configurationHash = sha256(JSON.stringify([SERVICE, base, EMBEDDING_MODEL, EMBEDDING_DIMS, sha256(key)]));
  const permit = await input.authorize({ modelKey: `${SERVICE}:${EMBEDDING_MODEL}`, configurationHash });
  try {
    await permit.beforeRequest();
    const receipt = await paidRequest(
      {
        service: SERVICE,
        costBounds: { input_tokens: texts.reduce((n, t) => n + Buffer.byteLength(t), 0), output_tokens: 0 },
        model: EMBEDDING_MODEL,
        purpose: "embedding",
        runtimeControl,
        usageContext: { lane: "news", capability: "embedding", sourceIds: [...input.sourceIds], object: null },
        subject,
        identity: { model: EMBEDDING_MODEL, dims: EMBEDDING_DIMS, texts: texts.map((t) => sha256(t)) },
        requestSummary: { count: texts.length, sourceIds: [...input.sourceIds], configurationHash },
      },
      async () => {
        await permit.beforeRequest();
        const res = await fetch(`${base.replace(/\/$/, "")}/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: EMBEDDING_MODEL,
            input: texts,
            ...(EMBEDDING_DIMS > 0 ? { dimensions: EMBEDDING_DIMS } : {}),
            encoding_format: "float",
          }),
          signal: AbortSignal.timeout(60_000),
        });
        const text = await res.text();
        if (!res.ok)
          throw new ProviderRejectedError(`embeddings HTTP ${res.status}: ${text.slice(0, 200)}`, res.status, res.status === 429 || res.status >= 500);
        const json = JSON.parse(text) as { data: Array<{ embedding: number[]; index: number }>; usage?: Record<string, unknown> };
        return { response: json, usage: json.usage ?? null, cost: null };
      },
    );
    await (permit.afterResponse ?? permit.beforeRequest)();
    const data = (receipt.response as { data: Array<{ embedding: number[]; index: number }> }).data;
    return [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  } finally {
    permit.close();
  }
}

/** Returns stored embeddings, computing and storing the missing ones. */
export async function ensureEmbeddings(kind: "fact" | "article" | "story", items: Array<{ id: string; text: string }>): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (items.length === 0) return out;
  const hashes = new Map(items.map((item) => [item.id, sha256(item.text)]));
  const now = Date.now();
  const uncached = items.filter((item) => {
    const hit = kind === "fact" ? factVectors.get(item.id) : undefined;
    if (!hit) return true;
    if (hit.textHash !== hashes.get(item.id) || hit.expiresAt <= now) {
      factVectors.delete(item.id);
      return true;
    }
    // Refresh recency, but not expiry: repeated access must not conceal a stored-vector repair.
    factVectors.delete(item.id);
    factVectors.set(item.id, hit);
    out.set(item.id, hit.vector);
    return false;
  });
  const rows = uncached.length
    ? await sql<{ ref_id: string; text_hash: string; vector: number[] }[]>`
    SELECT ref_id, text_hash, vector FROM embeddings WHERE kind = ${kind} AND model = ${EMBEDDING_MODEL} AND ref_id IN ${sql(uncached.map((i) => i.id))}`
    : [];
  const have = new Map(rows.map((r) => [r.ref_id, r]));
  const missing = uncached.filter((i) => {
    const h = have.get(i.id);
    if (h && h.text_hash === hashes.get(i.id)) {
      out.set(i.id, h.vector);
      if (kind === "fact") cacheFact(i.id, h.text_hash, h.vector);
      return false;
    }
    return true;
  });
  const runtimeControl = missing.length ? await runtimeControlSnapshot("news", ["processing"]) : null;
  for (let i = 0; i < missing.length; i += 10) {
    const batch = await permittedItems(kind, missing.slice(i, i + 10));
    if (!batch.length) continue;
    const texts = batch.map((item) => item.text.slice(0, 2000));
    const prepared = await prepareNewsFallback({
      root: shutdownSignal.signal,
      expected: texts,
      current: async () => texts,
      articles: batch.map(({ id, revision }) => ({ id, revision })),
    });
    if (!prepared) continue;
    const vectors = await embedBatch(texts, `${kind}:${batch[0]!.id}`, runtimeControl!, prepared({ system: "", user: texts }));
    await storeEmbeddingBatch(
      kind,
      EMBEDDING_MODEL,
      batch.map((item, index) => ({ id: item.id, textHash: hashes.get(item.id)!, vector: vectors[index]! })),
      runtimeControl!,
      batch.map(({ id, revision }) => ({ id, revision })),
    );
    for (const [index, item] of batch.entries()) out.set(item.id, vectors[index]!);
  }
  return out;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
