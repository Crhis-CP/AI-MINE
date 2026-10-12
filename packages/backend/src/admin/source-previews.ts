import { dbOf, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { enqueue } from "../jobs/queue.ts";
import { Conflict, readCurrentSourcePolicy, evaluateSourcePolicy, previewSource } from "./sources.ts";
import { audit } from "./auth.ts";
import type { SourceRow } from "../sources/types.ts";
const sql = dbOf("sources");
type SourceDraft = { id: number; kind: SourceRow["kind"]; config: Record<string, unknown>; config_hash: string };
type SourcePreview = {
  id: number;
  source_id: string;
  draft_id: number | null;
  config_hash: string;
  permission_version: number;
  status: string;
  result: Awaited<ReturnType<typeof previewSource>> | null;
};
export const SOURCE_PREVIEW_QUEUE = "sources.preview";
export const sourcePreviewHash = (kind: string, config: unknown) => sha256(stableJson([kind, config]));
export async function saveSourceDraft(sourceId: string, kind: string, config: Record<string, unknown>, actor: string, db: Db = sql) {
  const [draft] = await db<SourceDraft[]>`INSERT INTO sources.source_config_drafts(source_id,kind,config,config_hash,actor)
    VALUES(${sourceId},${kind},${db.json(config as never)},${sourcePreviewHash(kind, config)},${actor}) RETURNING *`;
  await audit(actor, "source.config.draft", `source:${sourceId}`, null, null, { draft_id: draft!.id }, undefined, db);
  return draft!;
}
export async function sourcePreviewState(sourceId: string) {
  const [draft] =
    await sql`SELECT * FROM sources.source_config_drafts d WHERE source_id=${sourceId} AND NOT EXISTS(SELECT 1 FROM sources.source_config_activations a WHERE a.draft_id=d.id) ORDER BY id DESC LIMIT 1`;
  const previews =
    await sql`SELECT id,draft_id,status,result,error,config_hash,permission_version,created_at,completed_at FROM sources.source_previews WHERE source_id=${sourceId} ORDER BY id DESC LIMIT 10`;
  return { draft: draft ?? null, previews };
}
/** HTTP queues by default; a worker CLI can prepare the same immutable binding for its own immediate execution. */
export async function requestSourcePreview(
  sourceId: string,
  input: { draft_id?: number; config?: Record<string, unknown> },
  actor: string,
  options: { inline?: boolean } = {},
) {
  return sql.begin(async (tx) => {
    const [source] = await tx<SourceRow[]>`SELECT * FROM sources WHERE id=${sourceId} FOR SHARE`;
    if (!source) throw new Conflict("请先保存暂停的信源，再请求预览");
    if (source.archived_at) throw new Conflict("信源已归档，不能试抓；如需再次采集请重新添加。");
    let draft: SourceDraft | undefined;
    if (input.config) draft = await saveSourceDraft(sourceId, source.kind, input.config, actor, tx);
    else if (input.draft_id) [draft] = await tx<SourceDraft[]>`SELECT * FROM sources.source_config_drafts WHERE id=${input.draft_id} AND source_id=${sourceId}`;
    if (input.draft_id && !draft) throw new Conflict("信源草稿不存在");
    const policy = await readCurrentSourcePolicy(sourceId, tx);
    if (!policy) throw new Conflict("信源尚无许可依据");
    const hash = draft?.config_hash ?? sourcePreviewHash(source.kind, source.config);
    const [preview] = await tx<{ id: number }[]>`INSERT INTO sources.source_previews(source_id,draft_id,config_hash,permission_version,actor)
      VALUES(${sourceId},${draft?.id ?? null},${hash},${policy.permission_version},${actor}) RETURNING id`;
    const jobId = options.inline
      ? null
      : await enqueue(SOURCE_PREVIEW_QUEUE, { previewId: String(preview!.id), lane: source.lane }, { singletonKey: String(preview!.id) }, tx);
    return { preview_id: preview!.id, job_id: jobId, status: options.inline ? "prepared" : "queued", ms: 0, count: 0, items: [] };
  });
}
/** Worker-only: HTTP never fetches a preview. Saving success cannot authorize a changed config or licence. */
export async function runSourcePreview(previewId: string, fetchPreview: typeof previewSource = previewSource) {
  const [preview] = await sql<SourcePreview[]>`SELECT * FROM sources.source_previews WHERE id=${previewId}`;
  if (!preview) throw new Conflict("预览任务不存在");
  if (preview.status === "succeeded") return preview.result;
  const [source] = await sql<SourceRow[]>`SELECT * FROM sources WHERE id=${preview.source_id}`;
  if (!source) throw new Conflict("信源不存在");
  if (source.archived_at) throw new Conflict("信源已归档，预览已失效。");
  const [draft] = preview.draft_id ? await sql<SourceDraft[]>`SELECT * FROM sources.source_config_drafts WHERE id=${preview.draft_id}` : [];
  const config = (draft?.config ?? source.config) as Record<string, unknown>;
  const kind = (draft?.kind ?? source.kind) as SourceRow["kind"];
  try {
    const check = async () => {
      const [state] = await sql<{ archived_at: Date | null }[]>`SELECT archived_at FROM sources WHERE id=${source.id}`;
      if (!state || state.archived_at) throw new Conflict("信源已归档，预览已失效。");
      const policy = await readCurrentSourcePolicy(source.id);
      if (!policy || policy.permission_version !== preview.permission_version) throw new Conflict("预览期间许可已变更");
      const url = String(config.url ?? config.feedUrl ?? config.listUrl ?? config.endpoint ?? "");
      for (const capability of ["fetch", "process_locally"] as const) {
        const decision = await evaluateSourcePolicy({
          source_id: source.id,
          lane: source.lane,
          expected_permission_version: policy.permission_version,
          capability,
          resource: { url, attachment: false, document_type: null },
        });
        if (decision.decision !== "allow") throw new Conflict("当前来源许可不允许预览");
      }
      if (!draft) {
        const [current] = await sql`SELECT kind,config FROM sources WHERE id=${source.id}`;
        if (!current || sourcePreviewHash(String(current.kind), current.config) !== preview.config_hash) throw new Conflict("当前配置已变化");
      }
    };
    await check();
    const result = await fetchPreview({ ...source, kind, config });
    await check();
    if ("status" in result && result.status === "deferred") throw new Conflict(`预览待重试：${result.reason}`);
    if (result.count < 1) throw new Conflict("预览未取得有效样例，不能据此启用");
    await sql`UPDATE sources.source_previews SET status='succeeded',result=${sql.json(result as never)},error=NULL,completed_at=now() WHERE id=${previewId}`;
    return result;
  } catch (error) {
    await sql`UPDATE sources.source_previews SET status='failed',error=${String(error).slice(0, 400)},completed_at=now() WHERE id=${previewId}`;
    throw error;
  }
}
export async function requireSuccessfulSourcePreview(source: Pick<SourceRow, "id" | "kind" | "config">, db: Db, previewId?: number) {
  const [state] = await db<{ archived_at: Date | null }[]>`SELECT archived_at FROM sources WHERE id=${source.id}`;
  if (!state || state.archived_at) throw new Conflict("信源已归档，预览已失效。");
  const policy = await readCurrentSourcePolicy(source.id, db);
  const [preview] = await db<SourcePreview[]>`SELECT * FROM sources.source_previews WHERE source_id=${source.id} AND status='succeeded'
    AND config_hash=${sourcePreviewHash(source.kind, source.config)} AND permission_version=${policy?.permission_version ?? -1}
    AND (${previewId ?? null}::bigint IS NULL OR id=${previewId ?? null}) ORDER BY id DESC LIMIT 1`;
  if (!preview) throw new Conflict("须先成功预览当前配置与许可，再启用或切换信源");
  return preview;
}
