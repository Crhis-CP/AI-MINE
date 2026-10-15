import { attachSourcePolicies } from "./reader-context.ts";
import { geographyRecipe } from "../editorial/geography.ts";
import { publicCompanyContext, readerAttribution } from "./reader-context.ts";
// Item detail, behind the visibility and licence rules every public output shares.
import { relatedPoliciesForNews } from "./news-policy-links.ts";
import type { ItemDetail, SiteItemDetail, OutlineEntry, StoryRef } from "@amp/contracts/site";
import { linkBodyImages } from "../content/sanitize.ts";
import { dbOf } from "../db.ts";
import { ITEM_COLUMNS, ITEM_FROM, selectedCondition, toItemSummary, type ItemRow } from "./items.ts";
import { pickRepresentative } from "./timeline.ts";
import { hasItemPage } from "./rules.ts";
import {
  isChineseOriginal,
  readableTranslation,
  readablePartialTranslation,
  TRANSLATION_MANIFEST_FORMAT,
  type StoredTranslation,
} from "../editorial/translation-readiness.ts";
import { promptVersion } from "../editorial/prompts.ts";

const sql = dbOf("publication");
const RECIPE = `${TRANSLATION_MANIFEST_FORMAT}:${promptVersion("translate-body")}`;

interface DetailRow extends ItemRow {
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
    SELECT ${ITEM_COLUMNS}, p.first_public_at, (SELECT label FROM publication.manual_copies m WHERE m.article_id=a.id AND m.material_revision=a.revision AND m.state IN ('active','needs_review')) AS manual_revision_label, (SELECT body_html FROM publication.manual_copies m WHERE m.article_id=a.id AND m.material_revision=a.revision AND m.state IN ('active','needs_review')) AS manual_body_html, a.body_html, a.body_text, a.body_status, a.revision AS content_revision, s.site_fulltext AS source_site_fulltext,
      s.syndicate_fulltext AS source_syndicate_fulltext,p.summary AS machine_summary,
      jsonb_build_object('revision',tr.revision,'body_html',tr.body_html,'complete',tr.complete,'origin',tr.origin,
        'recipe',tr.recipe,'source_hash',tr.source_hash,'manifest',tr.manifest) AS translation
    ${ITEM_FROM}
    WHERE p.article_id = ${id}`;
  if (row) await attachSourcePolicies([row]);
  return row ?? null;
}

/**
 * Public detail (rules.hasItemPage): items the lists leave out (low relevance, merged duplicates, no
 * Chinese summary yet) keep a noindex page; withdrawn and hot_signal items are a 404.
 */
export async function loadItemDetail(id: string, now = new Date(), machine = false): Promise<DetailResult> {
  const row = await loadRow(id);
  if (!row || !hasItemPage({ visibility: row.visibility, sourceMode: row.source_mode })) return { kind: "not_found" };

  const summary = toItemSummary(machine ? { ...row, summary: row.machine_summary } : row);
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
    };
    return { kind: "found", detail, row };
  }

  const related = await sql<StoryRef[]>`
    SELECT DISTINCT st.public_id::text AS "publicId", st.title
    FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id JOIN stories st ON st.id = f.story_id
    WHERE fa.article_id = ${id} AND (fa.manual OR fa.input_revision=${row.content_revision}) AND fa.role <> 'mention' AND st.merged_into IS NULL
    LIMIT 6`;

  let body: ItemDetail["body"] = null;
  let outline: OutlineEntry[] = [];
  if (row.body_mode === "full" && row.source_site_fulltext && (row.body_html || row.manual_body_html)) {
    const isZh = isChineseOriginal(row.language, row.body_text ?? "");
    const original = linkBodyImages(row.body_html ?? "");
    const verified = isZh || !row.body_html ? null : readableTranslation(row.body_html, { revision: row.content_revision, recipe: RECIPE }, row.translation);
    const partial =
      isZh || !row.body_html || verified
        ? null
        : readablePartialTranslation(row.body_html, { revision: row.content_revision, recipe: RECIPE }, row.translation);
    const zh = row.manual_body_html
      ? `<p>AI 辅助整理，经人工修订</p>${linkBodyImages(row.manual_body_html)}`
      : isZh
        ? original
        : verified || partial
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
    const [g] = await sql<{ public_id: string; reports: number; sources: number }[]>`
      SELECT f.public_id, count(p.article_id) AS reports, count(DISTINCT p.source_id) AS sources
      FROM facts f JOIN publications p ON p.fact_id = f.id
      WHERE f.id = ${row.fact_id} AND p.visibility = 'public' AND p.eligible AND (NOT p.selected OR p.visible_after <= ${now})
      GROUP BY f.public_id`;
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

  const detail: ItemDetail = {
    ...summary,
    readingMode: "full",
    readingState: !row.source_site_fulltext
      ? "restricted"
      : body?.zh
        ? "available"
        : row.body_status === "pending" || (body?.original && !body.complete)
          ? "pending"
          : "unavailable",
    firstPublicAt: row.first_public_at?.toISOString() ?? null,
    eventCoverage: row.story_id ? await eventCoverage(row.story_id, now, machine) : null,
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
  };
  return { kind: "found", detail, row };
}

/** Current public event members: first-party representation and the latest distinct fact stay separate. */
async function eventCoverage(storyId: number, now: Date, machine: boolean): Promise<NonNullable<ItemDetail["eventCoverage"]> | null> {
  const rows = await sql<(ItemRow & { machine_summary: string | null })[]>`SELECT ${ITEM_COLUMNS},p.summary AS machine_summary ${ITEM_FROM}
    WHERE p.story_id=${storyId} AND p.visibility='public' AND p.eligible AND s.participation_mode='editorial'
      AND (NOT p.selected OR p.visible_after <= ${now})
    ORDER BY p.timeline_at ASC,p.article_id ASC`;
  if (rows.length < 2) return null;
  const facts = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    const key = row.fact_id === null ? row.id : String(row.fact_id);
    facts.set(key, [...(facts.get(key) ?? []), row]);
  }
  const latest = [...facts.values()].sort((a, b) => Math.min(...b.map((r) => r.sort_at.getTime())) - Math.min(...a.map((r) => r.sort_at.getTime())))[0]!;
  const project = (row: (typeof rows)[number]) => toItemSummary(machine ? { ...row, summary: row.machine_summary } : row);
  return { representative: project(pickRepresentative(rows)), latest: project(pickRepresentative(latest)), reportCount: rows.length };
}

/** Site reading projection: default text remains SSR, a second language has its own readable URL. */
export function siteItemDetail(detail: ItemDetail, original = false): SiteItemDetail {
  const hasTranslation = !!detail.body?.zh && detail.body.zhKind === "translation" && !!detail.body.original;
  const bodyLanguage = original && detail.body?.original ? "original" : "zh";
  const selectedHtml = bodyLanguage === "zh" ? detail.body?.zh : detail.body?.original;
  return {
    ...detail,
    hasTranslation,
    bodyLanguage,
    readingState: selectedHtml ? "available" : detail.readingState,
    body: detail.body
      ? { ...detail.body, zh: bodyLanguage === "zh" ? detail.body.zh : null, original: bodyLanguage === "original" ? detail.body.original : null }
      : null,
    outline: selectedHtml ? withOutline(selectedHtml).outline : [],
  };
}

/** Machine reading never inherits the website's source-excerpt fallback or its full-text licence. */
export async function machineItemDetail(id: string, language: "zh" | "original" = "zh", now = new Date()) {
  const found = await loadItemDetail(id, now, true);
  if (found.kind !== "found" || (found.row.selected && (!found.row.visible_after || found.row.visible_after > now))) return null;
  const { score: _score, ...view } = siteItemDetail(found.detail, language === "original"),
    allowed = found.row.syndicate && found.row.source_syndicate_fulltext && found.row.source_site_fulltext && view.readingMode === "full";
  const html = view.body?.zh ?? view.body?.original ?? null,
    capacity = html !== null && Buffer.byteLength(html) > 256 * 1024,
    readable = allowed && html !== null && !capacity;
  return {
    item: { ...view, summary: found.row.machine_summary, body: readable ? view.body : null, outline: readable ? view.outline : [] },
    reading: {
      redistribution: allowed ? ("allowed" as const) : ("restricted" as const),
      state: readable ? (view.body?.complete ? ("complete" as const) : ("partial" as const)) : ("link_only" as const),
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
export async function publicItemMetadata(id: string) {
  const [meta] = await sql<{ source_time: unknown; jurisdictions: string[] | null }[]>`
    SELECT CASE WHEN p.source_date_version=a.source_date_version AND p.source_date_config_hash=s.source_date_config_hash THEN p.source_time ELSE NULL END AS source_time,
      g.jurisdictions FROM publications p JOIN articles a ON a.id=p.article_id JOIN sources s ON s.id=p.source_id
      LEFT JOIN publication.news_geography g ON g.article_id=p.article_id AND g.article_revision=a.revision AND g.analysis_id IS NOT DISTINCT FROM p.analysis_id AND g.recipe=${geographyRecipe()}
      WHERE p.article_id=${id}`;
  return meta ?? null;
}
