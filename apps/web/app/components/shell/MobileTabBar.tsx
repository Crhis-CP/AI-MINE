import { UnreadMark } from "../../features/changelog/UnreadMark";
import { useLocation } from "react-router";
import { IntentLink as Link } from "../ui/IntentLink";
import { TABBAR, tabIsActive } from "./nav";

/** Bottom tab bar of the mobile shell (up to 960px), as on the original site. */
export function MobileTabBar() {
  const { pathname } = useLocation();
  if (/^\/(?:items|story)\/|^\/(?:daily|weekly|monthly)\/(?!archive(?:\/|$))[^/]+$|^\/policies\/(?!reports(?:\?|$))/.test(pathname)) return null;
  return (
    <nav
      aria-label="底部导航"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
    >
      <div className="mx-auto grid h-[54px] max-w-[640px]" style={{ gridTemplateColumns: `repeat(${TABBAR.length}, minmax(0, 1fr))` }}>
        {TABBAR.map((t) => {
          const active = tabIsActive(t, pathname);
          const Icon = t.icon;
          if (/^\/(?:items|story)\/|^\/(?:daily|weekly|monthly)\/(?!archive(?:\/|$))[^/]+$|^\/policies\/(?!reports(?:\?|$))/.test(pathname)) return null;
          return (
            <Link
              key={t.to}
              to={t.to}
              aria-current={active ? "page" : undefined}
              className={`relative flex flex-col items-center justify-center gap-[3px] text-[11px] transition-colors ${active ? "font-semibold text-accent" : "text-ink-3 active:text-ink"}`}
            >
              <Icon size={21} />
              <span className="flex items-center gap-1">
                {t.label}
                {t.to === "/more" && <UnreadMark />}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
