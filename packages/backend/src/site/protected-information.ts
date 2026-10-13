import { beijingDate, isValidDate } from "@amp/contracts/time";
import { SITE } from "@amp/industry/site";
import { ProtectedSiteInformation } from "@amp/contracts/http/private";
import { config, environmentValue } from "../config.ts";
/** Configuration presence only: never infer a licence or validity date, and never return filing numbers to the editable form. */
export function protectedSiteInformation(now = new Date()) {
  const recorded = environmentValue("NEWS_LICENSE_VALID_UNTIL")?.trim() || null;
  const validUntil = recorded && isValidDate(recorded) ? recorded : null;
  const remaining = validUntil ? Math.round((Date.parse(`${validUntil}T00:00:00Z`) - Date.parse(`${beijingDate(now)}T00:00:00Z`)) / 86400000) : null;
  const field = (configured: boolean, aboutDisplayed = false) => ({
    configured,
    origin: configured ? ("build" as const) : ("not_recorded" as const),
    footerDisplayed: configured,
    aboutDisplayed: configured && aboutDisplayed,
  });
  return ProtectedSiteInformation.parse({
    siteUrl: config.siteUrl,
    siteUrlOrigin: environmentValue("SITE_URL") ? "runtime" : "build_default",
    icp: field(!!SITE.icp),
    publicSecurity: field(!!SITE.publicSecurity),
    newsLicense: field(!!SITE.newsLicense, true),
    newsLicenseValidUntil: validUntil,
    newsLicenseDateState: !recorded ? "not_recorded" : validUntil ? "recorded" : "invalid",
    remainingDays: remaining,
    warningDays: 60,
    productionFilingConfigured: !!SITE.icp && !!SITE.publicSecurity,
  });
}
