import { createHash, randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";

import type { EntryContext, RouterContextProvider } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import type { RenderToPipeableStreamOptions } from "react-dom/server";
import { renderToPipeableStream } from "react-dom/server";
import { contentSecurityPolicy, NonceContext } from "./lib/csp";
import { registerEnglishPhrases } from "./i18n";
import { PHRASES } from "./i18n/phrases";

// The server renders either language at once; browsers fetch the English phrases only for English pages (TASK-0593).
registerEnglishPhrases(PHRASES);

export const streamTimeout = 5_000;

/**
 * The sha256 of every inline script the page runs, in the form a Content-Security-Policy hash source takes. Data
 * blocks (JSON-LD) never run and need none; scripts with a source file are allowed by 'self'.
 */
function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  for (const [, attributes, text] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc=/i.test(attributes!) || /\btype="application\/ld\+json"/i.test(attributes!)) continue;
    hashes.add(createHash("sha256").update(text!, "utf8").digest("base64"));
  }
  return [...hashes];
}

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: RouterContextProvider,
) {
  const siteOrigin = process.env.SITE_URL ? new URL(process.env.SITE_URL).origin : undefined;
  // Reader pages may be kept by a shared cache (TASK-0672): they carry no nonce, and each inline script is allowed by
  // its hash, so the whole page is rendered before it is sent. Private pages stream with a fresh nonce each time.
  const hashed = import.meta.env.PROD && "public-layout" in routerContext.manifest.routes;
  const nonce = hashed ? undefined : randomBytes(16).toString("base64");
  if (import.meta.env.PROD && nonce) responseHeaders.set("Content-Security-Policy", contentSecurityPolicy({ nonce }, siteOrigin));

  // https://httpwg.org/specs/rfc9110.html#HEAD
  // A hashed page is rendered for HEAD too, so its policy names the same scripts as the page a GET returns.
  if (request.method.toUpperCase() === "HEAD" && !hashed) {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  return new Promise<Response>((resolve, reject) => {
    let shellRendered = false;
    const userAgent = request.headers.get("user-agent");

    // Ensure requests from bots and SPA Mode renders wait for all content to load before responding
    // https://react.dev/reference/react-dom/server/renderToPipeableStream#waiting-for-all-content-to-load-for-crawlers-and-static-generation
    const readyOption: keyof RenderToPipeableStreamOptions =
      hashed || (userAgent && isbot(userAgent)) || routerContext.isSpaMode ? "onAllReady" : "onShellReady";

    // Abort the rendering stream after the `streamTimeout` so it has time to
    // flush down the rejected boundaries
    let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(() => abort(), streamTimeout + 1000);

    const { pipe, abort } = renderToPipeableStream(
      <NonceContext.Provider value={nonce}>
        <ServerRouter context={routerContext} url={request.url} nonce={nonce} />
      </NonceContext.Provider>,
      {
        nonce,
        [readyOption]() {
          shellRendered = true;
          responseHeaders.set("Content-Type", "text/html");
          if (hashed) {
            const chunks: Buffer[] = [];
            const body = new PassThrough();
            body.on("data", (chunk: Buffer) => chunks.push(chunk));
            body.on("error", reject);
            body.on("end", () => {
              clearTimeout(timeoutId);
              timeoutId = undefined;
              const html = Buffer.concat(chunks).toString("utf8");
              responseHeaders.set("Content-Security-Policy", contentSecurityPolicy({ hashes: inlineScriptHashes(html) }, siteOrigin));
              resolve(new Response(html, { headers: responseHeaders, status: responseStatusCode }));
            });
            pipe(body);
            return;
          }
          const body = new PassThrough({
            final(callback) {
              // Clear the timeout to prevent retaining the closure and memory leak
              clearTimeout(timeoutId);
              timeoutId = undefined;
              callback();
            },
          });
          const stream = createReadableStreamFromReadable(body);

          pipe(body);

          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          // Log streaming rendering errors from inside the shell.  Don't log
          // errors encountered during initial shell rendering since they'll
          // reject and get logged in handleDocumentRequest.
          if (shellRendered) {
            console.error(error);
          }
        },
      },
    );
  });
}
