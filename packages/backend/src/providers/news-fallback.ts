import { newsMaterialBindings } from "@amp/backend/content/materials";
import { readCurrentSourcePolicy } from "@amp/backend/admin/sources";
import { sha256, stableJson } from "../lib/ids.ts";
import { createFallbackPermitPort, type FallbackMaterialSnapshot, type FallbackPermitPort } from "./model-fallback-permit.ts";

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
/** Prepared before the primary call. A later failure can only use this same input, never a new read substituted for it. */
export async function prepareNewsFallback<T>(
  input: {
    root: AbortSignal;
    expected: T;
    current(): Promise<T | null>;
    articles: { id: string; revision: number }[];
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
    // Read again across the independent projection/permission ports, avoiding a mixed initial snapshot.
    if (stableJson(await input.current()) !== expected || stableJson(await ports.materials(ids)) !== stableJson(materials))
      throw new Error("新闻备用输入读取期间已变化");
    return { value, materials, permissions };
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
      materials: state.materials.map((m: Material) => ({
        source_id: m.source_id,
        material_id: m.id,
        revision: m.revision,
        content_hash: m.content_hash!,
        resource: { url: m.url, document_type: null, attachment: false },
      })),
      upstream_artifacts: [],
    },
  });
  return (request) => {
    // Keep the exact request independent of a caller's later mutation.
    const frozen = JSON.parse(stableJson(request)) as typeof request;
    return createFallbackPermitPort({ root: input.root, snapshot: snapshot(initial, frozen), current: async () => snapshot(await read(), frozen) });
  };
}
