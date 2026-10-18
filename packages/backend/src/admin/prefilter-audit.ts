import { latestPrefilterAuditJudgments, prefilterAuditAnalysisCopies } from "@amp/backend/editorial/analyze";
import { prefilterAuditMaterialSources, prefilterAuditMaterialCopies } from "@amp/backend/content/materials";
import { prefilterAuditExclusions } from "@amp/backend/admin/content";
import { newsAuditSourceNames } from "@amp/backend/admin/sources";
// A small random look at articles the prefilter already judged. Drawing and labeling only write
// these audit tables. They do not publish, withdraw, translate, or change the prefilter rules.
import { randomBytes } from "node:crypto";
import { sql, type Db } from "../db.ts";
import { audit, requireOwner, type AdminPrincipal } from "./auth.ts";
import { PrefilterAuditDrawRequest, PrefilterAuditLabel, PrefilterAuditLabelRequest, PrefilterAuditView } from "@amp/contracts/http/private";
import { selectionCommand, SelectionConflict } from "./selectbench-state.ts";

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

type AuditPoolItem = { article_id: string; analysis_id: number; relevance: string | null; source_name: string; excluded: boolean };
async function auditPool(db: Db): Promise<AuditPoolItem[]> {
  const latest = await latestPrefilterAuditJudgments(db);
  const ids = latest.map((row) => row.article_id);
  const sourceNames = new Map((await newsAuditSourceNames(db)).map((row) => [row.id, row.name]));
  const materialSources = new Map((await prefilterAuditMaterialSources(ids, db)).map((row) => [row.id, row.source_id]));
  const humanExcluded = new Set(await prefilterAuditExclusions(ids, db));
  return latest.flatMap((row) => {
    const sourceId = materialSources.get(row.article_id);
    const sourceName = sourceId ? sourceNames.get(sourceId) : undefined;
    if (sourceName === undefined) return [];
    return [{ ...row, source_name: sourceName, excluded: humanExcluded.has(row.article_id) || EXCLUDED_SOURCES.includes(sourceId!) }];
  });
}
function poolCounts(pool: AuditPoolItem[]): PoolRow {
  const counts = { discarded: 0, kept: 0, unknown: 0, excluded: 0 };
  for (const row of pool) {
    if (row.excluded) {
      if (row.relevance === "block" || row.relevance === "pass") counts.excluded++;
    } else if (row.relevance === "block") counts.discarded++;
    else if (row.relevance === "pass") counts.kept++;
    else if (row.relevance === "unknown") counts.unknown++;
  }
  return counts;
}
async function pick(db: Db, pool: AuditPoolItem[], relevance: "block" | "pass", limit: number, seed: string, previousId: string | null): Promise<PickRow[]> {
  if (limit <= 0) return [];
  const eligible = new Map(pool.filter((row) => row.relevance === relevance && !row.excluded).map((row) => [row.article_id, row]));
  const ids = [...eligible.keys()];
  if (!ids.length) return [];
  const selected = await db<{ article_id: string }[]>`WITH candidates AS (SELECT unnest(${ids}::text[]) AS article_id)
    SELECT a.article_id FROM candidates a
    LEFT JOIN LATERAL(SELECT revision FROM ai.prefilter_audit_labels WHERE article_id=a.article_id ORDER BY revision DESC LIMIT 1) lab ON true
    LEFT JOIN ai.prefilter_audit_items prev ON prev.article_id=a.article_id AND prev.draw_id=${previousId}
    ORDER BY (lab.revision IS NULL AND prev.article_id IS NULL) DESC,(lab.revision IS NULL) DESC,hashtext(a.article_id || ${seed}),a.article_id LIMIT ${limit}`;
  const materials = new Map(
    (
      await prefilterAuditMaterialCopies(
        selected.map((row) => row.article_id),
        db,
      )
    ).map((row) => [row.id, row]),
  );
  const analyses = new Map(
    (
      await prefilterAuditAnalysisCopies(
        selected.map((row) => eligible.get(row.article_id)!.analysis_id),
        db,
      )
    ).map((row) => [row.id, row]),
  );
  return selected.flatMap(({ article_id }) => {
    const decision = eligible.get(article_id)!,
      material = materials.get(article_id),
      analysis = analyses.get(decision.analysis_id);
    if (!material || !analysis) return [];
    return [
      {
        article_id,
        analysis_id: decision.analysis_id,
        title_zh: analysis.title_zh,
        article_title: material.title,
        summary_zh: analysis.summary_zh,
        excerpt: material.excerpt,
        body_text: material.body_text,
        source_name: decision.source_name,
        discovered_at: material.discovered_at,
      },
    ];
  });
}

async function auditView(db: Db) {
  const pools = poolCounts(await auditPool(db));
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
  const pool = await auditPool(db);
  const pools = poolCounts(pool);
  const take = prefilterAuditTake(PREFILTER_AUDIT_BATCH, pools);
  const [previous] = await db<{ id: string }[]>`SELECT id FROM ai.prefilter_audit_draws ORDER BY created_at DESC, id DESC LIMIT 1`;
  const discarded = await pick(db, pool, "block", take.discarded, seed, previous?.id ?? null);
  const kept = await pick(db, pool, "pass", take.kept, seed, previous?.id ?? null);
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
