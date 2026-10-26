import { evaluateSourcePolicy, readCurrentSourcePolicy, sourceDateConfiguration } from "../admin/sources.ts";
// What the judging steps read about an article: loaded once per analysis and rendered per step.
import { narrativeText } from "./narrative.ts";
import type { XPostData } from "../content/materials.ts";
import type { TimeAssertion } from "@amp/contracts/time-assertion";
import { materialSourceTime } from "../content/date-evidence.ts";
import { modelSourceDateLabel } from "./source-time.ts";
import { sql, type Db } from "../db.ts";
import { collapseWhitespace, truncate, withXArticle } from "../lib/text.ts";
export { withXArticle, postEvidenceText } from "../lib/text.ts";
import { produceImage } from "../media/images.ts";
import type { ContentPart } from "../providers/llm.ts";

export interface AnalyzeInputArticle {
  sourceId?: string;
  id: string;
  revision: number;
  title: string;
  url: string;
  author: string | null;
  publishedAt: Date | null;
  /** Explicit null means the original time is unconfirmed. Undefined is reserved for old offline inputs. */
  sourceTime?: TimeAssertion | null;
  /** When the site first saw it; never an original publication timestamp. */
  discoveredAt?: Date | null;
  bodyText: string | null;
  excerpt: string | null;
  /** pending: no body fetched yet; ok; unconfirmed: fetching failed; none. */
  bodyStatus?: string;
  media: Array<Record<string, any>>;
  xPost?: XPostData | null;
  source: {
    name: string;
    kind: string;
    tier: string;
    firstParty: boolean;
    tags?: string[];
    ownerEntityId?: string | null;
    /** The source asks for the article page (fetchPublicContent, detail pages, web listings). */
    fetchesBody?: boolean;
  };
  /** Stored Chinese translation of the body (e.g. a full post whose original was truncated). */
  translationZh?: string | null;
}

export async function loadAnalyzeInput(articleId: string, db: Db = sql): Promise<AnalyzeInputArticle | null> {
  const [row] = await db<
    {
      source_id: string;
      id: string;
      revision: number;
      title: string;
      url: string;
      author: string | null;
      published_at: Date | null;
      source_date_version: string;
      discovered_at: Date;
      body_text: string | null;
      body_html: string | null;
      excerpt: string | null;
      body_status: string;
      x_post: XPostData | null;
      x_article: { title?: string; text?: string } | null;
      media: Array<Record<string, any>>;
      source_name: string;
      source_kind: string;
      tier: string;
      first_party: boolean;
      source_tags: string[];
      owner_entity_id: string | null;
      config: Record<string, any>;
      translation_zh: string | null;
    }[]
  >`
    SELECT a.source_id, a.id, a.revision, a.title, a.url, a.author, a.published_at, a.source_date_version, a.discovered_at, a.body_text, a.body_html, a.excerpt, a.body_status, a.x_post, a.x_article, a.media,
           s.name AS source_name, s.kind AS source_kind, s.tier, s.first_party, s.tags AS source_tags, s.owner_entity_id, s.config,
           tr.body_text AS translation_zh
    FROM articles a JOIN sources s ON s.id = a.source_id
    LEFT JOIN translations tr ON tr.article_id = a.id AND tr.lang = 'zh' AND tr.revision >= a.revision
    WHERE a.id = ${articleId}`;
  if (!row) return null;
  const dateConfig = await sourceDateConfiguration(row.source_id, db);
  const sourceTime =
    dateConfig?.lane === "news" && dateConfig.configHash
      ? await materialSourceTime(
          { articleId: row.id, sourceId: row.source_id, revision: row.revision, configHash: dateConfig.configHash },
          Number(row.source_date_version),
          Date.now(),
          db,
        )
      : null;
  return {
    sourceId: row.source_id,
    id: row.id,
    revision: row.revision,
    title: row.title,
    url: row.url,
    author: row.author,
    publishedAt: row.published_at,
    sourceTime,
    discoveredAt: row.discovered_at,
    bodyText: narrativeText(row.body_text, row.body_html, row.url),
    excerpt: row.excerpt,
    bodyStatus: row.body_status,
    ...(row.x_post ? { xPost: withXArticle(row.x_post, row.x_article)! } : {}),
    media: row.media,
    source: {
      name: row.source_name,
      kind: row.source_kind,
      tier: row.tier,
      firstParty: row.first_party,
      tags: row.source_tags,
      ownerEntityId: row.owner_entity_id,
      fetchesBody: row.config?.fetchPublicContent === true || !!row.config?.detail || row.source_kind === "web_list",
    },
    translationZh: row.translation_zh,
  };
}

const KIND_LABEL: Record<string, string> = {
  rss: "RSS",
  web_list: "网页",
  json_list: "网页接口",
  mp_account: "微信公众号",
  external: "外部上报",
};

/** The material as the structure step reads it (source facts, text, link). */
export function buildMaterial(a: AnalyzeInputArticle): string {
  const lines: string[] = [];
  lines.push("<source>");
  lines.push(`名称：${a.source.name}`);
  lines.push(`类型：${KIND_LABEL[a.source.kind] ?? a.source.kind}；分级：${a.source.tier}；一手来源：${a.source.firstParty ? "是" : "否"}`);
  lines.push("</source>");
  lines.push("<material>");
  lines.push(`原文时间：${modelSourceDateLabel(a)}`);
  if (a.author) lines.push(`作者：${a.author}`);
  if (a.xPost) {
    lines.push(`作者：${a.xPost.authorName} (@${a.xPost.handle})`);
    lines.push(`帖子：\n${truncate(a.xPost.text, 60000)}`);
    if (a.xPost.quoted?.text) lines.push(`引用的帖子（@${a.xPost.quoted.handle}）：\n${truncate(a.xPost.quoted.text, 60000)}`);
    if (a.translationZh) lines.push(`帖子中文译文：\n${truncate(a.translationZh, 4000)}`);
  } else {
    lines.push(`标题：${collapseWhitespace(a.title)}`);
    const body = a.bodyText ?? a.excerpt ?? "";
    lines.push(body ? `正文：\n${truncate(body, 7000)}` : "正文：（无）");
    if (a.translationZh && !a.bodyText) lines.push(`正文中文译文：\n${truncate(a.translationZh, 5000)}`);
  }
  lines.push(`原文链接：${a.url}`);
  lines.push("</material>");
  return lines.join("\n");
}

/**
 * The article's first image, inlined: models cannot reach most original hosts from China, so they get
 * the site's cached thumbnail (fetched through the egress route). None when it cannot be fetched.
 */
export async function firstImagePart(a: AnalyzeInputArticle): Promise<ContentPart | null> {
  const image = firstInputImage(a);
  if (!image || !a.sourceId) return null;
  const policy = await readCurrentSourcePolicy(a.sourceId);
  if (!policy) return null;
  for (const capability of ["fetch", "external_model"] as const) {
    const permit = await evaluateSourcePolicy({
      source_id: a.sourceId,
      lane: "news",
      capability,
      expected_permission_version: policy.permission_version,
      resource: { url: String(image.url), attachment: true, document_type: null },
    });
    if (permit.decision !== "allow") return null;
  }
  try {
    const { body, type } = await produceImage(String(image.url), "thumb");
    return /^image\/(jpeg|png|webp)$/.test(type) ? { type: "image_url", image_url: { url: `data:${type};base64,${body.toString("base64")}` } } : null;
  } catch {
    return null;
  }
}

export const firstInputImage = (a: AnalyzeInputArticle) =>
  [...(a.xPost?.media ?? []), ...(a.xPost?.quoted?.media ?? []), ...(a.media ?? [])].find((m) => m.kind === "image" && m.url);

/** Bind only post fields consumed by model renderers/images; display-only edits cannot invalidate a paid input. */
export function analysisInputIdentity(a: AnalyzeInputArticle) {
  if (!a.xPost) return a;
  const post = a.xPost,
    counted = post.media ?? a.media ?? [];
  return {
    ...a,
    xPost: {
      authorName: post.authorName,
      handle: post.handle,
      text: post.text,
      ...(post.quoted?.text ? { quoted: { handle: post.quoted.handle, text: post.quoted.text } } : {}),
    },
    media: {
      images: counted.filter((m) => m.kind === "image").length,
      videos: counted.filter((m) => m.kind === "video").length,
      firstImageUrl: firstInputImage(a)?.url ?? null,
    },
  };
}

/** Existing model-derived context may be cited in an evaluation only for this actual material revision. */
export async function currentEvaluationDerivedInput(articleId: string, revision: number) {
  const [row] = await sql<{ title_zh: string | null; summary_zh: string | null; output: Record<string, unknown> | null }[]>`
    SELECT title_zh,summary_zh,output FROM analyses WHERE article_id=${articleId} AND input_revision=${revision} ORDER BY id DESC LIMIT 1`;
  return row ?? null;
}
