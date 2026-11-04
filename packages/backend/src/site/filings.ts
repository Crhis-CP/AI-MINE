import type { SiteFilings } from "@amp/contracts/http/public";
import { environmentValue } from "../config.ts";

/**
 * Filing and licence numbers are deployment facts, not source code (DEC-78): the deployer sets them in the API
 * environment, and an unset number is simply not shown. A value that is set but malformed stops the API from
 * starting rather than being shown wrong or silently dropped; SITE_REQUIRE_FILINGS=true also refuses to start
 * without the ICP and public-security numbers (mainland China deployments should turn it on).
 */
export const FILING_VARIABLES = {
  icp: "SITE_ICP_FILING",
  publicSecurity: "SITE_PUBLIC_SECURITY_FILING",
  newsLicense: "SITE_NEWS_LICENSE",
  require: "SITE_REQUIRE_FILINGS",
} as const;

type Read = (name: string) => string | undefined;

// 京ICP备00000000号-1, 京ICP证000000号: province abbreviation, ICP, 备 or 证, digits, 号, optional site suffix.
const ICP = /^\p{Script=Han}{1,2}ICP[备证]\d{5,12}号(?:-\d{1,3})?$/u;
// 京公网安备00000000000000号: the digits are the code the national query page takes.
const PUBLIC_SECURITY = /^\p{Script=Han}{1,2}公网安备(\d{10,20})号$/u;
// Licence numbers differ by issuer; accept letters, digits and the usual separators only.
const NEWS_LICENSE = /^[\p{Script=Han}A-Za-z0-9（）()\-]{4,60}$/u;

export type FilingProblem = { variable: string; reason: "invalid" | "missing" };

function value(read: Read, name: string): string | null {
  const raw = read(name)?.trim();
  return raw ? raw : null;
}

/** Parse the filing variables; problems name only the variable, never echo the configured value. */
export function readSiteFilings(read: Read = environmentValue): { filings: SiteFilings; problems: FilingProblem[] } {
  const problems: FilingProblem[] = [];
  const icpRaw = value(read, FILING_VARIABLES.icp);
  const icp = icpRaw && ICP.test(icpRaw) ? icpRaw : null;
  if (icpRaw && !icp) problems.push({ variable: FILING_VARIABLES.icp, reason: "invalid" });
  const securityRaw = value(read, FILING_VARIABLES.publicSecurity);
  const code = securityRaw?.match(PUBLIC_SECURITY)?.[1];
  const publicSecurity = securityRaw && code ? { text: securityRaw, code } : null;
  if (securityRaw && !publicSecurity) problems.push({ variable: FILING_VARIABLES.publicSecurity, reason: "invalid" });
  const licenseRaw = value(read, FILING_VARIABLES.newsLicense);
  const newsLicense = licenseRaw && NEWS_LICENSE.test(licenseRaw) ? licenseRaw : null;
  if (licenseRaw && !newsLicense) problems.push({ variable: FILING_VARIABLES.newsLicense, reason: "invalid" });
  const required = ["1", "true"].includes((read(FILING_VARIABLES.require) ?? "").trim().toLowerCase());
  if (required) {
    if (!icpRaw) problems.push({ variable: FILING_VARIABLES.icp, reason: "missing" });
    if (!securityRaw) problems.push({ variable: FILING_VARIABLES.publicSecurity, reason: "missing" });
  }
  return { filings: { icp, publicSecurity, newsLicense }, problems };
}

/** What readers see: only well-formed numbers. */
export function siteFilings(read: Read = environmentValue): SiteFilings {
  return readSiteFilings(read).filings;
}

/** API start-up check; runs before any database or credential access. */
export function assertSiteFilings(env: Readonly<Record<string, string | undefined>>): void {
  const { problems } = readSiteFilings((name) => env[name]);
  if (!problems.length) return;
  const detail = problems.map((p) => `${p.variable} ${p.reason === "missing" ? "is required by SITE_REQUIRE_FILINGS" : "is not a valid number"}`);
  throw new Error(`Refusing to start: ${detail.join("; ")}`);
}
