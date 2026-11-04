import { SearchProvider } from "../features/search/SearchOverlay";
import { Outlet, useNavigation, type ShouldRevalidateFunction } from "react-router";
import type { ReactNode } from "react";
import type { Route } from "./+types/public-layout";
import { ContentVersionGuard } from "../features/feed/ContentVersionGuard";
import { Sidebar } from "../components/shell/Sidebar";
import { MobileTabBar } from "../components/shell/MobileTabBar";
import { MobileFooter } from "../components/shell/MobileFooter";
import { BackToTop, NavigationProgress } from "../components/shell/Chrome";
import { apiGet } from "../lib/api.server";
import { ErrorBoundary as PageError } from "../root";
import { WEB_MODULES } from "@amp/site/modules/web";
import { SiteMeta } from "@amp/contracts/http/public";
import { NO_FILINGS } from "../components/shell/Filings";

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

/** Sidebar, main column and phone tab bar around a page (or an error). */
function SiteShell({ children }: { children: ReactNode }) {
  const navigation = useNavigation();
  return (
    <SearchProvider>
      <div className="flex min-h-dvh">
        <NavigationProgress active={navigation.state === "loading"} />
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-control focus:bg-surface focus:px-3 focus:py-2"
        >
          跳到正文
        </a>
        <Sidebar />
        {/* Mobile shell (≤ 960px): one centred column, the tab bar below. Desktop: the page fills the main area
          up to the list width (--page-max-wide), centred beyond it. */}
        <main id="main" className="min-w-0 flex-1 pb-[calc(72px+env(safe-area-inset-bottom))] lg:px-7 lg:pb-[72px] lg:pt-6">
          <div className="mx-auto w-full max-w-[640px] px-4 lg:max-w-[var(--page-max-wide)] lg:px-0">
            {children}
            <MobileFooter />
          </div>
        </main>
        <MobileTabBar />
        <BackToTop />
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
