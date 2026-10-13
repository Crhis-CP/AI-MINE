import { useEffect, useState } from "react";
import { Link } from "react-router";
import { createPrivateClient, privateSchemas } from "@amp/api-client/private";
import type { z } from "zod";
import { SITE } from "@amp/industry/site";
import type { Route } from "./+types/accounts";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { AdminPage, Card, Input, Button, Badge } from "../../features/admin/ui";
import { bj } from "../../features/admin/format";
type Account = z.infer<typeof privateSchemas.AccountRecord>;
type Action = z.infer<typeof privateSchemas.AccountActionRequest>["action"];
const names: Record<Action, string> = {
  reset_password: "重置密码",
  enable: "启用账号",
  disable: "停用账号",
  grant_models: "授予模型配置",
  revoke_models: "撤销模型配置",
};
export const meta = () => [{ title: `账号管理 · ${SITE.name} 后台` }];
export async function loader({ request }: Route.LoaderArgs) {
  const path = "/api/admin/accounts",
    client = createPrivateClient({ baseUrl: "" });
  return privateSchemas.AccountList.parse(
    await adminGet(request, path, (_u, init) => client.GET(path, { baseUrl: new URL(_u).origin, headers: init.headers, signal: init.signal })),
  );
}
export default function Accounts({ loaderData }: Route.ComponentProps) {
  const { accounts, limit } = loaderData,
    { run, busy } = useAdminAction();
  const [selected, setSelected] = useState<{ account: Account; action: Action } | null>(null),
    [create, setCreate] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState("");
  const [login, setLogin] = useState(""),
    [display, setDisplay] = useState(""),
    [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState("");
  const clear = () => {
    setSelected(null);
    setCreate(false);
    setConfirmed(false);
    setError("");
    setPassword("");
    setConfirmation("");
    setLogin("");
    setDisplay("");
  };
  const choose = (account: Account, action: Action) => {
    clear();
    setSelected({ account, action });
  };
  useEffect(() => {
    if (selected) {
      const current = accounts.find((a) => a.id === selected.account.id);
      if (current && current.revision !== selected.account.revision) {
        setSelected({ ...selected, account: current });
        setConfirmed(false);
      }
    }
  }, [accounts, selected]);
  const formOpen = create || !!selected,
    reset = create || selected?.action === "reset_password";
  return (
    <AdminPage
      title="账号管理"
      subtitle={`已建立 ${accounts.length} / ${limit} 个账号。停用后保留登录名与操作记录。`}
      actions={
        <>
          <Link className="text-sm text-accent" to="/admin/account">
            我的账号
          </Link>
          <Button
            tone="primary"
            disabled={busy || accounts.length >= limit}
            onClick={() => {
              clear();
              setCreate(true);
            }}
          >
            新增管理员
          </Button>
        </>
      }
    >
      {formOpen && (
        <Card className="mb-5" title={create ? "新增管理员" : `${names[selected!.action]} · ${selected!.account.display_name}`}>
          <form
            className="max-w-xl space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy) return;
              setError("");
              const client = createPrivateClient({ baseUrl: "" });
              let result: Account | null;
              if (create) {
                const body = privateSchemas.AccountCreateRequest.safeParse({
                  login_name: login,
                  display_name: display,
                  password,
                  password_confirmation: confirmation,
                  confirmed,
                });
                if (!body.success) {
                  setError("请核对登录名、显示名称和两次密码，并确认操作。");
                  return;
                }
                result = await run("POST", "/api/admin/accounts", body.data, {
                  success: "管理员已建立，首次登录必须修改密码。",
                  parse: (v) => privateSchemas.AccountRecord.parse(v),
                  send: (_u, init) => client.POST("/api/admin/accounts", { body: body.data, headers: init.headers, signal: init.signal }),
                });
              } else {
                const s = selected!;
                const body = privateSchemas.AccountActionRequest.safeParse({
                  action: s.action,
                  expected_revision: s.account.revision,
                  ...(reset ? { password, password_confirmation: confirmation } : {}),
                  confirmed,
                });
                if (!body.success) {
                  setError("请核对两次密码并确认操作。");
                  return;
                }
                result = await run("POST", `/api/admin/accounts/${s.account.id}/actions`, body.data, {
                  success: "账号已更新，原有登录状态已失效。",
                  parse: (v) => privateSchemas.AccountRecord.parse(v),
                  onConflict: () => setError("账号状态已更新，已保留你的输入。请核对最新状态后再操作。"),
                  send: (_u, init) =>
                    client.POST("/api/admin/accounts/{id}/actions", {
                      params: { path: { id: String(s.account.id) } },
                      body: body.data,
                      headers: init.headers,
                      signal: init.signal,
                    }),
                });
              }
              if (result) clear();
            }}
          >
            {create && (
              <>
                <label className="block text-sm" htmlFor="managed-account-0">
                  登录名
                  <Input
                    className="mt-1"
                    id="managed-account-0"
                    aria-label="登录名"
                    value={login}
                    autoComplete="off"
                    minLength={3}
                    maxLength={254}
                    pattern="[A-Za-z0-9._+@\-]+"
                    required
                    onChange={(e) => setLogin(e.target.value.toLowerCase())}
                  />
                  <span className="mt-1 block text-xs text-ink-3">3–254 个字母、数字或 . _ + @ -，不区分大小写。</span>
                </label>
                <label className="block text-sm" htmlFor="managed-account-1">
                  显示名称
                  <Input
                    className="mt-1"
                    id="managed-account-1"
                    aria-label="显示名称"
                    value={display}
                    maxLength={120}
                    required
                    onChange={(e) => setDisplay(e.target.value)}
                  />
                </label>
              </>
            )}
            {reset && (
              <>
                <label className="block text-sm" htmlFor="managed-account-2">
                  初始密码
                  <Input
                    className="mt-1"
                    id="managed-account-2"
                    aria-label="初始密码"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    minLength={12}
                    maxLength={128}
                    required
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <label className="block text-sm" htmlFor="managed-account-3">
                  再次输入初始密码
                  <Input
                    className="mt-1"
                    id="managed-account-3"
                    aria-label="再次输入初始密码"
                    type="password"
                    autoComplete="new-password"
                    value={confirmation}
                    minLength={12}
                    maxLength={128}
                    required
                    onChange={(e) => setConfirmation(e.target.value)}
                  />
                </label>
                <p className="text-xs text-ink-3">请通过双方认可的安全渠道交付初始密码，首次登录需要修改。</p>
              </>
            )}
            {selected && (
              <p className="text-sm text-ink-3">
                {selected.action === "disable"
                  ? "该账号将无法继续使用后台；当前所有登录设备立即退出。"
                  : selected.action === "grant_models"
                    ? "可调整环节指派与非秘密参数、测试连接和停用接入。新增供应商、密钥及地址变更仍由负责人处理。"
                    : "提交后，该账号所有设备需要重新登录。"}
              </p>
            )}
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" />
              我已核对账号与本次操作
            </label>
            {error && (
              <p role="alert" className="text-sm text-hot">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button type="submit" tone="primary" disabled={busy || !confirmed}>
                {busy ? "正在保存…" : "确认保存"}
              </Button>
              <Button type="button" disabled={busy} onClick={clear}>
                取消
              </Button>
            </div>
          </form>
        </Card>
      )}
      {accounts.every((a) => a.role === "owner") && <p className="mb-4 text-sm text-ink-3">还没有管理员。可以新建管理员，一起维护内容和反馈。</p>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {accounts.map((a) => (
          <Card key={a.id} title={a.display_name} right={<Badge tone={a.active ? "ok" : "muted"}>{a.active ? "启用" : "停用"}</Badge>}>
            <p className="break-all text-sm text-ink-3">{a.login_name ?? "飞书账号"}</p>
            <div className="my-3 flex flex-wrap gap-2">
              <Badge tone={a.role === "owner" ? "ok" : "muted"}>{a.role === "owner" ? "负责人" : "管理员"}</Badge>
              {a.models_manage && <Badge>模型配置</Badge>}
              {a.must_change_password && <Badge tone="warn">待修改初始密码</Badge>}
            </div>
            <p className="text-xs text-ink-4">最近登录：{a.last_login_at ? bj(a.last_login_at, true) : "尚无记录"}</p>
            {a.role === "owner" ? (
              <p className="mt-4 text-xs text-ink-3">负责人密码在“我的账号”修改；忘记密码时使用预先登记的服务器恢复操作。</p>
            ) : (
              <div className="mt-4 flex flex-wrap gap-2">
                {a.managed && (
                  <Button disabled={busy} onClick={() => choose(a, "reset_password")}>
                    重置密码
                  </Button>
                )}
                <Button disabled={busy} onClick={() => choose(a, a.active ? "disable" : "enable")}>
                  {a.active ? "停用" : "启用"}
                </Button>
                <Button disabled={busy} onClick={() => choose(a, a.models_manage ? "revoke_models" : "grant_models")}>
                  {a.models_manage ? "撤销模型配置" : "授权模型配置"}
                </Button>
              </div>
            )}
          </Card>
        ))}
      </div>
    </AdminPage>
  );
}
