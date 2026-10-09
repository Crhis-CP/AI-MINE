import { useState } from "react";
import { Link } from "react-router";
import { createPrivateClient, privateSchemas } from "@amp/api-client/private";
import { SITE } from "@amp/industry/site";
import type { Route } from "./+types/account";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction, useAdminMe } from "../../features/admin/action";
import { AdminPage, Card, Input, Button, Badge } from "../../features/admin/ui";
import { bj } from "../../features/admin/format";
export const meta = () => [{ title: `我的账号 · ${SITE.name} 后台` }];
export async function loader({ request }: Route.LoaderArgs) {
  const path = "/api/admin/account",
    client = createPrivateClient({ baseUrl: "" });
  return privateSchemas.CurrentAccount.parse(
    await adminGet(request, path, (_u, init) => client.GET(path, { baseUrl: new URL(_u).origin, headers: init.headers, signal: init.signal })),
  );
}
export default function Account({ loaderData }: Route.ComponentProps) {
  const { account, password_login } = loaderData,
    me = useAdminMe(),
    { run, busy } = useAdminAction();
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [confirm, setConfirm] = useState(""),
    [error, setError] = useState("");
  return (
    <AdminPage
      title="我的账号"
      subtitle="修改密码后需要重新登录，其他设备也会退出。"
      actions={
        me.owner ? (
          <Link className="text-accent text-sm" to="/admin/accounts">
            管理账号 →
          </Link>
        ) : undefined
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(240px,1fr)_minmax(320px,1.4fr)]">
        <Card title="登录身份">
          <div className="flex flex-wrap items-center gap-2">
            <strong>{account.display_name}</strong>
            <Badge tone={account.role === "owner" ? "ok" : "muted"}>{account.role === "owner" ? "负责人" : "管理员"}</Badge>
          </div>
          <dl className="mt-4 space-y-3 text-sm">
            <div>
              <dt className="text-ink-3">登录名</dt>
              <dd className="mt-1 break-all">{account.login_name ?? "飞书登录"}</dd>
            </div>
            <div>
              <dt className="text-ink-3">最近登录</dt>
              <dd className="mt-1">{account.last_login_at ? bj(account.last_login_at, true) : "暂无记录"}</dd>
            </div>
            <div>
              <dt className="text-ink-3">模型配置权限</dt>
              <dd className="mt-1">{account.models_manage ? "已授予" : "未授予"}</dd>
            </div>
          </dl>
          <form method="post" action="/api/auth/logout" className="mt-5">
            <input type="hidden" name="csrf" value={me.csrf} />
            <Button type="submit">退出登录</Button>
          </form>
        </Card>
        <Card title="修改密码">
          {account.must_change_password && (
            <p role="status" className="mb-4 rounded-control bg-amber/10 p-3 text-sm text-amber-ink">
              请先修改初始密码，再使用后台其他功能。
            </p>
          )}
          {password_login ? (
            <form
              className="space-y-4"
              onSubmit={async (e) => {
                e.preventDefault();
                if (busy) return;
                setError("");
                const parsed = privateSchemas.AccountPasswordChangeRequest.safeParse({
                  current_password: current,
                  new_password: next,
                  password_confirmation: confirm,
                  expected_revision: account.revision,
                });
                if (!parsed.success) {
                  setError("新密码需为 12–128 个字符，两次输入应一致。");
                  return;
                }
                const client = createPrivateClient({ baseUrl: "" });
                const result = await run("POST", "/api/admin/account/password", parsed.data, {
                  revalidate: false,
                  parse: (v) => privateSchemas.AccountPasswordChanged.parse(v),
                  send: (_url, init) => client.POST("/api/admin/account/password", { body: parsed.data, headers: init.headers, signal: init.signal }),
                });
                if (result) window.location.assign("/admin/login?password-changed=1");
              }}
            >
              <label className="block text-sm" htmlFor="self-password-0">
                当前密码
                <Input
                  id="self-password-0"
                  aria-label="当前密码"
                  className="mt-1"
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  maxLength={256}
                  required
                  onChange={(e) => setCurrent(e.target.value)}
                />
              </label>
              <label className="block text-sm" htmlFor="self-password-1">
                新密码
                <Input
                  id="self-password-1"
                  aria-label="新密码"
                  className="mt-1"
                  type="password"
                  autoComplete="new-password"
                  value={next}
                  minLength={12}
                  maxLength={128}
                  required
                  onChange={(e) => setNext(e.target.value)}
                />
              </label>
              <label className="block text-sm" htmlFor="self-password-2">
                再次输入新密码
                <Input
                  id="self-password-2"
                  aria-label="再次输入新密码"
                  className="mt-1"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  minLength={12}
                  maxLength={128}
                  required
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </label>
              <p className="text-xs text-ink-3">使用至少 12 个字符的独立密码。密码不会显示在账号清单或操作记录中。</p>
              {error && (
                <p role="alert" className="text-sm text-hot">
                  {error}
                </p>
              )}
              <Button type="submit" tone="primary" disabled={busy}>
                {busy ? "正在保存…" : "修改密码并退出"}
              </Button>
            </form>
          ) : (
            <p className="text-sm text-ink-3">此账号使用飞书登录，登录密码请在飞书中修改。</p>
          )}
        </Card>
      </div>
    </AdminPage>
  );
}
