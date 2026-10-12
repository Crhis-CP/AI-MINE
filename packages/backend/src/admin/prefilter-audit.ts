// A small random look at articles the prefilter already judged. Drawing and labeling only write
// these audit tables. They do not publish, withdraw, translate, or change the prefilter rules.
import { randomBytes } from "node:crypto";
import { dbOf, type Db } from "../db.ts";
import { audit, requireOwner, type AdminPrincipal } from "./auth.ts";
import { PrefilterAuditDrawRequest, PrefilterAuditLabel, PrefilterAuditLabelRequest, PrefilterAuditView } from "@amp/contracts/http/private";
import { selectionCommand, SelectionConflict } from "./selectbench-state.ts";

const sql = dbOf("ai-gateway");
export const PREFILTER_AUDIT_BATCH = 20;
/** Agreed takedown: the 16 China Geological Survey pieces stay out of the sample and stay unpublished. */
const EXCLUDED_SOURCES = ["cgs-news"];

export function prefilterAuditTake(size: number, available: { discarded: number; kept: number }) {
  const half = Math.floor(size / 2);
  let discarded = Math.min(half, Math.max(0, available.discarded));
  let kept = Math.min(half, Math.max(0, available.kept));
  let rest = size - discarded - kept;
  const extraDiscarded = Math.min(rest, Math.max(0, available.discarded - discarded));
  discarded += extraDiscarded;
  rest -= extraDiscarded;
  kept += Math.min(rest, Math.max(0, available.kept - kept));
  return { discarded, kept };
}

type PoolRow = { discarded: number; kept: number; unknown: number; excluded: number };
type PickRow = {
  article_id: string;
  analysis_id: number | string;
  title_zh: string | null;
  article_title: string;
  summary_zh: string | null;
  excerpt: string | null;
  body_text: string | null;
  source_name: string;
  discovered_at: Date | null;
};

function clip(value: string | null | undefined, max: number) {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return Array.from(text).slice(0, max).join("");
}

function iso(value: Date | string | null) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function poolCounts(db: Db): Promise<PoolRow> {
  const [row] = await db<PoolRow[]>`
    WITH latest AS (
      SELECT DISTINCT ON (article_id) article_id, relevance
      FROM analyses
      ORDER BY article_id, input_revision DESC, id DESC
    )
    SELECT
      count(*) FILTER (WHERE l.relevance = 'block' AND NOT l.excluded)::int AS discarded,
      count(*) FILTER (WHERE l.relevance = 'pass' AND NOT l.excluded)::int AS kept,
      count(*) FILTER (WHERE l.relevance = 'unknown' AND NOT l.excluded)::int AS unknown,
      count(*) FILTER (WHERE l.relevance IN ('block', 'pass') AND l.excluded)::int AS excluded
    FROM (
      SELECT l.relevance,
             (o.article_id IS NOT NULL OR s.id = ANY(${EXCLUDED_SOURCES})) AS excluded
      FROM latest l
      JOIN articles a ON a.id = l.article_id
      JOIN sources s ON s.id = a.source_id AND s.lane = 'news'
      LEFT JOIN editorial_overrides o ON o.article_id = a.id
        AND (o.visibility = 'withdrawn' OR o.fields->>'relevance' = 'block')
    ) l`;
  return row ?? { discarded: 0, kept: 0, unknown: 0, excluded: 0 };
}

async function pick(db: Db, relevance: "block" | "pass", limit: number, seed: string, previousId: string | null) {
  if (limit <= 0) return [];
  return db<PickRow[]>`
    WITH latest AS (
      SELECT DISTINCT ON (article_id) article_id, id AS analysis_id, relevance, title_zh, summary_zh
      FROM analyses
      ORDER BY article_id, input_revision DESC, id DESC
    )
    SELECT a.id AS article_id, l.analysis_id, l.title_zh, a.title AS article_title,
           l.summary_zh, a.excerpt, a.body_text, s.name AS source_name, a.discovered_at
    FROM latest l
    JOIN articles a ON a.id = l.article_id
    JOIN sources s ON s.id = a.source_id AND s.lane = 'news'
    LEFT JOIN editorial_overrides o ON o.article_id = a.id
      AND (o.visibility = 'withdrawn' OR o.fields->>'relevance' = 'block')
    LEFT JOIN LATERAL (
      SELECT revision FROM ai.prefilter_audit_labels WHERE article_id = a.id ORDER BY revision DESC LIMIT 1
    ) lab ON true
    LEFT JOIN ai.prefilter_audit_items prev ON prev.article_id = a.id AND prev.draw_id = ${previousId}
    WHERE l.relevance = ${relevance}
      AND o.article_id IS NULL
      AND (s.id = ANY(${EXCLUDED_SOURCES})) IS NOT TRUE
    ORDER BY (lab.revision IS NULL AND prev.article_id IS NULL) DESC,
             (lab.revision IS NULL) DESC,
             hashtext(a.id || ${seed}),
             a.id
    LIMIT ${limit}`;
}

async function auditView(db: Db) {
  const pools = await poolCounts(db);
  const [draw] = await db<{ id: string; created_at: Date; discarded_count: number; kept_count: number }[]>`
    SELECT id, created_at, discarded_count, kept_count FROM ai.prefilter_audit_draws ORDER BY created_at DESC, id DESC LIMIT 1`;
  if (!draw)
    return PrefilterAuditView.parse({
      pools: { discarded: pools.discarded, kept: pools.kept, unknown: pools.unknown },
      excluded: pools.excluded,
      batchSize: PREFILTER_AUDIT_BATCH,
      draw: null,
    });
  const rows = await db<
    {
      position: number;
      article_id: string;
      pool: "discarded" | "kept";
      title: string;
      preview: string;
      source_name: string;
      discovered_at: Date | null;
      decision: "should_not_discard" | "should_not_keep" | "agree" | null;
      note: string | null;
      revision: number | null;
      actor: string | null;
      labeled_at: Date | null;
    }[]
  >`
    SELECT i.position, i.article_id, i.pool, i.title, i.preview, i.source_name, i.discovered_at,
           lab.decision, lab.note, lab.revision, lab.actor, lab.created_at AS labeled_at
    FROM ai.prefilter_audit_items i
    LEFT JOIN LATERAL (
      SELECT decision, note, revision, actor, created_at FROM ai.prefilter_audit_labels
      WHERE article_id = i.article_id ORDER BY revision DESC LIMIT 1
    ) lab ON true
    WHERE i.draw_id = ${draw.id}
    ORDER BY i.position`;
  return PrefilterAuditView.parse({
    pools: { discarded: pools.discarded, kept: pools.kept, unknown: pools.unknown },
    excluded: pools.excluded,
    batchSize: PREFILTER_AUDIT_BATCH,
    draw: {
      id: draw.id,
      createdAt: iso(draw.created_at),
      discarded: draw.discarded_count,
      kept: draw.kept_count,
      items: rows.map((row) => ({
        position: row.position,
        articleId: row.article_id,
        pool: row.pool,
        title: row.title,
        preview: row.preview ?? "",
        sourceName: row.source_name,
        discoveredAt: iso(row.discovered_at),
        label: row.revision
          ? {
              decision: row.decision,
              note: row.note ?? "",
              revision: row.revision,
              actor: row.actor,
              at: iso(row.labeled_at),
            }
          : null,
      })),
    },
  });
}

export async function prefilterAuditView(principal: AdminPrincipal) {
  return sql.begin(async (tx) => {
    await requireOwner(principal, tx);
    return auditView(tx);
  });
}

/** Insert one batch. Caller holds the transaction. Does not touch publications, translations, or jobs. */
export async function recordPrefilterAuditDraw(db: Db, actor: string, seed: string) {
  await db`SELECT pg_advisory_xact_lock(hashtext('prefilter-audit-draw'))`;
  const pools = await poolCounts(db);
  const take = prefilterAuditTake(PREFILTER_AUDIT_BATCH, pools);
  const [previous] = await db<{ id: string }[]>`SELECT id FROM ai.prefilter_audit_draws ORDER BY created_at DESC, id DESC LIMIT 1`;
  const discarded = await pick(db, "block", take.discarded, seed, previous?.id ?? null);
  const kept = await pick(db, "pass", take.kept, seed, previous?.id ?? null);
  const id = `pa-${randomBytes(6).toString("hex")}`;
  await db`INSERT INTO ai.prefilter_audit_draws (id, actor, seed, discarded_count, kept_count)
    VALUES (${id}, ${actor}, ${seed}, ${discarded.length}, ${kept.length})`;
  let position = 0;
  for (const row of [...discarded.map((item) => ({ ...item, pool: "discarded" as const })), ...kept.map((item) => ({ ...item, pool: "kept" as const }))]) {
    await db`INSERT INTO ai.prefilter_audit_items
      (draw_id, position, article_id, pool, analysis_id, title, preview, source_name, discovered_at)
      VALUES (${id}, ${position}, ${row.article_id}, ${row.pool}, ${Number(row.analysis_id)},
        ${clip(row.title_zh, 180) || clip(row.article_title, 180)},
        ${clip(row.summary_zh, 240) || clip(row.excerpt, 240) || clip(row.body_text, 240)},
        ${clip(row.source_name, 80)}, ${row.discovered_at})`;
    position += 1;
  }
  await audit(actor, "prefilter_audit.draw", id, null, null, { discarded: discarded.length, kept: kept.length, seed }, undefined, db);
  return auditView(db);
}

export async function drawPrefilterAudit(value: unknown, principal: AdminPrincipal) {
  const input = PrefilterAuditDrawRequest.parse(value);
  return selectionCommand(principal, "prefilter-audit-draw", input, (tx) => recordPrefilterAuditDraw(tx, `account:${principal.userId}`, input.nonce), false);
}

export async function labelPrefilterAudit(articleId: string, value: unknown, principal: AdminPrincipal) {
  const input = PrefilterAuditLabelRequest.parse(value);
  return selectionCommand(
    principal,
    "prefilter-audit-label",
    { ...input, articleId },
    async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`prefilter-audit:${articleId}`}))`;
      const [item] = await tx<{ pool: "discarded" | "kept"; draw_id: string }[]>`
        SELECT i.pool, i.draw_id FROM ai.prefilter_audit_items i
        JOIN ai.prefilter_audit_draws d ON d.id = i.draw_id
        WHERE i.article_id = ${articleId}
        ORDER BY d.created_at DESC, i.position LIMIT 1`;
      if (!item) throw new SelectionConflict("这不在已抽出的样本里，请刷新后再标");
      const [before] = await tx<{ revision: number }[]>`
        SELECT revision FROM ai.prefilter_audit_labels WHERE article_id = ${articleId} ORDER BY revision DESC LIMIT 1`;
      if ((before?.revision ?? 0) !== input.expectedRevision) throw new SelectionConflict("标注已变化，请保留草稿并刷新");
      const [saved] = await tx<{ revision: number; decision: string; note: string; actor: string; created_at: Date }[]>`
        INSERT INTO ai.prefilter_audit_labels (article_id, revision, pool, decision, note, actor, draw_id)
        VALUES (${articleId}, ${input.expectedRevision + 1}, ${item.pool}, ${input.decision}, ${input.note}, ${`account:${principal.userId}`}, ${item.draw_id})
        RETURNING revision, decision, note, actor, created_at`;
      const result = PrefilterAuditLabel.parse({
        revision: saved!.revision,
        decision: saved!.decision,
        note: saved!.note,
        actor: saved!.actor,
        at: saved!.created_at.toISOString(),
      });
      await audit(result.actor, "prefilter_audit.label", articleId, input.note, before ?? null, { ...result, pool: item.pool }, undefined, tx);
      return result;
    },
    false,
  );
}
