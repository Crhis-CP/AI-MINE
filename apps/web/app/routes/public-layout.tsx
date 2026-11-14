import { SearchProvider } from "../features/search/SearchOverlay";
import { createContext, Outlet, useLocation, useNavigation, type ShouldRevalidateFunction } from "react-router";
import { useEffect, type ReactNode } from "react";
import type { Route } from "./+types/public-layout";
import { ContentVersionGuard } from "../features/feed/ContentVersionGuard";
import { SiteHeader } from "../components/shell/SiteHeader";
import { SiteFooter } from "../components/shell/SiteFooter";
import { MobileTabBar } from "../components/shell/MobileTabBar";
import { MobileFooter } from "../components/shell/MobileFooter";
import { PhoneFallbackBar } from "../components/shell/PhoneBar";
import { Wordmark } from "../components/Logo";
import { Link } from "../i18n/navigation";
import { SITE } from "@amp/industry/site";
import { BackToTop, ListKeys, NavigationProgress } from "../components/shell/Chrome";
import { apiGet } from "../lib/api.server";
import { markDegraded } from "../lib/cache.server";
import { ErrorBoundary as PageError } from "../root";
import { WEB_MODULES } from "@amp/site/modules/web";
import { SiteMeta, schemas as publicSchemas } from "@amp/contracts/http/public";
import { NO_FILINGS } from "../components/shell/Filings";
import { localeOf, useT, useTr } from "../i18n";
import { useVisitBeacon } from "../lib/visit-beacon";

/** The content and withdrawal versions this page was read at (TASK-0679 R1); null when they could not be read. */
export type ServedVersion = { version: string; withdrawalVersion: string } | null;
const servedVersion = createContext<ServedVersion>(null);

/**
 * A page document reads the content and withdrawal versions before any of its data and carries them, so the browser
 * re-reads the page only when they have moved since (TASK-0679 R1). Read first, a race can only leave them older than
 * the data: one extra read, never a missed withdrawal. Data requests (in-site navigation) do not need them.
 */
export const middleware: Route.MiddlewareFunction[] = [
  async ({ request, context }, next) => {
    if (new URL(request.url).pathname.endsWith(".data")) return next();
    try {
      context.set(servedVersion, publicSchemas.ContentVersion.parse(await apiGet<unknown>("/api/site/content-version", { signal: request.signal })));
    } catch {
      // The browser then re-reads once, as before; the page itself stays out of every cache.
      markDegraded();
    }
    return next();
  },
];

// Unavailable metadata leaves the navigation unmarked and the footer without numbers; it never invents either, and the
// page is not cached that way (TASK-0679 R13).
export async function loader({ request, context }: Route.LoaderArgs): Promise<SiteMeta & { contentVersion: ServedVersion }> {
  const contentVersion = context.get(servedVersion);
  try {
    const raw = await apiGet<unknown>("/api/site/meta", {
      signal: request.signal,
      headers: Object.assign({}, ...WEB_MODULES.map((module) => module.root?.documentHeaders?.(request) ?? {})),
    });
    const meta = SiteMeta.safeParse(raw);
    if (meta.success) return { ...meta.data, contentVersion };
    markDegraded();
    // An API without run-time filing numbers (during a rolling release) still marks product updates.
    const version = SiteMeta.shape.changelogVersion.safeParse((raw as { changelogVersion?: unknown } | null)?.changelogVersion);
    return { changelogVersion: version.success ? version.data : null, filings: NO_FILINGS, contentVersion };
  } catch {
    markDegraded();
    return { changelogVersion: null, filings: NO_FILINGS, contentVersion };
  }
}

export const shouldRevalidate: ShouldRevalidateFunction = () => false;

/** Header, main column and footer (desktop) or phone tab bar around a page (or an error). */
function SiteShell({ children }: { children: ReactNode }) {
  const navigation = useNavigation();
  const t = useT();
  const tr = useTr();
  const { pathname, search } = useLocation();
  // English pages keep their Chinese <title> from each route's meta (they are noindex); the tab shows it in English.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a search change can change the title.
  useEffect(() => {
    if (localeOf(pathname) !== "en" || navigation.state !== "idle") return;
    const english = document.title
      .split(" · ")
      .map((part) => tr.maybe(part))
      .join(" · ");
    if (english !== document.title) document.title = english;
  }, [pathname, search, navigation.state, tr]);
  return (
    <SearchProvider>
      <div className="flex min-h-dvh flex-col">
        <NavigationProgress active={navigation.state === "loading"} />
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-control focus:bg-surface focus:px-3 focus:py-2"
        >
          {t.shell.skip}
        </a>
        <SiteHeader />
        {/* Mobile shell (≤ 960px): one centred column, the tab bar below. Desktop: the page fills the frame under
          the header up to the list width (--page-max-wide), centred beyond it; the footer closes it. */}
        <main id="main" className="site-main min-w-0 flex-1 pb-[calc(72px+env(safe-area-inset-bottom))] lg:pb-0 lg:pt-7">
          <div className="site-frame">
            <PhoneFallbackBar
              home={
                <Link to="/" aria-label={`${SITE.name} ${t.shell.home}`} className="flex h-11 items-center px-2.5 text-ink">
                  <Wordmark size={17} />
                </Link>
              }
            />
            {children}
            <MobileFooter />
          </div>
        </main>
        <SiteFooter />
        <MobileTabBar />
        <BackToTop />
        <ListKeys />
      </div>
    </SearchProvider>
  );
}

export default function PublicLayout() {
  // Counts reader pages for the admin's 访问概况; error pages (the boundary below) are not counted.
  useVisitBeacon();
  return (
    <SiteShell>
      <ContentVersionGuard>
        <Outlet />
      </ContentVersionGuard>
    </SiteShell>
  );
}

export function ErrorBoundary() {
  return (
    <SiteShell>
      <PageError />
    </SiteShell>
  );
}
