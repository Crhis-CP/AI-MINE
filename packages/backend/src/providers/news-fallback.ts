import { databaseLifetimeSignal, sql, type Db, type Tx } from "../db.ts";
import { newsMaterialBindings, readCurrentBody } from "@amp/backend/content/materials";
import { readCurrentSourcePolicy, lockCurrentSourcePolicies, evaluateSourcePolicy } from "@amp/backend/admin/sources";
import { sha256, stableJson } from "../lib/ids.ts";
import { createFallbackPermitPort, type FallbackMaterialSnapshot, type FallbackPermitPort } from "./model-fallback-permit.ts";
import { originalPostInputBlocked } from "../lib/original-post-admission.ts";

type Material = Awaited<ReturnType<typeof newsMaterialBindings>>[number];
type Ports = {
  materials: typeof newsMaterialBindings;
  permissionVersion(sourceId: string): Promise<number | null>;
};
const defaultPorts: Ports = {
  materials: newsMaterialBindings,
  permissionVersion: async (id) => (await readCurrentSourcePolicy(id))?.permission_version ?? null,
};
export type NewsFallbackInput = (request: { system: string; user: unknown }) => FallbackPermitPort;

/** Quote resources retain the parent's material identity but need their own current URL permission. */
async function quotedResources(materials: Material[], db: Db = sql, checkAdmission = false) {
  const resources: { id: string; sourceId: string; revision: number; url: string }[] = [];
  for (const material of materials) {
    const body = await readCurrentBody(material.id, db);
    if (!body || body.revision !== material.revision || body.source_id !== material.source_id) throw new Error("新闻引用材料修订未证明");
    // Canonical stored body includes an actually acquired long article; quote text is stored separately.
    if (checkAdmission && body.x_post && originalPostInputBlocked({ text: body.body_text ?? body.x_post.text }))
      throw new Error("原帖新增准入尚未开启，等待可用正文");
    const quote = body.x_post?.quoted;
    if (quote) {
      if (!quote.url) throw new Error("新闻引用材料URL缺失");
      resources.push({ id: material.id, sourceId: material.source_id, revision: material.revision, url: quote.url });
    }
  }
  return resources;
}
/** Prepared before the primary call. A later failure can only use this same input, never a new read substituted for it. */
export async function prepareNewsFallback<T>(
  input: {
    root: AbortSignal;
    expected: T;
    current(): Promise<T | null>;
    articles: { id: string; revision: number }[];
    /** Strict body translation consumes only its HTML, never the separately stored quote. */
    materialScope?: "body";
  },
  ports: Ports = defaultPorts,
): Promise<NewsFallbackInput | undefined> {
  const ids = [...new Set(input.articles.map((a) => a.id))].sort();
  if (!ids.length || ids.length !== input.articles.length) return undefined;
  const expected = stableJson(input.expected);
  const read = async () => {
    const value = await input.current();
    const materials = await ports.materials(ids);
    if (value === null || stableJson(value) !== expected || materials.length !== ids.length) throw new Error("新闻备用输入已变化或缺失");
    for (const m of materials) {
      if (!m.content_hash || !/^[a-f0-9]{64}$/.test(m.content_hash) || !input.articles.some((a) => a.id === m.id && a.revision === m.revision))
        throw new Error("新闻备用材料修订未证明");
    }
    const permissions = await Promise.all(
      [...new Set(materials.map((m) => m.source_id))].sort().map(async (id) => {
        const version = await ports.permissionVersion(id);
        if (version === null) throw new Error("新闻备用来源许可缺失");
        return { id, version };
      }),
    );
    const quotes = input.materialScope === "body" ? [] : await quotedResources(materials, sql, true);
    for (const quote of quotes) {
      const decision = await evaluateSourcePolicy({
        source_id: quote.sourceId,
        lane: "news",
        capability: "process_locally",
        expected_permission_version: permissions.find((p) => p.id === quote.sourceId)!.version,
        resource: { url: quote.url, attachment: false, document_type: null },
      });
      if (decision.decision !== "allow") throw new Error("新闻引用材料当前不允许处理");
    }
    // Read again across the independent projection/permission ports, avoiding a mixed initial snapshot.
    if (
      stableJson(await input.current()) !== expected ||
      stableJson(await ports.materials(ids)) !== stableJson(materials) ||
      (input.materialScope !== "body" && stableJson(await quotedResources(materials, sql, true)) !== stableJson(quotes))
    )
      throw new Error("新闻备用输入读取期间已变化");
    return { value, materials, permissions, ...(quotes.length ? { quotes } : {}) };
  };
  let initial: Awaited<ReturnType<typeof read>>;
  try {
    initial = await read();
  } catch {
    return undefined;
  }
  const snapshot = (state: typeof initial, request: { system: string; user: unknown }): FallbackMaterialSnapshot => ({
    inputFingerprint: sha256(stableJson({ state, request })),
    manifest: {
      schema_version: 1,
      kind: "source_materials",
      lane: "news",
      materials: state.materials.flatMap((m: Material) =>
        [...new Set([m.url, ...(state.quotes ?? []).filter((q) => q.id === m.id).map((q) => q.url)])].map((url) => ({
          source_id: m.source_id,
          material_id: m.id,
          revision: m.revision,
          content_hash: m.content_hash!,
          resource: { url, document_type: null, attachment: false },
        })),
      ),
      upstream_artifacts: [],
    },
  });
  return (request) => {
    // Keep the exact request independent of a caller's later mutation.
    const frozen = JSON.parse(stableJson(request)) as typeof request;
    return createFallbackPermitPort({
      root: databaseLifetimeSignal(),
      stopBeforeSend: input.root,
      snapshot: snapshot(initial, frozen),
      current: async () => snapshot(await read(), frozen),
    });
  };
}

/** Publication of a paid result is fenced against a simultaneous permission edit. Call before taking material locks. */
export async function lockNewsProcessingPermissions(articleIds: string[], tx: Tx, materialScope?: "body") {
  const materials = await newsMaterialBindings(articleIds, tx);
  if (materials.length !== new Set(articleIds).size) throw new Error("新闻写回原材料缺失");
  const policies = await Promise.all(
    [...new Set(materials.map((m) => m.source_id))].sort().map(async (sourceId) => {
      const policy = await readCurrentSourcePolicy(sourceId, tx);
      if (!policy) throw new Error("新闻写回来源许可缺失");
      return { sourceId, permissionVersion: policy.permission_version };
    }),
  );
  await lockCurrentSourcePolicies(tx, policies);
  const quotes = materialScope === "body" ? [] : await quotedResources(materials, tx);
  for (const material of materials)
    for (const url of new Set([material.url, ...quotes.filter((q) => q.id === material.id).map((q) => q.url)]))
      for (const capability of materialScope === "body"
        ? (["external_model", "process_locally", "store_fulltext"] as const)
        : (["external_model", "process_locally"] as const)) {
        const decision = await evaluateSourcePolicy(
          {
            source_id: material.source_id,
            lane: "news",
            capability,
            expected_permission_version: policies.find((p) => p.sourceId === material.source_id)!.permissionVersion,
            resource: { url, attachment: false, document_type: null },
          },
          undefined,
          tx,
        );
        if (decision.decision !== "allow") throw new Error("新闻结果写回前来源许可已收紧");
      }
}
