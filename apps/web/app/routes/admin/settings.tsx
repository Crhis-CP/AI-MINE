import { apiFetch } from "../../lib/http.ts";
import { schemas as privateSchemas } from "@amp/contracts/http/private";
import { apiBaseFor } from "../../../api-target.ts";
import { UsageProtection } from "../../features/admin/UsageProtection";
import { SITE } from "@amp/industry/site";
import { useState } from "react";
import type { Route } from "./+types/settings";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction, useAdminMe } from "../../features/admin/action";
import { bj, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Input, ReasonDialog } from "../../features/admin/ui";
import { RuntimeControls } from "../../features/admin/RuntimeControls";
import { LaneControlsResponse } from "@amp/contracts/http/private";
import { MonthlyUsageList } from "@amp/contracts/http/private";
import { MonthlyUsage } from "../../features/admin/MonthlyUsage";
import type { z } from "zod";

interface Settings {
  protection: z.infer<typeof privateSchemas.UsageProtectionOverview> | null;
  runtime: z.infer<typeof LaneControlsResponse> | null;
  monthly: z.infer<typeof MonthlyUsageList>["items"] | null;
  targets: Array<{
    key: string;
    purpose: string;
    kind: string;
    enabled: boolean;
    enabled_at: string | null;
    config_ref: string | null;
    note: string | null;
    deliveries_7d: number;
    last_sent_at: string | null;
  }>;
  budgets: Array<{
    service: string;
    per_minute: number;
    per_hour: number;
    per_day: number;
    note: string | null;
    updated_at: string;
    used_day: number;
    used_hour: number;
  }>;
  settingsUnavailable?: boolean;
}

export async function loader({ request }: Route.LoaderArgs) {
  const path = "/api/admin/usage-protection",
    apiBase = apiBaseFor(path);
  const [settings, runtime, monthly, protection] = await Promise.all([
    adminGet<Omit<Settings, "runtime" | "monthly" | "protection">>(request, "/api/admin/settings").catch(() => null),
    adminGet<unknown>(request, "/api/admin/lane-controls")
      .then((value) => LaneControlsResponse.parse(value))
      .catch(() => null),
    adminGet<unknown>(request, "/api/admin/usage/reports")
      .then((value) => MonthlyUsageList.parse(value).items)
      .catch(() => null),
    adminGet<unknown>(request, path, (_url, init) => apiFetch(path, { headers: init.headers, signal: init.signal, method: "GET", baseUrl: apiBase }))
      .then((value) => privateSchemas.UsageProtectionOverview.parse(value))
      .catch(() => null),
  ]);
  return {
    targets: settings?.targets ?? [],
    budgets: settings?.budgets ?? [],
    settingsUnavailable: settings == null,
    runtime,
    monthly,
    protection,
  };
}

export const meta: Route.MetaFunction = () => [{ title: `自动运行与通知 · ${SITE.name} 后台` }];

function BudgetRow({ b }: { b: Settings["budgets"][number] }) {
  const { run, pending } = useAdminAction();
  const [v, setV] = useState({ perMinute: b.per_minute, perHour: b.per_hour, perDay: b.per_day });
  const [open, setOpen] = useState(false);
  const changed = v.perMinute !== b.per_minute || v.perHour !== b.per_hour || v.perDay !== b.per_day;
  return (
    <tr className="border-b border-line/70 last:border-0">
      <td className="px-3 py-2 font-mono text-[12.5px]">{b.service}</td>
      {(["perMinute", "perHour", "perDay"] as const).map((k) => (
        <td key={k} className="px-3 py-2">
          <Input type="number" min={0} className="!w-24 !py-1 text-right" value={v[k]} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} />
        </td>
      ))}
      <td className="num px-3 py-2 text-right text-ink-3">
        {num(b.used_hour)} / {num(b.used_day)}
      </td>
      <td className="px-3 py-2 text-right">
        <Button size="sm" tone="primary" disabled={!changed} onClick={() => setOpen(true)}>
          保存
        </Button>
        <ReasonDialog
          open={open}
          title={`调整 ${b.service} 的请求上限`}
          description="同一服务下的模型与接入合计，重试也计入。达到上限后等待滚动窗口恢复；填 0 表示停用该服务的新付费调用。"
          confirmLabel="保存"
          busy={pending === "budget"}
          onClose={() => setOpen(false)}
          onSubmit={async (reason) =>
            (await run("PUT", `/api/admin/budgets/${encodeURIComponent(b.service)}`, { ...v, reason }, { label: "budget", success: "上限已更新" })) !== null
          }
        />
      </td>
    </tr>
  );
}

function TargetToggle({ t }: { t: Settings["targets"][number] }) {
  const { run, pending } = useAdminAction();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" tone={t.enabled ? "danger" : "primary"} onClick={() => setOpen(true)}>
        {t.enabled ? "停用" : "启用"}
      </Button>
      <ReasonDialog
        open={open}
        title={`${t.enabled ? "停用" : "启用"}：${t.note ?? t.key}`}
        description={t.enabled ? "停用后新的推送不再发往这个群。" : "启用时间会被记录：启用之前的内容不会补推。开发与彩排环境即使启用也不会真的发出。"}
        danger={t.enabled}
        confirmLabel={t.enabled ? "停用" : "启用"}
        busy={pending === "target"}
        onClose={() => setOpen(false)}
        onSubmit={async (reason) =>
          (await run(
            "POST",
            `/api/admin/notify-targets/${encodeURIComponent(t.key)}`,
            { enabled: !t.enabled, reason },
            { label: "target", success: "已更新" },
          )) !== null
        }
      />
    </>
  );
}

export default function SettingsAdmin({ loaderData: s }: Route.ComponentProps) {
  const { run } = useAdminAction();
  const me = useAdminMe();
  return (
    <AdminPage title="设置" subtitle="通知目的地、付费请求上限和费用保护都从已保存的记录读取，以及资讯线与法规线各自的暂停。不用改服务器。">
      <RuntimeControls
        initial={s.runtime}
        canManage={!!me.owner}
        onAction={(action) =>
          run("POST", "/api/admin/lane-controls/actions", action, {
            label: "lane-control",
            parse: LaneControlsResponse.parse,
            success: action.action === "pause" ? "所选范围已暂停" : "所选负责人暂停已解除",
            onConflict: () => {},
          })
        }
      />
      <UsageProtection data={s.protection} />
      <MonthlyUsage entries={s.monthly} pushTime={s.protection?.configuration?.config.usage_report.push_time} />
      {s.settingsUnavailable ? (
        <Card title="通知与请求上限" className="mt-5">
          <p className="text-[13px] text-ink-2">通知目的地和付费请求上限暂时无法读取。页面其余部分仍可用，不会把读不到的记录显示成 0。</p>
        </Card>
      ) : (
        <>
          <Card title="通知目的地" pad={false}>
            <DataTable
              rows={s.targets}
              rowKey={(t) => t.key}
              columns={[
                {
                  key: "k",
                  label: "目的地",
                  render: (t) => (
                    <div>
                      <div className="font-medium text-ink">{t.note ?? t.key}</div>
                      <div className="font-mono text-[11.5px] text-ink-4">
                        {t.key} · {t.config_ref}
                      </div>
                    </div>
                  ),
                },
                { key: "e", label: "状态", render: (t) => (t.enabled ? <Badge tone="ok">启用于 {bj(t.enabled_at)}</Badge> : <Badge>停用</Badge>) },
                { key: "d", label: "7 天投递", align: "right", render: (t) => num(t.deliveries_7d) },
                { key: "a", label: "", align: "right", render: (t) => <TargetToggle t={t} /> },
              ]}
            />
          </Card>
          <Card className="mt-5" title="付费请求上限" right={<span>已用：近 1 小时 / 近 24 小时</span>} pad={false}>
            <p className="px-4 py-3 text-[13px] leading-6 text-ink-3">
              同一服务下的不同模型和接入共享次数，连接测试与失败后的重试也计入。计数按滚动时间窗口恢复。
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left text-[12px] text-ink-3">
                    <th className="px-3 py-2 font-medium">服务</th>
                    <th className="px-3 py-2 font-medium">每分钟</th>
                    <th className="px-3 py-2 font-medium">每小时</th>
                    <th className="px-3 py-2 font-medium">滚动24小时</th>
                    <th className="px-3 py-2 text-right font-medium">已用</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {s.budgets.map((b) => (
                    <BudgetRow key={`${b.service}-${b.updated_at}`} b={b} />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </AdminPage>
  );
}
