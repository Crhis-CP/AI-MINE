import { SITE } from "@aihot/industry/site";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { pageMeta } from "../lib/seo";
import { removeStar, useStarred } from "../lib/local-state";
import { fullDateTime, shortSourceName } from "../lib/format";
import { IconBookmark, IconClose } from "../components/icons";

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export function meta() {
  return pageMeta({ title: "我的收藏", description: `保存在这台设备上的 ${SITE.name} 收藏。`, path: "/starred", noindex: true });
}

export default function StarredPage() {
  const starred = useStarred();
  const [mounted, setMounted] = useState(false);
  const [availability, setAvailability] = useState<Record<string, string>>({});
  useEffect(() => setMounted(true), []);

  const starredIds = starred.map((s) => s.id).join(",");
  useEffect(() => {
    if (!mounted || !starredIds) return;
    const controller = new AbortController();
    fetch(`/api/site/items/availability?ids=${encodeURIComponent(starredIds)}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : {}))
      .then((data) => {
        if (!controller.signal.aborted) setAvailability(data);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [mounted, starredIds]);

  return (
    <div className="pb-12">
      <header className="flex flex-col gap-2 pb-4 pt-5 sm:flex-row sm:items-start sm:justify-between lg:pt-1">
        <div>
          <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">收藏</h1>
          <p className="mt-1.5 text-[13px] text-ink-3">本机收藏的 {SITE.name} 内容，适合稍后阅读和回看。</p>
        </div>
      </header>
      <p className="rounded-tile border border-line bg-surface px-4 py-2.5 text-[12.5px] text-ink-3">
        收藏只保存在当前浏览器；清除浏览器数据或换设备后不会同步。
      </p>
      {!mounted ? null : starred.length === 0 ? (
        <div className="mt-3 flex flex-col items-center rounded-card border border-dashed border-line-strong px-6 py-12 text-center">
          <IconBookmark size={20} className="text-ink-4" />
          <p className="mt-3 text-[13px] text-ink-3">还没有收藏内容。点开任意一条内容，在详情页点击收藏即可添加。</p>
          <Link to="/" className="mt-4 text-[12.5px] font-medium text-accent hover:text-accent-ink">
            去看精选 →
          </Link>
        </div>
      ) : (
        <ul className="mt-3 lg:space-y-3">
          {starred.map((s) => {
            const status = availability[s.id];
            const unavailable = status === "unavailable";
            return (
              <li
                key={s.id}
                className={`relative border-b border-line-soft py-4 lg:card lg:px-[18px] lg:py-[15px] ${unavailable ? "opacity-70" : "lg:card-hover"}`}
              >
                <div className="flex items-center gap-2 text-[12.5px] text-ink-4">
                  <span className="min-w-0 truncate text-ink-3">{shortSourceName(s.sourceName)}</span>
                  {s.publishedAt && <span className="num shrink-0">· {fullDateTime(s.publishedAt)}</span>}
                  <span className="ml-auto hidden shrink-0 sm:inline">
                    收藏于 <span className="num">{fullDateTime(s.savedAt)}</span>
                  </span>
                  <button
                    type="button"
                    aria-label="取消收藏"
                    title="取消收藏"
                    onClick={() => removeStar(s.id)}
                    className="relative z-10 -my-1 ml-auto grid size-7 shrink-0 place-items-center rounded-full text-ink-4 transition-colors hover:bg-bg-sunk hover:text-ink sm:ml-0"
                  >
                    <IconClose size={14} />
                  </button>
                </div>
                <h2 className="mt-1.5 text-[16px] font-[650] leading-[1.55] text-ink">
                  {unavailable ? (
                    s.title
                  ) : (
                    <Link to={`/items/${s.id}`} className="transition-colors after:absolute after:inset-0 after:content-[''] hover:text-accent">
                      {s.title}
                    </Link>
                  )}
                </h2>
                {s.summary && <p className="mt-1.5 line-clamp-2 text-[14px] leading-[1.75] text-ink-3">{s.summary}</p>}
                {unavailable && <p className="mt-2 text-[12.5px] text-hot">这条内容已不再公开，收藏会保留直到你手动移除。</p>}
                {status === "summary-only" && <p className="mt-2 text-[12.5px] text-amber-ink">应来源方要求，这条内容现在只提供摘要。</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
