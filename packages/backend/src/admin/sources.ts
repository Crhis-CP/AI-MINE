// Source administration (F18): list, detail, preview (fetch without storing), edit, create with
// duplicate checks, pause/resume and manual collection. Every change is audited.
import { z } from "zod";
import { dbOf, type Db, type Tx } from "../db.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { enqueueSourceFetch } from "../jobs/source-queues.ts";
import { republishKey } from "../jobs/publication.ts";
import { normalizeUrl } from "../lib/url.ts";
import { fetchJsonList } from "../sources/json-list.ts";
import { fetchRss } from "../sources/rss.ts";
import { assertSupportedConfig, sourceDateConfigHash } from "../sources/config-keys.ts";
import type { SourceRow } from "../sources/types.ts";
import { fetchWebList } from "../sources/web-list.ts";
import { audit } from "./auth.ts";
const sql = dbOf("sources");

export class Conflict extends Error {
  code = "conflict";
}

export interface SourceListFilters {
  q?: string;
  kind?: string;
  health?: string;
  enabled?: "true" | "false";
  mode?: string;
  page?: number;
}

export async function listSources(f: SourceListFilters) {
  const page = Math.max(1, f.page ?? 1);
  const q = f.q?.trim() ? `%${f.q.trim()}%` : null;
  const rows = await sql`
    SELECT s.id, s.name, s.kind, s.tier, s.participation_mode, s.enabled, s.health, s.fail_count, s.interval_minutes,
           s.last_ok_at, s.last_fetch_at, s.last_error, s.first_party, s.next_fetch_at,
           (SELECT count(*)::int FROM articles a WHERE a.source_id = s.id AND a.discovered_at > now() - interval '7 days') AS items_7d,
           (SELECT count(*)::int FROM publications p WHERE p.source_id = s.id AND p.selected AND p.discovered_at > now() - interval '30 days') AS selected_30d
    FROM sources s
    WHERE (${q}::text IS NULL OR s.name ILIKE ${q} OR s.id ILIKE ${q} OR s.config::text ILIKE ${q})
      AND (${f.kind ?? null}::text IS NULL OR s.kind = ${f.kind ?? null})
      AND (${f.health ?? null}::text IS NULL OR s.health = ${f.health ?? null})
      AND (${f.mode ?? null}::text IS NULL OR s.participation_mode = ${f.mode ?? null})
      AND (${f.enabled ?? null}::text IS NULL OR s.enabled = (${f.enabled ?? null} = 'true'))
    ORDER BY s.enabled DESC, CASE s.health WHEN 'failing' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END, s.name
    LIMIT 100 OFFSET ${(page - 1) * 100}`;
  const [totals] = await sql<{ total: number; enabled: number; failing: number; degraded: number }[]>`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE enabled)::int AS enabled,
           count(*) FILTER (WHERE health = 'failing')::int AS failing, count(*) FILTER (WHERE health = 'degraded')::int AS degraded
    FROM sources`;
  return { page, rows, totals };
}

export async function sourceDetail(id: string) {
  const [source] = await sql`SELECT * FROM sources WHERE id = ${id}`;
  if (!source) return null;
  const runs =
    await sql`SELECT id, started_at, finished_at, status, found_count, new_count, error, detail FROM fetch_runs WHERE source_id = ${id} ORDER BY started_at DESC LIMIT 30`;
  const items = await sql`
    SELECT a.id, a.title, a.url, a.discovered_at, a.published_at, a.processing_state, p.selected, p.visibility, p.title AS title_zh
    FROM articles a LEFT JOIN publications p ON p.article_id = a.id WHERE a.source_id = ${id} ORDER BY a.discovered_at DESC LIMIT 30`;
  const [stats] = await sql`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE a.discovered_at > now() - interval '7 days')::int AS last7d,
           (SELECT count(*)::int FROM publications p WHERE p.source_id = ${id} AND p.selected) AS selected
    FROM articles a WHERE a.source_id = ${id}`;
  const history =
    await sql`SELECT created_at, actor, action, reason, before, after FROM audit_log WHERE subject = ${`source:${id}`} ORDER BY created_at DESC LIMIT 20`;
  const [republish] = await sql<{ value: Record<string, unknown> }[]>`SELECT value FROM settings WHERE key = ${republishKey(id)}`;
  return { source, permission: await readCurrentSourcePolicy(id), runs, items, stats, history, republish: republish?.value ?? null };
}

/** Fetches a source (saved or draft) and returns what it would collect, without storing anything. */
export async function previewSource(draft: Pick<SourceRow, "id" | "kind" | "config"> & Partial<SourceRow>) {
  const source = { name: draft.id, enabled: true, cursor: null, tier: "T2", participation_mode: "editorial", ...draft } as SourceRow;
  assertSupportedConfig(source.kind, source.config);
  const started = Date.now();
  let candidates;
  if (source.kind === "rss") candidates = (await fetchRss(source, { force: true })).candidates;
  else if (source.kind === "web_list") candidates = await fetchWebList(source);
  else if (source.kind === "json_list") candidates = await fetchJsonList(source);
  else throw new Error(`preview is not available for ${source.kind} sources`);
  return {
    ms: Date.now() - started,
    count: candidates.length,
    items: candidates
      .slice(0, 20)
      .map((c) => ({ title: c.title, url: c.url, publishedAt: c.publishedAt?.toISOString() ?? null, excerpt: (c.excerpt ?? c.bodyText ?? "").slice(0, 200) })),
  };
}

const EDITABLE = z
  .object({
    name: z.string().min(1).max(200),
    enabled: z.boolean(),
    interval_minutes: z.number().int().min(1).max(1440),
    tier: z.enum(["T1", "T1_5", "T2", "EXCLUDE_MP"]),
    participation_mode: z.enum(["editorial", "hot_signal", "isolated"]),
    first_party: z.boolean(),
    owner_entity_id: z.string().max(120).nullable(),
    site_fulltext: z.boolean(),
    syndicate_fulltext: z.boolean(),
    tags: z.array(z.string().max(60)).max(30),
    config: z.record(z.string(), z.unknown()),
  })
  .partial()
  .strict();

export async function updateSource(id: string, input: { patch: unknown; version: string; reason?: string }, actor: string) {
  const patch = EDITABLE.parse(input.patch);
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(23621, hashtext(${id}))`;
    const [before] = await tx`SELECT * FROM sources WHERE id = ${id} FOR UPDATE`;
    if (!before) return null;
    if (new Date(before.updated_at as Date).toISOString() !== input.version) throw new Conflict("信源已被其他操作修改，请刷新后再改");
    if (patch.config) assertSupportedConfig(before.kind as SourceRow["kind"], patch.config);
    if (patch.site_fulltext === true) {
      const current = await readCurrentSourcePolicy(id, tx);
      if (current?.permissions.public_original_fulltext !== "allow" || current?.permissions.public_translation !== "allow")
        throw new Conflict("当前全文用途仍被禁止、未知或尚无许可记录；重新勾选旧开关不能恢复，须正式编辑权限并填写依据");
    }
    const keys = Object.keys(patch) as Array<keyof typeof patch>;
    if (!keys.length) return before;
    if (keys.some((key) => patch[key] === undefined)) throw new Error("Undefined source values are not allowed");
    const [after] = await tx`UPDATE sources SET
      name = CASE WHEN ${Object.hasOwn(patch, "name")} THEN ${patch.name ?? null} ELSE name END,
      enabled = CASE WHEN ${Object.hasOwn(patch, "enabled")} THEN ${patch.enabled ?? null} ELSE enabled END,
      interval_minutes = CASE WHEN ${Object.hasOwn(patch, "interval_minutes")} THEN ${patch.interval_minutes ?? null} ELSE interval_minutes END,
      tier = CASE WHEN ${Object.hasOwn(patch, "tier")} THEN ${patch.tier ?? null} ELSE tier END,
      participation_mode = CASE WHEN ${Object.hasOwn(patch, "participation_mode")} THEN ${patch.participation_mode ?? null} ELSE participation_mode END,
      first_party = CASE WHEN ${Object.hasOwn(patch, "first_party")} THEN ${patch.first_party ?? null} ELSE first_party END,
      owner_entity_id = CASE WHEN ${Object.hasOwn(patch, "owner_entity_id")} THEN ${patch.owner_entity_id ?? null} ELSE owner_entity_id END,
      site_fulltext = CASE WHEN ${Object.hasOwn(patch, "site_fulltext")} THEN ${patch.site_fulltext ?? null} ELSE site_fulltext END,
      syndicate_fulltext = CASE WHEN ${Object.hasOwn(patch, "syndicate_fulltext")} THEN ${patch.syndicate_fulltext ?? null} ELSE syndicate_fulltext END,
      tags = CASE WHEN ${Object.hasOwn(patch, "tags")} THEN ${patch.tags ?? null}::text[] ELSE tags END,
      config = CASE WHEN ${Object.hasOwn(patch, "config")} THEN ${patch.config === undefined ? null : tx.json(patch.config as never)} ELSE config END,
      source_date_config_hash = CASE WHEN ${Object.hasOwn(patch, "config")} THEN ${patch.config ? sourceDateConfigHash(before.kind as SourceRow["kind"], patch.config) : null} ELSE source_date_config_hash END,
      updated_at = now(),
      health = CASE WHEN ${patch.enabled ?? null}::boolean IS FALSE THEN 'paused' WHEN ${patch.enabled ?? null}::boolean IS TRUE AND health = 'paused' THEN 'unknown' ELSE health END,
      next_fetch_at = CASE WHEN ${patch.enabled ?? null}::boolean IS TRUE THEN now() ELSE next_fetch_at END
      WHERE id = ${id} RETURNING *`;
    if (patch.site_fulltext === false) {
      const current = await readCurrentSourcePolicy(id, tx);
      if (current && (current.permissions.public_original_fulltext !== "deny" || current.permissions.public_translation !== "deny"))
        await appendSourcePolicy(tx, current.permission_version, {
          ...current,
          permission_version: current.permission_version + 1,
          reviewed_by: actor,
          reviewed_at: new Date().toISOString(),
          permissions: { ...current.permissions, public_original_fulltext: "deny", public_translation: "deny" },
          evidence: [
            ...current.evidence,
            {
              kind: "owner_instruction",
              url: null,
              checked_at: new Date().toISOString(),
              valid_until: null,
              basis_zh: input.reason?.trim() || "负责人关闭站内全文展示",
              capabilities: ["public_original_fulltext", "public_translation"],
              scope: current.scope,
            },
          ],
        });
    }
    await audit(actor, "source.update", `source:${id}`, input.reason ?? null, Object.fromEntries(keys.map((k) => [k, before[k]])), patch, undefined, tx);
    // What public exits show for this source's articles is derived from these fields: re-derive them
    // all (in the worker) so a revoked licence or an isolated source stops on every exit.
    if (keys.some((k) => PUBLICATION_FIELDS.includes(k) && JSON.stringify(before[k]) !== JSON.stringify(patch[k]))) {
      await tx`INSERT INTO settings (key, value, updated_by) VALUES (${republishKey(id)}, ${tx.json({ status: "queued", queuedAt: new Date().toISOString() })}, ${actor})
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      await enqueue(QUEUES.republishSource, { sourceId: id }, { singletonKey: id }, tx);
    }
    return after;
  });
}

/** Source fields the public projection reads (publication/rules.ts and the v1 payload). */
const PUBLICATION_FIELDS: string[] = ["participation_mode", "site_fulltext", "syndicate_fulltext", "tier", "name", "first_party"];

/** The address a source collects from, used to find duplicates before creating one. */
export function sourceIdentity(config: Record<string, unknown>): string | null {
  const raw = (config.feedUrl ?? config.url ?? config.listUrl ?? config.endpoint ?? null) as string | null;
  if (!raw) return null;
  try {
    return normalizeUrl(String(raw).replace(/^https:\/\/r\.jina\.ai\//, "")) ?? String(raw);
  } catch {
    return String(raw);
  }
}

export async function findDuplicateSource(kind: string, config: Record<string, unknown>, db: Db = sql) {
  const identity = sourceIdentity(config);
  if (!identity) return null;
  const rows = await db<
    { id: string; kind: string; config: Record<string, unknown>; name: string }[]
  >`SELECT id, kind, config, name FROM sources WHERE kind = ${kind}`;
  return rows.find((r) => sourceIdentity(r.config) === identity) ?? null;
}

/** Validate a complete seed batch before any source is created, using the same rules as the HTTP entry. */
export function validateSourceCreate(input: unknown) {
  const source = SourceCreateRequest.parse(input);
  assertSupportedConfig(source.kind, source.config);
  return source;
}

export async function createSource(input: unknown, actor: string, opts: { lane?: "news" | "policy" } = {}) {
  const lane = opts.lane ?? "news";
  if (lane !== "news" && lane !== "policy") throw new Error("业务线必须是 news 或 policy");
  const s = validateSourceCreate(input);
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(23622, hashtext(${s.kind + ":" + (sourceIdentity(s.config) ?? s.id)}))`;
    const dup = await findDuplicateSource(s.kind, s.config, tx);
    if (dup) return { created: false as const, duplicate: dup };
    await tx`SELECT pg_advisory_xact_lock(23621, hashtext(${s.id}))`;
    const [row] = await tx`
      INSERT INTO sources (id,name,kind,config,tier,participation_mode,interval_minutes,first_party,tags,site_fulltext,syndicate_fulltext,enabled,health,next_fetch_at,source_date_config_hash,lane)
      VALUES (${s.id},${s.name},${s.kind},${tx.json(s.config as never)},${s.tier},${s.participation_mode},${s.interval_minutes},${s.first_party},${s.tags},
        ${s.site_fulltext},${s.syndicate_fulltext},false,'paused',NULL,${sourceDateConfigHash(s.kind, s.config)},${lane}) ON CONFLICT (id) DO NOTHING RETURNING *`;
    if (!row) throw new Conflict(`信源 ID ${s.id} 已存在`);
    const at = new Date().toISOString();
    const permission = SourcePolicySchema.parse({
      source_id: s.id,
      permission_version: 1,
      permissions: Object.fromEntries(
        SOURCE_PURPOSES.map((purpose) => [
          purpose,
          !s.site_fulltext && (purpose === "public_original_fulltext" || purpose === "public_translation") ? "deny" : "allow",
        ]),
      ),
      evidence: [
        {
          kind: "owner_declared",
          url: null,
          checked_at: at,
          valid_until: null,
          basis_zh: "Owner 2026-10-01书面答复",
          capabilities: [...SOURCE_PURPOSES],
          scope: s.permission_scope,
        },
      ],
      scope: s.permission_scope,
      conditions: [],
      attachments_in_scope: s.attachments_in_scope,
      reviewed_by: actor,
      reviewed_at: at,
      expires_at: null,
      licence_label_zh: "负责人声明许可；来源异议或指示可逐项收紧",
    });
    await appendSourcePolicy(tx, null, permission);
    await audit(actor, "source.create", `source:${s.id}`, null, null, { ...s, lane }, undefined, tx);
    return { created: true as const, source: row };
  });
}

export async function fetchNow(id: string, actor: string) {
  const [s] = await sql<{ id: string; kind: string; lane: SourceRow["lane"] }[]>`SELECT id, kind, lane FROM sources WHERE id = ${id}`;
  if (!s) return null;
  const jobId =
    s.kind === "mp_account"
      ? await enqueue(QUEUES.mpCheck, { sourceId: id, reason: "manual" }, { singletonKey: `mp:${id}` })
      : await enqueueSourceFetch(s.lane, { sourceId: id, force: true });
  await audit(actor, "source.fetch", `source:${id}`, null, null, { jobId });
  return { jobId };
}

/** The sources on one business line (ADR-0016), for checks of one line that must not count the other line's material. */
export async function sourceIdsOnLane(lane: SourceRow["lane"]): Promise<string[]> {
  return (await sql<{ id: string }[]>`SELECT id FROM sources WHERE lane = ${lane}`).map((r) => r.id);
}

/** A current acquisition snapshot; it does not itself grant permission or hold a network-time lock. */
export async function readSourceDateContext(sourceId: string): Promise<SourceRow | null> {
  const [source] = await sql<SourceRow[]>`SELECT id, name, kind, config, tier, participation_mode, lane, first_party,
    interval_minutes, enabled, cursor, fail_count FROM sources WHERE id = ${sourceId}`;
  return source ?? null;
}

/** Caller holds the permission lock first. Configuration stays stable until the material commit. */
export async function lockSourceDateConfiguration(tx: Tx, sourceId: string, expectedHash: string): Promise<void> {
  const [source] = await tx<{ enabled: boolean; kind: SourceRow["kind"]; config: Record<string, unknown>; source_date_config_hash: string | null }[]>`
    SELECT enabled, kind, config, source_date_config_hash FROM sources WHERE id = ${sourceId} FOR UPDATE`;
  if (!source?.enabled || sourceDateConfigHash(source.kind, source.config) !== expectedHash) throw new Conflict("Stale source date configuration");
  // Existing sources acquire their deterministic identity without inventing a date or a permission.
  if (source.source_date_config_hash === null) await tx`UPDATE sources SET source_date_config_hash = ${expectedHash} WHERE id = ${sourceId}`;
  else if (source.source_date_config_hash !== expectedHash) throw new Conflict("Stale source date configuration");
}

import { appendSourcePolicy, readCurrentSourcePolicy } from "../sources/permission-store.ts";
import { SOURCE_PURPOSES, SourcePolicySchema } from "@amp/contracts/source-policy";
import { SourceCreateRequest } from "@amp/contracts/http/private";
export {
  readCurrentSourcePolicy,
  readCurrentPublicPolicy,
  publicProcessingAllowed,
  lockCurrentSourcePolicies,
  evaluateSourcePolicy,
} from "../sources/permission-store.ts";
export { parseSourceDate } from "../sources/date-extraction.ts";

/** Explicit permission edit; no HTTP caller is activated by this storage capability. */
export async function saveSourcePolicy(id: string, input: { policy: Record<string, unknown>; expectedVersion: number | null; reason: string }, actor: string) {
  if (!actor.trim() || !input.reason.trim()) throw new Error("Permission editor and reason are required");
  return sql.begin(async (tx) => {
    const change = await appendSourcePolicy(tx, input.expectedVersion, {
      ...input.policy,
      source_id: id,
      permission_version: (input.expectedVersion ?? 0) + 1,
      reviewed_by: actor,
      reviewed_at: new Date().toISOString(),
    });
    await audit(actor, "source.permission", `source:${id}`, input.reason, change.before, change.after, undefined, tx);
    return change.after;
  });
}

import { stableJson } from "../lib/ids.ts";

/** A policy observation is accepted only against the still-current explicit source configuration. */
export async function lockPolicySourceConfiguration(tx: Tx, expected: Pick<SourceRow, "id" | "kind" | "config">) {
  const [row] = await tx`SELECT kind,config,lane,enabled FROM sources WHERE id=${expected.id} FOR SHARE`;
  if (!row || row.lane !== "policy" || !row.enabled || row.kind !== expected.kind || stableJson(row.config) !== stableJson(expected.config))
    throw new Error("Policy source configuration changed or paused");
}
