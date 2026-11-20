// The pure half of a reader page's Content-Security-Policy (TASK-0672), shared by the old reader's entry
// (app/entry.server.tsx) and the rewrite's (reader/entry.server.tsx) so the rule cannot drift between them. Each
// entry keeps its own render scaffold; this file only reads the finished HTML. It imports node:crypto, so it stays
// out of csp.ts, which the browser bundle loads.
import { createHash } from "node:crypto";
import { contentSecurityPolicy } from "./csp.ts";

/**
 * The sha256 of every inline script the page runs, in the form a Content-Security-Policy hash source takes. Data
 * blocks (JSON-LD) never run and need none; scripts with a source file are allowed by 'self'.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  for (const [, attributes, text] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc=/i.test(attributes!) || /\btype="application\/ld\+json"/i.test(attributes!)) continue;
    hashes.add(createHash("sha256").update(text!, "utf8").digest("base64"));
  }
  return [...hashes];
}

/**
 * The response for a fully rendered page that may sit in a shared cache: no nonce, each of its inline scripts allowed
 * by hash. `headers` is the router's response headers, which this sets the policy on.
 */
export function hashedDocument(html: string, status: number, headers: Headers, siteOrigin: string | undefined): Response {
  headers.set("Content-Security-Policy", contentSecurityPolicy({ hashes: inlineScriptHashes(html) }, siteOrigin));
  return new Response(html, { headers, status });
}
