import { registerSourceTargets } from "./routes/admin-source-targets.ts";
import { registerAdminSite } from "./routes/admin-site.ts";
import { registerSiteInformation } from "./routes/site-information.ts";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { randomUUID } from "node:crypto";
import { OAUTH_PROBE_PATHS, resolveRedirect } from "@amp/contracts/http-policy";
import { config } from "@amp/backend/config";
import { dbOf } from "@amp/backend/db";
import { registerSite } from "./routes/site.ts";
import { registerPolicies } from "./routes/policies.ts";
import { registerOg } from "./routes/og.ts";
import { registerAdminAuth } from "./routes/admin-auth.ts";
import { registerOperationsMcp } from "./routes/mcp-ops.ts";
import { registerUsageProtection } from "./routes/admin-usage-protection.ts";

import { registerAdmin } from "./routes/admin.ts";
import { registerV1, registerV1Fallbacks } from "./routes/v1.ts";
import { registerFeeds } from "./routes/feeds.ts";
import { registerStatic } from "./routes/static.ts";
import { registerMcp } from "./routes/mcp.ts";
import { sendProblem } from "./http/respond.ts";

const sql = dbOf("publication");

export type ApiRole = "public-api" | "private-api";

/** A single Host authority, never a URL, list, userinfo or escaped hostname. Ports are not part of the hostname. */
function hostname(authority: unknown): string | null {
  if (typeof authority !== "string" || !authority || /[\s,/@\\?#%]/.test(authority)) return null;
  try {
    return new URL(`http://${authority}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export async function buildApp(role: ApiRole): Promise<FastifyInstance> {
  if (role !== "public-api" && role !== "private-api") throw new Error("Invalid API role");
  const publicRoutes = role === "public-api";
  const privateRoutes = role === "private-api";
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || "info", redact: ["req.headers.authorization", "req.headers.cookie"] },
    // Access logs never record query strings (tokens, actors).
    disableRequestLogging: true,
    trustProxy: true,
    genReqId: () => randomUUID(),
    bodyLimit: 10 * 1024 * 1024,
    routerOptions: { ignoreTrailingSlash: false, maxParamLength: 300 },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook("onRequest", async (req) => {
    req.requestId = req.id;
  });

  app.addHook("onResponse", async (req, reply) => {
    const path = (req.raw.url ?? "").split("?")[0] ?? "/";
    // The reverse proxy logs every request; the process only notes the slow and the failed.
    const ms = Math.round(reply.elapsedTime);
    if (reply.statusCode >= 500 || (ms >= 1000 && path !== "/api/mcp" && !path.startsWith("/api/img-proxy"))) {
      req.log.warn({ method: req.method, path, status: reply.statusCode, ms }, "request");
    }
  });

  if (role === "private-api" && config.privateHost !== null) {
    const expected = hostname(config.privateHost);
    app.addHook("onRequest", async (req, reply) => {
      if ((req.raw.url ?? "").split("?")[0] === "/api/health") return;
      const forwarded = req.headers["x-forwarded-host"];
      const count = req.raw.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "x-forwarded-host").length;
      if (expected && count === 1 && hostname(forwarded) === expected) return;
      return sendProblem(req, reply, { status: 404, code: "not_found", detail: "No such endpoint." });
    });
  }

  // Central public redirect table (shared with the web server); never bypasses the private host guard.
  if (publicRoutes)
    app.addHook("onRequest", async (req, reply) => {
      const raw = req.raw.url ?? "/";
      const qi = raw.indexOf("?");
      const pathname = qi >= 0 ? raw.slice(0, qi) : raw;
      const search = qi >= 0 ? raw.slice(qi) : "";
      if (OAUTH_PROBE_PATHS.includes(pathname)) {
        return reply.code(404).header("Cache-Control", "public, max-age=3600").type("application/json").send('{"error":"not_found"}');
      }
      const decision = resolveRedirect(pathname, search);
      if (decision) {
        for (const [k, v] of Object.entries(decision.headers)) reply.header(k, v);
        if (decision.location) return reply.code(decision.status).header("Location", decision.location).send();
        return reply
          .code(decision.status)
          .type("text/plain; charset=utf-8")
          .send(decision.status === 410 ? "Gone" : "Not found");
      }
    });

  app.get("/api/health", async (_req, reply) => {
    const started = Date.now();
    await sql`SELECT 1`;
    return reply.header("Cache-Control", "no-store").send({ ok: true, db: "ok", ms: Date.now() - started, release: process.env.AMP_RELEASE ?? "dev" });
  });

  // Two routes stay closed and are not registered; registering either again needs the Owner's approval.
  // The signed image proxy (routes/media.ts, DR-78): pages and feeds link to a picture on the source's
  // site, and no source is authorised to show its pictures here (Q-68). The external push entrance
  // (routes/ingest.ts, F-ACQ-07, a candidate): enabling it also moves it off the public port (adoption 4.5
  // row 7).

  if (privateRoutes) {
    registerAdmin(app);
    registerSourceTargets(app);
    registerOperationsMcp(app);
    registerUsageProtection(app);

    registerAdminAuth(app);
    registerAdminSite(app);
  }
  if (publicRoutes) {
    registerFeeds(app);
    registerMcp(app);
    registerOg(app);
    registerSite(app);
    registerSiteInformation(app);
    registerPolicies(app);
    registerStatic(app);
    registerV1(app);
    registerV1Fallbacks(app);
  }

  app.setNotFoundHandler((req, reply) => {
    if ((req.raw.url ?? "").startsWith("/api/")) {
      return sendProblem(req, reply, { status: 404, code: "not_found", detail: "No such endpoint." });
    }
    return reply.code(404).type("text/plain; charset=utf-8").header("Cache-Control", "public, max-age=60").send("Not found");
  });

  app.setErrorHandler((error, req, reply) => {
    req.log.error({ err: error }, "unhandled");
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status === 400 || status === 413 || status === 415) {
      return sendProblem(req, reply, { status: status === 400 ? 400 : status, code: "invalid_request", detail: "The request could not be processed." });
    }
    return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "Temporarily unavailable.", retryAfter: 30 });
  });

  return app;
}
