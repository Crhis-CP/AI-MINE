// The frame around every page of the rewritten reader: skip link, site name, main column and the footer with the
// filing numbers. Plan 3.2 replaces it with the full shell (navigation, search, the content-version guard). It counts
// a page view for the admin's 访问概况; its error page does not, so a 404 is never counted.
import { isRouteErrorResponse, Link, Outlet, type ShouldRevalidateFunction, useLocation, useRouteError, useRouteLoaderData } from "react-router";
import type { ReactNode } from "react";
import { SITE } from "@amp/industry/site";
import { type SiteFilings, SiteMeta } from "@amp/contracts/http/public";
import { markDegraded } from "../../app/lib/cache.server.ts";
import { useVisitBeacon } from "../../app/lib/visit-beacon.ts";
import { localeOf, localizedPath, wordsFor } from "../i18n/locale.ts";
import { readSite } from "../lib/api.server.ts";
import type { Route } from "./+types/layout";

const NO_FILINGS: SiteFilings = { icp: null, publicSecurity: null, newsLicense: null };

/** Filing numbers that could not be read are left out, never invented, and the page is then kept out of every cache. */
export async function loader({ request }: Route.LoaderArgs): Promise<{ filings: SiteFilings }> {
  try {
    return { filings: (await readSite(request, "/api/site/meta", SiteMeta)).body.filings };
  } catch {
    markDegraded();
    return { filings: NO_FILINGS };
  }
}

export const shouldRevalidate: ShouldRevalidateFunction = () => false;

function Frame({ children }: { children: ReactNode }) {
  const locale = localeOf(useLocation().pathname);
  const words = wordsFor(locale);
  const filings = useRouteLoaderData<typeof loader>("public-layout")?.filings ?? NO_FILINGS;
  return (
    <div className="flex min-h-dvh flex-col bg-bg text-ink">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-control focus:bg-surface focus:px-3 focus:py-2"
      >
        {words.skip}
      </a>
      <header className="border-b border-line px-4 py-3">
        <Link to={localizedPath("/", locale)} className="text-[17px] font-bold text-ink">
          {SITE.name}
        </Link>
      </header>
      <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        {children}
      </main>
      <footer className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line px-4 py-4 text-[12px] text-ink-4">
        {filings.icp && (
          <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">
            {filings.icp}
          </a>
        )}
        {filings.publicSecurity && (
          <a href={`https://beian.mps.gov.cn/#/query/webSearch?code=${filings.publicSecurity.code}`} target="_blank" rel="noopener noreferrer">
            {filings.publicSecurity.text}
          </a>
        )}
        {filings.newsLicense && (
          <span>
            {words.license}
            {filings.newsLicense}
          </span>
        )}
      </footer>
    </div>
  );
}

export default function Layout() {
  useVisitBeacon();
  return (
    <Frame>
      <Outlet />
    </Frame>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const locale = localeOf(useLocation().pathname);
  const words = wordsFor(locale);
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <Frame>
      <title>{`${notFound ? words.notFound : words.unavailable} · ${SITE.webName}`}</title>
      <meta name="robots" content="noindex" />
      <h1 className="text-[20px] font-bold">{notFound ? words.notFound : words.unavailable}</h1>
      <p className="mt-2 text-[13.5px] text-ink-3">{notFound ? words.notFoundBody : words.unavailableBody}</p>
      <p className="mt-6">
        <Link reloadDocument to={localizedPath("/", locale)} className="text-accent-ink underline">
          {words.home}
        </Link>
      </p>
    </Frame>
  );
}
