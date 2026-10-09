// Admin sign-in: the admin password (ADMIN_PASSWORD), and Feishu when it is configured. The form posts
// straight to the API, which sets the session cookie and sends the browser on.
import { useEffect, useState } from "react";
import { useLoaderData } from "react-router";
import type { Route } from "./+types/admin-login";
import { SITE } from "@amp/industry/site";
import { createPrivateClient, privateSchemas } from "@amp/api-client/private";
import { contractResult } from "../lib/api.server";
import { apiBaseFor, privateHostHeaders } from "../../api-target.ts";
import { Wordmark } from "../components/Logo";
import { buttonClass } from "../components/ui/Controls";

const ERRORS: Record<string, string> = {
  wrong: "账号或密码不正确，请检查后重试。",
  verification: "登录验证已失效，请刷新登录页后重试。",
  unset: "账号尚未开通，请联系网站负责人。",
  "too-many": "尝试次数太多，请 15 分钟后再试。",
};

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("return") ?? "/admin";
  const options = await createPrivateClient({ baseUrl: apiBaseFor("/api/auth/options") })
    .GET("/api/auth/options", {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
      headers: { accept: "application/json", "x-amp-ssr": "1", ...privateHostHeaders("/api/auth/options", request.headers.get("host")) },
    })
    .then((result) => contractResult(result, privateSchemas.LoginOptions))
    .catch(() => ({
      password: true,
      feishu: false,
    }));
  return {
    returnTo: returnTo.startsWith("/admin") ? returnTo : "/admin",
    error: url.searchParams.get("error"),
    changed: url.searchParams.get("password-changed") === "1",
    ...options,
  };
}

export const meta: Route.MetaFunction = () => [{ title: `登录 · ${SITE.name} 后台` }, { name: "robots", content: "noindex, nofollow" }];

export const headers: Route.HeadersFunction = () => ({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });

export default function AdminLogin() {
  const { returnTo, error, password, feishu, changed } = useLoaderData<typeof loader>();
  const [nonce, setNonce] = useState(""),
    [nonceError, setNonceError] = useState("");
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const refresh = () => {
      if (active) setNonce("");
      createPrivateClient({ baseUrl: "" })
        .GET("/api/auth/password-nonce", { signal: controller.signal })
        .then((r) => {
          const parsed = privateSchemas.LoginNonce.safeParse(r.data);
          if (!r.response.ok || !parsed.success) throw new Error();
          if (active) {
            setNonce(parsed.data.token);
            setNonceError("");
          }
        })
        .catch(() => {
          if (active) setNonceError("登录验证暂时无法取得，请稍后刷新重试。");
        });
    };
    refresh();
    const timer = setInterval(refresh, 4 * 60_000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  const message = nonceError || (error ? (ERRORS[error] ?? ERRORS.wrong) : !password ? ERRORS.unset : null);
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4">
      <div className="w-full max-w-[360px]">
        <div className="flex items-center justify-center gap-2">
          <Wordmark size={26} className="text-ink" />
          <span className="text-[15px] font-semibold text-ink-3">后台</span>
        </div>
        <form method="post" action="/api/auth/password" className="card mt-8 p-6">
          <input type="hidden" name="return" value={returnTo} />
          <input type="hidden" name="login_nonce" value={nonce} />
          {changed && (
            <p role="status" className="mb-4 text-sm text-ok">
              密码已修改，请重新登录。
            </p>
          )}
          <label htmlFor="login_name" className="block text-[13px] font-medium text-ink-2">
            登录名
          </label>
          <input
            id="login_name"
            name="login_name"
            type="text"
            autoComplete="username"
            maxLength={254}
            required
            autoFocus
            className="mt-2 mb-4 h-10 w-full rounded-full border border-line-strong bg-surface px-4 text-[14px] text-ink outline-none focus:border-accent"
          />

          <label htmlFor="password" className="block text-[13px] font-medium text-ink-2">
            密码
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={256}
            className="mt-2 h-10 w-full rounded-full border border-line-strong bg-surface px-4 text-[14px] text-ink outline-none transition-colors focus:border-accent"
          />
          {message && (
            <p role="alert" className="mt-3 text-[12.5px] leading-relaxed text-hot">
              {message}
            </p>
          )}
          <button type="submit" disabled={!nonce || !password} className={`${buttonClass("primary", "lg")} mt-5 w-full`}>
            登录
          </button>
          {feishu && (
            <a href={`/api/auth/feishu?${new URLSearchParams({ return: returnTo })}`} className={`${buttonClass("secondary", "lg")} mt-3 w-full`}>
              用飞书登录
            </a>
          )}
        </form>
        <p className="mt-6 text-center text-[12px] text-ink-4">
          <a href="/" className="hover:text-ink-2">
            回到 {SITE.name}
          </a>
        </p>
      </div>
    </div>
  );
}
