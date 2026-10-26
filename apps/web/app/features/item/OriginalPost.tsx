import { useState } from "react";
import type { MediaView, XPostDetailView, XPostFeedView } from "@amp/contracts/site";
import { ArticleBody } from "./ArticleBody";

// The existing image policy permits site resources; a public media URL does not create a proxy.
const localImage = (url: string | null | undefined): url is string => !!url && /^\/(?!\/)[^\\\s]*$/.test(url);
const localSrcSet = (value?: string) =>
  value
    ?.split(",")
    .filter((candidate) => localImage(candidate.trim().split(/\s+/)[0]))
    .join(",") || undefined;

export function PostAuthor({ post }: { post: XPostFeedView }) {
  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-ink-3">
      {localImage(post.avatarUrl) && (
        <img
          src={post.avatarUrl}
          srcSet={localSrcSet(post.avatarSrcSet)}
          width={20}
          height={20}
          alt=""
          loading="lazy"
          className="size-5 rounded-full object-cover"
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      )}
      <span className="break-words font-semibold">{post.authorName || (post.handle ? `@${post.handle}` : "原帖作者未提供")}</span>
      {post.authorName && post.handle && <span className="break-all text-ink-4">@{post.handle}</span>}
    </div>
  );
}

export function QuotedPost({
  quoted,
  language = "zh",
  compact = false,
}: {
  quoted: NonNullable<XPostFeedView["quoted"]> | NonNullable<XPostDetailView["quoted"]>;
  language?: "zh" | "original";
  compact?: boolean;
}) {
  const translated = language === "zh" && !!quoted.translation?.trim();
  return (
    <figure className={`mt-3 min-w-0 rounded-control border border-line-soft px-3 py-2 ${compact ? "text-[13px]" : "text-[15px]"}`}>
      <figcaption className="flex flex-wrap items-baseline gap-x-1.5 text-[12px] text-ink-4">
        <span>{translated ? "引用 · AI 翻译" : "引用 · 原文"}</span>
        <span className="break-words font-semibold text-ink-2">{quoted.authorName || `@${quoted.handle}`}</span>
        {quoted.authorName && quoted.handle && <span className="break-all">@{quoted.handle}</span>}
      </figcaption>
      <blockquote className={`mt-1 whitespace-pre-line break-words leading-[1.75] text-ink-3 ${compact ? "line-clamp-2" : ""}`}>
        {translated ? quoted.translation : quoted.text}
      </blockquote>
      {!compact && "url" in quoted && (
        <a href={quoted.url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-[13px] text-accent">
          打开被引用的原帖
        </a>
      )}
    </figure>
  );
}

export function PostMedia({ media, href, compact = false }: { media: MediaView[]; href: string; compact?: boolean }) {
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  if (!media.length) return null;
  const unique = [...new Map(media.map((entry) => [`${entry.kind}:${entry.url}`, entry])).values()];
  const shown = compact ? unique.slice(0, 4) : unique;
  return (
    <ArticleBody>
      <div className={`relative z-10 mt-3 grid gap-2 ${shown.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
        {shown.map((entry) => {
          const preview = entry.poster ?? entry.url;
          const fallback = !localImage(preview) || failed[preview];
          const image = !fallback && (
            <img
              src={preview}
              srcSet={localSrcSet(entry.srcSet)}
              data-full-src={entry.kind === "image" && localImage(entry.fullUrl) ? entry.fullUrl : undefined}
              width={entry.width ?? undefined}
              height={entry.height ?? undefined}
              alt={entry.alt ?? "原帖图片"}
              loading="lazy"
              decoding="async"
              onError={() => setFailed((current) => ({ ...current, [preview]: true }))}
              className={`block w-full rounded-control object-cover ${compact ? "h-28" : "max-h-[360px]"}`}
            />
          );
          return (
            <div key={`${entry.kind}:${entry.url}`} className="min-w-0 overflow-hidden rounded-control border border-line-soft bg-bg-sunk">
              {fallback || entry.kind === "video" ? (
                <a href={href} target={compact ? undefined : "_blank"} rel="noopener noreferrer" className="block text-[13px] leading-relaxed text-accent">
                  {image}
                  <span className="block px-3 py-2">{fallback ? (compact ? "媒体暂不可用，查看原帖" : "媒体暂不可用，打开原文查看") : "在原文播放视频"}</span>
                </a>
              ) : (
                image
              )}
            </div>
          );
        })}
      </div>
      {compact && unique.length > shown.length && (
        <a href={href} className="relative z-10 mt-1 inline-block text-[12px] text-accent">
          查看全部 {unique.length} 项媒体
        </a>
      )}
    </ArticleBody>
  );
}
