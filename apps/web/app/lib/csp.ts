import { createContext } from "react";

export const NonceContext = createContext<string | undefined>(undefined);

/** Shared by both route groups; only the server provides this request's nonce. */
export function contentSecurityPolicy(nonce: string, siteOrigin?: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' https:",
    "object-src 'none'",
    "base-uri 'none'",
    `form-action 'self'${siteOrigin ? ` ${siteOrigin}` : ""}`,
    "frame-ancestors 'none'",
  ].join("; ");
}
