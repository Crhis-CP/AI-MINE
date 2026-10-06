import { Outlet, useNavigation, type ShouldRevalidateFunction } from "react-router";
import type { ReactNode } from "react";
import type { Route } from "./+types/public-layout";
import { Sidebar } from "../components/shell/Sidebar";
import { MobileTabBar } from "../components/shell/MobileTabBar";
import { MobileFooter } from "../components/shell/MobileFooter";
import { BackToTop, NavigationProgress } from "../components/shell/Chrome";
import { apiGet } from "../lib/api.server";
import { ErrorBoundary as PageError } from "../root";

interface SiteMeta {
  changelogVersion: string | null;
}

// Nothing reads the changelog version since the navigation's unread dot was removed; the endpoint
// changes when site/meta.ts moves to the product update records.
export async function loader({ request }: Route.LoaderArgs) {
  try {
    return await apiGet<SiteMeta>("/api/site/meta", { signal: request.signal });
  } catch {
    return { changelogVersion: null } satisfies SiteMeta;
  }
}

export const shouldRevalidate: ShouldRevalidateFunction = () => false;

/** Sidebar, main column and phone tab bar around a page (or an error). */
function SiteShell({ children }: { children: ReactNode }) {
  const navigation = useNavigation();
  return (
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
  );
}

export default function PublicLayout() {
  return (
    <SiteShell>
      <Outlet />
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
