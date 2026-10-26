import { z } from "zod";
import type { XPostData, MediaItem } from "./materials.ts";
import { escapeHtml } from "../lib/text.ts";

const url = z
  .url({ protocol: /^https?$/ })
  .max(8192)
  .refine((value) => {
    const parsed = new URL(value);
    return !parsed.username && !parsed.password;
  });
const media = z.strictObject({
  kind: z.enum(["image", "video"]),
  url,
  width: z.number().int().nonnegative().nullable().optional(),
  height: z.number().int().nonnegative().nullable().optional(),
  alt: z.string().max(4096).nullable().optional(),
  poster: url.nullable().optional(),
});
const post = z.strictObject({
  tweetId: z.string().trim().min(1).max(200),
  authorName: z.string().max(500),
  handle: z.string().max(200),
  avatarUrl: url.nullable().optional(),
  text: z.string().max(1_000_000),
  quoted: z
    .strictObject({
      authorName: z.string().max(500),
      handle: z.string().max(200),
      text: z.string().max(1_000_000),
      url,
      media: z.array(media).max(64).optional(),
    })
    .nullable()
    .optional(),
  media: z.array(media).max(64).optional(),
  lang: z.string().max(40).nullable().optional(),
  replyTo: z.string().max(200).nullable().optional(),
});

/** Only an explicit typed post enters storage; unrelated raw/title fields never establish this identity. */
export function validatedPost(value: XPostData): XPostData {
  const parsed = post.safeParse(value);
  if (!parsed.success) throw new Error("Invalid original-post material");
  return parsed.data;
}

const semanticMedia = (items?: MediaItem[]) => items?.map(({ kind, url, alt }) => ({ kind, url, alt }));
/** Avatars and display dimensions update presentation without buying another analysis. */
export function postContentIdentity(value: XPostData | null | undefined) {
  if (!value) return null;
  const { avatarUrl: _avatar, lang: _lang, replyTo: _reply, ...content } = value;
  return { ...content, media: semanticMedia(value.media), quoted: value.quoted ? { ...value.quoted, media: semanticMedia(value.quoted.media) } : value.quoted };
}

export type PostArticle = { title?: string | null; text?: string } | null;
export function postArticleBlock(article: PostArticle): string {
  return article?.text ? [article.title ? `# ${article.title}` : "", article.text].filter(Boolean).join("\n\n") : "";
}
export function withStoredPostArticle(text: string | null, article: PostArticle): string | null {
  const block = postArticleBlock(article);
  return block && !text?.endsWith(block) ? [text, block].filter(Boolean).join("\n\n") : text;
}
export function postBodyHtml(value: XPostData, article: PostArticle = null): string | null {
  const text = withStoredPostArticle(value.text, article);
  const paragraphs = text
    ? text
        .split(/\n{2,}/)
        .map((part) => `<p>${escapeHtml(part).replace(/\n/g, "<br>")}</p>`)
        .join("\n")
    : "";
  const pictures = (value.media ?? [])
    .filter((item) => item.kind === "image")
    .map((item) => `<p><img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.alt ?? "原帖配图")}"></p>`)
    .join("\n");
  return [paragraphs, pictures].filter(Boolean).join("\n") || null;
}
