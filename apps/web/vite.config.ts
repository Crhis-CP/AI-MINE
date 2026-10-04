import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { isApiOwned, resolveRedirect } from "@amp/contracts/http-policy";
import { assertWebEnvironment } from "./runtime-env.ts";
import { apiBaseFor, privateHostHeaders } from "./api-target.ts";
import { privateWebHostname, webHostPolicy } from "./host-policy.ts";

/** Development stand-in for the production web server: the shared redirect table and api-owned path routing. */
export function devEdge(env: Readonly<Record<string, string | undefined>> = process.env): Plugin {
  return {
    name: "amp-dev-edge",
    configureServer(server) {
      assertWebEnvironment(env);
      const hostPolicy = webHostPolicy(env);
      server.middlewares.use((req, res, next) => {
        const group = hostPolicy(req, res);
        if (!group) return;
        if (env.WEB_ROUTE_GROUP && group !== env.WEB_ROUTE_GROUP) {
          res.writeHead(404, { "Cache-Control": "private, no-store" });
          return res.end("Not found");
        }
        const raw = req.url ?? "/";
        const qi = raw.indexOf("?");
        const pathname = qi >= 0 ? raw.slice(0, qi) : raw;
        const search = qi >= 0 ? raw.slice(qi) : "";
        if (pathname.startsWith("/@") || pathname.startsWith("/node_modules/") || pathname.startsWith("/app/") || pathname.startsWith("/__")) return next();
        const decision = resolveRedirect(pathname, search);
        if (decision) {
          for (const [k, v] of Object.entries(decision.headers)) res.setHeader(k, v);
          if (decision.location) res.setHeader("Location", decision.location);
          res.statusCode = decision.status;
          return res.end();
        }
        if (!isApiOwned(pathname)) return next();
        const target = new URL(apiBaseFor(raw, env));
        const headers = { ...req.headers, ...privateHostHeaders(raw, req.headers.host) };
        const upstream = httpRequest({ hostname: target.hostname, port: target.port, path: raw, method: req.method, headers }, (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        });
        upstream.on("error", () => {
          res.statusCode = 502;
          res.end("api unavailable");
        });
        req.pipe(upstream);
      });
    },
  };
}

const group = process.env.WEB_ROUTE_GROUP || "public";
const buildGraph: Plugin = {
  name: "amp-build-graph",
  writeBundle(_, bundle) {
    if (this.environment.name !== "client") return;
    const modules = [...new Set(Object.values(bundle).flatMap((output) => (output.type === "chunk" ? Object.keys(output.modules) : [])))]
      .map((id) => path.relative(import.meta.dirname, id).replaceAll("\\", "/"))
      .sort();
    mkdirSync(`build/${group}`, { recursive: true });
    writeFileSync(`build/${group}/modules.json`, JSON.stringify(modules));
  },
};

export default defineConfig({
  plugins: [devEdge(), tailwindcss(), reactRouter(), buildGraph],
  resolve: { alias: { "./group.css": path.resolve(import.meta.dirname, `app/${group}.css`) } },
  server: { port: 3000, strictPort: true, allowedHosts: [privateWebHostname(), new URL(process.env.SITE_URL || "http://localhost:3000").hostname] },
  build: {
    rolldownOptions: {
      output: {
        // A page used to load 15–30 small shared chunks (a third of all edge requests were JS files).
        // Framework code stays one stable chunk across releases; app code that at least four public
        // routes share is one chunk (7–10 files a page, and less JavaScript than before on every page
        // but the three smallest, measured 2026-09-29); the rest keeps automatic splitting. Motion is
        // left to the admin pages.
        codeSplitting: {
          groups: [
            {
              name: "framework",
              test: /node_modules[\\/](?:react|react-dom|scheduler|react-router|@react-router|cookie|set-cookie-parser|turbo-stream)[\\/]/,
              priority: 30,
            },
            { name: "motion", test: /node_modules[\\/](?:motion|framer-motion|motion-dom|motion-utils)[\\/]/, priority: 20 },
            { name: "shared", test: /apps[\\/]web[\\/]app[\\/](?!features[\\/]admin[\\/]|routes[\\/])/, minShareCount: 4, priority: 10 },
          ],
        },
      },
    },
  },
});
