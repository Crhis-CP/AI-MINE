import { createContext } from "react";

export const NonceContext = createContext<string | undefined>(undefined);

/**
 * How a page's own inline scripts are allowed. Private pages: this response's random nonce, trusted onward with
 * 'strict-dynamic'. Reader pages may sit in a shared cache (TASK-0672), where one nonce would be handed to everyone:
 * each inline script is allowed by the hash of its exact text instead, and the page's built files by 'self'
 * ('strict-dynamic' would block their preload links, which carry no nonce).
 */
export type ScriptSources = { nonce: string } | { hashes: readonly string[] };

/** Shared by both route groups; only the server provides this request's nonce or hashes. */
export function contentSecurityPolicy(scripts: ScriptSources, siteOrigin?: string): string {
  const scriptSrc =
    "nonce" in scripts ? `'self' 'nonce-${scripts.nonce}' 'strict-dynamic'` : ["'self'", ...scripts.hashes.map((hash) => `'sha256-${hash}'`)].join(" ");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' https:",
    "object-src 'none'",
    "base-uri 'none'",
    `form-action 'self'${siteOrigin ? ` ${siteOrigin}` : ""}`,
    "frame-ancestors 'none'",
  ].join("; ");
}
