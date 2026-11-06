import type { SiteFilings } from "@amp/contracts/http/public";
import { useTr } from "../../i18n";
import { useRouteLoaderData } from "react-router";

export const NO_FILINGS: SiteFilings = { icp: null, publicSecurity: null, newsLicense: null };

/**
 * Footer filing numbers (INV-46). They are deployment settings read by the API at run time and handed to the
 * reader shell through the public layout's site metadata; a number that is not configured is not shown.
 */
export function useSiteFilings(): SiteFilings {
  return useRouteLoaderData<{ filings?: SiteFilings }>("public-layout")?.filings ?? NO_FILINGS;
}

export function hasFilings(filings: SiteFilings): boolean {
  return !!(filings.icp || filings.publicSecurity || filings.newsLicense);
}

/** ICP links to the MIIT filing query; the public-security number links to the national query page with its code. */
export function FilingLinks({
  filings,
  linkClassName,
  licenseClassName,
  licenseAs: License = "span",
}: {
  filings: SiteFilings;
  linkClassName?: string;
  licenseClassName?: string;
  licenseAs?: "span" | "p";
}) {
  const tr = useTr();
  return (
    <>
      {filings.icp && (
        <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" className={linkClassName}>
          {filings.icp}
        </a>
      )}
      {filings.publicSecurity && (
        <a
          href={`https://beian.mps.gov.cn/#/query/webSearch?code=${filings.publicSecurity.code}`}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClassName}
        >
          {filings.publicSecurity.text}
        </a>
      )}
      {filings.newsLicense && (
        <License className={licenseClassName}>
          {tr("互联网新闻信息服务许可证：")}
          {filings.newsLicense}
        </License>
      )}
    </>
  );
}
