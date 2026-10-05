import { SITE } from "@amp/industry/site";
import { useLocation } from "react-router";

/**
 * The filing numbers under every public page on phones (INV-46). Desktop shows them in the sidebar; the
 * "更多" page has its own fuller footer, so it is skipped there. Numbers not on file are not shown.
 */
export function MobileFooter() {
  const { pathname } = useLocation();
  if (pathname.replace(/\/+$/, "") === "/more" || !(SITE.icp || SITE.publicSecurity || SITE.newsLicense)) return null;
  return (
    <footer className="mt-10 flex flex-wrap justify-center gap-x-4 gap-y-1 border-t border-line-soft pb-2 pt-4 text-center text-[11px] text-ink-4 lg:hidden">
      {SITE.icp && (
        <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" className="hover:text-ink-3">
          {SITE.icp}
        </a>
      )}
      {SITE.publicSecurity && (
        <a
          href={`https://beian.mps.gov.cn/#/query/webSearch?code=${SITE.publicSecurity.code}`}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-ink-3"
        >
          {SITE.publicSecurity.text}
        </a>
      )}
      {SITE.newsLicense && <span>互联网新闻信息服务许可证：{SITE.newsLicense}</span>}
    </footer>
  );
}
