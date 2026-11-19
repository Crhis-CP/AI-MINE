// The old reader's document path did not change when its policy rule moved to app/lib/hashed-document.server.ts for
// the rewrite to share (DEC-79): for a fixed render, the built entry answers exactly what the entry answered before
// the move — the same status, headers, Content-Security-Policy and HTML bytes. The reference below is that earlier
// entry's reader-page path, kept as it was; the public build always takes it in production. Run after the build.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToPipeableStream } from "react-dom/server";
import { createRequestHandler, type EntryContext, ServerRouter, type ServerBuild } from "react-router";
import { contentSecurityPolicy } from "../app/lib/csp.ts";

/** app/entry.server.tsx before the move, reader pages only (`hashed` is always true in the production public build). */
function referenceEntry(request: Request, responseStatusCode: number, responseHeaders: Headers, routerContext: EntryContext) {
  const streamTimeout = 5_000;
  const siteOrigin = process.env.SITE_URL ? new URL(process.env.SITE_URL).origin : undefined;
  const inlineScriptHashes = (html: string) => {
    const hashes = new Set<string>();
    for (const [, attributes, text] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\bsrc=/i.test(attributes!) || /\btype="application\/ld\+json"/i.test(attributes!)) continue;
      hashes.add(createHash("sha256").update(text!, "utf8").digest("base64"));
    }
    return [...hashes];
  };
  return new Promise<Response>((resolve, reject) => {
    let shellRendered = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(() => abort(), streamTimeout + 1000);
    const { pipe, abort } = renderToPipeableStream(createElement(ServerRouter, { context: routerContext, url: request.url }), {
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
          responseHeaders.set("Content-Security-Policy", contentSecurityPolicy({ hashes: inlineScriptHashes(html) }, siteOrigin));
          resolve(new Response(html, { headers: responseHeaders, status: responseStatusCode }));
        });
        pipe(body);
      },
      onShellError(error: unknown) {
        reject(error);
      },
      onError(error: unknown) {
        responseStatusCode = 500;
        if (shellRendered) console.error(error);
      },
    });
  });
}

const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  const answers: Record<string, unknown> = {
    "/api/site/meta": { changelogVersion: null, filings: { icp: "京ICP备00000000号-1", publicSecurity: null, newsLicense: null } },
    "/api/site/content-version": { version: "1", withdrawalVersion: "1" },
    "/api/site/stats": { selected: 1 },
    "/api/site/timeline": {
      filters: { channel: "all", category: null, tag: null, topic: null },
      cards: [],
      nextCursor: null,
      refreshAt: null,
      hot: null,
      dayCounts: {},
      generatedAt: "2026-10-04T00:00:00.000Z",
    },
  };
  if (url.pathname in answers) return res.end(JSON.stringify(answers[url.pathname]));
  res.statusCode = 404;
  res.end(JSON.stringify({ code: "not_found" }));
});

let build: ServerBuild;
before(async () => {
  assert.ok(
    existsSync(new URL("../build/public/server/index.js", import.meta.url)),
    "apps/web/build/public is missing: run npm run build --workspace @amp/web first",
  );
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  // Read when the build's modules load, so it is set before the import.
  process.env.API_BASE_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  // @ts-expect-error generated build
  build = await import("../build/public/server/index.js");
});
after(async () => {
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

test("the old reader's entry answers a fixed render exactly as before its policy rule was shared", async () => {
  const actual = createRequestHandler(build, "production");
  const reference = createRequestHandler({ ...build, entry: { module: { ...build.entry.module, default: referenceEntry } } }, "production");
  const seen = async (handler: typeof actual, method: string, path: string) => {
    const response = await handler(new Request(`http://127.0.0.1${path}`, { method }));
    return { status: response.status, headers: [...response.headers].sort(), body: await response.text() };
  };
  for (const [method, path, status] of [
    ["GET", "/", 200],
    ["GET", "/en", 200],
    ["HEAD", "/", 200],
    ["GET", "/no-such-page", 404],
  ] as const) {
    const now = await seen(actual, method, path);
    assert.equal(now.status, status, `${method} ${path}`);
    assert.match(Object.fromEntries(now.headers)["content-security-policy"] ?? "", /script-src 'self' 'sha256-/, `${method} ${path}`);
    assert.deepEqual(now, await seen(reference, method, path), `${method} ${path}`);
  }
});
