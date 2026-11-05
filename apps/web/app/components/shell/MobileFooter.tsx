import { useLocation } from "react-router";
import { FilingLinks, hasFilings, useSiteFilings } from "./Filings";
import { basePath } from "../../i18n";

/**
 * The filing numbers under every public page on phones (INV-46). Desktop shows them in the sidebar; the
 * "更多" page has its own fuller footer, so it is skipped there. Numbers not configured are not shown.
 */
export function MobileFooter() {
  const { pathname } = useLocation();
  const filings = useSiteFilings();
  if (basePath(pathname).replace(/\/+$/, "") === "/more" || !hasFilings(filings)) return null;
  return (
    <footer className="mt-10 flex flex-wrap justify-center gap-x-4 gap-y-1 border-t border-line-soft pb-2 pt-4 text-center text-[12px] text-ink-4 lg:hidden">
      <FilingLinks filings={filings} linkClassName="hover:text-ink-3" />
    </footer>
  );
}
