import { CURRENT_SOURCE_TIME, publicSourceTime, sourceInstant } from "./source-time.ts";
import {
  isChineseOriginal,
  readableTranslation,
  readablePartialTranslation,
  TRANSLATION_MANIFEST_FORMAT,
  type StoredTranslation,
} from "../editorial/translation-readiness.ts";
import { promptVersion } from "../editorial/prompts.ts";
// RSS feeds. GUID = article id (isPermaLink=false), <link> = the site's page, pubDate = source
// publication time. Summary feeds never carry content:encoded; full feeds inline bodies only for
// sources that explicitly allow redistribution. Titles come from the site's name and categories.
import { PUBLIC_API_CATEGORY_KEYS, type PublicApiCategoryKey } from "@amp/contracts/taxonomy";
import { CATEGORY_LABELS } from "@amp/industry/taxonomy";
import { SITE, withSubject } from "@amp/industry/site";
import { config } from "../config.ts";
import { linkBodyImages } from "../content/sanitize.ts";
import { sql } from "../db.ts";
import type { FeedNotice } from "../modules.ts";
import { escapeXml } from "../lib/text.ts";
import { reportHeadline, reportIndex, reportLeadParagraph } from "./reports.ts";
import { selectedCondition, type ItemRow } from "./items.ts";
import { dailyUrl, itemUrl, siteUrl } from "./links.ts";
import { listPolicies } from "./policies.ts";
import { readAllFactApiItems } from "./timeline.ts";

const RECIPE = `${TRANSLATION_MANIFEST_FORMAT}:${promptVersion("translate-body")}`;

interface FeedMeta {
  id: string;
  path: string;
  title: string;
  description: string;
  homePath: string;
  pollHintMinutes: number;
}

const FEEDS: Record<"selected" | "selectedFull" | "all" | "daily", FeedMeta> = {
  selected: {
    id: "selected",
    path: "/feed.xml",
    title: `${SITE.name} — 精选`,
    description: `最新 50 条 ${SITE.name} 精选摘要，保留标题、站内阅读与原文入口；需要阅读器内全文可改订 /feed/full.xml。`,
    homePath: "/",
    pollHintMinutes: 1,
  },
  selectedFull: {
    id: "selected-full",
    path: "/feed/full.xml",
    title: `${SITE.name} — 精选全文`,
    description: "与精选摘要相同的最新 50 条；仅对明确允许再分发的来源内联正文，其余仍提供摘要和阅读入口。",
    homePath: "/",
    pollHintMinutes: 1,
  },
  all: {
    id: "all",
    path: "/feed/all.xml",
    title: `${SITE.name} — 全部动态`,
    description: "最近 7 天公开动态，按真实发布时间倒序；不含未审内容、低相关条目和已合并的重复条目。",
    homePath: "/all",
    pollHintMinutes: 1,
  },
  daily: {
    id: "daily",
    path: "/feed/daily.xml",
    title: `${SITE.name} ${withSubject("日报")}`,
    description: `${SITE.name} 每天 08:00 北京时间发布的${withSubject("日报")}，保留最近 30 期。`,
    homePath: "/daily",
    pollHintMinutes: 1,
  },
};

/** RSS <author> needs an address; a no-reply one on the site's own domain. */
const AUTHOR = `noreply@${new URL(config.siteUrl).hostname}`;

function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")}]]>`;
}

function rfc822(d: Date): string {
  return d.toUTCString();
}

function noticeXml(notice: FeedNotice): string {
  if (!Number.isFinite(notice.at.getTime())) throw new Error("Invalid feed notice date");
  return `    <item>
      <title>${cdata(notice.title)}</title>
      <link>${escapeXml(notice.link)}</link>
      <description>${cdata(notice.description)}</description>
      <pubDate>${rfc822(notice.at)}</pubDate>
      <guid isPermaLink="false">${escapeXml(notice.guid)}</guid>
      <author>${escapeXml(AUTHOR)} (${escapeXml(SITE.name)})</author>
    </item>`;
}

function channel(
  meta: { title: string; description: string; homePath: string; selfPath: string; ttl: number },
  items: string[],
  notice?: FeedNotice | null,
): string {
  if (notice) items.unshift(noticeXml(notice));
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:amp="urn:aiminingpolicy:ai-metadata:v1">
  <channel>
    <title>${escapeXml(meta.title)}</title>
    <link>${escapeXml(siteUrl(meta.homePath))}</link>
    <description>${escapeXml(meta.description)}</description>
    <language>zh-CN</language>
    <atom:link href="${escapeXml(siteUrl(meta.selfPath))}" rel="self" type="application/rss+xml" />
    <ttl>${meta.ttl}</ttl>
    <generator>${escapeXml(`${SITE.name} (${siteUrl("/agent")})`)}</generator>
${items.join("\n")}
  </channel>
</rss>
`;
}

type FeedRow = Pick<
  ItemRow,
  "id" | "title" | "summary" | "url" | "category" | "published_at" | "discovered_at" | "source_name" | "source_time" | "first_public_at"
> &
  Partial<
    Pick<ItemRow, "language" | "syndicate"> & {
      human_edited: boolean;
      body_html: string | null;
      manual_body_html: string | null;
      content_revision: number;
      translation: StoredTranslation;
    }
  >;

/**
 * The permitted full feed prefers verified Chinese; partial renditions or original text explicitly
 * state that the Chinese translation is unfinished.
 * It ends with an attribution line (also a mark on copies taken from the feed).
 */
function aiLabel(r: FeedRow) {
  return r.human_edited || r.manual_body_html ? "ai_assisted_human_edited" : "ai_generated";
}
function aiNotice(r: FeedRow) {
  return aiLabel(r) === "ai_assisted_human_edited"
    ? "原始来源可追溯；中文内容由 AI 辅助生成或翻译，并经人工修订，核对细节请看原文。"
    : "原始来源可追溯；中文内容由 AI 辅助生成或翻译，核对细节请看原文。";
}
function attributionHtml(r: FeedRow) {
  return `据<a href="${escapeXml(r.url)}">${escapeXml(r.source_name)}</a>原文整理：`;
}
function fullContent(r: FeedRow, pageUrl: string): string | null {
  const html = r.manual_body_html
    ? `<p>AI 辅助整理，经人工修订</p>${r.manual_body_html}`
    : r.body_html
      ? isChineseOriginal(r.language ?? null, r.body_html)
        ? r.body_html
        : (readableTranslation(r.body_html, { revision: r.content_revision ?? 0, recipe: RECIPE }, r.translation ?? null) ??
          `<p>中文译文尚不完整，未译部分保留原文。</p>${readablePartialTranslation(r.body_html, { revision: r.content_revision ?? 0, recipe: RECIPE }, r.translation ?? null) ?? r.body_html}`)
      : null;
  if (!html) return null;
  return `<p>${attributionHtml(r)}</p>${linkBodyImages(html)}<p>${aiNotice(r)}</p><p>—— 本文由 ${escapeXml(SITE.name)} 聚合整理，完整版与更多动态见 <a href="${pageUrl}">${pageUrl}</a></p>`;
}

function itemXml(r: FeedRow, includeContent: boolean): string {
  const pageUrl = itemUrl(r.id);
  const summary = r.summary ?? "";
  const sourceTime = publicSourceTime(r.source_time);
  const description = `<p>${attributionHtml(r)}${escapeXml(summary)}</p><p>${escapeXml(sourceTime?.label ?? "原文发布时间尚未确认")}</p><p>${aiNotice(r)}</p>\n<p>🔗 <a href="${escapeXml(r.url)}">阅读原文</a></p>\n<p>via ${escapeXml(SITE.name)} · <a href="${pageUrl}">${pageUrl}</a></p>`;
  const label = r.category ? CATEGORY_LABELS[r.category as PublicApiCategoryKey] : undefined;
  const category = label ? `\n      <category>${escapeXml(label)}</category>` : "";
  let content = "";
  if (includeContent && r.syndicate) {
    const html = fullContent(r, pageUrl);
    if (html) content = `\n      <content:encoded>${cdata(html)}</content:encoded>`;
  }
  const pub = sourceInstant(sourceTime);
  const date = pub ? `<pubDate>${rfc822(pub)}</pubDate>` : sourceTime?.local_date ? `<dc:date>${escapeXml(sourceTime.local_date)}</dc:date>` : "";
  return `    <item>
      <title>${cdata(r.title)}</title>
      <link>${pageUrl}</link>
      <description>${cdata(description)}</description>${content}${category}
      ${date}
      ${r.first_public_at ? `<amp:first-public-at>${r.first_public_at.toISOString()}</amp:first-public-at>` : ""}
      <guid isPermaLink="false">${escapeXml(r.id)}</guid>
      <author>${AUTHOR} (${escapeXml(r.source_name)})</author>
      <source url="${escapeXml(r.url)}">${escapeXml(r.source_name)}</source>
      <category domain="ai-label">${aiLabel(r)}</category>
      <amp:provider>${escapeXml(SITE.name)}</amp:provider>
      <amp:content-id>${escapeXml(r.id)}</amp:content-id>
    </item>`;
}

export type ItemFeedKind = "selected" | "selected-full" | "all";

// Like the live feeds, items are the newest by their original publish time (the pubDate shown):
// 50 per feed; a category feed holds only its last 7 days (by original publish time).

function feedScope(kind: ItemFeedKind, category: PublicApiCategoryKey | null, now: Date) {
  return sql`p.visibility = 'public' AND (NOT p.selected OR p.visible_after <= ${now}) AND (
    (${kind} = 'all' AND p.eligible AND coalesce(p.published_at, p.discovered_at) > ${now}::timestamptz - interval '7 days'
      AND coalesce(p.published_at, p.discovered_at) <= ${now}) OR
    (${kind} <> 'all' AND ${selectedCondition(now)} AND p.seat AND (${category}::text IS NULL OR p.category = ${category})
      AND (${category}::text IS NULL OR coalesce(p.published_at, p.discovered_at) >= ${new Date(now.getTime() - 7 * 86400_000)})))`;
}

export async function itemFeed(kind: ItemFeedKind, category: PublicApiCategoryKey | null, now = new Date(), notice?: FeedNotice | null): Promise<string> {
  const includeContent = kind === "selected-full";
  const allIds =
    kind === "all"
      ? (
          await readAllFactApiItems(sql, {
            category: null,
            source: null,
            jurisdiction: null,
            jurisdictionCodes: [],
            jurisdictionRecipe: "",
            rangeStart: null,
            rangeEnd: null,
            selected: false,
            by: "published",
            now,
            windowStart: new Date(now.getTime() - 7 * 86400000),
            afterAt: null,
            afterId: null,
            limit: 50,
          })
        ).map((row) => row.id)
      : null;
  const rows = includeContent
    ? await sql<FeedRow[]>`
      WITH page AS MATERIALIZED (
        SELECT p.article_id FROM publications p WHERE ${feedScope(kind, category, now)}
          AND (${allIds}::text[] IS NULL OR p.article_id=ANY(${allIds}::text[]))
        ORDER BY coalesce(p.published_at, p.discovered_at) DESC, p.article_id DESC LIMIT 50
      )
      SELECT p.article_id AS id, p.title, p.summary, p.url, p.category, p.published_at, ${CURRENT_SOURCE_TIME()} AS source_time,p.first_public_at, p.discovered_at, s.name AS source_name,
        EXISTS(SELECT 1 FROM publication.manual_copies m JOIN articles current_article ON current_article.id=m.article_id
          WHERE m.article_id=p.article_id AND m.material_revision=current_article.revision AND m.state IN ('active','needs_review')) AS human_edited,
        (p.syndicate AND s.site_fulltext AND s.syndicate_fulltext) AS syndicate, a.language, (SELECT body_html FROM publication.manual_copies m WHERE m.article_id=a.id AND m.material_revision=a.revision AND m.state IN ('active','needs_review') AND p.syndicate AND s.site_fulltext AND s.syndicate_fulltext) AS manual_body_html, CASE WHEN p.syndicate AND s.site_fulltext AND s.syndicate_fulltext THEN a.body_html END AS body_html, a.revision AS content_revision,
        jsonb_build_object('revision',tr.revision,'body_html',tr.body_html,'complete',tr.complete,'origin',tr.origin,
          'recipe',tr.recipe,'source_hash',tr.source_hash,'manifest',tr.manifest) AS translation
      FROM page JOIN publications p ON p.article_id = page.article_id JOIN sources s ON s.id = p.source_id
      JOIN articles a ON a.id = p.article_id
      LEFT JOIN translations tr ON tr.article_id = p.article_id AND tr.lang = 'zh' AND tr.revision >= a.revision AND p.syndicate AND s.site_fulltext AND s.syndicate_fulltext
      ORDER BY coalesce(p.published_at, p.discovered_at) DESC, p.article_id DESC`
    : await sql<FeedRow[]>`
      WITH page AS MATERIALIZED (
        SELECT p.article_id FROM publications p WHERE ${feedScope(kind, category, now)}
          AND (${allIds}::text[] IS NULL OR p.article_id=ANY(${allIds}::text[]))
        ORDER BY coalesce(p.published_at, p.discovered_at) DESC, p.article_id DESC LIMIT 50
      )
      SELECT p.article_id AS id, p.title, p.summary, p.url, p.category, p.published_at, ${CURRENT_SOURCE_TIME()} AS source_time,p.first_public_at, p.discovered_at, s.name AS source_name,
        EXISTS(SELECT 1 FROM publication.manual_copies m JOIN articles current_article ON current_article.id=m.article_id
          WHERE m.article_id=p.article_id AND m.material_revision=current_article.revision AND m.state IN ('active','needs_review')) AS human_edited
      FROM page JOIN publications p ON p.article_id = page.article_id JOIN sources s ON s.id = p.source_id JOIN articles a ON a.id=p.article_id
      ORDER BY coalesce(p.published_at, p.discovered_at) DESC, p.article_id DESC`;
  if (allIds) {
    const order = new Map(allIds.map((id, index) => [id, index]));
    rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  }
  let meta: { title: string; description: string; homePath: string; selfPath: string; ttl: number };
  if (category) {
    const label = CATEGORY_LABELS[category] ?? category;
    meta = {
      title: includeContent ? `${SITE.name} — ${label}全文` : `${SITE.name} — ${label}`,
      description: includeContent
        ? `${SITE.name} 每日精选「${label}」分类全文源。仅对明确允许再分发的来源内联正文。`
        : `${SITE.name} 每日精选「${label}」分类摘要，按分类订阅、不被全量精选刷屏。`,
      homePath: "/",
      selfPath: includeContent ? `/feed/full/category/${category}.xml` : `/feed/category/${category}.xml`,
      ttl: 1,
    };
  } else {
    const m = FEEDS[kind === "selected" ? "selected" : kind === "selected-full" ? "selectedFull" : "all"];
    meta = { title: m.title, description: m.description, homePath: m.homePath, selfPath: m.path, ttl: m.pollHintMinutes };
  }
  return channel(
    meta,
    rows.map((r) => itemXml(r, includeContent)),
    notice,
  );
}

export async function dailyFeed(notice?: FeedNotice | null): Promise<string> {
  const index = await reportIndex("daily");
  const rows = index.rows.slice(0, 30);
  const m = FEEDS.daily;
  const gone = index.gone;
  const items = rows.map((r) => {
    const url = dailyUrl(r.key);
    const lead = reportHeadline(r.content, "daily", gone);
    const title = lead ? `${SITE.name} ${withSubject("日报")} · ${r.key} — ${lead}` : `${SITE.name} ${withSubject("日报")} · ${r.key}`;
    const description = `<p>${escapeXml(reportLeadParagraph(r.content, gone) ?? lead ?? "")} — 点击查看完整日报</p><p>内容由 AI 辅助生成/翻译，核对细节请看原始报道。</p>\n<p>via ${escapeXml(SITE.name)} · <a href="${url}">${url}</a></p>`;
    return `    <item>
      <title>${cdata(title)}</title>
      <link>${url}</link>
      <description>${cdata(description)}</description>
      <pubDate>${rfc822(r.generated_at)}</pubDate>
      <guid isPermaLink="false">daily-${escapeXml(r.key)}</guid>
      <author>${AUTHOR} (${escapeXml(SITE.name)})</author>
      <category domain="ai-label">ai_generated</category>
      <amp:provider>${escapeXml(SITE.name)}</amp:provider>
      <amp:content-id>daily-${escapeXml(r.key)}</amp:content-id>
    </item>`;
  });
  return channel({ title: m.title, description: m.description, homePath: m.homePath, selfPath: m.path, ttl: m.pollHintMinutes }, items, notice);
}

export function isFeedCategory(v: string): v is PublicApiCategoryKey {
  return (PUBLIC_API_CATEGORY_KEYS as readonly string[]).includes(v);
}

/** Summary-only policy syndication; qualifications and withdrawals are evaluated for every read. */
export async function policyFeed(notice?: FeedNotice | null) {
  const { items } = await listPolicies({ page: 1, page_size: 50 });
  return channel(
    {
      title: `${SITE.name} — 法规政策动态`,
      description: items.length ? "最近50份当前可公开法规文书的摘要；请核对适用条件及官方原文。" : "暂时没有可公开的法规文书；不代表有关法域没有新法规。",
      homePath: "/policies",
      selfPath: "/feed/policies.xml",
      ttl: 1,
    },
    items.map((policy) => {
      const time = policy.published_time,
        dateOnly = time.precision === "date" && !!time.local_date,
        precise = ["minute", "second"].includes(time.precision) && time.utc && Number.isFinite(Date.parse(time.utc)),
        sources = policy.attributions.map((a) => `<a href="${escapeXml(a.url)}">${escapeXml(a.name)}</a>`).join("、"),
        description = `${dateOnly ? `<p>来源发布日期：${time.local_date}（仅提供日期）。</p>` : ""}<p>据${sources}原文整理：${escapeXml(policy.summary ?? "尚未完成解读，请查看基本事实和官方原文。")}</p><p>内容由 AI 辅助生成/翻译，以原文为准。</p>`;
      return `    <item>
      <title>${cdata(policy.title)}</title>
      <link>${escapeXml(siteUrl(`/policies/${encodeURIComponent(policy.id)}`))}</link>
      <description>${cdata(description)}</description>
      <source url="${escapeXml(policy.original_url)}">${escapeXml(policy.authority.name)}</source>
      <guid isPermaLink="false">${escapeXml(policy.id)}</guid>
      ${dateOnly ? `<dc:date>${escapeXml(time.local_date!)}</dc:date>` : precise ? `<pubDate>${rfc822(new Date(time.utc!))}</pubDate>` : ""}
      <category domain="ai-label">${escapeXml(policy.ai_label)}</category>
      <amp:provider>${escapeXml(SITE.name)}</amp:provider>
      <amp:content-id>${escapeXml(policy.id)}</amp:content-id>
    </item>`;
    }),
    notice,
  );
}
