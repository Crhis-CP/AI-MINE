// Every page of the rewritten reader may sit in a shared cache (TASK-0672), so every page is rendered whole and each
// of its inline scripts is allowed by hash (plan 3.2: 恒走哈希式). There is no nonce path in this build: the admin,
// which streams with a nonce, stays in the private build.
import { PassThrough } from "node:stream";
import type { EntryContext, RouterContextProvider } from "react-router";
import { ServerRouter } from "react-router";
import { renderToPipeableStream } from "react-dom/server";
import { hashedDocument } from "../app/lib/hashed-document.server.ts";

export const streamTimeout = 5_000;

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: RouterContextProvider,
) {
  const siteOrigin = process.env.SITE_URL ? new URL(process.env.SITE_URL).origin : undefined;
  // HEAD renders the page too, so its policy names the same scripts as the page a GET returns.
  return new Promise<Response>((resolve, reject) => {
    let shellRendered = false;
    // Abort the render after streamTimeout so rejected boundaries still have time to flush.
    let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(() => abort(), streamTimeout + 1000);
    const { pipe, abort } = renderToPipeableStream(<ServerRouter context={routerContext} url={request.url} />, {
      onAllReady() {
        shellRendered = true;
        responseHeaders.set("Content-Type", "text/html");
        const chunks: Buffer[] = [];
        const body = new PassThrough();
        body.on("data", (chunk: Buffer) => chunks.push(chunk));
        body.on("error", reject);
        body.on("end", () => {
          clearTimeout(timeoutId);
          timeoutId = undefined;
          const html = Buffer.concat(chunks).toString("utf8");
          // In development Vite injects its own scripts; the policy is a production concern only.
          resolve(
            import.meta.env.PROD
              ? hashedDocument(html, responseStatusCode, responseHeaders, siteOrigin)
              : new Response(html, { headers: responseHeaders, status: responseStatusCode }),
          );
        });
        pipe(body);
      },
      onShellError(error: unknown) {
        reject(error);
      },
      onError(error: unknown) {
        responseStatusCode = 500;
        // Errors in the first render reject and are logged by the router; only later ones are logged here.
        if (shellRendered) console.error(error);
      },
    });
  });
}
