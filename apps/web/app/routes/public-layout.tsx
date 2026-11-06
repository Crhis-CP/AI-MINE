import { SearchProvider } from "../features/search/SearchOverlay";
import { Outlet, useLocation, useNavigation, type ShouldRevalidateFunction } from "react-router";
import { useEffect, type ReactNode } from "react";
import type { Route } from "./+types/public-layout";
import { ContentVersionGuard } from "../features/feed/ContentVersionGuard";
import { SiteHeader } from "../components/shell/SiteHeader";
import { SiteFooter } from "../components/shell/SiteFooter";
import { MobileTabBar } from "../components/shell/MobileTabBar";
import { MobileFooter } from "../components/shell/MobileFooter";
import { BackToTop, ListKeys, NavigationProgress } from "../components/shell/Chrome";
import { apiGet } from "../lib/api.server";
import { ErrorBoundary as PageError } from "../root";
import { WEB_MODULES } from "@amp/site/modules/web";
import { SiteMeta } from "@amp/contracts/http/public";
import { NO_FILINGS } from "../components/shell/Filings";
import { localeOf, useT, useTr } from "../i18n";

// Unavailable metadata leaves the navigation unmarked and the footer without numbers; it never invents either.
export async function loader({ request }: Route.LoaderArgs): Promise<SiteMeta> {
  try {
    const raw = await apiGet<unknown>("/api/site/meta", {
      signal: request.signal,
      headers: Object.assign({}, ...WEB_MODULES.map((module) => module.root?.documentHeaders?.(request) ?? {})),
    });
    const meta = SiteMeta.safeParse(raw);
    if (meta.success) return meta.data;
    // An API without run-time filing numbers (during a rolling release) still marks product updates.
    const version = SiteMeta.shape.changelogVersion.safeParse((raw as { changelogVersion?: unknown } | null)?.changelogVersion);
    return { changelogVersion: version.success ? version.data : null, filings: NO_FILINGS };
  } catch {
    return { changelogVersion: null, filings: NO_FILINGS };
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
