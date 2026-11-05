// The desktop page footer (PG-00 §1, DEC-78): the lockup and the AI notice, the secondary links with the
// correction and takedown entry, and the filing numbers configured for this deployment (INV-46).
// Phones keep MobileFooter and the "更多" page's own footer.
import { useLocation } from "react-router";
import { SITE } from "@amp/industry/site";
import { feedbackPath } from "../../lib/feedback-origin";
import { Wordmark } from "../Logo";
import { IntentLink as Link } from "../ui/IntentLink";
import { FilingLinks, useSiteFilings } from "./Filings";

export function SiteFooter() {
  const { pathname, search } = useLocation();
  const filings = useSiteFilings();
  const link = "hover:text-ink-2";
  return (
    <footer className="mt-16 hidden border-t border-line bg-surface-2 lg:block">
      <div className="site-frame flex flex-wrap items-center gap-x-6 gap-y-3 py-6 text-[13px] text-ink-4">
        <Link to="/" className="shrink-0" aria-label={`${SITE.name} 首页`}>
          <Wordmark size={17} />
        </Link>
        <span>AI 辅助整理，请以原文为准</span>
        <nav className="flex flex-wrap gap-x-4 gap-y-1" aria-label="页脚导航">
          <Link to="/about" className={link}>
            关于
          </Link>
          <Link to="/terms" className={link}>
            服务条款
          </Link>
          <Link to="/privacy" className={link}>
            隐私
          </Link>
          <Link to={feedbackPath(pathname, search)} className={link}>
            更正与下架
          </Link>
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1">
          <FilingLinks filings={filings} linkClassName={link} />
          <span>
            © {new Date().getFullYear()} {SITE.name}
          </span>
        </div>
      </div>
    </footer>
  );
}
