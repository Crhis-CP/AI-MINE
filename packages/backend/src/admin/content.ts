import { manualMaterialSnapshot } from "@amp/backend/content/materials";
import { detachArticleFromFactTx, factArticleIds } from "@amp/backend/events/group";
import { invalidateReportCorrections } from "@amp/backend/reports/compose";
export { previewWithdrawal, actWithdrawal } from "../editorial/withdrawals.ts";
import { manualRevisionHistory } from "../editorial/manual-revisions.ts";
import { GeographyCandidate } from "../editorial/geography.ts";
// Content diagnostics and corrections (F19). Find any item by id, URL or title and see its whole
// chain: source → discoveries → revisions → model receipts → decisions → publication and sync
// ledger → grouping → deliveries. Visibility changes and manual corrections go through editorial
// overrides with a version check, are re-projected to every public exit, and are audited.
import { z } from "zod";
import { ARTICLE_ID_PATTERN, CATEGORY_KEYS } from "@amp/contracts/taxonomy";
import { dbOf, type Db } from "../db.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { queueProcessing } from "../jobs/content.ts";
import { normalizeUrl } from "../lib/url.ts";
import { publishArticle, publishArticleTx, publishedStoryId } from "../publication/publish.ts";

import { computeHotRanking } from "../events/hot.ts";
import { mergeStoryInto } from "../events/merge.ts";
import { latestHotRanking } from "../events/hot-read.ts";
import { audit } from "./auth.ts";
import { Conflict } from "./sources.ts";

const sql = dbOf("editorial");

export async function searchContent(q: string) {
  const term = q.trim();
  if (!term) return [];
  const byId = ARTICLE_ID_PATTERN.test(term) ? term : null;
  const url = /^https?:\/\//i.test(term) ? normalizeUrl(term) : null;
  return sql`
    SELECT a.id, coalesce(p.title, a.title) AS title, a.url, s.name AS source, a.discovered_at, a.processing_state,
           p.visibility, p.selected, p.score
    FROM articles a JOIN sources s ON s.id = a.source_id LEFT JOIN publications p ON p.article_id = a.id
    WHERE (${byId}::text IS NOT NULL AND a.id = ${byId})
       OR (${url}::text IS NOT NULL AND (a.url = ${url} OR a.identity_key = ${url} OR a.url = ${term}))
       OR (${url}::text IS NULL AND (a.title ILIKE ${`%${term}%`} OR p.title ILIKE ${`%${term}%`}))
    ORDER BY a.discovered_at DESC LIMIT 50`;
}

export async function contentChain(id: string) {
  const [article] = await sql`
    SELECT a.id, a.source_id, a.url, a.identity_key, a.title, a.author, a.language, a.published_at, a.published_at_claim, a.discovered_at,
           a.timeline_at, a.backfill, a.body_status, a.revision, a.processing_state, a.processing_error, a.grouped_at, length(a.body_text) AS body_chars,
           s.name AS source_name, s.kind AS source_kind, s.tier, s.participation_mode, s.site_fulltext, s.syndicate_fulltext
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${id}`;
  if (!article) return null;
  const [discoveries, revisions, analyses, publication, override, ledger, membership, decisions, deliveries, history] = await Promise.all([
    sql`SELECT source_id, via, discovered_at FROM article_discoveries WHERE article_id = ${id} ORDER BY discovered_at`,
    sql`SELECT revision, title, content_hash, created_at FROM article_revisions WHERE article_id = ${id} ORDER BY revision DESC LIMIT 10`,
    sql`
      SELECT an.id, an.origin, an.model, an.prompt_version, an.input_revision, an.relevance, an.category, an.score, an.selected, an.title_zh, an.reason_zh,
             an.created_at,
             (SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'service', r.service, 'model', r.model, 'cost', r.cost, 'at', r.created_at) ORDER BY r.id), '[]'::jsonb)
                FROM receipts r WHERE r.id = ANY(an.receipt_ids)) AS receipts
      FROM analyses an WHERE an.article_id = ${id} ORDER BY an.created_at DESC LIMIT 10`,
    sql`SELECT * FROM publications WHERE article_id = ${id}`,
    sql`SELECT fields, visibility, reason, version, updated_by, updated_at FROM editorial_overrides WHERE article_id = ${id}`,
    sql`SELECT seq, op, visible_at, changed_at FROM selected_ledger WHERE article_id = ${id} ORDER BY seq DESC LIMIT 10`,
    sql`
      SELECT fa.fact_id, fa.role, fa.manual, (fa.manual AND fa.input_revision IS DISTINCT FROM ${Number(article.revision)}) AS needs_review, f.public_id AS fact_public_id, f.title AS fact_title, st.id AS story_id, st.public_id AS story_public_id, st.title AS story_title
      FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id LEFT JOIN stories st ON st.id = f.story_id WHERE fa.article_id = ${id}`,
    sql`SELECT verdict, fact_id, story_id, receipt_id, candidates, created_at FROM grouping_decisions WHERE article_id = ${id} ORDER BY created_at DESC LIMIT 5`,
    sql`SELECT target_key, dedupe_key, status, attempts, response, created_at, sent_at FROM deliveries WHERE subject_id = ${id} ORDER BY created_at DESC`,
    sql`SELECT created_at, actor, action, reason, before, after FROM audit_log WHERE subject = ${`content:${id}`} ORDER BY created_at DESC LIMIT 20`,
  ]);
  return {
    article,
    discoveries,
    revisions,
    analyses,
    publication: publication[0] ?? null,
    override: override[0] ?? null,
    ledger,
    membership,
    decisions,
    deliveries,
    history,
    manualRevisions: await manualRevisionHistory(id),
  };
}

/** Whether the current hot ranking shows the article: as an event's representative or among its reports. */
async function inHotRanking(id: string): Promise<boolean> {
  const ranking = await latestHotRanking();
  if (!ranking?.entries.length) return false;
  if (ranking.entries.some((e) => e.representativeItemId === id)) return true;
  const [p] = await sql<{ story_id: number | null }[]>`SELECT story_id FROM publications WHERE article_id = ${id}`;
  return !!p?.story_id && ranking.entries.some((e) => e.storyId === Number(p.story_id));
}

const STALE = "这条内容的人工设置已被修改，请刷新后再操作";

async function overrideRow(id: string, db: Db = sql) {
  const [o] = await db<
    { fields: Record<string, unknown>; visibility: string | null; version: number }[]
  >`SELECT fields, visibility, version FROM editorial_overrides WHERE article_id = ${id}`;
  return o ?? { fields: {}, visibility: null, version: 0 };
}

/**
 * Public / summary-only / withdrawn. Applies to the site, API, RSS, MCP, the sync ledger and the
 * search index through the one publication projection; ETags change with the content.
 */
export async function setVisibility(
  id: string,
  input: { visibility: "public" | "summary-only" | "withdrawn"; reason: string; version: number },
  actor: string,
) {
  if (!input.reason?.trim()) throw new Error("reason is required");
  const published = await sql.begin(async (tx) => {
    await manualMaterialSnapshot(id, tx);
    const before = await overrideRow(id, tx);
    if (before.version !== input.version) throw new Conflict(STALE);
    const written = await tx`
      INSERT INTO editorial_overrides (article_id, visibility, reason, version, updated_by) VALUES (${id}, ${input.visibility}, ${input.reason}, 1, ${actor})
      ON CONFLICT (article_id) DO UPDATE SET visibility = EXCLUDED.visibility, reason = EXCLUDED.reason, version = editorial_overrides.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()
      WHERE editorial_overrides.version = ${input.version} RETURNING version`;
    if (!written.count) throw new Conflict(STALE);
    const published = await publishArticleTx(tx, id);
    if (published?.changed) await invalidateReportCorrections(tx, [id], input.visibility === "withdrawn" ? "withdrawal" : "restoration");
    await enqueue("events.hot-refresh", { articleId: id, lane: "news" }, { singletonKey: "hot-ranking" }, tx);
    await audit(actor, "content.visibility", `content:${id}`, input.reason, { visibility: before.visibility }, { visibility: input.visibility }, undefined, tx);
    return published;
  });
  // The durable queue is committed with the withdrawal. Try the inexpensive current ranking now;
  // a failure cannot undo the already committed action and is retried by that queue.
  if (published?.reduced && (await inHotRanking(id))) await computeHotRanking().catch(() => undefined);
  return published;
}

/** Marks a detail page for search indexing (sitemap, IndexNow, robots) or removes the mark. */
export async function setSeoIndexed(id: string, input: { indexed: boolean; reason: string }, actor: string) {
  if (!input.reason?.trim()) throw new Error("reason is required");
  const [before] = await sql<
    { seo_indexed_at: Date | null; indexable: boolean }[]
  >`SELECT seo_indexed_at, indexable FROM publications WHERE article_id = ${id}`;
  if (!before) return null;
  // Marking indexes the page; unmarking excludes it, so a selected page is not indexed again automatically.
  await sql`UPDATE publications SET seo_indexed_at = ${input.indexed ? (before.seo_indexed_at ?? new Date()) : null},
              seo_excluded_at = ${input.indexed ? null : new Date()} WHERE article_id = ${id}`;
  const published = await publishArticle(id);
  await audit(actor, "content.seo", `content:${id}`, input.reason, { indexed: before.indexable }, { indexed: input.indexed });
  return published;
}

const FieldsSchema = z
  .object({
    title: z.string().min(1).max(300),
    summary: z.string().max(2000),
    body: z.string().max(500000),
    reason: z.string().max(1000),
    category: z.enum(CATEGORY_KEYS).nullable(),
    tags: z.array(z.string().max(60)).max(20),
    geography: z.strictObject({ revision: z.number().int().positive(), value: GeographyCandidate }),
    selected: z.boolean(),
    silent: z.boolean(),
    // 收录 (AI-01 人工覆盖): "pass" admits despite a model BLOCK, "block" keeps the item off every public page.
    relevance: z.enum(["pass", "block"]),
  })
  .partial()
  .strict();

/** Manual corrections win over model output; null clears a correction. */
type ManualDraft = {
  id: number;
  source_revision: number;
  fields: Record<string, unknown>;
  evidence_quote: string | null;
  source_checked: boolean;
  facts_checked: boolean;
};
export async function overrideFields(
  id: string,
  input: {
    fields: unknown;
    clear?: string[];
    reason: string;
    version: number;
    command?: "save_draft" | "publish";
    source_revision?: number;
    draft_id?: number;
    evidence_quote?: string;
    source_checked?: boolean;
    facts_checked?: boolean;
    resolution_note?: string;
  },
  actor: string,
) {
  if (!input.reason?.trim()) throw new Error("reason is required");
  const fields = FieldsSchema.parse(input.fields ?? {});
  return sql.begin(async (tx) => {
    const material = await manualMaterialSnapshot(id, tx);
    if (!material) return null;
    const before = await overrideRow(id, tx);
    if (before.version !== input.version) throw new Conflict(STALE);
    if (input.source_revision !== material.revision) throw new Conflict("原材料修订已变化，请核对当前原文");
    let next: Record<string, unknown> = { ...before.fields, ...fields };
    for (const k of input.clear ?? []) delete next[k];
    let draft: ManualDraft | undefined;
    if (input.draft_id) {
      [draft] = await tx<ManualDraft[]>`SELECT * FROM editorial.manual_revisions WHERE id=${input.draft_id} AND article_id=${id}`;
      if (!draft || draft.source_revision !== material.revision) throw new Conflict("草稿来源修订已过期");
      next = draft.fields as Record<string, unknown>;
    } else {
      [draft] = await tx<
        ManualDraft[]
      >`INSERT INTO editorial.manual_revisions(article_id,source_revision,fields,evidence_quote,source_checked,facts_checked,actor,reason)
        VALUES(${id},${material.revision},${tx.json(next as never)},${input.evidence_quote?.trim() ?? null},${input.source_checked === true},${input.facts_checked === true},${actor},${input.reason}) RETURNING *`;
      await tx`INSERT INTO editorial.manual_revision_events(revision_id,state,actor) VALUES(${draft!.id},'draft',${actor})`;
    }
    if (input.command !== "publish") {
      await audit(actor, "content.draft", `content:${id}`, input.reason, null, { draft_id: draft!.id }, undefined, tx);
      return { draft_id: draft!.id, version: before.version, status: "draft" };
    }
    const quote = String(input.evidence_quote ?? draft!.evidence_quote ?? "").trim();
    if (
      input.source_checked !== true ||
      input.facts_checked !== true ||
      quote.length < 12 ||
      !(material.title + "\n" + (material.body_text ?? "")).includes(quote)
    )
      throw new Conflict("发布人工修订须核对原始来源及中文事实，并填写当前原文逐字依据（至少12字）");
    const [active] = await tx<
      { id: number; state: string }[]
    >`SELECT m.id,(SELECT state FROM editorial.manual_revision_events WHERE revision_id=m.id ORDER BY id DESC LIMIT 1) AS state
      FROM editorial_overrides o JOIN editorial.manual_revisions m ON m.id=o.manual_revision_id WHERE o.article_id=${id}`;
    if (active?.state === "conflict" && (input.resolution_note?.trim().length ?? 0) < 10) throw new Conflict("解决事实冲突须填写至少10字处理说明");
    // Publishing a saved draft creates a separately bound, immutable confirmed revision.
    if (input.draft_id || draft!.evidence_quote !== quote || !draft!.source_checked || !draft!.facts_checked) {
      [draft] = await tx<
        ManualDraft[]
      >`INSERT INTO editorial.manual_revisions(article_id,source_revision,fields,evidence_quote,source_checked,facts_checked,actor,reason)
        VALUES(${id},${material.revision},${tx.json(next as never)},${quote},true,true,${actor},${input.reason}) RETURNING *`;
    }
    if (active) await tx`INSERT INTO editorial.manual_revision_events(revision_id,state,actor) VALUES(${active.id},'superseded',${actor})`;
    await tx`INSERT INTO editorial.manual_revision_events(revision_id,state,actor,note) VALUES(${draft!.id},'active',${actor},${input.resolution_note ?? null})`;
    const written = await tx`INSERT INTO editorial_overrides(article_id,fields,reason,version,updated_by,manual_revision_id,material_revision)
      VALUES(${id},${tx.json(next as never)},${input.reason},1,${actor},${draft!.id},${material.revision})
      ON CONFLICT(article_id) DO UPDATE SET fields=EXCLUDED.fields,reason=EXCLUDED.reason,version=editorial_overrides.version+1,
        updated_by=EXCLUDED.updated_by,updated_at=now(),manual_revision_id=EXCLUDED.manual_revision_id,material_revision=EXCLUDED.material_revision
      WHERE editorial_overrides.version=${input.version} RETURNING version`;
    if (!written.count) throw new Conflict(STALE);
    const published = await publishArticleTx(tx, id);
    if (published?.changed) {
      await invalidateReportCorrections(tx, [id], "manual_correction");
      const storyId = await publishedStoryId(id, tx);
      if (storyId) await enqueue(QUEUES.digest, { storyId, afterCorrection: true }, { singletonKey: `story:${storyId}:correction` }, tx);
    }
    await audit(actor, "content.override", `content:${id}`, input.reason, before.fields, { fields: next, manual_revision_id: draft!.id }, undefined, tx);
    return { draft_id: draft!.id, version: written[0]!.version, status: "active", publication: published };
  });
}

/**
 * Re-runs a pipeline step for the current revision. Re-evaluation is a new paid model call bound to
 * the request id, so submitting the same request twice neither enqueues nor pays twice.
 */
export async function rerun(id: string, step: "extract" | "analyze" | "group", requestId: string, actor: string) {
  if (!/^[\w-]{8,80}$/.test(requestId)) throw new Error("a stable request id is required");
  const [a] = await sql`SELECT id FROM articles WHERE id = ${id}`;
  if (!a) return null;
  let jobId: string | null;
  if (step === "group") {
    // An explicit regroup replaces an earlier manual "keep standalone" decision and the automatic membership.
    await sql`DELETE FROM grouping_overrides WHERE article_id = ${id}`;
    jobId = await enqueue(QUEUES.group, { articleId: id, force: true }, { singletonKey: `manual:group:${id}:${requestId}` });
  } else {
    await sql`UPDATE articles SET processing_state = 'new', processing_error = NULL, processing_attempts = 0, processing_retry_at = NULL,
                body_status = CASE WHEN ${step === "extract"} THEN 'pending' ELSE body_status END WHERE id = ${id}`;
    jobId =
      step === "analyze" ? await queueProcessing(id, { step: "analyze", attemptTag: `admin:${requestId}` }) : await queueProcessing(id, { step: "extract" });
  }
  await audit(actor, `content.rerun.${step}`, `content:${id}`, null, null, { jobId, requestId }, requestId);
  return { jobId };
}

/**
 * Takes an article out of its fact; it is shown on its own again and stays that way (automatic
 * grouping, retries and later revisions do not re-attach it; an explicit regroup does). Its heat
 * evidence leaves the old story, whose digest is rewritten.
 */
export async function detachFromFact(id: string, reason: string, actor: string) {
  const { facts, stories } = await sql.begin((tx) => detachArticleFromFactTx(tx, id, reason, actor));
  await publishArticle(id);
  // The fact's other reports may take a new reading-group anchor.
  if (facts.length) {
    for (const articleId of await factArticleIds(facts, sql)) await publishArticle(articleId);
  }
  for (const storyId of stories) await enqueue(QUEUES.digest, { storyId }, { singletonKey: `story:${storyId}` });
  await audit(actor, "content.detach", `content:${id}`, reason, { facts, stories }, null);
  return { detached: facts.length };
}

/** Merges one story into another: facts move, the old public id keeps working as an alias. */
export async function mergeStories(fromId: number, intoId: number, reason: string, actor: string) {
  if (fromId === intoId) throw new Error("cannot merge a story into itself");
  const done = await mergeStoryInto(fromId, intoId, reason, actor);
  if (done) return done;
  const found = await sql<{ id: number }[]>`SELECT id FROM stories WHERE id IN (${fromId}, ${intoId})`;
  if (found.length < 2) throw new Error("story not found");
  throw new Conflict("两个事件都必须是未合并的事件");
}

/** Minimal current exceptions for operations; no source body or human draft is exposed. */
export async function manualReviewExceptions() {
  return sql`SELECT o.article_id,e.state,e.created_at FROM editorial_overrides o
    JOIN LATERAL(SELECT state,created_at FROM editorial.manual_revision_events WHERE revision_id=o.manual_revision_id ORDER BY id DESC LIMIT 1)e ON true
    WHERE e.state IN ('needs_review','conflict') ORDER BY e.created_at LIMIT 100`;
}

/** Human takedown/relevance decisions remain authoritative for the private prefilter sample. */
export async function prefilterAuditExclusions(articleIds: string[], db: Db) {
  if (!articleIds.length) return [];
  return (
    await db<{ article_id: string }[]>`SELECT article_id FROM editorial_overrides WHERE article_id=ANY(${articleIds}::text[])
    AND (visibility='withdrawn' OR fields->>'relevance'='block')`
  ).map((row) => row.article_id);
}
