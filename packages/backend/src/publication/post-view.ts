import { z } from "zod";
import { XPostDetailView, type XPostFeedView } from "@amp/contracts/http/public";
import { PermissionScopeSchema } from "@amp/contracts/source-policy";
import type { XPostData } from "../content/materials.ts";
import { escapeHtml } from "../lib/text.ts";
import { quoteTranslationRecipe } from "../editorial/prompts.ts";
import { originalPostProjectionAllowed } from "../lib/original-post-admission.ts";

type Purpose = "public_excerpt" | "public_summary" | "public_original_fulltext" | "public_translation";
const policy = z.object({
  source_id: z.string(),
  permissions: z.record(z.string(), z.enum(["allow", "deny", "unknown"])),
  scope: PermissionScopeSchema,
  conditions: z.array(z.string()),
  expires_at: z.string().nullable(),
  grants: z.record(z.string(), z.array(z.object({ scope: PermissionScopeSchema, expires_at: z.string().nullable() }))),
});

/** Current public evidence only. A stored post projection is never a permission grant. */
export function postPermission(value: unknown, sourceId: string, url: string, purpose: Purpose, now = Date.now()): boolean {
  const parsed = policy.safeParse(value);
  if (!parsed.success) return false;
  const p = parsed.data;
  const live = (until: string | null) => until === null || (Number.isFinite(Date.parse(until)) && Date.parse(until) > now);
  if (p.source_id !== sourceId || p.permissions[purpose] !== "allow" || p.conditions.length || !live(p.expires_at)) return false;
  try {
    const target = new URL(url);
    if (!/^https?:$/.test(target.protocol) || target.username || target.password) return false;
    const matches = (scope: z.infer<typeof PermissionScopeSchema>) =>
      !scope.excluded_content.length &&
      !scope.document_types.length &&
      scope.hosts.includes(target.hostname) &&
      scope.path_prefixes.some((prefix) => target.pathname.startsWith(prefix));
    return matches(p.scope) && (p.grants[purpose] ?? []).some((grant) => live(grant.expires_at) && matches(grant.scope));
  } catch {
    return false;
  }
}

export interface PostSummaryProjection {
  is_original_post?: boolean;
  post_summary_kind?: string | null;
  source_id: string;
  source_name: string;
  source_policy?: unknown;
  url: string;
  title: string;
  summary: string | null;
  reason?: string | null;
}
/** Translation/original copy and unclassified historical copy never inherit a summary grant. */
export function publicPostSummary(row: PostSummaryProjection, now = Date.now()) {
  const allowed = !row.is_original_post || postPermission(row.source_policy, row.source_id, row.url, "public_summary", now);
  const summary = allowed && (!row.is_original_post || row.post_summary_kind === "summary") ? row.summary : null;
  return { title: allowed ? row.title : `${row.source_name}的原帖`, summary, reason: allowed ? (row.reason ?? null) : null };
}

/** DR-78 has no image/avatar grant: retain author and permitted quote text, never invent local media. */
export function projectPostView(post: XPostData | null, sourceId: string, url: string, currentPolicy: unknown, translation: string | null, now: number) {
  if (!post || !postPermission(currentPolicy, sourceId, url, "public_original_fulltext", now)) return null;
  const quoted = post.quoted && postPermission(currentPolicy, sourceId, post.quoted.url, "public_original_fulltext", now) ? post.quoted : null;
  return XPostDetailView.parse({
    authorName: post.authorName,
    handle: post.handle,
    avatarUrl: null,
    media: [],
    quoted: quoted
      ? {
          authorName: quoted.authorName,
          handle: quoted.handle,
          text: quoted.text,
          url: quoted.url,
          translation: postPermission(currentPolicy, sourceId, quoted.url, "public_translation", now) ? translation : null,
        }
      : null,
  });
}

export interface PostProjection {
  original_post_admission_required?: boolean | null;
  is_original_post?: boolean;
  x_post?: unknown;
  x_post_revision?: number | null;
  content_revision?: number;
  body_mode?: "full" | "summary";
  source_site_fulltext?: boolean;
  source_id: string;
  source_policy?: unknown;
  url: string;
}
export function currentPostView(row: PostProjection, now = Date.now()) {
  if (!originalPostProjectionAllowed(row)) return null;
  if (!row.is_original_post || row.x_post_revision !== row.content_revision || row.body_mode !== "full" || row.source_site_fulltext === false) return null;
  if (!postPermission(row.source_policy, row.source_id, row.url, "public_original_fulltext", now)) return null;
  const parsed = z
    .strictObject({ view: XPostDetailView.nullable(), quoteRecipe: z.string().nullable(), summaryKind: z.enum(["summary", "original"]).nullable().optional() })
    .safeParse(row.x_post);
  if (!parsed.success) return null;
  const post = parsed.data.view;
  if (!post) return null;
  post.avatarUrl = null;
  delete post.avatarSrcSet;
  post.media = [];
  // Current permission also fences a previously accepted third-party quote and translation.
  if (post.quoted && !postPermission(row.source_policy, row.source_id, post.quoted.url, "public_original_fulltext", now)) post.quoted = null;
  if (
    post.quoted &&
    (parsed.data.quoteRecipe !== quoteTranslationRecipe() || !postPermission(row.source_policy, row.source_id, post.quoted.url, "public_translation", now))
  )
    post.quoted.translation = null;
  return post;
}
export function postFeedView(row: PostProjection): z.infer<typeof XPostFeedView> | null {
  const post = currentPostView(row);
  if (!post) return null;
  const quoted = post.quoted;
  return { ...post, quoted: quoted ? { authorName: quoted.authorName, handle: quoted.handle, text: quoted.text, translation: quoted.translation } : null };
}

/** Machine/RSS reading uses the same licensed quote, rendered only as text. */
export function postQuoteHtml(post: z.infer<typeof XPostDetailView> | null | undefined, original = false): string {
  const quote = post?.quoted;
  if (!quote) return "";
  const text = !original && quote.translation ? quote.translation : quote.text;
  return `<blockquote><p>引用 ${escapeHtml(quote.authorName)}（@${escapeHtml(quote.handle)}）${!original && !quote.translation ? "，原文" : ""}</p><p>${escapeHtml(text).replace(/\n/g, "<br>")}</p><p><a href="${escapeHtml(quote.url)}">引用原帖</a></p></blockquote>`;
}
