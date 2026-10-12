import { z } from "zod";
import { ProblemResponse } from "./common.ts";
const https = z
  .url()
  .max(2000)
  .refine((value) => {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password;
  }, "请使用完整HTTPS地址，且不包含登录凭据");
export const OfficialMetalLink = z.strictObject({ name: z.string().trim().min(1).max(100), url: https, note: z.string().trim().min(1).max(300) });
export const SiteInformationFields = z.strictObject({
  about: z.string().trim().max(5000),
  contactEmail: z.email().max(254).nullable(),
  contactPage: https.nullable(),
  metalLinks: z
    .array(OfficialMetalLink)
    .max(30)
    .refine((links) => new Set(links.map((link) => link.url)).size === links.length, "入口地址不能重复"),
});
export const SiteInformation = SiteInformationFields.extend({
  revision: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
});
export const SiteInformationUpdate = SiteInformationFields.extend({ expected_revision: z.number().int().nonnegative() });
const check = z.strictObject({
  configured: z.boolean(),
  origin: z.enum(["build", "runtime", "not_recorded"]),
  footerDisplayed: z.boolean(),
  aboutDisplayed: z.boolean(),
});
export const ProtectedSiteInformation = z.strictObject({
  siteUrl: z.url(),
  siteUrlOrigin: z.enum(["build_default", "runtime"]),
  icp: check,
  publicSecurity: check,
  newsLicense: check,
  newsLicenseValidUntil: z.iso.date().nullable(),
  newsLicenseDateState: z.enum(["recorded", "not_recorded", "invalid"]),
  remainingDays: z.number().int().nullable(),
  warningDays: z.number().int().positive(),
  productionFilingConfigured: z.boolean(),
});
export const AdminSiteInformation = z.strictObject({ information: SiteInformation, protected: ProtectedSiteInformation });
export const siteInformationSchemas = { OfficialMetalLink, SiteInformation };
export const siteInformationPrivateSchemas = { OfficialMetalLink, SiteInformation, SiteInformationUpdate, ProtectedSiteInformation, AdminSiteInformation };
const errors = { 400: ProblemResponse, 401: ProblemResponse, 403: ProblemResponse, 409: ProblemResponse, 503: ProblemResponse };
export const siteInformationRoutes = {
  siteInformation: {
    method: "GET" as const,
    url: "/api/site/information",
    schema: { operationId: "siteInformation", response: { 200: SiteInformation, 304: z.undefined(), 503: ProblemResponse } },
  },
};
export const siteInformationPrivateRoutes = {
  adminSiteInformation: {
    method: "GET" as const,
    url: "/api/admin/site",
    schema: { operationId: "adminSiteInformation", response: { 200: AdminSiteInformation, ...errors } },
  },
  saveSiteInformation: {
    method: "PUT" as const,
    url: "/api/admin/site",
    schema: { operationId: "saveSiteInformation", body: SiteInformationUpdate, response: { 200: SiteInformation, ...errors } },
  },
};
