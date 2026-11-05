// The desktop header (direction C "survey map", DEC-78, Owner 2026-11-05): the lockup, the content
// sections in one row, a "更多" menu for the rest, then search and the appearance switch, over slowly
// drifting gold contour lines. Phones keep their own header and the tab bar (≤ 960px).
import { useEffect, useRef } from "react";
import { Link as PlainLink, useLocation } from "react-router";
import { otherLanguagePath, useLocale, useT } from "../../i18n";
import { SITE } from "@amp/industry/site";
import { UnreadMark } from "../../features/changelog/UnreadMark";
import { useOpenSearch } from "../../features/search/SearchOverlay";
import { feedbackPath } from "../../lib/feedback-origin";
import { IconChevronDown, IconSearch } from "../icons";
import { Wordmark } from "../Logo";
import { IntentLink as Link } from "../ui/IntentLink";
import { SIDEBAR, tabIsActive, type NavItem } from "./nav";
import { ThemeSwitch } from "./ThemeSwitch";

const [CONTENT, ...REST] = SIDEBAR;

/** Seven gentle survey contours, twice the header's width so the drift can loop seamlessly. */
const CONTOURS = Array.from({ length: 7 }, (_, k) => {
  const y = 12 + k * 11,
    a = 6 + k * 1.4;
  let d = `M0 ${y}`;
  for (let x = 0; x <= 2880; x += 120) d += ` Q ${x + 60} ${y + ((x / 120 + k) % 2 ? a : -a)} ${x + 120} ${y}`;
  return d;
});

function useHref(item: NavItem) {
  const { pathname, search } = useLocation();
  return { to: item.to === "/feedback" ? feedbackPath(pathname, search) : item.to, active: tabIsActive(item, pathname) };
}

function TopLink({ item }: { item: NavItem }) {
  const { to, active } = useHref(item);
  const t = useT();
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={`flex h-10 shrink-0 items-center whitespace-nowrap px-2.5 text-[14.5px] xl:px-3 xl:text-[15px] transition-colors duration-150 ${
        active ? "font-semibold text-ink shadow-[inset_0_-2px_0_var(--accent)]" : "rounded-control font-medium text-ink-3 hover:bg-bg-sunk hover:text-ink"
      }`}
    >
      {t.nav[item.to] ?? item.label}
    </Link>
  );
}

function MenuLink({ item }: { item: NavItem }) {
  const { to, active } = useHref(item);
  const t = useT();
  const Icon = item.icon;
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={`flex h-10 items-center gap-2.5 rounded-control px-2.5 text-[15px] ${active ? "bg-accent-soft font-semibold text-ink" : "text-ink-2 hover:bg-bg-sunk hover:text-ink"}`}
    >
      <span className={`flex w-[20px] shrink-0 justify-center ${active ? "text-accent" : "text-ink-4"}`}>
        <Icon size={16} />
      </span>
      <span className="min-w-0 flex-1 truncate">{t.nav[item.to] ?? item.label}</span>
      {item.to === "/changelog" && <UnreadMark />}
    </Link>
  );
}

/** "更多" as a native disclosure: usable without scripts; closes on navigation, outside clicks and Escape. */
function MoreMenu() {
  const ref = useRef<HTMLDetailsElement>(null);
  const t = useT();
  const { pathname, search } = useLocation();
  const active = REST.some((section) => section.items.some((item) => tabIsActive(item, pathname)));
  // biome-ignore lint/correctness/useExhaustiveDependencies: close whenever the location changes.
  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [pathname, search]);
  useEffect(() => {
    const close = (event: Event) => {
      const menu = ref.current;
      if (!menu?.open) return;
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !menu.contains(event.target as Node)) {
        menu.open = false;
        if (event instanceof KeyboardEvent) menu.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);
  return (
    <details ref={ref} className="group relative shrink-0">
      <summary
        className={`flex h-10 cursor-pointer list-none items-center gap-1 px-2.5 text-[14.5px] xl:px-3 xl:text-[15px] [&::-webkit-details-marker]:hidden ${
          active ? "font-semibold text-ink shadow-[inset_0_-2px_0_var(--accent)]" : "rounded-control font-medium text-ink-3 hover:bg-bg-sunk hover:text-ink"
        }`}
      >
        {t.shell.more}
        <UnreadMark />
        <IconChevronDown size={14} className="transition-transform duration-150 group-open:rotate-180" />
      </summary>
      <div className="absolute right-0 top-[calc(100%+6px)] z-40 w-56 rounded-card border border-line bg-raised p-1.5 shadow-[var(--shadow-pop)]">
        {REST.map((section) => (
          <div key={section.title} className="[&+&]:mt-1.5 [&+&]:border-t [&+&]:border-line-soft [&+&]:pt-1.5">
            {REST.length > 1 && <div className="px-2.5 pb-1 pt-1 text-[12px] text-ink-4">{section.title}</div>}
            {section.items.map((item) => (
              <MenuLink key={item.to} item={item} />
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

/** The same page in the other interface language; a plain link, so the address is not re-localised. */
function LanguageSwitch() {
  const { pathname, search } = useLocation();
  const locale = useLocale(),
    t = useT();
  return (
    <PlainLink
      to={otherLanguagePath(pathname, search, locale)}
      hrefLang={locale === "en" ? "zh-CN" : "en"}
      lang={locale === "en" ? "zh-CN" : "en"}
      aria-label={t.shell.switchToLabel}
      className="flex h-10 items-center rounded-control border border-line bg-surface px-3 text-[13.5px] font-semibold text-ink-3 hover:text-ink"
    >
      {t.shell.switchTo}
    </PlainLink>
  );
}

export function SiteHeader() {
  const openSearch = useOpenSearch();
  const t = useT();
  return (
    <header className="site-header relative hidden border-b border-line bg-surface lg:block">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <svg className="site-contours" viewBox="0 0 2880 90" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          {CONTOURS.map((d) => (
            <path key={d} d={d} />
          ))}
        </svg>
      </div>
      <div className="site-frame relative flex h-[68px] items-center gap-3 xl:gap-5">
        <Link to="/" className="flex shrink-0 items-center text-ink" aria-label={`${SITE.name} ${t.shell.home}`}>
          <Wordmark size={22} />
        </Link>
        <nav data-site-nav className="-my-2 flex min-w-0 flex-1 items-center gap-0.5 py-2" aria-label={t.shell.mainNav}>
          <div className="scrollbar-none flex min-w-0 items-center gap-0.5 overflow-x-auto">
            {CONTENT?.items.map((item) => (
              <TopLink key={item.to} item={item} />
            ))}
          </div>
          {REST.length > 0 && <MoreMenu />}
        </nav>
        <div className="flex shrink-0 items-center gap-2.5">
          {openSearch && (
            <button
              type="button"
              onClick={(event) => openSearch("", event.currentTarget)}
              className="flex size-10 items-center justify-center rounded-control border border-line bg-surface text-ink-3 hover:text-ink"
              aria-label={t.shell.search}
            >
              <IconSearch size={17} />
            </button>
          )}
          <LanguageSwitch />
          <ThemeSwitch className="w-[108px]" />
        </div>
      </div>
    </header>
  );
}
