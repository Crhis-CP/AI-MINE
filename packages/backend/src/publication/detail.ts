import { originalPostAdmissionCondition } from "./items.ts";
import { originalPostAffectedStories } from "./groups.ts";
import { foldCopies, readStoryReportLines, storyLine } from "./stories.ts";
import { CURRENT_SOURCE_TIME } from "./source-time.ts";
import { attachSourcePolicies } from "./reader-context.ts";
import { compatibleGeographyRecipes } from "../editorial/geography.ts";
import { publicCompanyContext, readerAttribution } from "./reader-context.ts";
// Item detail, behind the visibility and licence rules every public output shares.
import { relatedPoliciesForNews } from "./news-policy-links.ts";
import type { ItemDetail, SiteItemDetail, OutlineEntry, StoryRef } from "@amp/contracts/site";
import { linkBodyImages } from "../content/sanitize.ts";
import { sql, type Db } from "../db.ts";
import {
  ITEM_COLUMNS,
  ITEM_FROM,
  confirmedSelected,
  englishCopyOf,
  fetchItemsByIds,
  jurisdictionHits,
  selectedCondition,
  toItemSummary,
  type ItemRow,
} from "./items.ts";
import { filterHits } from "./mentions.ts";
import { JURISDICTIONS } from "@amp/industry/jurisdictions";
import { ARTICLE_ID_PATTERN, toPublicApiCategory, type PublicApiCategoryKey } from "@amp/contracts/taxonomy";
import { attachRepresentativePriority, pickRepresentative } from "./representative.ts";
import { hasItemPage } from "./rules.ts";
import type { CategoryKey } from "@amp/contracts/taxonomy";
import {
  isChineseOriginal,
  readableTranslation,
  readablePartialTranslation,
  TRANSLATION_MANIFEST_FORMAT,
  type StoredTranslation,
} from "../editorial/translation-readiness.ts";
import { promptVersion } from "../editorial/prompts.ts";
import { looksZh } from "../editorial/writing.ts";
import { currentPostView, postPermission, postQuoteHtml } from "./post-view.ts";

const RECIPE = `${TRANSLATION_MANIFEST_FORMAT}:${promptVersion("translate-body")}`;

interface DetailRow extends ItemRow {
  /** Persisted release gate, independent of the confirmed selection badge. */
  release_gated: boolean;
  first_public_at: Date | null;
  body_html: string | null;
  manual_body_html: string | null;
  manual_revision_label: string | null;
  body_text: string | null;
  body_status: string;
  content_revision: number;
  source_site_fulltext: boolean;
  source_syndicate_fulltext: boolean;
  machine_summary: string | null;
  translation: StoredTranslation;
}

export type DetailResult = { kind: "found"; detail: ItemDetail; row: DetailRow } | { kind: "not_found" };
export type DetailReadCache = Map<string, Promise<ItemDetail["eventCoverage"]>>;

/** A body picture's link ("查看配图…", linkBodyImages) does not name the heading it sits in. */
const PICTURE_LINK = /<a\b(?:[^>"']|"[^"]*"|'[^']*')*>查看配图[^<]*<\/a>/g;

/** Adds stable ids to h2–h4 and returns the outline. */
function withOutline(html: string): { html: string; outline: OutlineEntry[] } {
  const outline: OutlineEntry[] = [];
  let n = 0;
  const out = html.replace(/<h([2-4])(?: id="sec-\d+")?>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
    n += 1;
    const id = `sec-${n}`;
    const text = inner
      .replace(PICTURE_LINK, "")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (text) outline.push({ id, text: text.slice(0, 80), level: Number(level) });
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
  return { html: out, outline };
}

async function loadRow(id: string): Promise<DetailRow | null> {
  const [row] = await sql<DetailRow[]>`
    SELECT ${ITEM_COLUMNS()}, p.selected AS release_gated, p.first_public_at, (SELECT label FROM publication.manual_copies m WHERE m.article_id=a.id AND m.material_revision=a.revision AND m.state IN ('active','needs_review')) AS manual_revision_label, (SELECT body_html FROM publication.manual_copies m WHERE m.article_id=a.id AND m.material_revision=a.revision AND m.state IN ('active','needs_review')) AS manual_body_html, a.body_html, a.body_text, a.body_status, a.revision AS content_revision, s.site_fulltext AS source_site_fulltext,
      s.syndicate_fulltext AS source_syndicate_fulltext,p.summary AS machine_summary,
      jsonb_build_object('revision',tr.revision,'body_html',tr.body_html,'complete',tr.complete,'origin',tr.origin,
        'recipe',tr.recipe,'source_hash',tr.source_hash,'manifest',tr.manifest) AS translation
    ${ITEM_FROM()}
    WHERE p.article_id = ${id} AND ${originalPostAdmissionCondition()}`;
  if (row) await attachSourcePolicies([row]);
  return row ?? null;
}

/**
 * Public detail (rules.hasItemPage): items the lists leave out (low relevance, merged duplicates, no
 * Chinese summary yet) keep a noindex page; withdrawn and hot_signal items are a 404.
 */
export async function loadItemDetail(id: string, now = new Date(), machine = false, coverage?: DetailReadCache): Promise<DetailResult> {
  const row = await loadRow(id);
  if (!row || !hasItemPage({ visibility: row.visibility, sourceMode: row.source_mode })) return { kind: "not_found" };

  const summary = toItemSummary(machine ? { ...row, summary: row.machine_summary } : row);
  // The English interface's title and summary (TASK-0595): the website's detail only, never the machine one.
  const englishCopy = machine ? null : englishCopyOf(row);
  const english = englishCopy ? { english: englishCopy } : {};
  if (row.visibility === "summary-only") {
    const detail: ItemDetail = {
      ...summary,
      reason: null,
      tags: [],
      readingMode: "summary-only",
      readingState: "restricted",
      firstPublicAt: row.first_public_at?.toISOString() ?? null,
      attribution: readerAttribution(row.source_name, row.url, row.source_policy),
      author: null,
      language: row.language,
      body: null,
      outline: [],
      relatedStories: [],
      indexable: false,
      group: null,
      ...english,
    };
    return { kind: "found", detail, row };
  }

  const relatedRows = await sql<(StoryRef & { internal_id: number })[]>`
    SELECT DISTINCT st.id AS internal_id,st.public_id::text AS "publicId", st.title
    FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id JOIN stories st ON st.id = f.story_id
    WHERE fa.article_id = ${id} AND (fa.manual OR fa.input_revision=${row.content_revision}) AND fa.role <> 'mention' AND st.merged_into IS NULL
    LIMIT 6`;
  const admissionAffected = await originalPostAffectedStories(relatedRows.map((story) => story.internal_id));
  const related = relatedRows.map(({ internal_id, ...story }) => ({ ...story, title: admissionAffected.has(internal_id) ? summary.title : story.title }));

  let body: ItemDetail["body"] = null;
  let outline: OutlineEntry[] = [];
  const originalAllowed =
    !row.is_original_post ||
    (row.x_post_revision === row.content_revision && postPermission(row.source_policy, row.source_id, row.url, "public_original_fulltext", now.getTime()));
  const translationAllowed = !row.is_original_post || postPermission(row.source_policy, row.source_id, row.url, "public_translation", now.getTime());
  if (originalAllowed && row.body_mode === "full" && row.source_site_fulltext && (row.body_html || row.manual_body_html)) {
    const isZh = isChineseOriginal(row.language, row.body_text ?? "");
    const original = linkBodyImages(row.body_html ?? "");
    const verified = isZh || !row.body_html ? null : readableTranslation(row.body_html, { revision: row.content_revision, recipe: RECIPE }, row.translation);
    const partial =
      isZh || !row.body_html || verified
        ? null
        : readablePartialTranslation(row.body_html, { revision: row.content_revision, recipe: RECIPE }, row.translation);
    const zh =
      row.manual_body_html && (translationAllowed || isZh)
        ? `<p>AI 辅助整理，经人工修订</p>${linkBodyImages(row.manual_body_html)}`
        : isZh
          ? original
          : translationAllowed && (verified || partial)
            ? linkBodyImages((verified ?? partial)!)
            : null;
    const primary = withOutline(zh ?? original);
    outline = primary.outline;
    body = {
      zh: zh ? primary.html : null,
      original: zh && !isZh ? (original ? withOutline(original).html : null) : isZh ? null : primary.html,
      zhKind: isZh ? "original" : zh ? "translation" : null,
      complete: !!row.manual_body_html || isZh || verified !== null,
    };
  }

  let group: ItemDetail["group"] = null;
  if (row.fact_id) {
    // Copies of one report (copyGroups) count once, as in the list the group opens.
    const members = foldCopies(
      await sql<{ public_id: string; id: string; source_id: string; title: string; original_title: string | null; first_party: boolean; at: Date }[]>`
      SELECT f.public_id, p.article_id AS id, p.source_id, p.title, p.original_title, p.first_party, coalesce(p.published_at, p.discovered_at) AS at
      FROM facts f JOIN publications p ON p.fact_id = f.id
      WHERE f.id = ${row.fact_id} AND p.visibility = 'public' AND ${originalPostAdmissionCondition()} AND p.eligible AND (NOT p.selected OR p.visible_after <= ${now})`,
    );
    const g = members.length ? { public_id: members[0]!.public_id, reports: members.length, sources: new Set(members.map((m) => m.source_id)).size } : null;
    const [dev] = await sql<{ n: number }[]>`
      SELECT count(DISTINCT other.id) AS n FROM facts f
      JOIN facts other ON other.story_id = f.story_id AND other.id <> f.id
      JOIN publications p ON p.fact_id = other.id
      WHERE f.id = ${row.fact_id} AND f.story_id IS NOT NULL AND ${selectedCondition(now)}`;
    if (g) {
      group = {
        factId: g.public_id,
        story: summary.story,
        reportCount: Number(g.reports),
        additionalSourceCount: Math.max(0, Number(g.sources) - 1),
        developmentCount: Number(dev?.n ?? 0),
      };
    }
  }

  const post = row.is_original_post ? currentPostView(row, now.getTime()) : undefined;
  const detail: ItemDetail = {
    ...summary,
    readingMode: "full",
    readingState:
      !row.source_site_fulltext || !originalAllowed
        ? "restricted"
        : body?.zh || post?.quoted
          ? "available"
          : row.body_status === "pending" || (body?.original && !body.complete)
            ? "pending"
            : "unavailable",
    firstPublicAt: row.first_public_at?.toISOString() ?? null,
    eventCoverage: row.story_id ? await requestEventCoverage(row.story_id, now, machine, coverage) : null,
    manualRevisionLabel: row.manual_revision_label,
    companyContext: await publicCompanyContext(id),
    relatedPolicies: await relatedPoliciesForNews(id),
    attribution: readerAttribution(row.source_name, row.url, row.source_policy),
    author: row.author,
    language: row.language,
    body,
    outline,
    relatedStories: related,
    indexable: row.indexable,
    group,
    ...(row.is_original_post ? { x: post ?? null } : {}),
    ...english,
  };
  return { kind: "found", detail, row };
}

/** Current public event members: first-party representation and the latest distinct fact stay separate. */
function requestEventCoverage(storyId: number, now: Date, machine: boolean, cache?: DetailReadCache) {
  const key = `${storyId}:${machine}`;
  let pending = cache?.get(key);
  if (!pending) {
    pending = eventCoverage(storyId, now, machine);
    cache?.set(key, pending);
  }
  return pending;
}

async function eventCoverage(storyId: number, now: Date, machine: boolean): Promise<NonNullable<ItemDetail["eventCoverage"]> | null> {
  const rows = await sql<(ItemRow & { machine_summary: string | null })[]>`SELECT ${ITEM_COLUMNS()},p.summary AS machine_summary ${ITEM_FROM()}
    WHERE p.story_id=${storyId} AND p.visibility='public' AND ${originalPostAdmissionCondition()} AND p.eligible AND s.participation_mode='editorial'
      AND (NOT p.selected OR p.visible_after <= ${now})
    ORDER BY p.timeline_at ASC,p.article_id ASC`;
  // Copies of one report count once; "最新进展" is the development the story page marks as the newest.
  const kept = foldCopies(rows.map((row) => Object.assign(row, { at: row.published_at ?? row.discovered_at })));
  if (kept.length < 2) return null;
  await attachSourcePolicies(kept);
  await attachRepresentativePriority(kept);
  const line = storyLine(await readStoryReportLines([storyId], now));
  let latest = kept.filter((row) => line.developmentOf.get(row.id) === line.developments.length - 1);
  if (!latest.length) {
    const facts = new Map<string, (typeof kept)[number][]>();
    for (const row of kept) {
      const key = row.fact_id === null ? row.id : String(row.fact_id);
      facts.set(key, [...(facts.get(key) ?? []), row]);
    }
    latest = [...facts.values()].sort((a, b) => Math.min(...b.map((r) => r.sort_at.getTime())) - Math.min(...a.map((r) => r.sort_at.getTime())))[0]!;
  }
  const project = (row: (typeof rows)[number]) => toItemSummary(machine ? { ...row, summary: row.machine_summary } : row);
  return { representative: project(pickRepresentative(kept)), latest: project(pickRepresentative(latest)), reportCount: kept.length };
}

/** Site reading projection: default text remains SSR, a second language has its own readable URL. */
export function siteItemDetail(detail: ItemDetail, original = false, opts: { originalWhilePending?: boolean } = {}): SiteItemDetail {
  const hasTranslation = (!!detail.body?.zh && detail.body.zhKind === "translation" && !!detail.body.original) || !!detail.x?.quoted?.translation;
  // While a foreign article's Chinese translation is still being made, the reading page shows the original text
  // (readingState stays "pending", so the page can say the translation is on its way). TASK-0569.
  const pendingOriginal = !original && opts.originalWhilePending !== false && detail.readingState === "pending" && !detail.body?.zh && !!detail.body?.original;
  const bodyLanguage = (original || pendingOriginal) && (detail.body?.original || detail.x) ? "original" : "zh";
  const originalHtml = detail.body?.original ?? (detail.body?.zhKind === "original" ? detail.body.zh : null);
  const selectedHtml = bodyLanguage === "zh" ? detail.body?.zh : originalHtml;
  return {
    ...detail,
    hasTranslation,
    bodyLanguage,
    readingState: selectedHtml && !pendingOriginal ? "available" : detail.readingState,
    body: detail.body
      ? { ...detail.body, zh: bodyLanguage === "zh" ? detail.body.zh : null, original: bodyLanguage === "original" ? originalHtml : null }
      : null,
    outline: selectedHtml ? withOutline(selectedHtml).outline : [],
  };
}

/** Machine reading never inherits the website's source-excerpt fallback or its full-text licence. */
export async function machineItemDetail(id: string, language: "zh" | "original" = "zh", now = new Date()) {
  const found = await loadItemDetail(id, now, true);
  if (found.kind !== "found" || (found.row.release_gated && (!found.row.visible_after || found.row.visible_after > now))) return null;
  const { score: _score, ...view } = siteItemDetail(found.detail, language === "original", { originalWhilePending: false }),
    allowed = found.row.syndicate && found.row.source_syndicate_fulltext && found.row.source_site_fulltext && view.readingMode === "full";
  const quoteHtml = allowed ? postQuoteHtml(view.x, language === "original") : "";
  const baseHtml = view.body?.zh ?? view.body?.original ?? null;
  const html = [baseHtml, quoteHtml].filter(Boolean).join("\n") || null,
    capacity = html !== null && Buffer.byteLength(html) > 256 * 1024,
    readable = allowed && html !== null && !capacity;
  const body = !found.row.is_original_post
    ? readable
      ? view.body
      : null
    : readable
      ? {
          zh: language === "zh" ? html : null,
          original: language === "original" ? html : null,
          zhKind: view.body?.zhKind ?? (view.x?.quoted?.translation ? ("translation" as const) : null),
          complete: !!view.body?.complete && (!view.x?.quoted || language === "original" || !!view.x.quoted.translation || looksZh(view.x.quoted.text)),
        }
      : null;
  return {
    item: {
      ...view,
      summary: found.row.is_original_post ? found.detail.summary : found.row.machine_summary,
      ...(found.row.is_original_post && !readable ? { x: null } : {}),
      body,
      outline: readable ? view.outline : [],
    },
    reading: {
      redistribution: allowed ? ("allowed" as const) : ("restricted" as const),
      state: readable ? (body?.complete ? ("complete" as const) : ("partial" as const)) : ("link_only" as const),
      reason: !allowed
        ? "全文站外再分发未获许可，请到本站或原文阅读。"
        : capacity
          ? "正文超过单次机器输出容量，请到本站或原文完整阅读。"
          : !html
            ? "所选语言正文当前不可用，请到本站或原文阅读。"
            : null,
    },
  };
}

/** Current source-time and geography evidence, projected without raw source metadata. */
export async function publicItemMetadata(id: string, db: Db = sql) {
  const [meta] = await db<{ source_time: unknown; jurisdictions: string[] | null }[]>`
    SELECT ${CURRENT_SOURCE_TIME()} AS source_time,
      g.jurisdictions FROM publications p JOIN articles a ON a.id=p.article_id JOIN sources s ON s.id=p.source_id
      LEFT JOIN publication.news_geography g ON g.article_id=p.article_id AND g.article_revision=a.revision AND g.analysis_id IS NOT DISTINCT FROM p.analysis_id AND g.recipe=ANY(${compatibleGeographyRecipes()}::text[])
      WHERE p.article_id=${id} AND ${originalPostAdmissionCondition()}`;
  return meta ?? null;
}

export interface ReaderInterestFacet {
  key: string;
  label: string;
}
export interface ReaderInterestFacts {
  id: string;
  title: string;
  category: PublicApiCategoryKey | null;
  minerals: ReaderInterestFacet[];
  companies: ReaderInterestFacet[];
  countries: ReaderInterestFacet[];
}

/**
 * 读者兴趣记录 (TASK-0596): what the reader filters show each article under, for articles that still have a page.
 * Category as the lists show it; a mineral or company when its filter shows the article (stored tag or alias in the
 * search text, filterHits); a jurisdiction when its country filter does (current geography evidence,
 * jurisdictionHits). The title is the one the lists show. Read-only, no model.
 */
export async function readerInterestFacts(ids: readonly string[], db: Db = sql): Promise<Map<string, ReaderInterestFacts>> {
  const out = new Map<string, ReaderInterestFacts>();
  const clean = [...new Set(ids.filter((id) => ARTICLE_ID_PATTERN.test(id)))];
  const names = new Map(JURISDICTIONS.map((j) => [j.id, j.name_zh]));
  for (let at = 0; at < clean.length; at += 500) {
    const chunk = clean.slice(at, at + 500);
    const items = await fetchItemsByIds(chunk, db);
    const extra = await db<{ id: string; search_text: string; jurisdictions: string[] | null }[]>`
      SELECT p.article_id AS id,p.search_text,g.jurisdictions FROM publications p JOIN articles a ON a.id=p.article_id
        LEFT JOIN publication.news_geography g ON g.article_id=p.article_id AND g.article_revision=a.revision AND g.analysis_id IS NOT DISTINCT FROM p.analysis_id AND g.recipe=ANY(${compatibleGeographyRecipes()}::text[])
      WHERE p.article_id=ANY(${chunk}::text[])`;
    const facts = new Map(extra.map((row) => [row.id, row]));
    for (const id of chunk) {
      const row = items.get(id);
      if (!row || !hasItemPage({ visibility: row.visibility, sourceMode: row.source_mode })) continue;
      const fact = facts.get(id);
      const hits = filterHits(row.tags ?? [], fact?.search_text ?? "");
      out.set(id, {
        id,
        title: row.title,
        category: toPublicApiCategory(row.category),
        minerals: hits.filter((m) => m.kind === "mineral").map((m) => ({ key: m.label, label: m.label })),
        companies: hits.filter((m) => m.kind === "company").map((m) => ({ key: m.id, label: m.label })),
        countries: jurisdictionHits(fact?.jurisdictions ?? []).map((code) => ({ key: code, label: names.get(code) ?? code })),
      });
    }
  }
  return out;
}

export interface SelectedDeliveryCandidate {
  article_id: string;
  seat: boolean;
  title: string;
  summary: string | null;
  reason: string | null;
  category: CategoryKey | null;
  source_name: string;
  url: string;
  timeline_at: Date;
  discovered_at: Date;
  visible_after: Date;
  backfill: boolean;
  fact_id: number | null;
  jurisdictions: string[];
}

/** Worker admission snapshot; callers must still check release time, age, silence and target scope. */
export async function selectedDeliveryCandidate(id: string, db: Db = sql): Promise<SelectedDeliveryCandidate | null> {
  const [row] = await db<SelectedDeliveryCandidate[]>`
    SELECT p.article_id,p.seat,p.title,p.summary,p.reason,p.category,s.name AS source_name,p.url,
      p.timeline_at,p.discovered_at,p.visible_after,p.backfill,p.fact_id,coalesce(g.jurisdictions,'{}'::text[]) AS jurisdictions
    FROM publications p JOIN articles a ON a.id=p.article_id JOIN sources s ON s.id=p.source_id
    LEFT JOIN publication.news_geography g ON g.article_id=p.article_id AND g.article_revision=a.revision
      AND g.analysis_id IS NOT DISTINCT FROM p.analysis_id AND g.recipe=ANY(${compatibleGeographyRecipes()}::text[])
    WHERE p.article_id=${id} AND p.visibility='public' AND ${originalPostAdmissionCondition()} AND p.eligible AND ${confirmedSelected()} AND NOT p.operator_withdrawn
      AND p.visible_after IS NOT NULL AND s.lane='news' AND s.participation_mode='editorial'`;
  return row ?? null;
}
