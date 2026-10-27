import { isHistorical, newsMaterialBindings, type XPostData } from "../content/materials.ts";
export { extractHistoricalAnchors, readHistoricalBackgroundCandidates, replaceHistoricalBackgroundProjection } from "./historical-background.ts";
import { groupingAnalysisHash, readQuotedPostTranslation } from "../enrichment/records.ts";
import { deferHistoricalSelection } from "../events/group.ts";
import { recomputeSelection } from "./selection-recompute.ts";
import { audit } from "../admin/auth.ts";
import { emit } from "../modules.ts";
import { pendingSourceTimeProjectionIds } from "./items.ts";
import { materialSourceTime } from "../content/date-evidence.ts";
import { sourceDateConfiguration, readCurrentPublicPolicy, evaluateSourcePolicy } from "../admin/sources.ts";
import { publicSourceTime, sourceInstant } from "./source-time.ts";
import { representativeFactSubjects } from "../events/representative-input.ts";
import { representativePriority, pickRepresentative } from "./representative.ts";
import { representativeSourceIdentities } from "../sources/representative-input.ts";
import { z } from "zod";
import { verifiedCompanyContext } from "./reader-context.ts";
import { articleWithdrawalHeld } from "./withdrawals.ts";
export {
  applyWithdrawalProjection,
  policyReportWithdrawalSnapshot,
  projectedWithdrawalMembers,
  withdrawalIdentity,
  articleWithdrawalHeld,
} from "./withdrawals.ts";
export type { WithdrawalTarget } from "./withdrawals.ts";
import { manualRevisionState } from "../editorial/manual-revisions.ts";
import { requireRuntimeRunning, assertRuntimeControl, RuntimeControlPaused, RuntimeControlStale } from "../operations/lane-controls.ts";
// Publishing: derive the public projection of one article from its material, the latest judgement,
// manual overrides and grouping, then record selected-set changes in the sync ledger.
// Rebuilding only re-reads stored results; it never calls a model.
import { renameCategoryTags } from "@amp/industry/mining-taxonomy";
import { SITE } from "@amp/industry/site";
import { toPublicApiCategory } from "@amp/contracts/taxonomy";
import { one, sql, type Tx, type Db } from "../db.ts";
import { fetchItemsByIds } from "./items.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { collapseWhitespace, usableSourceText, originalPostCopy } from "../lib/text.ts";
import { promptVersion } from "../editorial/prompts.ts";
import { looksZh } from "../editorial/writing.ts";
import { normalizeSourceLanguage } from "../sources/config-keys.ts";
import { isChineseOriginal, readableTranslation, TRANSLATION_MANIFEST_FORMAT } from "../editorial/translation-readiness.ts";
import { readStoredTranslation } from "../editorial/translation-store.ts";
import { itemUrl } from "./links.ts";
import { QUEUES, shutdownSignal } from "../jobs/queue.ts";
import { enqueueJob as enqueue } from "../jobs/module-queues.ts";
import {
  bodyModeOf,
  displayTags,
  isIndexable,
  isPoolEligible,
  isSelectable,
  independentSelectedSources,
  isIndependentSelectedSource,
  mayRedistribute,
  type SourceFacts,
} from "./rules.ts";
import { foldableSelectionCondition } from "./scope.ts";
import { projectNewsGeography } from "./news-geography.ts";
import { withXArticle } from "../editorial/input.ts";
import { analysisVersionOf } from "../editorial/analyze.ts";
import { quoteTranslatable, quoteTranslationRecipe } from "../editorial/post-translation.ts";
import { postPermission, projectPostView } from "./post-view.ts";
import { originalPostAdmissionRequired, originalPostProjectionAllowed } from "../lib/original-post-admission.ts";

async function sourceTimeForMaterial(material: { id: string; source_id: string; revision: number; source_date_version: string | number }, now: Date, db: Db) {
  const context = await sourceDateConfiguration(material.source_id, db);
  if (context?.lane !== "news") return null;
  const time = publicSourceTime(
    await materialSourceTime(
      { articleId: material.id, sourceId: material.source_id, revision: material.revision, configHash: context.configHash ?? "" },
      Number(material.source_date_version),
      now.getTime(),
      db,
    ),
  );
  return { time, configHash: (time ? context.configHash : context.storedConfigHash) ?? null };
}

interface ArticleRow {
  x_post: XPostData | null;
  x_article: { title?: string; text?: string } | null;
  id: string;
  revision: number;
  source_id: string;
  source_date_version: string;
  url: string;
  title: string;
  language: string | null;
  published_at: Date | null;
  discovered_at: Date;
  timeline_at: Date;
  backfill: boolean;
  body_status: string;
  body_text: string | null;
  body_html: string | null;
  excerpt: string | null;
  grouped_at: Date | null;
  grouping_status: string;
  grouping_input_revision: number | null;
  selection_adds_value: boolean | null;
  processing_state: string;
}

interface AnalysisRow {
  id: number;
  prompt_version: string | null;
  input_revision: number;
  relevance: string | null;
  output: unknown;
  category: string | null;
  tags: string[];
  subjects: string[];
  title_zh: string | null;
  summary_zh: string | null;
  reason_zh: string | null;
  score: number | null;
  selected: boolean | null;
}

interface OverrideRow {
  fields: Record<string, unknown>;
  visibility: string | null;
}

interface PublicationRow {
  original_post_admission_required?: boolean | null;
  x_post?: unknown;
  x_post_revision?: number | null;
  is_original_post?: boolean;
  article_id: string;
  analysis_id: number | null;
  first_public_at: Date | null;
  first_publication_observed: boolean;
  company_context?: ReturnType<typeof verifiedCompanyContext>;
  revision: number;
  visibility: string;
  operator_withdrawn: boolean;
  source_time: unknown;
  source_time_material_revision: number | null;
  source_date_version: number | null;
  source_date_config_hash: string | null;
  eligible: boolean;
  selected: boolean;
  title: string;
  original_title: string | null;
  summary: string | null;
  source_excerpt: string | null;
  reason: string | null;
  category: string | null;
  tags: string[];
  score: number | null;
  body_mode: string;
  story_id: number | null;
  fact_id: number | null;
  selected_ready_at: Date | null;
  first_selected_at: Date | null;
  selection_candidate: boolean;
  representative_priority: number;
  visible_after: Date | null;
  indexable: boolean;
  seo_indexed_at: Date | null;
  seo_excluded_at: Date | null;
}

export interface V1ItemPayload {
  id: string;
  title: string;
  originalTitle: string | null;
  summary: string | null;
  source: { name: string };
  links: { original: string };
  publishedAt: string | null;
  discoveredAt: string;
  category: string | null;
  score: number | null;
  selected: boolean;
  reason: string | null;
  attribution: { name: string; url: string };
}

export interface PublishOptions {
  now?: Date;
  /** Historical import: the item was already public, so it is released at its discovery time. */
  releasedAt?: Date | null;
}

export interface PublishResult {
  articleId: string;
  changed: boolean;
  selected: boolean;
  visibility: string;
  ledger: "upsert" | "remove" | null;
  /** Something that was public is now shown less (withdrawn, out of the pool or selection, full text revoked). */
  reduced: boolean;
}

function pickString(override: unknown, fallback: string | null): string | null {
  return typeof override === "string" && override.trim() !== "" ? override.trim() : fallback;
}

function round1(n: number | null): number | null {
  return n === null || n === undefined ? null : Math.round(Number(n) * 10) / 10;
}

export function v1Payload(p: {
  articleId: string;
  title: string;
  originalTitle: string | null;
  summary: string | null;
  sourceName: string;
  url: string;
  publishedAt: Date | null;
  discoveredAt: Date;
  category: string | null;
  score: number | null;
  selected: boolean;
  reason: string | null;
}): V1ItemPayload {
  const pageUrl = itemUrl(p.articleId);
  return {
    id: p.articleId,
    title: p.title,
    originalTitle: p.originalTitle,
    summary: p.summary,
    source: { name: p.sourceName },
    links: { original: p.url },
    publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
    discoveredAt: p.discoveredAt.toISOString(),
    category: toPublicApiCategory(p.category),
    score: p.score === null ? null : Math.round(p.score),
    selected: p.selected,
    reason: p.selected ? p.reason : null,
    attribution: { name: SITE.name, url: pageUrl },
  };
}

/** Allocates the next ledger sequence under a transaction lock so sequence order equals commit order. */
async function appendLedger(tx: Tx, articleId: string, op: "upsert" | "remove", payload: V1ItemPayload | null, visibleAt: Date, now: Date): Promise<number> {
  await tx`SELECT pg_advisory_xact_lock(hashtext('selected_ledger'))`;
  const { next } = one(await tx<{ next: number }[]>`SELECT coalesce(max(seq), 0) + 1 AS next FROM selected_ledger`);
  await tx`INSERT INTO selected_ledger (seq, article_id, op, changed_at, visible_at, payload)
           VALUES (${next}, ${articleId}, ${op}, ${now}, ${visibleAt}, ${payload ? tx.json(payload as never) : null})`;
  return next;
}

export async function publishArticle(articleId: string, options: PublishOptions = {}): Promise<PublishResult | null> {
  return sql.begin((tx) => publishArticleTx(tx, articleId, options));
}

/** Grouping reads the effective nomination only when it belongs to the same saved analysis. */
export async function groupingSelectionCandidate(articleId: string, analysisId: number, db: Db = sql) {
  const [row] = await db<{ selection_candidate: boolean }[]>`SELECT selection_candidate FROM publications
    WHERE article_id=${articleId} AND analysis_id=${analysisId}`;
  return row?.selection_candidate === true;
}

/** Worker rechecks current scope, source licence and withdrawal before any translation request. */
export async function prepareTranslation(articleId: string): Promise<number | null> {
  let revision: number | null = null;
  await sql.begin((tx) =>
    publishArticleTx(tx, articleId, {}, (current) => {
      revision = current;
    }),
  );
  return revision;
}

export async function publishArticleTx(
  tx: Tx,
  articleId: string,
  options: PublishOptions = {},
  forTranslation?: (revision: number) => void,
): Promise<PublishResult | null> {
  // All publication and membership changes use the same short transaction fence, before material locks.
  // Settling a representative may update a peer publication, but never locks the peer's material.
  await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
  const [article] = await tx<ArticleRow[]>`
    SELECT id, revision, source_id, source_date_version, url, title, language, published_at, discovered_at, timeline_at, backfill, body_status,
           body_text, body_html, excerpt, x_post, x_article, grouped_at, grouping_status, grouping_input_revision, selection_adds_value, processing_state
    FROM articles WHERE id = ${articleId} FOR UPDATE`;
  if (!article) return null;
  // Reports take this lock exclusively while reading candidates. Hold it through commit so a
  // release stamped before their cutoff cannot commit after their candidate snapshot.
  await tx`SELECT pg_advisory_xact_lock_shared(hashtext('report_candidates'))`;
  const now = options.now ?? new Date(); // sample after both locks, which may span a report cutoff
  const [source] = await tx<SourceFacts[]>`
    SELECT id, name, kind, tier, participation_mode, first_party, site_fulltext, syndicate_fulltext FROM sources WHERE id = ${article.source_id}`;
  if (!source) return null;
  const dateProjection = await sourceTimeForMaterial(article, now, tx);
  if (!dateProjection) return null;
  const { time: sourceTime, configHash: timeConfigHash } = dateProjection;
  const [storedAnalysis] = await tx<AnalysisRow[]>`
    SELECT id, input_revision, prompt_version, relevance, output, category, tags, subjects, title_zh, summary_zh, reason_zh, score, selected
    FROM analyses WHERE article_id = ${articleId} ORDER BY input_revision DESC, id DESC LIMIT 1`;
  const [override] = await tx<OverrideRow[]>`SELECT fields, visibility FROM editorial_overrides WHERE article_id = ${articleId}`;
  const [membership] = await tx<{ fact_id: number; story_id: number | null; fact_public_id: string; story_public_id: string | null }[]>`
    SELECT fa.fact_id, f.story_id,f.public_id AS fact_public_id,s.public_id::text AS story_public_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id
    LEFT JOIN stories s ON s.id = f.story_id
    WHERE fa.article_id = ${articleId} AND (fa.manual OR fa.input_revision=${article.revision}) AND fa.role IN ('primary', 'report') AND (s.id IS NULL OR s.merged_into IS NULL)
    ORDER BY (fa.role = 'primary') DESC, fa.created_at LIMIT 1`;
  const [identity] = await representativeSourceIdentities([article.source_id], tx);
  const [factIdentity] = await representativeFactSubjects(membership?.fact_id ? [membership.fact_id] : [], tx);
  const priority = representativePriority({ ...identity, fact_subject: factIdentity?.subject ?? null });
  const [previous] = await tx<PublicationRow[]>`SELECT * FROM publications WHERE article_id = ${articleId}`;

  const post = withXArticle(article.x_post, article.x_article);
  const analysis =
    storedAnalysis?.input_revision === article.revision && (!post || storedAnalysis.prompt_version === analysisVersionOf({ xPost: post }))
      ? storedAnalysis
      : undefined;
  const currentPolicy = post ? await readCurrentPublicPolicy(source.id, tx) : null;
  const quotedTranslation = post?.quoted ? await readQuotedPostTranslation(source.id, post.quoted, quoteTranslationRecipe(), tx) : null;
  const postView = source.site_fulltext ? projectPostView(post, source.id, article.url, currentPolicy, quotedTranslation, now.getTime()) : null;
  const quoteRecipe =
    postView?.quoted &&
    quoteTranslatable(postView.quoted.text) &&
    postPermission(currentPolicy, source.id, postView.quoted.url, "public_translation", now.getTime())
      ? quoteTranslationRecipe()
      : null;
  const postWriter = analysis?.output as { writer?: string; postSummaryKind?: string } | null | undefined;
  const summaryKind =
    postWriter?.writer === "verbatim" ? "original" : postWriter?.writer === "understand" || postWriter?.postSummaryKind === "summary" ? "summary" : null;
  const storedPostView = post ? { view: postView, quoteRecipe, summaryKind } : null;
  const admissionRequired = originalPostAdmissionRequired(post, (analysis?.output as { writer?: string } | null)?.writer, analysis?.summary_zh);
  const admissionAllowed = originalPostProjectionAllowed({ is_original_post: !!post, original_post_admission_required: admissionRequired });
  const postReady = admissionAllowed && !!post && !!analysis && analysis.relevance === "pass";
  const verbatim = postReady && (analysis.output as { writer?: unknown } | null)?.writer === "verbatim";
  const manual = await manualRevisionState(articleId, article.revision, article.title + "\n" + (article.body_text ?? ""), tx);
  const f: Record<string, unknown> = manual.fields;
  const [previousManual] = await tx<{ manual_revision_id: number | null; body_html: string | null; state: string }[]>`
    SELECT manual_revision_id,body_html,state FROM publication.manual_copies WHERE article_id=${articleId}`;
  const manualChanged =
    (previousManual?.manual_revision_id ?? null) !== manual.manualRevisionId ||
    (previousManual?.body_html ?? null) !== manual.bodyHtml ||
    (previousManual?.state ?? "none") !== (manual.state ?? "none");
  const companyContext = verifiedCompanyContext(analysis?.output, article.title + "\n" + (article.body_text ?? ""), article.url);
  await tx`INSERT INTO publication.manual_copies(article_id,manual_revision_id,material_revision,body_html,label,state)
    VALUES(${articleId},${manual.manualRevisionId},${article.revision},${manual.bodyHtml},'AI 辅助整理，经人工修订',${manual.state ?? "none"})
    ON CONFLICT(article_id) DO UPDATE SET manual_revision_id=EXCLUDED.manual_revision_id,material_revision=EXCLUDED.material_revision,body_html=EXCLUDED.body_html,label=EXCLUDED.label,state=EXCLUDED.state
    WHERE (manual_copies.manual_revision_id,manual_copies.material_revision,manual_copies.body_html,manual_copies.state)
      IS DISTINCT FROM (EXCLUDED.manual_revision_id,EXCLUDED.material_revision,EXCLUDED.body_html,EXCLUDED.state)`;
  const hasMaterial = !!usableSourceText(article.body_text, article.excerpt) || postReady;
  const language = normalizeSourceLanguage(article.language);
  const nativeChinese = isChineseOriginal(language);
  // Wide admission (BR-SEL-01): only a BLOCK keeps an item out. PASS, UNKNOWN and "not judged yet" go on;
  // the latest judgement holds until a newer revision is judged, and the manual 收录 choice outranks it.
  // Material that is never judged (hot_signal and isolated sources mark it "skipped") stays out even after its
  // source becomes editorial: nothing would ever judge it (INV-13 lets an item wait for its judgement only).
  const manualScope = f.relevance === "pass" || f.relevance === "block" ? f.relevance : null;
  const scope = manualScope ?? storedAnalysis?.relevance ?? (article.processing_state === "skipped" ? "block" : null);
  const admitted = scope !== "block";
  const bodyMode = post
    ? source.site_fulltext &&
      (article.body_status === "ok" || verbatim) &&
      postPermission(currentPolicy, source.id, article.url, "public_original_fulltext", now.getTime())
      ? "full"
      : "summary"
    : bodyModeOf(source, article.body_status, !!usableSourceText(article.body_text));
  // A Chinese original with full-text permission is guided by a deterministic excerpt until the model writes (BR-ENR-06).
  const excerpt =
    !post && admitted && nativeChinese && bodyMode === "full" && collapseWhitespace(article.body_text!).length >= 20
      ? `来源摘录：${Array.from(collapseWhitespace(article.body_text!)).slice(0, 400).join("")}（根据来源正文整理，保留原始材料供核对）`
      : null;
  const isChineseTitle = nativeChinese;
  // Without a written Chinese title, a Chinese original keeps its own title; a foreign one would
  // still be a half-finished card.
  const zhTitle = analysis?.title_zh?.trim() ? analysis.title_zh : null;
  // A verbatim title/summary is the original full text, not a separately licensed summary.
  const title = pickString(
    f.title,
    post && verbatim ? `${post.authorName || post.handle || source.name}的原帖` : (zhTitle ?? (isChineseTitle ? collapseWhitespace(article.title) : null)),
  );
  const summary = pickString(f.summary, post && summaryKind !== "summary" ? null : analysis?.summary_zh?.trim() || null);
  if (storedPostView && typeof f.summary === "string" && f.summary.trim()) storedPostView.summaryKind = "summary";
  const sourceExcerpt = summary ? null : excerpt;
  const displaySummary = summary ?? sourceExcerpt;
  const category = toPublicApiCategory(f.category === null ? null : pickString(f.category, analysis?.category ?? null));
  // Tags set by hand stay as they are; analysed ones show renamed categories by their current name (TASK-0041).
  const tags = z
    .array(z.string())
    .parse(Array.isArray(f.tags) ? f.tags : renameCategoryTags([...(analysis?.tags ?? []), ...(analysis?.subjects ?? []).map((s) => `entity:${s}`)]));
  const score = typeof f.score === "number" ? f.score : (analysis?.score ?? null);
  const relevance = admitted ? "pass" : "unknown";
  const recomputed = analysis && typeof f.selected !== "boolean" ? recomputeSelection(analysis, source.tier, article.timeline_at, now, previous) : null;
  const judgedSelected = typeof f.selected === "boolean" ? (f.selected as boolean) : (recomputed?.selected ?? analysis?.selected ?? null);
  const chineseCopy = (!!title && !!displaySummary && looksZh(title) && looksZh(displaySummary)) || (postReady && verbatim);
  const translation = !nativeChinese && article.body_html ? await readStoredTranslation(articleId, tx) : null;
  const wholeChinese =
    nativeChinese ||
    !!(
      article.body_html &&
      readableTranslation(
        article.body_html,
        { revision: article.revision, recipe: `${TRANSLATION_MANIFEST_FORMAT}:${promptVersion("translate-body")}` },
        translation,
      )
    );
  // 2026-10-10 Owner 测试阶段决定：外文先按导读公开，全文后补。
  // 有中文标题和中文导读即可进入读者站；站内全文关着、或完整译文还没有，不再挡住。
  // 已有获准完整中文正文的仍按全文显示。不要把空正文伪装成译文，也不要为了上站把全文转载开关打开。
  // 不要把 DEC-35「必须先有完整中文正文」加回这个门槛。
  const readingReady = !!language && (nativeChinese || chineseCopy);
  const withdrawnByGroup = await articleWithdrawalHeld(tx, articleId, membership?.fact_public_id ?? null, membership?.story_public_id ?? null);
  const operatorWithdrawn = withdrawnByGroup || override?.visibility === "withdrawn" || override?.fields.relevance === "block";
  const visibility =
    !admissionAllowed || operatorWithdrawn || source.participation_mode === "isolated" || !admitted || !hasMaterial || !chineseCopy || !readingReady
      ? "withdrawn"
      : (override?.visibility ?? "public");
  const eligible =
    admissionAllowed &&
    readingReady &&
    hasMaterial &&
    (isPoolEligible({ participationMode: source.participation_mode, relevance, title, summary: displaySummary }) ||
      (postReady && verbatim && source.participation_mode === "editorial" && admitted && !!title)) &&
    (!article.backfill || article.published_at !== null || !!options.releasedAt);
  const selectionCandidate = isSelectable(eligible, judgedSelected, source.tier);
  const waitingForCoverage =
    selectionCandidate &&
    typeof f.selected !== "boolean" &&
    analysis !== undefined &&
    analysis.selected !== true &&
    isHistorical(article) &&
    visibility === "public" &&
    !operatorWithdrawn &&
    article.grouping_status === "complete" &&
    article.grouping_input_revision === article.revision &&
    article.selection_adds_value === true &&
    (await deferHistoricalSelection(articleId, article.revision, groupingAnalysisHash({ ...analysis, selected: false }), tx));
  const selected =
    selectionCandidate &&
    !waitingForCoverage &&
    article.grouping_status === "complete" &&
    article.grouping_input_revision === article.revision &&
    (f.selected === true || article.selection_adds_value === true);
  let quoteNeedsTranslation =
    !!postView?.quoted &&
    quoteTranslatable(postView.quoted.text) &&
    !quotedTranslation &&
    postPermission(currentPolicy, source.id, postView.quoted.url, "public_translation", now.getTime());
  if (quoteNeedsTranslation && postView?.quoted && currentPolicy) {
    for (const capability of ["external_model", "process_locally", "store_fulltext"] as const) {
      const allowed = await evaluateSourcePolicy(
        {
          source_id: source.id,
          lane: "news",
          capability,
          expected_permission_version: currentPolicy.permission_version,
          resource: { url: postView.quoted.url, document_type: null, attachment: false },
        },
        undefined,
        tx,
      );
      if (allowed.decision !== "allow") quoteNeedsTranslation = false;
    }
  }
  if (!quotedTranslation && storedPostView && !quoteNeedsTranslation) storedPostView.quoteRecipe = null;
  const noMainText = originalPostCopy(post, article.url) !== null;
  const needsTranslation =
    selected &&
    visibility === "public" &&
    !!language &&
    admitted &&
    chineseCopy &&
    bodyMode === "full" &&
    ((!noMainText &&
      !nativeChinese &&
      !wholeChinese &&
      (!post || postPermission(currentPolicy, source.id, article.url, "public_translation", now.getTime()))) ||
      quoteNeedsTranslation) &&
    source.participation_mode === "editorial" &&
    (!override?.visibility || override.visibility === "public");
  if (needsTranslation) {
    if (forTranslation) forTranslation(article.revision);
    else await enqueue(QUEUES.translate, { articleId, lane: "news" }, { singletonKey: articleId }, tx);
  }
  const reason = selected ? pickString(f.reason, analysis?.reason_zh ?? null) : null;
  const syndicate = mayRedistribute(source, bodyMode);
  const originalTitle = post ? null : isChineseTitle && title === collapseWhitespace(article.title) ? null : collapseWhitespace(article.title);

  // Nomination and actual public confirmation are separate clocks. Waiting never times out into selection.
  const selectedReadyAt = previous?.selected_ready_at ?? (selectionCandidate ? (options.releasedAt ?? now) : null);
  let previousRelease = previous?.first_selected_at ?? null;
  if (
    !previousRelease &&
    previous?.selected &&
    previous.visibility === "public" &&
    previous.eligible &&
    previous.visible_after &&
    previous.visible_after <= now
  )
    previousRelease = previous.visible_after;
  if (!previousRelease && previous?.selected_ready_at) {
    const [history] = await tx<{ at: Date | null }[]>`SELECT min(l.visible_at) AS at FROM selected_ledger l
      WHERE l.article_id=${articleId} AND l.op='upsert' AND l.visible_at<=${now}
      AND NOT EXISTS(SELECT 1 FROM selected_ledger canceled WHERE canceled.article_id=l.article_id
        AND canceled.op='remove' AND canceled.seq>l.seq AND canceled.changed_at<l.visible_at)`;
    previousRelease = history?.at ?? null;
  }
  const firstSelectedAt = previousRelease ?? (selected && visibility === "public" ? (options.releasedAt ?? now) : null);
  const visibleAfter = selected ? (firstSelectedAt ?? options.releasedAt ?? now) : null;

  const indexable = isIndexable({
    visibility,
    hasSummary: !!displaySummary,
    selected,
    seoIndexedAt: previous?.seo_indexed_at ?? null,
    seoExcludedAt: previous?.seo_excluded_at ?? null,
  });
  const searchText = collapseWhitespace(
    [title, originalTitle, displaySummary, source.name, ...displayTags(tags), ...(analysis?.subjects ?? [])].filter(Boolean).join(" "),
  ).toLowerCase();

  // Independent selected articles retain their arrival and never date the ordinary reading group.
  let sortAt: Date = article.timeline_at;
  if (selected && membership?.fact_id && !isIndependentSelectedSource(source.id)) {
    const [anchor] = await tx<{ t: Date | null }[]>`
      SELECT min(p.timeline_at) AS t FROM publications p
      WHERE p.fact_id = ${membership.fact_id} AND p.eligible AND p.visibility = 'public' AND p.article_id <> ${articleId}
        AND ${foldableSelectionCondition()}`;
    if (anchor?.t && anchor.t < sortAt) sortAt = anchor.t;
  }

  const next = {
    visibility,
    operator_withdrawn: operatorWithdrawn,
    eligible,
    selected,
    selection_candidate: selectionCandidate,
    representative_priority: priority,
    title: title ?? collapseWhitespace(article.title),
    original_title: originalTitle,
    summary,
    source_excerpt: sourceExcerpt,
    reason,
    category,
    tags,
    score: round1(score),
    body_mode: bodyMode,
    story_id: membership?.story_id ?? null,
    fact_id: membership?.fact_id ?? null,
    indexable,
  };
  const changed =
    !previous ||
    (post && previous.original_post_admission_required !== admissionRequired) ||
    previous.is_original_post !== !!post ||
    stableJson(previous.x_post ?? null) !== stableJson(storedPostView) ||
    (previous.x_post_revision ?? null) !== (post ? article.revision : null) ||
    manualChanged ||
    stableJson(previous.source_time) !== stableJson(sourceTime) ||
    previous.source_time_material_revision !== article.revision ||
    Number(previous.source_date_version) !== Number(article.source_date_version) ||
    previous.source_date_config_hash !== timeConfigHash ||
    stableJson(previous.company_context ?? []) !== stableJson(companyContext) ||
    stableJson({ ...next, tags: [...next.tags].sort() }) !==
      stableJson({
        visibility: previous.visibility,
        operator_withdrawn: previous.operator_withdrawn,
        eligible: previous.eligible,
        selected: previous.selected,
        selection_candidate: previous.selection_candidate,
        representative_priority: previous.representative_priority,
        title: previous.title,
        original_title: previous.original_title,
        summary: previous.summary,
        source_excerpt: previous.source_excerpt,
        reason: previous.reason,
        category: previous.category,
        tags: [...previous.tags].sort(),
        score: previous.score === null ? null : Number(previous.score),
        body_mode: previous.body_mode,
        story_id: previous.story_id,
        fact_id: previous.fact_id,
        indexable: previous.indexable,
      });
  const wasPublic = !!previous && previous.visibility !== "withdrawn" && previous.eligible;
  if (recomputed?.evidence && previous?.selection_candidate !== selectionCandidate) {
    await audit(
      "worker",
      "selection.recompute",
      `article:${articleId}`,
      "来源分级门槛变更，复用原两次评分",
      { selected: previous?.selected ?? null, selectionCandidate: previous?.selection_candidate ?? null },
      { ...recomputed.evidence, selected, selectionCandidate, promptVersion: analysis!.prompt_version },
      undefined,
      tx,
    );
  }
  const reduced =
    wasPublic &&
    (visibility === "withdrawn" ||
      !eligible ||
      (previous!.visibility === "public" && visibility !== "public") ||
      (previous!.selected && !selected) ||
      (previous!.body_mode === "full" && bodyMode !== "full"));
  if (visibility === "public" && eligible && !reduced) await requireRuntimeRunning("news", ["publication"], tx);
  const revision = previous ? previous.revision + (changed ? 1 : 0) : 1;
  const firstPublicationObserved = previous ? previous.first_publication_observed === true : true;
  const firstPublicAt = previous?.first_public_at ?? (firstPublicationObserved && visibility === "public" && eligible ? now : null);

  await tx`
    INSERT INTO publications (article_id, analysis_id, revision, visibility, operator_withdrawn, eligible, selected, selection_candidate, representative_priority, title, original_title, summary, source_excerpt,
      reason, category, tags, score, source_id, channel, first_party, url, published_at, discovered_at, timeline_at, backfill,
      selected_ready_at, first_selected_at, visible_after, body_mode, syndicate, indexable, story_id, fact_id, search_text, sort_at, updated_at,first_public_at,first_publication_observed)
    VALUES (${articleId}, ${analysis?.id ?? null}, ${revision}, ${visibility}, ${operatorWithdrawn}, ${eligible}, ${selected}, ${selectionCandidate}, ${priority}, ${next.title},
      ${originalTitle}, ${summary}, ${sourceExcerpt}, ${reason}, ${category}, ${tags}, ${next.score}, ${source.id}, 'news', ${source.first_party},
      ${article.url}, ${article.published_at}, ${article.discovered_at}, ${article.timeline_at}, ${article.backfill},
      ${selectedReadyAt}, ${firstSelectedAt}, ${visibleAfter}, ${bodyMode}, ${syndicate}, ${indexable}, ${next.story_id}, ${next.fact_id}, ${searchText}, ${sortAt}, now(),${firstPublicAt},${firstPublicationObserved})
    ON CONFLICT (article_id) DO UPDATE SET
      analysis_id = EXCLUDED.analysis_id, revision = EXCLUDED.revision, visibility = EXCLUDED.visibility, operator_withdrawn=EXCLUDED.operator_withdrawn,
      eligible = EXCLUDED.eligible, selected = EXCLUDED.selected, selection_candidate = EXCLUDED.selection_candidate, representative_priority=EXCLUDED.representative_priority, title = EXCLUDED.title, original_title = EXCLUDED.original_title,
      summary = EXCLUDED.summary, source_excerpt = EXCLUDED.source_excerpt, reason = EXCLUDED.reason, category = EXCLUDED.category, tags = EXCLUDED.tags,
      score = EXCLUDED.score, source_id = EXCLUDED.source_id, channel = EXCLUDED.channel, first_party = EXCLUDED.first_party,
      url = EXCLUDED.url, published_at = EXCLUDED.published_at, discovered_at = EXCLUDED.discovered_at,
      timeline_at = EXCLUDED.timeline_at, backfill = EXCLUDED.backfill, selected_ready_at = EXCLUDED.selected_ready_at, first_selected_at=EXCLUDED.first_selected_at,
      visible_after = EXCLUDED.visible_after, body_mode = EXCLUDED.body_mode, syndicate = EXCLUDED.syndicate,
      indexable = EXCLUDED.indexable, story_id = EXCLUDED.story_id, fact_id = EXCLUDED.fact_id,
      search_text = EXCLUDED.search_text, sort_at = EXCLUDED.sort_at, updated_at = now(),first_public_at=coalesce(publications.first_public_at,EXCLUDED.first_public_at)
    WHERE (publications.analysis_id, publications.revision, publications.visibility, publications.operator_withdrawn, publications.eligible,
        publications.selected, publications.selection_candidate, publications.representative_priority, publications.title, publications.original_title, publications.summary, publications.source_excerpt,
        publications.reason, publications.category, publications.tags, publications.score,
        publications.source_id, publications.channel, publications.first_party, publications.url,
        publications.published_at, publications.discovered_at, publications.timeline_at, publications.backfill,
        publications.selected_ready_at, publications.first_selected_at, publications.visible_after, publications.body_mode, publications.syndicate,
        publications.indexable, publications.story_id, publications.fact_id, publications.search_text,
        publications.sort_at,publications.first_public_at)
      IS DISTINCT FROM (EXCLUDED.analysis_id, EXCLUDED.revision, EXCLUDED.visibility, EXCLUDED.operator_withdrawn, EXCLUDED.eligible,
        EXCLUDED.selected, EXCLUDED.selection_candidate, EXCLUDED.representative_priority, EXCLUDED.title, EXCLUDED.original_title, EXCLUDED.summary, EXCLUDED.source_excerpt,
        EXCLUDED.reason, EXCLUDED.category, EXCLUDED.tags, EXCLUDED.score,
        EXCLUDED.source_id, EXCLUDED.channel, EXCLUDED.first_party, EXCLUDED.url,
        EXCLUDED.published_at, EXCLUDED.discovered_at, EXCLUDED.timeline_at, EXCLUDED.backfill,
        EXCLUDED.selected_ready_at, EXCLUDED.first_selected_at, EXCLUDED.visible_after, EXCLUDED.body_mode, EXCLUDED.syndicate,
        EXCLUDED.indexable, EXCLUDED.story_id, EXCLUDED.fact_id, EXCLUDED.search_text,
        EXCLUDED.sort_at,EXCLUDED.first_public_at)`;

  await tx`UPDATE publications SET is_original_post=${!!post},x_post=${storedPostView ? tx.json(storedPostView) : null},x_post_revision=${post ? article.revision : null},original_post_admission_required=${admissionRequired}
    WHERE article_id=${articleId} AND (is_original_post,x_post,x_post_revision,original_post_admission_required) IS DISTINCT FROM (${!!post},${storedPostView ? tx.json(storedPostView) : null},${post ? article.revision : null},${admissionRequired})`;
  await tx`UPDATE publications SET source_time=${sourceTime ? tx.json(sourceTime) : null},source_time_material_revision=${article.revision},source_date_version=${Number(article.source_date_version)},source_date_config_hash=${timeConfigHash}
    WHERE article_id=${articleId} AND (source_time,source_time_material_revision,source_date_version,source_date_config_hash)
    IS DISTINCT FROM (${sourceTime ? tx.json(sourceTime) : null},${article.revision},${Number(article.source_date_version)},${timeConfigHash})`;
  await tx`UPDATE publications SET company_context=${tx.json(companyContext as never)} WHERE article_id=${articleId} AND company_context IS DISTINCT FROM ${tx.json(companyContext as never)}`;
  const geographyChanged = await projectNewsGeography(tx, article, analysis?.id ?? null, f.geography);
  // The pool search row follows eligibility; its body part only covers full text the site may show.
  if (eligible) {
    const body = !post && bodyMode === "full" ? (article.body_text ?? "").slice(0, 12000).toLowerCase() : "";
    await tx`INSERT INTO pool_search (article_id, direct, body) VALUES (${articleId}, ${searchText}, ${body})
             ON CONFLICT (article_id) DO UPDATE SET direct = EXCLUDED.direct, body = EXCLUDED.body
             WHERE pool_search.direct IS DISTINCT FROM EXCLUDED.direct OR pool_search.body IS DISTINCT FROM EXCLUDED.body`;
  } else {
    await tx`DELETE FROM pool_search WHERE article_id = ${articleId}`;
  }

  // Content-group push: once, for an item that arrives live and becomes selected (never for imports,
  // backfill or stale-on-discovery material); it runs after the release gate opens.
  if (selected && !previousRelease && !options.releasedAt && !article.backfill && visibility === "public") {
    const at = visibleAfter && visibleAfter > now ? visibleAfter : now;
    await enqueue(
      QUEUES.notifySelected,
      { articleId, lane: "news" },
      { singletonKey: `selected:${articleId}`, startAfter: new Date(at.getTime() + 5_000) },
      tx,
    );
  }

  const seatChanges = await settleSelectedSeats(tx, articleId, previous?.fact_id ?? null, now);
  const ledger = seatChanges.ledger;
  if (previous && (changed || seatChanges.changed || geographyChanged))
    await emit(
      "articleChanged",
      { id: articleId, kind: "content", reduced, reason: "republication", previousStoryIds: previous.story_id === null ? [] : [previous.story_id] },
      tx,
    );
  return { articleId, changed: changed || seatChanges.changed || geographyChanged, selected, visibility, ledger, reduced };
}

interface SeatRow {
  article_id: string;
  source_id: string;
  fact_id: number | null;
  selected: boolean;
  selection_candidate: boolean;
  seat: boolean;
  representative_priority: number;
  eligible: boolean;
  visibility: string;
  body_mode: string;
  score: number | null;
  timeline_at: Date;
  sort_at: Date;
  visible_after: Date | null;
  title: string;
  original_title: string | null;
  summary: string | null;
  url: string;
  published_at: Date | null;
  source_time: unknown;
  discovered_at: Date;
  category: string | null;
  reason: string | null;
}

async function syncSelectedLedger(tx: Tx, row: SeatRow, sourceName: string, now: Date): Promise<"upsert" | "remove" | null> {
  const articleId = row.article_id;
  const inSet = row.selected && row.seat && row.eligible && row.visibility === "public";
  const [state] = await tx<{ in_set: boolean; payload_hash: string | null }[]>`SELECT in_set,payload_hash FROM selected_state WHERE article_id=${articleId}`;
  if (inSet) {
    const payload = v1Payload({
      articleId,
      title: row.title,
      originalTitle: row.original_title,
      summary: row.summary,
      sourceName,
      url: row.url,
      publishedAt: sourceInstant(row.source_time),
      discoveredAt: row.discovered_at,
      category: row.category,
      score: row.score,
      selected: true,
      reason: row.reason,
    });
    const hash = sha256(stableJson(payload));
    if (!state?.in_set || state.payload_hash !== hash) {
      const visibleAt = row.visible_after && row.visible_after > now ? row.visible_after : now;
      const seq = await appendLedger(tx, articleId, "upsert", payload, visibleAt, now);
      await tx`INSERT INTO selected_state(article_id,in_set,payload_hash,last_seq) VALUES(${articleId},true,${hash},${seq})
        ON CONFLICT(article_id) DO UPDATE SET in_set=true,payload_hash=EXCLUDED.payload_hash,last_seq=EXCLUDED.last_seq`;
      return "upsert";
    }
  } else if (state?.in_set) {
    const seq = await appendLedger(tx, articleId, "remove", null, now, now);
    await tx`UPDATE selected_state SET in_set=false,payload_hash=NULL,last_seq=${seq} WHERE article_id=${articleId}`;
    return "remove";
  }
  return null;
}

/** One ordinary seat per fact, plus each independent selected article; ledger changes commit together. */
async function settleSelectedSeats(tx: Tx, articleId: string, previousFact: number | null, now: Date) {
  const [self] = await tx<{ fact_id: number | null }[]>`SELECT fact_id FROM publications WHERE article_id=${articleId}`;
  const facts = [...new Set([previousFact, self?.fact_id].filter((id): id is number => id !== null && id !== undefined))];
  const rows = await tx<
    SeatRow[]
  >`SELECT article_id,source_id,fact_id,selected,selection_candidate,seat,representative_priority,eligible,visibility,body_mode,score,
    timeline_at,sort_at,visible_after,title,original_title,summary,url,published_at,source_time,discovered_at,category,reason
    FROM publications WHERE article_id=${articleId} OR fact_id=ANY(${facts}::bigint[]) ORDER BY article_id`;
  const sources = new Map((await representativeSourceIdentities([...new Set(rows.map((r) => r.source_id))], tx)).map((s) => [s.id, s.name]));
  const chosen = new Set<string>();
  const groups = new Map<string, SeatRow[]>();
  const independent = new Set(independentSelectedSources());
  const independentRow = (row: SeatRow) => row.selected && row.selection_candidate && independent.has(row.source_id);
  const anchorFacts = new Set(rows.filter((r) => r.fact_id !== null && independent.has(r.source_id)).map((r) => r.fact_id!));
  const priorSeats = new Map<number, number>();
  for (const row of rows)
    if (
      row.fact_id !== null &&
      row.selected &&
      row.selection_candidate &&
      row.seat &&
      row.eligible &&
      row.visibility === "public" &&
      (row.article_id !== articleId || previousFact === row.fact_id)
    )
      priorSeats.set(row.fact_id, (priorSeats.get(row.fact_id) ?? 0) + 1);
  // Multiple existing seats also identify a fact whose independent policy was removed.
  for (const [fact, count] of priorSeats) if (count > 1) anchorFacts.add(fact);
  const anchors = new Map<number, number>();
  for (const row of rows)
    if (row.fact_id !== null && row.eligible && row.visibility === "public" && !independentRow(row))
      anchors.set(row.fact_id, Math.min(anchors.get(row.fact_id) ?? Infinity, row.timeline_at.getTime()));
  for (const row of rows)
    if (row.selected && row.eligible && row.visibility === "public") {
      const key = row.fact_id === null || independentRow(row) ? `article:${row.article_id}` : `fact:${row.fact_id}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
  for (const members of groups.values()) chosen.add(pickRepresentative(members).article_id);
  let changed = false,
    ledger: "upsert" | "remove" | null = null;
  const replaced: Array<{ row: SeatRow; reason: string }> = [];
  // Remove old seats first; all changes become visible at this transaction's commit.
  rows.sort((a, b) => Number(chosen.has(a.article_id)) - Number(chosen.has(b.article_id)) || a.article_id.localeCompare(b.article_id));
  for (const row of rows) {
    const seat = chosen.has(row.article_id);
    const seatChanged = seat !== row.seat;
    // Reprojecting one source also repairs the ordinary members' previously shared anchor.
    const sortAt = new Date(
      row.fact_id !== null && anchorFacts.has(row.fact_id)
        ? row.selected && !independentRow(row)
          ? Math.min(row.timeline_at.getTime(), anchors.get(row.fact_id) ?? Infinity)
          : row.timeline_at.getTime()
        : row.sort_at.getTime(),
    );
    if (seatChanged || sortAt.getTime() !== row.sort_at.getTime()) {
      changed = true;
      await tx`UPDATE publications SET seat=${seat},sort_at=${sortAt},revision=revision+1,updated_at=${now} WHERE article_id=${row.article_id}`;
      if (seatChanged && seat)
        await enqueue(
          QUEUES.notifySelected,
          { articleId: row.article_id, lane: "news" },
          { singletonKey: `selected:${row.article_id}`, startAfter: new Date(now.getTime() + 5000) },
          tx,
        );
      row.seat = seat;
      row.sort_at = sortAt;
      if (row.article_id !== articleId) replaced.push({ row, reason: seatChanged ? "selected representative changed" : "selected reading-group time changed" });
    }
    const result = await syncSelectedLedger(tx, row, sources.get(row.source_id) ?? "", now);
    if (row.article_id === articleId) ledger = result;
  }
  for (const { row, reason } of replaced) await emit("articleChanged", { id: row.article_id, kind: "content", reduced: !row.seat, reason }, tx);
  return { changed, ledger };
}

/**
 * Re-derives every published article of one source (after its participation, licences, tier or name
 * changed) without calling models. Runs in the worker; progress goes to the callback. One item's failure
 * does not stop the rest: failed items are tried once more at the end, and those still failing keep their
 * stored projection and are counted (the first 20 ids go into the job's result; the source page does not
 * show them yet).
 */
export async function republishSource(
  sourceId: string,
  onProgress?: (done: number, total: number) => Promise<void>,
): Promise<{ total: number; changed: number; reduced: number; failed: number; failedIds: string[]; deferred: number }> {
  const { total } = one(await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM publications WHERE source_id = ${sourceId}`);
  let after = "";
  let done = 0;
  let changed = 0;
  let reduced = 0;
  const retry: string[] = [];
  const deferred = new Set<string>();
  const attempt = async (articleId: string): Promise<boolean> => {
    // Stopping mid-way is safe: the job is retried after the restart and re-derives from the start.
    if (shutdownSignal.signal.aborted) throw new Error("worker is stopping; republish resumes after restart");
    try {
      const r = await publishArticle(articleId);
      if (r?.changed) changed += 1;
      if (r?.reduced) reduced += 1;
      return true;
    } catch (error) {
      if (error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale) {
        deferred.add(articleId);
        return true;
      }
      if (shutdownSignal.signal.aborted) throw error;
      return false;
    }
  };
  for (;;) {
    const batch = await sql<{ article_id: string }[]>`
      SELECT article_id FROM publications WHERE source_id = ${sourceId} AND article_id > ${after} ORDER BY article_id LIMIT 500`;
    if (batch.length === 0) break;
    for (const { article_id } of batch) if (!(await attempt(article_id))) retry.push(article_id);
    done += batch.length;
    after = batch[batch.length - 1]!.article_id;
    await onProgress?.(done, total);
  }
  // A passing failure (a lock wait, a dropped connection) gets one more try; it costs no model call.
  const failedIds: string[] = [];
  for (const articleId of retry) if (!(await attempt(articleId))) failedIds.push(articleId);
  return { total, changed, reduced, failed: failedIds.length, failedIds: failedIds.slice(0, 20), deferred: deferred.size };
}

/** Private composition provenance, restricted to the still eligible news projection. No model work on reads. */
export async function newsCompositionPublications(articleIds: string[]) {
  if (!articleIds.length) return [];
  return sql<
    {
      article_id: string;
      analysis_id: number | null;
      revision: number;
      source_id: string;
      title: string;
      summary: string | null;
      category: string | null;
      manual_material_revision: number | null;
      manual_state: string | null;
    }[]
  >`
    SELECT p.article_id,p.analysis_id,p.revision,p.source_id,p.title,p.summary,p.category,m.material_revision AS manual_material_revision,m.state AS manual_state FROM publications p
    LEFT JOIN publication.manual_copies m ON m.article_id=p.article_id
    WHERE p.article_id=ANY(${articleIds}::text[]) AND p.visibility='public' AND p.eligible AND p.channel='news' ORDER BY p.article_id`;
}

/** Report corrections preserve the issue's references while resolving their current public facts. */
export async function currentReportPublications(ids: string[], db: Db = sql) {
  const rows = await fetchItemsByIds(ids, db);
  return ids.flatMap((id) => {
    const row = rows.get(id);
    if (row?.visibility !== "public" || !row.eligible || row.source_mode !== "editorial") return [];
    return [
      {
        itemId: id,
        publicationRevision: row.revision,
        factId: null,
        storyPublicId: row.story_public_id,
        title: row.title,
        summary: row.summary ?? "",
        sourceName: row.source_name,
        sourceUrl: row.url,
        sourceId: row.source_id,
        firstParty: row.first_party,
        role: row.first_party ? "官方" : row.source_kind === "mp_account" ? "公众号" : "媒体",
        score: row.score,
        publishedAt: (row.published_at ?? row.discovered_at).toISOString(),
        category: row.category,
        factKey: row.fact_id ? `fact:${row.fact_id}` : `a:${id}`,
      },
    ];
  });
}

export async function lockReportPublications(ids: string[], db: Db) {
  if (ids.length) await db`SELECT article_id FROM publications WHERE article_id=ANY(${ids}::text[]) ORDER BY article_id FOR SHARE`;
}

export {
  newsRelationJurisdictions,
  publicNewsDigestInput,
  readGroupingSelectionSnapshot,
  readConfirmedGroupingItems,
  selectedGroupingRecipeInputs,
} from "./items.ts";
export type { GroupingSelectionSnapshot } from "./items.ts";
export type { HistoricalAnchorExtractor, HistoricalBackgroundReader, HistoricalBackgroundProjector } from "@amp/contracts/site";

export async function publishedStoryId(articleId: string, tx: Tx): Promise<number | null> {
  const [row] = await tx<{ story_id: number | null }[]>`SELECT story_id FROM publications WHERE article_id=${articleId}`;
  return row?.story_id ?? null;
}

export { readGroupingEvidencePublications } from "./items.ts";

/** Bounded server maintenance for existing records. Only time fields and their sync projection change; no model call or re-scoring. */
export async function repairPublicationTimes(limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid time repair bound");
  let control;
  try {
    control = await requireRuntimeRunning("news", ["publication"]);
  } catch (error) {
    if (error instanceof RuntimeControlPaused) return { checked: 0, changed: 0, waiting: true };
    throw error;
  }
  const ids = await pendingSourceTimeProjectionIds(limit);
  let changed = 0,
    checked = 0;
  const failures: unknown[] = [];
  for (const id of ids) {
    try {
      const updated = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
        await assertRuntimeControl(tx, control);
        const [previous] = await tx<(PublicationRow & SeatRow)[]>`SELECT * FROM publications WHERE article_id=${id} FOR UPDATE`;
        const [material] = await newsMaterialBindings([id], tx);
        if (!previous || !material || previous.source_id !== material.source_id) return false;
        const now = new Date(),
          projection = await sourceTimeForMaterial(material, now, tx);
        if (!projection) return false;
        if (
          stableJson(previous.source_time) === stableJson(projection.time) &&
          previous.source_time_material_revision === material.revision &&
          Number(previous.source_date_version) === Number(material.source_date_version) &&
          previous.source_date_config_hash === projection.configHash
        )
          return false;
        await tx`UPDATE publications SET source_time=${projection.time ? tx.json(projection.time) : null},source_time_material_revision=${material.revision},source_date_version=${Number(material.source_date_version)},source_date_config_hash=${projection.configHash},revision=revision+1,updated_at=now() WHERE article_id=${id}`;
        const [source] = await representativeSourceIdentities([material.source_id], tx);
        await syncSelectedLedger(tx, { ...previous, source_time: projection.time }, source?.name ?? "", now);
        await emit("articleChanged", { id, kind: "content", reason: "source date correction" }, tx);
        return true;
      });
      checked++;
      if (updated) changed++;
    } catch (error) {
      if (error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale) return { checked, changed, waiting: true };
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Some source time projections could not be refreshed");
  return { checked, changed, waiting: false };
}
