import { useEffect, useState } from "react";
import { IconBookmark, IconExternal, IconList, IconShare } from "../../components/icons";
import { toggleStar, useIsStarred } from "../../lib/local-state";

export function ReaderToolbar({ id, originalUrl, onOutline, onShare }: { id: string; originalUrl: string; onOutline?: () => void; onShare: () => void }) {
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const starred = useIsStarred(id);
  useEffect(() => {
    let last = window.scrollY,
      frame = 0;
    const update = () => {
      frame = 0;
      const y = window.scrollY,
        end = document.documentElement.scrollHeight - window.innerHeight;
      if (y < 80 || y > end - 120) {
        setHidden(false);
        last = y;
      } else if (Math.abs(y - last) > 6) {
        setHidden(y > last);
        last = y;
      }
    };
    const scroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    window.addEventListener("scroll", scroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", scroll);
    };
  }, []);
  const tool = "flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-[11px] text-ink-3 active:text-accent";
  return (
    <nav
      aria-label="阅读工具"
      className={`fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur transition-transform duration-200 focus-within:translate-y-0 lg:hidden motion-reduce:transition-none ${hidden ? "translate-y-full" : ""}`}
    >
      {error && (
        <p role="alert" className="px-4 py-2 text-[13px] text-hot">
          {error}
        </p>
      )}
      <div className={`mx-auto grid max-w-[640px] ${onOutline ? "grid-cols-4" : "grid-cols-3"}`}>
        <button
          type="button"
          aria-label={starred ? "取消收藏" : "收藏"}
          aria-pressed={starred}
          className={tool}
          onClick={() => {
            const result = toggleStar({ id });
            setError(result.ok ? null : result.message);
          }}
        >
          <IconBookmark size={22} filled={starred} />
          <span>{starred ? "已收藏" : "收藏"}</span>
        </button>
        {onOutline && (
          <button type="button" onClick={onOutline} className={tool}>
            <IconList size={22} />
            <span>目录</span>
          </button>
        )}
        <button type="button" onClick={onShare} className={tool}>
          <IconShare size={22} />
          <span>分享</span>
        </button>
        <a href={originalUrl} target="_blank" rel="noopener noreferrer" className={tool}>
          <IconExternal size={22} />
          <span>打开原文</span>
        </a>
      </div>
    </nav>
  );
}

export { scrollToAnchor as scrollToReadingAnchor } from "../../lib/motion";
