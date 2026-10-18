import type { FastifyRequest, FastifyReply } from "fastify";
import { QueueUnavailableError } from "../jobs/queue.ts";
import { sessionPrincipal, type AdminPrincipal } from "./auth.ts";
import { sendProblem } from "../http.ts";

export type AdminHandler = (req: FastifyRequest, reply: FastifyReply, admin: AdminPrincipal) => Promise<unknown>;

/** Guard for /api/admin/*: a live session (or the development stand-in); writes need the CSRF token. */
export function adminHandler(fn: AdminHandler) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    let admin: AdminPrincipal | null;
    try {
      admin = await sessionPrincipal(req.headers.cookie);
    } catch {
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "登录状态暂时无法核实，请稍后重试。", retryAfter: 30 });
    }
    if (!admin) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "Sign in to the admin first." });
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-csrf-token"] !== admin.csrf) {
      return sendProblem(req, reply, { status: 403, code: "forbidden", detail: "Missing or stale CSRF token." });
    }
    if (admin.mustChangePassword && !["/api/admin/me", "/api/admin/account", "/api/admin/account/password"].includes(req.url.split("?")[0]!))
      return sendProblem(req, reply, { status: 403, code: "forbidden", detail: "请先在我的账号中修改初始密码。" });
    try {
      return await fn(req, reply, admin);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 429)
        return sendProblem(req, reply, { status: 429, code: "rate_limited", detail: (error as Error).message, retryAfter: 900 });
      if ((error as { statusCode?: number }).statusCode === 403)
        return sendProblem(req, reply, { status: 403, code: "forbidden", detail: "当前账号没有权限完成此操作。" });
      if (error instanceof QueueUnavailableError)
        return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: error.message, retryAfter: 30 });
      if ((error as { statusCode?: number }).statusCode === 400 || error instanceof SyntaxError) {
        return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: String((error as Error).message).slice(0, 300) });
      }
      if ((error as { code?: string }).code === "conflict") return sendProblem(req, reply, { status: 409, code: "conflict", detail: (error as Error).message });
      req.log.error({ err: error, path: req.url.split("?")[0] }, "admin api error");
      return sendProblem(req, reply, { status: 500, code: "internal_error", detail: "服务暂时无法完成此操作，请稍后重试。" });
    }
  };
}
