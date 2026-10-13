import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
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
  job_id: string | null;
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
    const [source] = await tx<SourceRow[]>`SELECT * FROM sources WHERE id=${sourceId} FOR UPDATE`;
    if (!source) throw new Conflict("请先保存暂停的信源，再请求预览");
    if (source.archived_at) throw new Conflict("信源已归档，不能试抓；如需再次采集请重新添加。");
    let draft: SourceDraft | undefined;
    if (input.config) {
      [draft] = await tx<SourceDraft[]>`SELECT d.* FROM sources.source_config_drafts d
        WHERE d.source_id=${sourceId} AND d.config_hash=${sourcePreviewHash(source.kind, input.config)}
          AND NOT EXISTS(SELECT 1 FROM sources.source_config_activations a WHERE a.draft_id=d.id)
        ORDER BY d.id DESC LIMIT 1`;
      draft ??= await saveSourceDraft(sourceId, source.kind, input.config, actor, tx);
    } else if (input.draft_id)
      [draft] = await tx<SourceDraft[]>`SELECT * FROM sources.source_config_drafts WHERE id=${input.draft_id} AND source_id=${sourceId}`;
    if (input.draft_id && !draft) throw new Conflict("信源草稿不存在");
    const policy = await readCurrentSourcePolicy(sourceId, tx);
    if (!policy) throw new Conflict("信源尚无许可依据");
    const hash = draft?.config_hash ?? sourcePreviewHash(source.kind, source.config);
    const [existing] = await tx<SourcePreview[]>`SELECT * FROM sources.source_previews
      WHERE source_id=${sourceId} AND config_hash=${hash} AND permission_version=${policy.permission_version}
        AND draft_id IS NOT DISTINCT FROM ${draft?.id ?? null}::bigint
        AND (status IN ('queued','running') OR created_at > now()-interval '1 minute') ORDER BY id DESC LIMIT 1`;
    if (existing)
      return {
        preview_id: existing.id,
        job_id: existing.job_id,
        status: existing.status,
        ms: existing.result?.ms ?? 0,
        count: existing.result?.count ?? 0,
        items: existing.result?.items ?? [],
      };
    const [preview] = await tx<{ id: number }[]>`INSERT INTO sources.source_previews(source_id,draft_id,config_hash,permission_version,actor)
      VALUES(${sourceId},${draft?.id ?? null},${hash},${policy.permission_version},${actor}) RETURNING id`;
    const jobId = options.inline
      ? null
      : await enqueue(SOURCE_PREVIEW_QUEUE, { previewId: String(preview!.id), lane: source.lane }, { singletonKey: String(preview!.id) }, tx);
    await tx`UPDATE sources.source_previews SET job_id=${jobId} WHERE id=${preview!.id}`;
    return { preview_id: preview!.id, job_id: jobId, status: options.inline ? "prepared" : "queued", ms: 0, count: 0, items: [] };
  });
}
/** Worker-only: HTTP never fetches a preview. Saving success cannot authorize a changed config or licence. */
export async function runSourcePreview(previewId: string, fetchPreview: typeof previewSource = previewSource, options: { timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? 90_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90_000) throw new Error("Preview timeout must be within 90 seconds");
  const token = randomUUID();
  const [preview] = await sql<SourcePreview[]>`UPDATE sources.source_previews
    SET status='running',execution_token=${token},started_at=now(),lease_until=now()+interval '120 seconds'
    WHERE id=${previewId} AND (status='queued' OR (status='running' AND (lease_until IS NULL OR lease_until<=now()))) RETURNING *`;
  if (!preview) {
    const [current] = await sql<SourcePreview[]>`SELECT * FROM sources.source_previews WHERE id=${previewId}`;
    if (!current) throw new Conflict("预览任务不存在");
    if (current.status === "succeeded") return current.result;
    if (current.status === "failed") throw new Conflict("该预览已结束，请重新试抓。");
    throw new Conflict("该预览正在执行，请读取原任务结果。");
  }
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await executeSourcePreview(preview, token, signal, fetchPreview);
  } catch (error) {
    await sql`UPDATE sources.source_previews SET status='failed',error=${String(error).slice(0, 400)},completed_at=now(),execution_token=NULL,lease_until=NULL
      WHERE id=${previewId} AND execution_token=${token} AND status='running' AND lease_until>now()`;
    throw error;
  }
}
async function executeSourcePreview(preview: SourcePreview, token: string, signal: AbortSignal, fetchPreview: typeof previewSource) {
  const previewId = preview.id;
  const [source] = await sql<SourceRow[]>`SELECT * FROM sources WHERE id=${preview.source_id}`;
  if (!source) throw new Conflict("信源不存在");
  if (source.archived_at) throw new Conflict("信源已归档，预览已失效。");
  const [draft] = preview.draft_id ? await sql<SourceDraft[]>`SELECT * FROM sources.source_config_drafts WHERE id=${preview.draft_id}` : [];
  const config = (draft?.config ?? source.config) as Record<string, unknown>;
  const kind = (draft?.kind ?? source.kind) as SourceRow["kind"];
  const check = async () => {
    signal.throwIfAborted();
    const [state] = await sql<{ archived_at: Date | null }[]>`SELECT s.archived_at FROM sources s
        JOIN sources.source_previews p ON p.source_id=s.id WHERE p.id=${previewId} AND p.execution_token=${token}
        AND p.status='running' AND p.lease_until>now()`;
    if (!state || state.archived_at) throw new Conflict("预览执行已失效或信源已归档。");
    const policy = await readCurrentSourcePolicy(source.id);
    if (!policy || policy.permission_version !== preview.permission_version) throw new Conflict("预览期间许可已变更");
    const url = String(config.url ?? config.feedUrl ?? config.listUrl ?? config.endpoint ?? "").replace(/^https:\/\/r\.jina\.ai\//, "");
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
    signal.throwIfAborted();
  };
  await check();
  const work = fetchPreview({ ...source, kind, config, collectionSignal: signal, collectionReadKey: `preview:${previewId}` });
  let listener: Disposable | undefined;
  const result = await Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      listener = addAbortListener(signal, () => reject(signal.reason));
    }),
  ]).finally(() => listener?.[Symbol.dispose]());
  await check();
  if ("status" in result && result.status === "deferred") throw new Conflict(`预览待重试：${result.reason}`);
  if (result.count < 1) throw new Conflict("预览未取得有效样例，不能据此启用");
  const [saved] =
    await sql`UPDATE sources.source_previews SET status='succeeded',result=${sql.json(result as never)},error=NULL,completed_at=now(),execution_token=NULL,lease_until=NULL
      WHERE id=${previewId} AND execution_token=${token} AND status='running' AND lease_until>now() RETURNING id`;
  if (!saved) throw new Conflict("预览执行已失效，旧结果不再保存。");
  return result;
}
/** Worker recovery: expired executions are fenced and requeued atomically, including after process death. */
export async function recoverSourcePreviews(limit = 100): Promise<{ reenqueued: number }> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: number; lane: string; archived_at: Date | null }[]>`SELECT p.id,s.lane,s.archived_at
      FROM sources.source_previews p JOIN sources s ON s.id=p.source_id
      WHERE p.status='running' AND (p.lease_until IS NULL OR p.lease_until<=now())
      ORDER BY p.id LIMIT ${Math.min(100, Math.max(1, limit))} FOR UPDATE OF p SKIP LOCKED`;
    let reenqueued = 0;
    for (const row of rows) {
      if (row.archived_at) {
        await tx`UPDATE sources.source_previews SET status='failed',error='信源已归档，预览已失效。',completed_at=now(),execution_token=NULL,lease_until=NULL WHERE id=${row.id}`;
        continue;
      }
      const jobId = await enqueue(
        SOURCE_PREVIEW_QUEUE,
        { previewId: String(row.id), lane: row.lane },
        { singletonKey: `recover:${row.id}:${randomUUID()}` },
        tx,
      );
      await tx`UPDATE sources.source_previews SET status='queued',execution_token=NULL,lease_until=NULL,job_id=${jobId},error='上次试抓中断，已重新安排。' WHERE id=${row.id}`;
      reenqueued++;
    }
    return { reenqueued };
  });
}
export async function requireSuccessfulSourcePreview(source: Pick<SourceRow, "id" | "kind" | "config">, db: Db, previewId?: number) {
  const [state] = await db<{ archived_at: Date | null }[]>`SELECT archived_at FROM sources WHERE id=${source.id}`;
  if (!state || state.archived_at) throw new Conflict("信源已归档，预览已失效。");
  const policy = await readCurrentSourcePolicy(source.id, db);
  const [preview] = await db<SourcePreview[]>`SELECT * FROM sources.source_previews WHERE source_id=${source.id} AND status='succeeded'
    AND config_hash=${sourcePreviewHash(source.kind, source.config)} AND permission_version=${policy?.permission_version ?? -1}
    AND completed_at > now()-interval '24 hours' AND completed_at <= now()
    AND (${previewId ?? null}::bigint IS NULL OR id=${previewId ?? null}) ORDER BY id DESC LIMIT 1`;
  if (!preview) throw new Conflict("须先成功预览当前配置与许可（有效期24小时），再启用或切换信源");
  return preview;
}
