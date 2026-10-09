import { routes as contracts } from "@amp/contracts/http/private";
// Admin sign-in and the /api/admin guard. Public routes never read the session.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "@amp/backend/config";
import { QueueUnavailableError } from "@amp/backend/jobs/queue";
import {
  completeLogin,
  currentCapability,
  issueLoginNonce,
  consumeLoginNonce,
  LOGIN_NONCE_COOKIE,
  passwordLoginAvailable,
  listAccounts,
  currentAccount,
  createAdministrator,
  changeAdministrator,
  changeOwnPassword,
  cookie,
  endSession,
  feishuLoginConfigured,
  LoginRejected,
  loginRedirect,
  parseCookies,
  passwordLogin,
  safeReturn,
  SESSION_COOKIE,
  SESSION_DAYS,
  sessionPrincipal,
  STATE_COOKIE,
  type AdminPrincipal,
} from "@amp/backend/admin/auth";
import { sendProblem } from "../http/respond.ts";

/** Cookies are Secure whenever the site is served over HTTPS. */
const secure = () => config.siteUrl.startsWith("https://");

const loginPage = (returnTo: string, error?: string) => `/admin/login?${new URLSearchParams({ return: safeReturn(returnTo), ...(error ? { error } : {}) })}`;

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

function accountKey(req: FastifyRequest) {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,200}$/u.test(key)) throw Object.assign(new Error("请刷新页面后重新提交账号操作。"), { statusCode: 400 });
  return key;
}

export function registerAdminAuth(app: FastifyInstance) {
  // The sign-in form posts as a plain HTML form.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });

  // The web admin sends a signed-out visitor here with ?return=; the sign-in page lives in the web app.
  app.get("/api/auth/login", async (req, reply) => {
    const returnTo = String((req.query as Record<string, string>).return ?? "/admin");
    return reply.header("Cache-Control", "no-store").redirect(loginPage(returnTo), 302);
  });

  app.get(contracts.loginOptions.url, contracts.loginOptions, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      return { password: await passwordLoginAvailable(), feishu: feishuLoginConfigured() };
    } catch {
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "登录服务暂时不可用。" });
    }
  });
  app.get(contracts.loginNonce.url, contracts.loginNonce, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const nonce = await issueLoginNonce(String(req.ip));
      reply.header("Set-Cookie", cookie(LOGIN_NONCE_COOKIE, nonce.token, 300, secure()));
      return nonce;
    } catch (error) {
      const limited = (error as { statusCode?: number }).statusCode === 429;
      return sendProblem(req, reply, {
        status: limited ? 429 : 503,
        code: limited ? "rate_limited" : "temporarily_unavailable",
        detail: limited ? "请求次数过多，请稍后再试。" : "登录服务暂时不可用。",
        retryAfter: 60,
      });
    }
  });
  app.post("/api/auth/password", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>,
      returnTo = String(b.return ?? "/admin");
    reply.header("Cache-Control", "no-store");
    try {
      await consumeLoginNonce(String(b.login_nonce ?? ""), parseCookies(req.headers.cookie)[LOGIN_NONCE_COOKIE], String(req.ip));
      const { token, returnTo: target } = await passwordLogin(
        String(b.password ?? ""),
        returnTo,
        req.headers["user-agent"],
        String(b.login_name ?? ""),
        String(req.ip),
      );
      reply.header("Set-Cookie", [cookie(SESSION_COOKIE, token, SESSION_DAYS * 86400, secure()), cookie(LOGIN_NONCE_COOKIE, "", 0, secure())]);
      return reply.redirect(target, 303);
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (error instanceof LoginRejected || status === 400 || status === 429)
        return reply.redirect(loginPage(returnTo, status === 429 ? "too-many" : status === 400 ? "verification" : "wrong"), 303);
      req.log.error({ err: error }, "admin login failed");
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "登录服务暂时不可用，请稍后重试。", retryAfter: 30 });
    }
  });

  // Optional Feishu sign-in (FEISHU_LOGIN_APP_ID / FEISHU_LOGIN_APP_SECRET and an allowlist).
  app.get("/api/auth/feishu", async (req, reply) => {
    const returnTo = String((req.query as Record<string, string>).return ?? "/admin");
    if (!feishuLoginConfigured()) return reply.redirect(loginPage(returnTo), 302);
    const { url, stateCookie } = loginRedirect(returnTo);
    reply.header("Set-Cookie", cookie(STATE_COOKIE, stateCookie, 600, secure())).header("Cache-Control", "no-store");
    return reply.redirect(url, 302);
  });

  // The callback registered in the Feishu open platform: the state cookie comes back here.
  app.get("/api/auth/callback", async (req, reply) => {
    const q = req.query as Record<string, string>;
    reply.header("Cache-Control", "no-store");
    try {
      const { token, returnTo } = await completeLogin(
        String(q.code ?? ""),
        String(q.state ?? ""),
        parseCookies(req.headers.cookie)[STATE_COOKIE],
        req.headers["user-agent"],
      );
      reply.header("Set-Cookie", [cookie(SESSION_COOKIE, token, SESSION_DAYS * 86400, secure()), cookie(STATE_COOKIE, "", 0, secure())]);
      return reply.redirect(returnTo, 302);
    } catch (error) {
      const message = error instanceof LoginRejected ? error.message : "登录失败，请稍后再试";
      if (!(error instanceof LoginRejected)) req.log.error({ err: error }, "admin login failed");
      return reply
        .code(error instanceof LoginRejected ? 403 : 503)
        .type("text/html; charset=utf-8")
        .send(
          `<!doctype html><meta charset="utf-8"><title>登录失败</title><p style="font:16px system-ui;padding:40px">${message}。<a href="/admin/login">重新登录</a></p>`,
        );
    }
  });

  // For a reverse proxy that guards /admin itself (auth_request): 204 with a live session, else 401.
  // Only the session cookie counts here, never the development stand-in.
  app.get("/api/auth/check", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const admin = await sessionPrincipal(req.headers.cookie);
      return reply.code(admin && !admin.dev ? 204 : 401).send();
    } catch {
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "登录状态暂时无法核实。", retryAfter: 30 });
    }
  });

  app.post("/api/auth/logout", async (req, reply) => {
    let admin: AdminPrincipal | null;
    try {
      admin = await sessionPrincipal(req.headers.cookie);
    } catch {
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "暂时无法退出，请稍后重试。" });
    }
    const b = (req.body ?? {}) as Record<string, string>;
    if (admin && b.csrf !== admin.csrf && req.headers["x-csrf-token"] !== admin.csrf)
      return sendProblem(req, reply, { status: 403, code: "forbidden", detail: "操作验证已失效，请刷新后重试。" });
    await endSession(req.headers.cookie);
    reply.header("Set-Cookie", cookie(SESSION_COOKIE, "", 0, secure())).header("Cache-Control", "no-store");
    return reply.redirect("/", 303);
  });

  app.get(
    "/api/admin/me",
    adminHandler(async (_req, _reply, admin) => ({
      name: admin.name,
      csrf: admin.csrf,
      dev: admin.dev,
      mustChangePassword: !!admin.mustChangePassword,
      owner: await currentCapability(admin, "owner"),
      modelsManage: await currentCapability(admin, "models.manage"),
    })),
  );
  app.get(
    contracts.accounts.url,
    contracts.accounts,
    adminHandler(async (_req, _reply, admin) => listAccounts(admin)),
  );
  app.post(
    contracts.createAccount.url,
    contracts.createAccount,
    adminHandler(async (req, _reply, admin) => createAdministrator(admin, req.body, accountKey(req))),
  );
  app.post(
    contracts.accountAction.url,
    contracts.accountAction,
    adminHandler(async (req, _reply, admin) => changeAdministrator(admin, Number((req.params as { id: string }).id), req.body, accountKey(req))),
  );
  app.get(
    contracts.currentAccount.url,
    contracts.currentAccount,
    adminHandler(async (_req, _reply, admin) => currentAccount(admin)),
  );
  app.post(
    contracts.changeAccountPassword.url,
    contracts.changeAccountPassword,
    adminHandler(async (req, reply, admin) => {
      const value = await changeOwnPassword(admin, req.body, String(req.ip));
      reply.header("Set-Cookie", cookie(SESSION_COOKIE, "", 0, secure()));
      return value;
    }),
  );
}
